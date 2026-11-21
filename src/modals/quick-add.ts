import { NkModal } from "./base";
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { BoardConfig, INBOX, PropertyDef, TASK_CREATED, UNCATEGORIZED } from "../types";
import { createCard, getProperty, questFolderPath } from "../store";
import { listQuests } from "../quests";
import { dateField } from "../dateinput";
import { toISODateTime } from "../dates";
import { AUTO_PROPS } from "../intake";
import { undo } from "../undo";

export interface QuickAddBoard {
  path: string;
  config: BoardConfig;
}

/** What the modal remembers between runs (stored in plugin settings). */
export interface QuickAddMemory {
  board?: string;
  /** Last quest used, per board path. */
  quest?: Record<string, string>;
}

/**
 * Log a task without opening the board: title, quest, status and the board's
 * own fields (ticket, requester, entity, due …). The note is created in the
 * quest's folder with a Created stamp.
 */
export class QuickAddModal extends NkModal {
  private boardPath: string;
  private title = "";
  private quest = INBOX;
  private values: Record<string, unknown> = {};
  private busy = false;

  constructor(
    app: App,
    private boards: readonly QuickAddBoard[],
    private memory: QuickAddMemory,
    private saveMemory: () => void,
    preferredBoard?: string
  ) {
    super(app);
    const known = (p?: string) => !!p && boards.some((b) => b.path === p);
    this.boardPath = known(preferredBoard)
      ? preferredBoard!
      : known(memory.board)
      ? memory.board!
      : boards[0].path;
  }

  private get board(): QuickAddBoard {
    return this.boards.find((b) => b.path === this.boardPath) ?? this.boards[0];
  }

  onOpen(): void {
    this.modalEl.addClass("nk-quickadd-modal");
    this.titleEl.setText("Quick add task");
    this.resetForBoard();
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Pick the default quest and status for the current board. */
  private resetForBoard(): void {
    const { config, path } = this.board;
    const quests = listQuests(this.app, config);
    const last = this.memory.quest?.[path];
    const radiant = quests.find((q) => q.radiant);
    if (last && (last === INBOX ? !!config.folder : quests.some((q) => q.name === last))) this.quest = last;
    else if (radiant) this.quest = radiant.name;
    else this.quest = config.folder ? INBOX : quests[0]?.name ?? INBOX;
    this.values = {};
    const first = getProperty(config, config.groupBy)?.options?.[0]?.name;
    if (first) this.values[config.groupBy] = first;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const { config } = this.board;

    if (this.boards.length > 1) {
      new Setting(contentEl).setName("Board").addDropdown((d) => {
        for (const b of this.boards) d.addOption(b.path, b.path.replace(/\.kanban$/, ""));
        d.setValue(this.boardPath).onChange((v) => {
          this.boardPath = v;
          this.resetForBoard();
          this.render();
        });
      });
    }

    new Setting(contentEl).setName("Title").addText((t) => {
      t.setPlaceholder("What needs doing?").setValue(this.title).onChange((v) => (this.title = v));
      t.inputEl.addClass("nk-quickadd-title");
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    const quests = listQuests(this.app, config);
    new Setting(contentEl).setName("Quest").addDropdown((d) => {
      if (config.folder) d.addOption(INBOX, "No quest");
      for (const q of quests) d.addOption(q.name, q.radiant ? `${q.name} (radiant)` : q.name);
      d.setValue(this.quest).onChange((v) => (this.quest = v));
    });

    // The group-by property first, then the board's other fields in order.
    const status = getProperty(config, config.groupBy);
    const defs = [
      ...(status ? [status] : []),
      ...config.properties.filter((p) => p !== status && !AUTO_PROPS.has(p.name)),
    ];
    for (const def of defs) this.renderField(contentEl, def);

    const buttons = new Setting(contentEl).setClass("nk-quickadd-buttons");
    buttons.setDesc("Enter adds · Ctrl/Cmd+Enter adds and opens the note");
    buttons.addButton((b) => b.setButtonText("Add & open").onClick(() => void this.submit(true)));
    buttons.addButton((b) => b.setButtonText("Add").setCta().onClick(() => void this.submit(false)));

    // Enter anywhere in the form submits (except in the date field, which commits first).
    contentEl.onkeydown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "BUTTON" || t.tagName === "SELECT") return;
      e.preventDefault();
      // Let a date field normalise its value on the same keypress first.
      window.setTimeout(() => void this.submit(e.ctrlKey || e.metaKey), 0);
    };
  }

  private renderField(host: HTMLElement, def: PropertyDef): void {
    const s = new Setting(host).setName(def.name);
    const v = this.values[def.name];
    switch (def.type) {
      case "select":
        s.addDropdown((d) => {
          d.addOption("", "—");
          for (const o of def.options ?? []) d.addOption(o.name, o.name);
          d.setValue(typeof v === "string" ? v : "").onChange((x) => (this.values[def.name] = x));
        });
        break;
      case "multiselect":
        s.setDesc(def.options?.length ? `e.g. ${def.options.slice(0, 3).map((o) => o.name).join(", ")}` : "Comma-separated");
        s.addText((t) =>
          t.setPlaceholder("a, b").onChange((x) => {
            this.values[def.name] = x.split(",").map((p) => p.trim()).filter(Boolean);
          })
        );
        break;
      case "date":
        dateField(s.controlEl, typeof v === "string" ? v : "", (iso) => (this.values[def.name] = iso));
        break;
      case "number":
        s.addText((t) => {
          t.inputEl.type = "number";
          t.onChange((x) => (this.values[def.name] = x === "" ? "" : Number(x)));
        });
        break;
      case "checkbox":
        s.addToggle((t) => t.setValue(v === true).onChange((x) => (this.values[def.name] = x)));
        break;
      default:
        s.addText((t) => t.setPlaceholder("Empty").onChange((x) => (this.values[def.name] = x.trim())));
    }
  }

  private async submit(open: boolean): Promise<void> {
    if (this.busy) return;
    const title = this.title.trim();
    if (!title) {
      new Notice("Give the task a title first.");
      return;
    }
    this.busy = true;
    const { config, path } = this.board;
    try {
      const status = this.values[config.groupBy];
      const extra: Record<string, unknown> = {};
      for (const def of config.properties) {
        if (def.name === config.groupBy) continue;
        const x = this.values[def.name];
        if (x === undefined || x === "" || (Array.isArray(x) && !x.length)) continue;
        extra[def.name] = x;
      }
      extra[TASK_CREATED] = toISODateTime(new Date());
      const folder = this.quest === INBOX ? config.folder : questFolderPath(config, this.quest);
      const file: TFile = await undo.record("Quick add task", async (tx) => {
        const f = await createCard(
          this.app,
          config,
          typeof status === "string" && status ? status : UNCATEGORIZED,
          title,
          folder,
          extra
        );
        tx.created(f.path);
        return f;
      });
      this.memory.board = path;
      (this.memory.quest ??= {})[path] = this.quest;
      this.saveMemory();
      this.close();
      new Notice(`Added "${file.basename}" to ${this.quest === INBOX ? "No quest" : this.quest}.`);
      if (open) await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      new Notice(`Couldn't add the task: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
