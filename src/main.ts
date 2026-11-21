import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  debounce,
  normalizePath,
} from "obsidian";
import {
  BoardConfig,
  KANBAN_EXT,
  KANBAN_VIEW_TYPE,
  defaultBoard,
} from "./types";
import { parseBoard, questsRootPath, renameQuestKey, scanCards, serializeBoard } from "./store";
import { questRenamesInFlight } from "./quests";
import { KanbanView } from "./view";
import { promptText } from "./modals/prompt";
import { BoardIndex, boardOptionsFor, renderQuestBanner } from "./banner";
import { TASK_CLOSED, addIntakeFields, closedStampUpdate, statusText } from "./intake";
import { isArchivedStatus, isClosedStatus } from "./status";
import { toISO } from "./dates";
import { QuickAddMemory, QuickAddModal } from "./modals/quick-add";
import { undo } from "./undo";
import { ExportKey, addExportMenu, exportDiagnostics, runExport } from "./export";

interface NKSettings {
  /** Clicking a folder that holds a .kanban board opens that board. */
  openBoardOnFolderClick: boolean;
  /** Show the quest banner (quest line + last edited) on task note pages. */
  questBanner: boolean;
  /** Add an "Export" submenu to note menus (note ⋯ menu, file explorer). */
  exportInFileMenu: boolean;
  /** Quick add remembers the last board and quest used. */
  quickAdd: QuickAddMemory;
}

const DEFAULT_SETTINGS: NKSettings = {
  openBoardOnFolderClick: true,
  questBanner: true,
  exportInFileMenu: true,
  quickAdd: {},
};

export default class NoteBoardPlugin extends Plugin {
  settings: NKSettings = { ...DEFAULT_SETTINGS };
  private boards = new BoardIndex(this.app);
  /** Last seen status per task path, so Closed is stamped only on a real change. */
  private lastStatus = new Map<string, string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    undo.init(this.app);

    // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo — on the board,
    // the timeline, the card modal and board settings. Text fields and the
    // note editor keep their own text undo.
    const onKey = (e: KeyboardEvent) => this.onUndoKey(e);
    window.addEventListener("keydown", onKey, true);
    this.register(() => window.removeEventListener("keydown", onKey, true));

    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf));

    // Open `.kanban` files with our board view.
    try {
      this.registerExtensions([KANBAN_EXT], KANBAN_VIEW_TYPE);
    } catch (e) {
      console.warn("NoteBoard: .kanban extension already registered.", e);
    }

    this.addRibbonIcon("layout-dashboard", "New kanban board", () =>
      this.createBoard()
    );

    // Quick add: log a task (e.g. an ad-hoc request) without opening the board.
    this.addRibbonIcon("list-plus", "Quick add task", () => this.openQuickAdd());
    this.addCommand({
      id: "quick-add-task",
      name: "Quick add task…",
      callback: () => this.openQuickAdd(),
    });
    this.addCommand({
      id: "add-intake-fields",
      name: "Add intake fields (Ticket, Requester, Entity, Closed) to board",
      callback: () => void this.addIntakeFieldsToBoard(),
    });

    this.addCommand({
      id: "create-kanban-board",
      name: "Create new kanban board",
      callback: () => this.createBoard(),
    });

    this.addSettingTab(new NKSettingTab(this));

    // Make clicking a board's folder open the board (and still expand it).
    this.registerDomEvent(document, "click", (evt) =>
      this.onExplorerClick(evt)
    );

    // Export a note: markdown / rich text / file to the clipboard, save as .md.
    const exportCommands: [ExportKey, string][] = [
      ["copy-md", "Copy note as markdown"],
      ["copy-body", "Copy note body (no properties)"],
      ["copy-rich", "Copy note as rich text"],
      ["copy-file", "Copy note file (.md)"],
      ["save", "Save note as .md file…"],
      ["copy-uri", "Copy obsidian:// link to note"],
    ];
    for (const [key, name] of exportCommands) {
      this.addCommand({
        id: `export-${key}`,
        name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void runExport(this.app, file, key);
          return true;
        },
      });
    }
    this.addCommand({
      id: "export-diagnostics",
      name: "Export diagnostics (why did copy fail?)",
      callback: async () => {
        const lines = await exportDiagnostics(this.app, this.app.workspace.getActiveFile());
        console.log("NoteBoard export diagnostics\n" + lines.join("\n"));
        new Notice(lines.join("\n"), 30000);
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (this.settings.exportInFileMenu && file instanceof TFile && file.extension === "md") {
          addExportMenu(menu, this.app, file);
        }
      })
    );

    // Quest banner on task note pages: keep a board index, re-draw banners
    // when notes open, switch mode, or their frontmatter changes.
    // Second pass: reading view builds its header asynchronously after a mode switch.
    const refresh = debounce(() => {
      this.refreshBanners();
      window.setTimeout(() => this.refreshBanners(), 400);
    }, 300, true);
    const reindex = debounce(async () => {
      await this.boards.rebuild();
      this.seedStatuses();
      this.refreshBanners();
    }, 500, true);
    const isBoard = (f: { path: string }) => f.path.endsWith(`.${KANBAN_EXT}`);
    this.addBoardOptionSuggestions();
    this.app.workspace.onLayoutReady(() => void reindex());
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    // Stamp Closed when a task becomes Done / Abandoned, clear it if reopened.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => void this.syncClosedStamp(file, cache.frontmatter))
    );
    this.registerEvent(this.app.vault.on("modify", (f) => (isBoard(f) ? reindex() : refresh())));
    this.registerEvent(this.app.vault.on("create", (f) => isBoard(f) && reindex()));
    this.registerEvent(this.app.vault.on("delete", (f) => isBoard(f) && reindex()));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const st = this.lastStatus.get(oldPath);
        if (st !== undefined) {
          this.lastStatus.delete(oldPath);
          this.lastStatus.set(file.path, st);
        }
        void this.syncQuestNames(file, oldPath);
        reindex();
      })
    );
  }

  private onUndoKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const isUndo = key === "z" && !e.shiftKey;
    const isRedo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey && !e.metaKey);
    if (!isUndo && !isRedo) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable='true'], .cm-editor")) return;

    const ourModal = document.querySelector(".modal-container .nk-card-modal, .modal-container .nk-settings-modal");
    const otherModal = !ourModal && document.querySelector(".modal-container");
    const onBoard = !!this.app.workspace.getActiveViewOfType(KanbanView);
    if (otherModal || (!ourModal && !onBoard)) return;

    e.preventDefault();
    e.stopPropagation();
    void (isUndo ? undo.undo() : undo.redo());
  }

  /**
   * A quest is a folder `Quests/<name>/` plus its note `<name>.md`; the two
   * must share a name. Renaming either one (note title, file explorer, …)
   * renames the other, and the board config follows the new name.
   */
  private async syncQuestNames(file: TAbstractFile, oldPath: string): Promise<void> {
    const { vault, fileManager } = this.app;
    const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

    for (const { path: boardPath, config } of this.boards.entries()) {
      const root = questsRootPath(config);

      // Quest note renamed in place → rename its folder to match.
      if (file instanceof TFile && file.extension === "md" && file.parent) {
        const oldDir = dir(oldPath);
        const oldName = base(oldPath).replace(/\.md$/, "");
        if (
          file.parent.path === oldDir &&
          dir(oldDir) === root &&
          base(oldDir) === oldName &&
          file.basename !== oldName
        ) {
          const target = normalizePath(`${root}/${file.basename}`);
          if (vault.getAbstractFileByPath(target)) {
            new Notice(`A quest named "${file.basename}" already exists, so its folder wasn't renamed.`);
            return;
          }
          await fileManager.renameFile(file.parent, target);
          await this.renameQuestInClosedBoard(boardPath, oldName, file.basename);
          return;
        }
      }

      // Quest folder renamed → rename its note to match.
      if (file instanceof TFolder && dir(file.path) === root && dir(oldPath) === root) {
        if (questRenamesInFlight.has(file.path)) return; // NoteBoard's own rename handles it
        const oldName = base(oldPath);
        const note = vault.getAbstractFileByPath(normalizePath(`${file.path}/${oldName}.md`));
        const target = normalizePath(`${file.path}/${file.name}.md`);
        if (note instanceof TFile && !vault.getAbstractFileByPath(target)) {
          await fileManager.renameFile(note, target);
        }
        await this.renameQuestInClosedBoard(boardPath, oldName, file.name);
        return;
      }
    }
  }

  /** Open boards re-key quests themselves; closed boards are patched on disk. */
  private async renameQuestInClosedBoard(boardPath: string, oldName: string, newName: string): Promise<void> {
    const open = this.app.workspace
      .getLeavesOfType(KANBAN_VIEW_TYPE)
      .some((l) => (l.view as unknown as { file?: TFile }).file?.path === boardPath);
    if (open) return;
    const f = this.app.vault.getAbstractFileByPath(boardPath);
    if (!(f instanceof TFile)) return;
    const config = parseBoard(await this.app.vault.read(f));
    if (renameQuestKey(config, oldName, newName)) await this.app.vault.modify(f, serializeBoard(config));
  }

  /**
   * Obsidian's Properties panel suggests a text property's values from what
   * other notes already use, so board options nobody has used yet (e.g. "Done")
   * never show up. Add every board's select options to those suggestions.
   * `getFrontmatterPropertyValuesForKey` isn't in the public API, so this is
   * guarded and undone on unload.
   */
  private addBoardOptionSuggestions(): void {
    const cache = this.app.metadataCache as unknown as {
      getFrontmatterPropertyValuesForKey?: (key: string) => string[];
    };
    const orig = cache.getFrontmatterPropertyValuesForKey;
    if (typeof orig !== "function") return;
    const boards = this.boards;
    const patched = function (this: unknown, key: string): string[] {
      const used = orig.call(this, key) ?? [];
      const extra = boardOptionsFor(boards, key).filter((v) => !used.includes(v));
      return extra.length ? [...used, ...extra] : used;
    };
    cache.getFrontmatterPropertyValuesForKey = patched;
    this.register(() => {
      if (cache.getFrontmatterPropertyValuesForKey === patched) cache.getFrontmatterPropertyValuesForKey = orig;
    });
  }

  /** The board to target: the active board view, else the remembered/only one. */
  private activeBoardPath(): string | undefined {
    return this.app.workspace.getActiveViewOfType(KanbanView)?.file?.path;
  }

  private openQuickAdd(): void {
    const boards = this.boards.entries();
    if (!boards.length) {
      new Notice("No NoteBoard boards in this vault yet — create one first.");
      return;
    }
    new QuickAddModal(
      this.app,
      boards,
      this.settings.quickAdd,
      () => void this.saveSettings(),
      this.activeBoardPath()
    ).open();
  }

  /** Add Ticket / Requester / Entity / Closed to the open board (or the only board). */
  private async addIntakeFieldsToBoard(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(KanbanView);
    const all = this.boards.entries();
    const path = view?.file?.path ?? (all.length === 1 ? all[0].path : undefined);
    if (!path) {
      new Notice("Open the board you want to add the fields to, then run this again.");
      return;
    }
    let added: string[] = [];
    const openView = this.app.workspace
      .getLeavesOfType(KANBAN_VIEW_TYPE)
      .map((l) => l.view as KanbanView)
      .find((v) => v.file?.path === path);
    if (openView) {
      openView.updateConfig((c) => (added = addIntakeFields(c)));
    } else {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return;
      const config = parseBoard(await this.app.vault.read(f));
      added = addIntakeFields(config);
      if (added.length) await this.app.vault.modify(f, serializeBoard(config));
    }
    new Notice(
      added.length
        ? `Added ${added.join(", ")} to ${path}. Add Entity options from any card (Entity → New option…).`
        : "This board already has all the intake fields."
    );
  }

  /** Remember every task's current status (after the board index is built). */
  private seedStatuses(): void {
    this.lastStatus.clear();
    for (const { config } of this.boards.entries()) {
      for (const c of scanCards(this.app, config)) this.lastStatus.set(c.path, statusText(config, c.props));
    }
  }

  /** Keep a task's Closed date in step with its status (boards with a Closed field only). */
  private async syncClosedStamp(file: TFile, fm: Record<string, unknown> | undefined): Promise<void> {
    const hit = this.boards.lookup(file);
    if (!hit || hit.ctx.isQuestNote) return;
    const props = fm ?? {};
    const prev = this.lastStatus.get(file.path);
    this.lastStatus.set(file.path, statusText(hit.config, props));
    // A task we haven't seen (new, or moved in): open → done needs a known start.
    // New notes created already-closed are stamped too.
    const from = prev ?? (file.stat.ctime > Date.now() - 60_000 ? "" : undefined);
    const next = closedStampUpdate(hit.config, from, props, toISO(new Date()), isClosedStatus, isArchivedStatus);
    if (next === undefined) return;
    await this.app.fileManager.processFrontMatter(file, (f) => {
      if (next === null) delete f[TASK_CLOSED];
      else f[TASK_CLOSED] = next;
    });
  }

  /** Insert (or refresh) the quest banner under the title of every open task note. */
  refreshBanners(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      view.containerEl.findAll(".nk-quest-banner").forEach((n) => n.remove());
      const file = view.file;
      if (!this.settings.questBanner || !file) continue;
      const hit = this.boards.lookup(file);
      if (!hit) continue;
      // Live preview keeps the title in .cm-sizer; reading view in .mod-header.
      for (const host of view.containerEl.findAll(".cm-sizer, .markdown-preview-sizer .mod-header")) {
        const banner = createDiv();
        renderQuestBanner(banner, this.app, hit.config, file, hit.ctx);
        const title = host.querySelector(".inline-title");
        if (title) title.insertAdjacentElement("afterend", banner);
        else host.prepend(banner);
      }
    }
  }

  onunload(): void {
    document.querySelectorAll(".nk-quest-banner").forEach((n) => n.remove());
    // Obsidian handles detaching leaves of our view type.
  }

  // ---- Folder-click → open board ----------------------------------------

  private onExplorerClick(evt: MouseEvent): void {
    if (!this.settings.openBoardOnFolderClick) return;
    if (evt.button !== 0 || evt.defaultPrevented) return;
    const target = evt.target as HTMLElement | null;
    const titleEl = target?.closest?.(
      ".nav-folder-title"
    ) as HTMLElement | null;
    if (!titleEl) return;
    const path = titleEl.getAttribute("data-path");
    if (!path) return;
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) return;
    const board = this.findBoard(folder);
    if (board) this.openBoard(board);
  }

  /** Find a board file in a folder: prefer one named after the folder. */
  private findBoard(folder: TFolder): TFile | null {
    let fallback: TFile | null = null;
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === KANBAN_EXT) {
        if (child.basename === folder.name) return child;
        if (!fallback) fallback = child;
      }
    }
    return fallback;
  }

  /** Open a board, reusing its existing tab if one is already open. */
  private openBoard(file: TFile): void {
    const leaves = this.app.workspace.getLeavesOfType(KANBAN_VIEW_TYPE);
    const existing = leaves.find(
      (l) => (l.view as unknown as { file?: TFile })?.file?.path === file.path
    );
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    this.app.workspace.getLeaf("tab").openFile(file);
  }

  // ---- Create board -----------------------------------------------------

  private async createBoard(): Promise<void> {
    const name = await promptText(
      this.app,
      "New kanban board",
      "Board name",
      "Kanban Board"
    );
    if (!name) return;
    const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Kanban Board";

    // One folder per board: the board file and its card notes live together,
    // so the file explorer shows a single item.
    const folder = safe;
    if (!this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
      await this.app.vault.createFolder(normalizePath(folder)).catch(() => {});
    }

    const config: BoardConfig = defaultBoard(folder);
    let path = normalizePath(`${folder}/${safe}.${KANBAN_EXT}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${safe} ${i}.${KANBAN_EXT}`);
      i++;
    }

    const file = await this.app.vault.create(path, serializeBoard(config));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Created board "${file.basename}".`);
    }
  }

  // ---- Settings persistence ---------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class NKSettingTab extends PluginSettingTab {
  constructor(private plugin: NoteBoardPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Open board when its folder is clicked")
      .setDesc(
        "Clicking a folder that contains a .kanban board opens the board (and still expands the folder)."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.openBoardOnFolderClick)
          .onChange(async (v) => {
            this.plugin.settings.openBoardOnFolderClick = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Export in note menus")
      .setDesc("Add an Export submenu (copy markdown, rich text, file; save as .md) to a note's ⋯ menu and the file explorer menu. The commands stay in the command palette either way.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.exportInFileMenu).onChange(async (v) => {
          this.plugin.settings.exportInFileMenu = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Quest banner on task notes")
      .setDesc("Show the quest line, progress and last edited time under the title of task notes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.questBanner).onChange(async (v) => {
          this.plugin.settings.questBanner = v;
          await this.plugin.saveSettings();
          this.plugin.refreshBanners();
        })
      );
  }
}
