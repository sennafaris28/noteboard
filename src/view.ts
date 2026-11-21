import {
  Menu,
  Notice,
  TAbstractFile,
  TextFileView,
  TFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
  normalizePath,
  setIcon,
} from "obsidian";
import {
  BoardConfig,
  Card,
  ColumnDef,
  COL_SHADOW_DEFAULT,
  COL_WIDTH_DEFAULT,
  GroupMode,
  INBOX,
  KANBAN_VIEW_TYPE,
  PropertyDef,
  Quest,
  QUEST_START,
  QUEST_TARGET,
  QUEST_TYPE,
  TASK_CREATED,
  TASK_DUE,
  TimelineLayout,
  TimelineZoom,
  UNCATEGORIZED,
  ViewMode,
} from "./types";
import {
  cardGroup,
  createCard,
  getProperty,
  layoutCards,
  layoutQuestCards,
  moveFileToFolder,
  parseBoard,
  questFolderPath,
  questsRootPath,
  renameQuestKey,
  scanCards,
  serializeBoard,
  setCardGroup,
  writeProp,
} from "./store";
import { applyColor, autoColor } from "./colors";
import { CardModal } from "./modals/card-modal";
import { BoardSettingsModal } from "./modals/board-settings";
import { confirmDialog, promptDate, promptText } from "./modals/prompt";
import { renderJourney } from "./journey";
import { renderSprint } from "./sprint";
import { isTouch, onHold, onLongPress } from "./touch";
import { isAbandoned, isArchived, isDone } from "./status";
import {
  createQuest,
  deleteQuest,
  ensureQuestNote,
  extractGoal,
  listQuests,
  renameQuest,
} from "./quests";
import { TimelineHandle, renderTimeline } from "./timeline";
import { formatDMY, parseDate, parseDateTime, toISO, toISODateTime } from "./dates";
import { Tx, undo } from "./undo";
import { addExportMenu } from "./export";
import { GroupColorModal, NewGroupModal, NewQuestModal } from "./modals/color-picker";
import { EmojiPickerModal, randomIconFor } from "./modals/emoji-picker";

interface DragState {
  path: string;
  fromCol: string;
}

export class KanbanView extends TextFileView {
  config: BoardConfig = parseBoard("");
  private search = "";
  private drag: DragState | null = null;
  private colDrag: string | null = null;
  /** path -> group, applied during render so a moved card lands instantly
   *  before its frontmatter write finishes on disk. */
  private pendingGroup = new Map<string, string>();
  /** path -> Due date (or null = cleared), applied during render while the
   *  frontmatter write from a timeline drag is still in flight. */
  private pendingDue = new Map<string, string | null>();
  private timeline: TimelineHandle | null = null;
  /** Timeline scroll position, kept across re-renders. */
  private tlScroll: { left: number; top: number } | null = null;
  private boardScroll = 0;
  /** Journey scroll position, kept across re-renders. */
  private jrScroll: { left: number; top: number } | null = null;
  /** Each journey lane's horizontal scroll, by quest key. */
  private jrLaneScroll = new Map<string, number>();
  /** Quest goal text by quest-note path, re-read when the note changes. */
  private goals = new Map<string, { mtime: number; text: string }>();
  private goalLoads = new Set<string>();
  /** Names of radiant quests, refreshed every render. */
  private radiantQuests = new Set<string>();
  /** Sprint view: sprints away from the current one (not saved). */
  private sprintOffset = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Re-render when the board's notes or quest folders change externally.
    const refresh = debounce(() => this.render(), 200, true);
    const watch = (file: TAbstractFile | null, oldPath?: string) => {
      if (this.inFolder(file) || (oldPath !== undefined && this.inFolder({ path: oldPath }))) {
        refresh();
      }
    };
    this.registerEvent(this.app.metadataCache.on("changed", (file) => watch(file)));
    this.registerEvent(this.app.vault.on("create", (file) => watch(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => watch(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.remapPath(oldPath, file.path);
        else if (file instanceof TFolder) this.onFolderRenamed(file, oldPath);
        watch(file, oldPath);
      })
    );

    // Let the undo history read/restore this board's config.
    this.register(
      undo.registerHost({
        path: () => this.file?.path,
        config: () => this.config,
        getJson: () => serializeBoard(this.config),
        setJson: (json) => {
          // Restore in place so modals holding this config object stay in sync.
          const next = parseBoard(json) as unknown as Record<string, unknown>;
          const cur = this.config as unknown as Record<string, unknown>;
          for (const k of Object.keys(cur)) delete cur[k];
          Object.assign(cur, next);
          this.commit();
        },
      })
    );
  }

  /**
   * Run a board action as one undo step. The config is snapshotted up front
   * and recorded only if the action actually changed it; file changes are
   * recorded by `fn` through `tx`.
   */
  private async track<T>(label: string, fn: (tx: Tx) => Promise<T>, mergeKey?: string): Promise<T> {
    const before = serializeBoard(this.config);
    const path = this.file?.path;
    return undo.record(
      label,
      async (tx) => {
        try {
          return await fn(tx);
        } finally {
          if (path && serializeBoard(this.config) !== before) tx.config(path, before);
        }
      },
      mergeKey
    );
  }

  getViewType(): string {
    return KANBAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Kanban";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  // ---- TextFileView contract -------------------------------------------

  getViewData(): string {
    return serializeBoard(this.config);
  }

  setViewData(data: string, _clear: boolean): void {
    this.config = parseBoard(data);
    this.render();
  }

  clear(): void {
    this.contentEl.empty();
  }

  /** Let code outside the view (commands) change this board's config. */
  updateConfig(fn: (config: BoardConfig) => void): void {
    fn(this.config);
    this.commit();
  }

  /** Mutate config then persist + re-render. */
  private commit(rerender = true): void {
    this.requestSave();
    if (rerender) this.render();
  }

  /** True for notes directly in the board folder, or anything under Quests/. */
  private inFolder(file: { path: string } | null): boolean {
    if (!file) return false;
    const qroot = questsRootPath(this.config);
    if (file.path === qroot || file.path.startsWith(qroot + "/")) return true;
    const folder = this.config.folder || "";
    const parent = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    return parent === folder;
  }

  /**
   * A quest folder was renamed (from anywhere): re-key it in the config now,
   * before the next render's quest sync would treat it as a brand-new quest.
   */
  private onFolderRenamed(folder: TFolder, oldPath: string): void {
    const root = questsRootPath(this.config);
    const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    if (parentOf(folder.path) !== root || parentOf(oldPath) !== root) return;
    const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1);
    if (renameQuestKey(this.config, oldName, folder.name)) this.requestSave();
  }

  /** A note was renamed/moved: keep its saved position and branch membership. */
  private remapPath(oldPath: string, newPath: string): void {
    let changed = false;
    const swap = (list: string[] | undefined) => {
      if (!list) return;
      const i = list.indexOf(oldPath);
      if (i >= 0) {
        list[i] = newPath;
        changed = true;
      }
    };
    for (const list of Object.values(this.config.cardOrder)) swap(list);
    for (const list of Object.values(this.config.questCardOrder ?? {})) swap(list);
    swap(this.config.journeyStacked);
    if (changed) this.requestSave();
  }

  private isQuestMode(): boolean {
    return this.config.groupMode !== "status";
  }

  /** The column list the board is currently showing (quests or statuses). */
  private activeColumns(): ColumnDef[] {
    return this.isQuestMode() ? (this.config.questColumns ??= []) : this.config.columns;
  }

  /** Folder a quest-column key maps to (INBOX = the board folder itself). */
  private questKeyFolder(key: string): string {
    return key === INBOX ? this.config.folder : questFolderPath(this.config, key);
  }

  /** List quests and keep config.questColumns in sync with the folders on disk. */
  private syncQuests(): Quest[] {
    const quests = listQuests(this.app, this.config);
    const names = new Set(quests.map((q) => q.name));
    const prev = this.config.questColumns ?? [];
    const next = prev.filter((c) => names.has(c.id));
    for (const q of quests) {
      if (!next.some((c) => c.id === q.name)) next.push({ id: q.name, color: autoColor(q.name) });
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      this.config.questColumns = next;
      this.requestSave();
    }
    const pos = new Map(next.map((c, i) => [c.id, i]));
    return quests.sort((a, b) => (pos.get(a.name) ?? 0) - (pos.get(b.name) ?? 0));
  }

  // ---- Rendering --------------------------------------------------------

  private render(): void {
    // Keep scroll positions across re-renders so edits don't make the view jump.
    const prevTl = this.contentEl.querySelector<HTMLElement>(".nk-tl-scroll");
    if (prevTl) this.tlScroll = { left: prevTl.scrollLeft, top: prevTl.scrollTop };
    const prevJr = this.contentEl.querySelector<HTMLElement>(".nk-jr");
    if (prevJr) {
      this.jrScroll = { left: prevJr.scrollLeft, top: prevJr.scrollTop };
      for (const w of prevJr.findAll(".nk-jr-lanewrap")) {
        const key = w.getAttr("data-key");
        if (key) this.jrLaneScroll.set(key, w.scrollLeft);
      }
    }
    const prevBoard = this.contentEl.querySelector<HTMLElement>(".nk-board");
    if (prevBoard) this.boardScroll = prevBoard.scrollLeft;

    const root = this.contentEl;
    root.empty();
    root.addClass("nk-root");
    root.toggleClass("nk-touch", isTouch());
    this.applyAppearance(root);
    this.timeline = null;

    const cards = scanCards(this.app, this.config);
    // Apply optimistic moves / reschedules still being written to disk.
    for (const card of cards) {
      const g = this.pendingGroup.get(card.path);
      if (g !== undefined) card.props[this.config.groupBy] = g === UNCATEGORIZED ? "" : g;
      if (this.pendingDue.has(card.path)) card.props[TASK_DUE] = this.pendingDue.get(card.path) ?? "";
    }
    const quests = this.syncQuests();
    this.radiantQuests = new Set(quests.filter((q) => q.radiant).map((q) => q.name));

    this.renderToolbar(root);

    if (this.config.viewMode === "sprint") {
      this.renderSprintView(root, cards);
    } else if (this.config.viewMode === "timeline") {
      this.renderTimelineView(root, cards, quests);
    } else if (this.config.viewMode === "journey") {
      this.renderJourneyView(root, cards, quests);
    } else {
      const board = root.createDiv({ cls: "nk-board" });
      if (this.isQuestMode()) this.renderQuestBoard(board, cards, quests);
      else this.renderStatusBoard(board, cards);
      this.renderAddColumn(board);
      board.scrollLeft = this.boardScroll;
    }
    this.applySearch();
  }

  private renderStatusBoard(board: HTMLElement, cards: Card[]): void {
    const prevColCount = this.config.columns.length;
    const { columns, byColumn, changedOrder } = layoutCards(this.config, cards);
    // Persist any auto-discovered columns so reorder/color/options work on them.
    this.config.columns = columns;
    for (const c of columns) this.ensureGroupOption(c.id);
    if (changedOrder || columns.length !== prevColCount) this.requestSave();

    for (const col of columns.filter((c) => !c.hidden)) {
      this.renderColumn(board, col, byColumn.get(col.id) ?? []);
    }
    // Uncategorized column only when it has cards.
    const uncat = byColumn.get(UNCATEGORIZED) ?? [];
    if (uncat.length) {
      this.renderColumn(board, { id: UNCATEGORIZED, color: "default" }, uncat, true);
    }
  }

  private renderQuestBoard(board: HTMLElement, cards: Card[], quests: Quest[]): void {
    const { byColumn, changedOrder } = layoutQuestCards(
      this.config,
      cards,
      quests.map((q) => q.name)
    );
    if (changedOrder) this.requestSave();
    for (const col of (this.config.questColumns ?? []).filter((c) => !c.hidden)) {
      this.renderColumn(board, col, byColumn.get(col.id) ?? []);
    }
    // "No quest" inbox only when it has cards.
    const inbox = byColumn.get(INBOX) ?? [];
    if (inbox.length) {
      this.renderColumn(board, { id: INBOX, color: "default" }, inbox, true);
    }
  }

  // ---- Sprint ---------------------------------------------------------------

  private renderSprintView(root: HTMLElement, cards: Card[]): void {
    const statusDef = getProperty(this.config, this.config.groupBy);
    const statusOf = (c: Card) => {
      const v = c.props[this.config.groupBy];
      return v === undefined || v === null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v).trim();
    };
    const entity = getProperty(this.config, "Entity");
    renderSprint(root, {
      config: this.config,
      cards,
      offset: this.sprintOffset,
      setOffset: (n) => {
        this.sprintOffset = n;
        this.render();
      },
      statuses: (statusDef?.options ?? []).map((o) => ({ name: o.name, color: o.color })),
      breakdown:
        entity && (entity.type === "select" || entity.type === "multiselect")
          ? { key: entity.name, color: (v) => entity.options?.find((o) => o.name === v)?.color }
          : undefined,
      isDone: (c) => isDone(this.config, c),
      isAbandoned: (c) => isAbandoned(this.config, c),
      isArchived: (c) => isArchived(this.config, c),
      statusText: statusOf,
      isRadiant: (c) => !!c.quest && this.radiantQuests.has(c.quest),
      questColor: (name) => this.config.questColumns?.find((c) => c.id === name)?.color,
      renderProps: (wrap, c) => {
        for (const name of this.config.cardProps) {
          if (name === this.config.groupBy) continue;
          const def = getProperty(this.config, name);
          const value = c.props[name];
          if (!def || value === undefined || value === null || value === "") continue;
          if (Array.isArray(value) && !value.length) continue;
          this.renderCardProp(wrap, def, value);
        }
      },
      openCard: (c) => new CardModal(this.app, this.config, c.file, () => this.commit()).open(),
      cardMenu: (pos, c) => this.buildCardMenu(c, true).showAtPosition(pos),
      setStatus: (c, status) => void this.setTaskStatus(c, status),
      openSettings: () => this.openBoardSettings(),
    });
  }

  /** Change a task's status from the sprint view (repaints at once, then writes). */
  private async setTaskStatus(card: Card, status: string): Promise<void> {
    return this.track("Change status", async (tx) => {
      this.pendingGroup.set(card.path, status || UNCATEGORIZED);
      this.render();
      // The metadata "changed" event repaints with the real value afterwards.
      try {
        await tx.frontmatter(card.file);
        await writeProp(this.app, card.file, this.config.groupBy, status);
      } finally {
        this.pendingGroup.delete(card.path);
      }
    });
  }

  // ---- Journey --------------------------------------------------------------

  private renderJourneyView(root: HTMLElement, cards: Card[], quests: Quest[]): void {
    const { byColumn, changedOrder } = layoutQuestCards(this.config, cards, quests.map((q) => q.name));
    if (changedOrder) this.requestSave();
    const statusDef = getProperty(this.config, this.config.groupBy);
    const statusOf = (c: Card) => {
      const v = c.props[this.config.groupBy];
      return v === undefined || v === null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v);
    };
    const stacked = new Set(this.config.journeyStacked ?? []);
    const byName = new Map(quests.map((q) => [q.name, q]));
    // Archived tasks are put away: not shown here (still on the Board).
    const visible = new Map<string, Card[]>();
    const archived = new Map<string, number>();
    for (const [key, list] of byColumn) {
      const keep = list.filter((c) => !isArchived(this.config, c));
      visible.set(key, keep);
      if (keep.length < list.length) archived.set(key, list.length - keep.length);
    }
    renderJourney(root, {
      config: this.config,
      quests,
      ordered: visible,
      archivedCount: (key) => archived.get(key) ?? 0,
      isStacked: (path) => stacked.has(path),
      goalOf: (name) => this.goalOf(byName.get(name)),
      touch: isTouch(),
      questColor: (name) => this.config.questColumns?.find((c) => c.id === name)?.color,
      statusColor: (c) => statusDef?.options?.find((o) => o.name === statusOf(c))?.color,
      statusText: statusOf,
      isDone: (c) => isDone(this.config, c),
      isAbandoned: (c) => isAbandoned(this.config, c),
      openCard: (c) => new CardModal(this.app, this.config, c.file, () => this.commit()).open(),
      cardMenu: (pos, c) => this.buildCardMenu(c, true).showAtPosition(pos),
      openQuest: (name) => void this.openQuestNote(name),
      questMenu: (pos, name) => this.buildQuestMenu(name, false).showAtPosition(pos),
      move: (path, from, to, index) => void this.journeyMove(path, from, to, index),
      stack: (path, from, to, onto) => void this.journeyStack(path, from, to, onto),
      createdOf: (c) => this.createdOf(c),
      newQuest: () => this.newQuest(),
      refresh: () => this.render(),
      addTask: (key) => void this.addTimelineTask(key, null),
      toggleRow: (key) => {
        const set = new Set(this.config.journeyCollapsed ?? []);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        this.config.journeyCollapsed = [...set];
        this.commit();
      },
      savedScroll: this.jrScroll,
      laneScroll: this.jrLaneScroll,
    });
  }

  /** Goal text for a quest (cached; loads in the background and re-renders). */
  private goalOf(q: Quest | undefined): string {
    const note = q?.note;
    if (!note) return "";
    const hit = this.goals.get(note.path);
    if (hit && hit.mtime === note.stat.mtime) return hit.text;
    if (!this.goalLoads.has(note.path)) {
      this.goalLoads.add(note.path);
      void this.app.vault.cachedRead(note).then((raw) => {
        this.goalLoads.delete(note.path);
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
        const text = extractGoal(raw, fm);
        this.goals.set(note.path, { mtime: note.stat.mtime, text });
        if (text !== (hit?.text ?? "")) this.render();
      });
    }
    return hit?.text ?? "";
  }

  /**
   * Taking `path` out of its journey step: if it heads a branch, the next
   * card in the step becomes the new head. Mutates `stacked`.
   */
  private detachFromStep(path: string, key: string, stacked: Set<string>): void {
    const list = this.config.questCardOrder?.[key] ?? [];
    const i = list.indexOf(path);
    if (i >= 0 && !stacked.has(path) && stacked.has(list[i + 1])) stacked.delete(list[i + 1]);
    stacked.delete(path);
  }

  /** Journey: drop a task onto another card → it joins that step as a branch. */
  private async journeyStack(path: string, fromKey: string, toKey: string, ontoPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.track("Stack as branch", async (tx) => {
      const stacked = new Set(this.config.journeyStacked ?? []);
      const list = (this.config.questCardOrder?.[toKey] ?? []).filter((p) => p !== path);
      let i = list.indexOf(ontoPath);
      if (i < 0) return;
      while (i + 1 < list.length && stacked.has(list[i + 1])) i++; // end of that step
      await this.moveQuestCard(file, fromKey, toKey, i + 1, tx);
      const after = new Set(this.config.journeyStacked ?? []);
      after.add(file.path);
      this.config.journeyStacked = [...after];
      this.commit();
    });
  }

  /** Quest-based move (journey, timeline menus): reorder or move to another quest. */
  private async journeyMove(path: string, fromKey: string, toKey: string, index: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.track(fromKey === toKey ? "Reorder card" : "Move card", (tx) =>
      this.moveQuestCard(file, fromKey, toKey, index, tx)
    );
  }

  // ---- Timeline -------------------------------------------------------------

  private renderTimelineView(root: HTMLElement, cards: Card[], quests: Quest[]): void {
    const statusDef = getProperty(this.config, this.config.groupBy);
    const statusOf = (c: Card) => {
      const v = c.props[this.config.groupBy];
      return v === undefined || v === null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v);
    };
    this.timeline = renderTimeline(root, {
      config: this.config,
      quests,
      cards: cards.filter((c) => !isArchived(this.config, c)), // archived = put away
      questColor: (name) => this.config.questColumns?.find((c) => c.id === name)?.color,
      statusColor: (c) => statusDef?.options?.find((o) => o.name === statusOf(c))?.color,
      statusText: statusOf,
      isDone: (c) => isDone(this.config, c),
      isAbandoned: (c) => isAbandoned(this.config, c),
      openCard: (c) => new CardModal(this.app, this.config, c.file, () => this.commit()).open(),
      openQuest: (name) => void this.openQuestNote(name),
      questMenu: (pos, name) => this.buildQuestMenu(name, false).showAtPosition(pos),
      cardMenu: (pos, c) => this.buildCardMenu(c, true).showAtPosition(pos),
      reschedule: (path, date, toQuest) => void this.rescheduleTask(path, date, toQuest),
      toggleRow: (key) => {
        const set = new Set(this.config.timelineCollapsed ?? []);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        this.config.timelineCollapsed = [...set];
        this.commit();
      },
      addTask: (key, date) => void this.addTimelineTask(key, date),
      refresh: () => this.render(),
      setLabelWidth: (px) => {
        this.config.timelineLabelW = px;
        this.commit();
      },
      savedScroll: this.tlScroll,
    });
  }

  /** Create a task from the timeline and open it, ready to type the title. */
  private async addTimelineTask(key: string, date: string | null): Promise<void> {
    return this.track("New task", async (tx) => {
      const first = getProperty(this.config, this.config.groupBy)?.options?.[0]?.name;
      const file = await createCard(
        this.app,
        this.config,
        first ?? UNCATEGORIZED,
        "Untitled",
        this.questKeyFolder(key),
        { ...this.newTaskProps(key), ...(date ? { [TASK_DUE]: date } : {}) }
      );
      tx.created(file.path);
      (( this.config.questCardOrder ??= {})[key] ??= []).push(file.path);
      this.commit();
      await this.waitForCache(file);
      new CardModal(this.app, this.config, file, () => this.commit(), true, true, () => {
        const order = this.config.questCardOrder ?? {};
        for (const k of Object.keys(order)) order[k] = order[k].filter((p) => p !== file.path);
        this.commit();
      }).open();
    });
  }

  /** Resolve once Obsidian has indexed a fresh note's frontmatter (or after a timeout). */
  private waitForCache(file: TFile, ms = 800): Promise<void> {
    if (this.app.metadataCache.getFileCache(file)?.frontmatter) return Promise.resolve();
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on("changed", (f) => {
        if (f.path === file.path) done();
      });
      const timer = window.setTimeout(() => done(), ms);
      const done = () => {
        window.clearTimeout(timer);
        this.app.metadataCache.offref(ref);
        resolve();
      };
    });
  }

  /**
   * Timeline drop: optionally move the task into another quest folder, then
   * set (date string), clear (null) or keep (undefined) its Due date.
   */
  private async rescheduleTask(
    path: string,
    date: string | null | undefined,
    toQuest: string
  ): Promise<void> {
    return this.track("Reschedule task", async (tx) => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return;
      const fromKey = Object.keys(this.config.questCardOrder ?? {}).find((k) =>
        this.config.questCardOrder?.[k].includes(path)
      );
      if (fromKey && fromKey !== toQuest) {
        const stacked = new Set(this.config.journeyStacked ?? []);
        this.detachFromStep(path, fromKey, stacked);
        this.config.journeyStacked = [...stacked];
      }
      const file = await moveFileToFolder(this.app, f, this.questKeyFolder(toQuest));
      tx.moved(path, file.path);
      if (file.path !== path) {
        const order = (this.config.questCardOrder ??= {});
        for (const k of Object.keys(order)) order[k] = order[k].filter((p) => p !== path);
      }
      if (date === undefined) {
        this.commit();
        return;
      }
      await tx.frontmatter(file);
      this.pendingDue.set(file.path, date);
      this.commit();
      try {
        await writeProp(this.app, file, TASK_DUE, date ?? "");
      } finally {
        this.pendingDue.delete(file.path);
      }
    });
  }

  /** Push the board's appearance config into CSS variables the stylesheet reads. */
  private applyAppearance(root: HTMLElement): void {
    const width = this.config.colWidth ?? COL_WIDTH_DEFAULT;
    const shadow = this.config.colShadow ?? COL_SHADOW_DEFAULT;
    root.style.setProperty("--nk-col-width", `${width}px`);
    root.style.setProperty("--nk-col-shadow", String(shadow / 100));
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "nk-toolbar" });
    bar.createDiv({ cls: "nk-title", text: this.getDisplayText() });

    const view: ViewMode = this.config.viewMode ?? "board";
    this.segmented<ViewMode>(
      bar,
      [["board", "Board"], ["journey", "Journey"], ["timeline", "Timeline"], ["sprint", "Sprint"]],
      view,
      (v) => {
        this.config.viewMode = v;
        this.tlScroll = null; // land on "today" when entering the timeline
        this.commit();
      }
    );
    if (view === "board") {
      const mode: GroupMode = this.config.groupMode ?? "quest";
      this.segmented<GroupMode>(bar, [["quest", "Quests"], ["status", "Status"]], mode, (v) => {
        this.config.groupMode = v;
        this.commit();
      });
    } else if (view === "timeline") {
      const layout: TimelineLayout = this.config.timelineLayout ?? "rows";
      this.segmented<TimelineLayout>(bar, [["rows", "Rows"], ["weeks", "Weeks"]], layout, (v) => {
        this.config.timelineLayout = v;
        this.commit();
      });
      const zoom: TimelineZoom = this.config.timelineZoom ?? "month";
      this.segmented<TimelineZoom>(
        bar,
        [["week", "Week"], ["month", "Month"], ["quarter", "Quarter"]],
        zoom,
        (v) => {
          this.config.timelineZoom = v;
          this.tlScroll = null;
          this.commit();
        }
      );
      const todayBtn = bar.createDiv({ cls: "nk-seg-solo", text: "Today" });
      todayBtn.addEventListener("click", () => this.timeline?.scrollToToday());
    }

    const spacer = bar.createDiv({ cls: "nk-toolbar-spacer" });
    spacer.toggleClass("nk-toolbar-spacer", true);

    const searchWrap = bar.createDiv({ cls: "nk-search" });
    setIcon(searchWrap.createSpan({ cls: "nk-search-icon" }), "search");
    const input = searchWrap.createEl("input", {
      attr: { type: "text", placeholder: "Search" },
    });
    input.value = this.search;
    input.addEventListener("input", () => {
      this.search = input.value;
      this.applySearch();
    });

    // No keyboard on a tablet: give undo/redo their own buttons.
    if (isTouch()) {
      const undoBtn = bar.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Undo" } });
      setIcon(undoBtn, "undo");
      undoBtn.addEventListener("click", () => void undo.undo());
      const redoBtn = bar.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Redo" } });
      setIcon(redoBtn, "redo");
      redoBtn.addEventListener("click", () => void undo.redo());
    }

    const settingsBtn = bar.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Board settings" } });
    setIcon(settingsBtn, "sliders-horizontal");
    settingsBtn.addEventListener("click", () => this.openBoardSettings());
  }

  private openBoardSettings(): void {
    // The settings modal edits config live; record it as one undo step on close.
    const before = serializeBoard(this.config);
    const modal = new BoardSettingsModal(this.app, this.config, () => this.commit());
    const close = modal.onClose.bind(modal);
    modal.onClose = () => {
      close();
      if (this.file && serializeBoard(this.config) !== before) {
        undo.pushConfig("Board settings", this.file.path, before);
      }
    };
    modal.open();
  }

  /** A small pill-style toggle group (Board | Timeline, Quests | Status...). */
  private segmented<T extends string>(
    parent: HTMLElement,
    options: [T, string][],
    current: T,
    onPick: (value: T) => void
  ): void {
    const wrap = parent.createDiv({ cls: "nk-seg" });
    for (const [value, label] of options) {
      const btn = wrap.createDiv({ cls: "nk-seg-btn", text: label });
      btn.toggleClass("is-active", value === current);
      btn.addEventListener("click", () => {
        if (value !== current) onPick(value);
      });
    }
  }

  private applySearch(): void {
    const q = this.search.trim().toLowerCase();
    this.contentEl.findAll(".nk-card, .nk-tl-card, .nk-tl-chip, .nk-tl-taskrow").forEach((el) => {
      const text = (el.getAttr("data-search") ?? "").toLowerCase();
      el.toggleClass("nk-hidden", q.length > 0 && !text.includes(q));
    });
    // hide empty columns' counts stay; nothing else needed
  }

  private renderColumn(
    board: HTMLElement,
    col: ColumnDef,
    cards: Card[],
    uncategorized = false
  ): void {
    if (col.collapsed) {
      this.renderCollapsedColumn(board, col, cards, uncategorized);
      return;
    }

    const colEl = board.createDiv({ cls: "nk-column" });
    colEl.setAttr("data-col", col.id);

    // --- header ---
    const header = colEl.createDiv({ cls: "nk-col-header" });
    header.setAttr("draggable", uncategorized ? "false" : "true");

    const titleWrap = header.createDiv({ cls: "nk-col-title" });
    const pill = titleWrap.createSpan({ cls: "nk-col-pill" });
    applyColor(pill, col.color);
    pill.setText(uncategorized ? this.uncategorizedLabel() : col.id || "Untitled");
    if (this.isQuestMode() && this.radiantQuests.has(col.id)) {
      titleWrap.createSpan({
        cls: "nk-col-radiant",
        text: "∞",
        attr: { "aria-label": "Radiant quest (endless)" },
      });
    }
    titleWrap.createSpan({ cls: "nk-col-count", text: String(cards.length) });

    const actions = header.createDiv({ cls: "nk-col-actions" });
    const addTop = actions.createDiv({ cls: "nk-icon-btn nk-sm", attr: { "aria-label": "New card" } });
    setIcon(addTop, "plus");
    addTop.addEventListener("click", () => this.addCard(col.id));

    if (!uncategorized) {
      const menuBtn = actions.createDiv({ cls: "nk-icon-btn nk-sm", attr: { "aria-label": "More" } });
      setIcon(menuBtn, "more-horizontal");
      menuBtn.addEventListener("click", (e) => this.columnMenu({ x: e.clientX, y: e.clientY }, col));
      onHold(header, { menu: (p) => this.columnMenu(p, col), drag: true });
    }

    // column drag (reorder groups)
    if (!uncategorized) {
      header.addEventListener("dragstart", (e) => {
        this.colDrag = col.id;
        colEl.addClass("nk-col-dragging");
        e.dataTransfer?.setData("text/col", col.id);
      });
      header.addEventListener("dragend", () => {
        this.colDrag = null;
        colEl.removeClass("nk-col-dragging");
      });
      colEl.addEventListener("dragover", (e) => {
        if (this.colDrag && this.colDrag !== col.id) {
          e.preventDefault();
          colEl.addClass("nk-col-drop");
        }
      });
      colEl.addEventListener("dragleave", () => colEl.removeClass("nk-col-drop"));
      colEl.addEventListener("drop", (e) => {
        if (this.colDrag && this.colDrag !== col.id) {
          e.preventDefault();
          colEl.removeClass("nk-col-drop");
          this.moveColumn(this.colDrag, col.id);
        }
      });
    }

    // --- cards container ---
    const list = colEl.createDiv({ cls: "nk-col-cards" });
    list.setAttr("data-col", col.id);
    for (const card of cards) this.renderCard(list, card, col);

    this.wireCardDrop(list, col.id);

    // --- footer ---
    const footer = colEl.createDiv({ cls: "nk-col-footer" });
    setIcon(footer.createSpan({ cls: "nk-footer-icon" }), "plus");
    footer.createSpan({ text: " New" });
    footer.addEventListener("click", () => this.addCard(col.id));
  }

  private uncategorizedLabel(): string {
    return this.isQuestMode() ? "No quest" : `No ${this.config.groupBy}`;
  }

  private renderCollapsedColumn(
    board: HTMLElement,
    col: ColumnDef,
    cards: Card[],
    uncategorized: boolean
  ): void {
    const colEl = board.createDiv({ cls: "nk-column nk-collapsed" });
    const header = colEl.createDiv({ cls: "nk-col-header-collapsed" });
    const expand = header.createDiv({ cls: "nk-icon-btn nk-sm" });
    setIcon(expand, "chevron-right");
    expand.addEventListener("click", () => this.toggleCollapse(col.id));
    const label = header.createSpan({ cls: "nk-col-pill" });
    applyColor(label, col.color);
    label.setText(uncategorized ? this.uncategorizedLabel() : col.id || "Untitled");
    header.createSpan({ cls: "nk-col-count", text: String(cards.length) });
  }

  private renderCard(list: HTMLElement, card: Card, col: ColumnDef): void {
    const el = list.createDiv({ cls: "nk-card" });
    el.setAttr("draggable", "true");
    el.setAttr("data-path", card.path);

    const searchText = [card.title, ...this.cardSearchValues(card)].join(" ");
    el.setAttr("data-search", searchText);

    const titleEl = el.createDiv({ cls: "nk-card-title" });
    const explicitIcon = typeof card.props.icon === "string" ? card.props.icon.trim() : "";
    const icon =
      explicitIcon ||
      (this.config.randomIcons !== false ? randomIconFor(card.path) : "");
    if (icon) {
      titleEl.createSpan({ cls: "nk-card-icon", text: icon });
      el.addClass("has-icon");
    }
    titleEl.createSpan({ cls: "nk-card-title-text", text: card.title });

    // Hover ⋯ menu button (top-right).
    const menuBtn = el.createDiv({
      cls: "nk-card-menu-btn",
      attr: { "aria-label": "Card actions" },
    });
    setIcon(menuBtn, "more-horizontal");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.buildCardMenu(card).showAtMouseEvent(e);
    });

    const propsWrap = el.createDiv({ cls: "nk-card-props" });
    if (this.isQuestMode()) {
      // Columns are quests, so surface the status on the card itself.
      const sdef = getProperty(this.config, this.config.groupBy);
      const sv = card.props[this.config.groupBy];
      if (sdef && sv !== undefined && sv !== null && sv !== "") this.renderCardProp(propsWrap, sdef, sv);
    } else if (card.quest) {
      const q = propsWrap.createSpan({ cls: "nk-card-quest" });
      setIcon(q.createSpan({ cls: "nk-prop-icon" }), "flag");
      q.createSpan({ text: card.quest });
    }
    for (const name of this.config.cardProps) {
      if (this.isQuestMode() && name === this.config.groupBy) continue;
      const def = getProperty(this.config, name);
      if (!def) continue;
      const value = card.props[name];
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      this.renderCardProp(propsWrap, def, value);
    }
    if (!propsWrap.childElementCount) propsWrap.remove();

    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".nk-card-prop-interactive")) return;
      new CardModal(this.app, this.config, card.file, () => this.commit()).open();
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.buildCardMenu(card).showAtMouseEvent(e);
    });
    onHold(el, { menu: (p) => this.buildCardMenu(card).showAtPosition(p), drag: true });

    el.addEventListener("dragstart", (e) => {
      this.drag = { path: card.path, fromCol: col.id };
      el.addClass("nk-card-dragging");
      e.dataTransfer?.setData("text/card", card.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      this.drag = null;
      el.removeClass("nk-card-dragging");
      this.contentEl.findAll(".nk-drop-indicator").forEach((n) => n.remove());
    });
  }

  private cardSearchValues(card: Card): string[] {
    const out: string[] = [];
    for (const [, v] of Object.entries(card.props)) {
      if (Array.isArray(v)) out.push(...v.map(String));
      else if (v !== null && v !== undefined) out.push(String(v));
    }
    return out;
  }

  private renderCardProp(
    wrap: HTMLElement,
    def: PropertyDef,
    value: unknown
  ): void {
    switch (def.type) {
      case "select": {
        const opt = def.options?.find((o) => o.name === String(value));
        const chip = wrap.createSpan({ cls: "nk-chip" });
        applyColor(chip, opt?.color);
        chip.setText(String(value));
        break;
      }
      case "multiselect": {
        const arr = Array.isArray(value) ? value : [value];
        for (const v of arr) {
          const opt = def.options?.find((o) => o.name === String(v));
          const chip = wrap.createSpan({ cls: "nk-chip" });
          applyColor(chip, opt?.color);
          chip.setText(String(v));
        }
        break;
      }
      case "date": {
        const d = wrap.createSpan({ cls: "nk-prop-date" });
        setIcon(d.createSpan({ cls: "nk-prop-icon" }), "calendar");
        const parsed = parseDate(value);
        d.createSpan({ text: parsed ? formatDMY(parsed) : String(value) });
        break;
      }
      case "checkbox": {
        const c = wrap.createSpan({ cls: "nk-prop-check" });
        setIcon(c, value ? "check-square" : "square");
        break;
      }
      case "number": {
        wrap.createSpan({ cls: "nk-prop-num", text: String(value) });
        break;
      }
      default:
        wrap.createSpan({ cls: "nk-prop-text", text: String(value) });
    }
  }

  private renderAddColumn(board: HTMLElement): void {
    const quest = this.isQuestMode();
    const text = quest ? "Add a quest" : "Add a group";
    const add = board.createDiv({ cls: "nk-add-column" });
    const btn = add.createDiv({ cls: "nk-add-column-btn", attr: { "aria-label": text } });
    setIcon(btn.createSpan({ cls: "nk-footer-icon" }), "plus");
    btn.createSpan({ text: ` ${text}` });
    btn.addEventListener("click", () => {
      if (quest) {
        this.newQuest();
        return;
      }
      new NewGroupModal(this.app, (name, color) => {
        if (this.config.columns.some((c) => c.id === name)) {
          new Notice("A group with that name already exists.");
          return;
        }
        void this.track("New group", async () => {
          this.config.columns.push({ id: name, color });
          this.ensureGroupOption(name);
          this.commit();
        });
      }).open();
    });
  }

  // ---- Drag & drop for cards -------------------------------------------

  private wireCardDrop(list: HTMLElement, colId: string): void {
    list.addEventListener("dragover", (e) => {
      const external = !this.drag && this.externalMdFiles().length > 0;
      if (!this.drag && !external) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      list.addClass("nk-col-dropzone");
      this.showIndicator(list, e.clientY);
    });
    list.addEventListener("dragleave", (e) => {
      if (!list.contains(e.relatedTarget as Node)) {
        list.removeClass("nk-col-dropzone");
        list.findAll(".nk-drop-indicator").forEach((n) => n.remove());
      }
    });
    list.addEventListener("drop", (e) => {
      const index = this.indicatorIndex(list);
      list.removeClass("nk-col-dropzone");
      this.contentEl.findAll(".nk-drop-indicator").forEach((n) => n.remove());
      if (this.drag) {
        e.preventDefault();
        this.moveCard(this.drag.path, this.drag.fromCol, colId, index);
        return;
      }
      const files = this.externalMdFiles();
      if (files.length) {
        e.preventDefault();
        this.importNotes(files, colId, index);
      }
    });
  }

  /** Notes currently being dragged from Obsidian's file explorer (md only). */
  private externalMdFiles(): TFile[] {
    const dm = (this.app as unknown as { dragManager?: { draggable?: unknown } })
      .dragManager;
    const d = dm?.draggable as
      | { file?: unknown; files?: unknown[] }
      | undefined;
    if (!d) return [];
    const out: TFile[] = [];
    if (d.file instanceof TFile) out.push(d.file);
    if (Array.isArray(d.files)) {
      for (const f of d.files) if (f instanceof TFile) out.push(f);
    }
    return out.filter((f) => f.extension === "md");
  }

  /** Bring existing notes into the board as cards in the given column. */
  private async importNotes(
    files: TFile[],
    toCol: string,
    index: number
  ): Promise<void> {
    return this.track("Add notes to board", async (tx) => {
      if (this.isQuestMode()) {
        const order = (this.config.questCardOrder ??= {});
        let at = index;
        for (const file of files) {
          if (file.extension !== "md") continue;
          const from = file.path;
          const moved = await moveFileToFolder(this.app, file, this.questKeyFolder(toCol));
          tx.moved(from, moved.path);
          for (const k of Object.keys(order)) order[k] = order[k].filter((p) => p !== moved.path && p !== file.path);
          const list = order[toCol] ?? [];
          list.splice(Math.max(0, Math.min(at, list.length)), 0, moved.path);
          order[toCol] = list;
          at++;
        }
        new Notice(
          files.length === 1
            ? `Added "${files[0].basename}" to the board.`
            : `Added ${files.length} notes to the board.`
        );
        this.commit();
        return;
      }
      const folder = this.config.folder || "";
      let insertAt = index;
      for (const file of files) {
        // Skip the board file itself and non-md (defensive).
        if (file.extension !== "md") continue;
        const from = file.path;
        const moved = await this.moveIntoFolder(file, folder);
        tx.moved(from, moved.path);
        await tx.frontmatter(moved);
        await setCardGroup(this.app, this.config, moved, toCol);
        if (toCol !== UNCATEGORIZED) this.ensureGroupOption(toCol);
        const order = this.config.cardOrder[toCol] ?? [];
        // de-dupe in case it already existed in some column
        for (const k of Object.keys(this.config.cardOrder)) {
          this.config.cardOrder[k] = (this.config.cardOrder[k] || []).filter(
            (p) => p !== moved.path
          );
        }
        order.splice(Math.max(0, Math.min(insertAt, order.length)), 0, moved.path);
        this.config.cardOrder[toCol] = order;
        insertAt++;
      }
      new Notice(
        files.length === 1
          ? `Added "${files[0].basename}" to the board.`
          : `Added ${files.length} notes to the board.`
      );
      this.commit();
    });
  }

  /** Move a note into the board folder (no-op if already there). Returns the file. */
  private async moveIntoFolder(file: TFile, folder: string): Promise<TFile> {
    const parentPath =
      file.parent && file.parent.path !== "/" ? file.parent.path : "";
    if (parentPath === folder) return file;

    if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
      await this.app.vault.createFolder(normalizePath(folder)).catch(() => {});
    }
    const base = file.basename;
    let target = normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
    let i = 2;
    while (
      this.app.vault.getAbstractFileByPath(target) &&
      target !== file.path
    ) {
      target = normalizePath(
        folder ? `${folder}/${base} ${i}.md` : `${base} ${i}.md`
      );
      i++;
    }
    await this.app.fileManager.renameFile(file, target);
    const after = this.app.vault.getAbstractFileByPath(target);
    return after instanceof TFile ? after : file;
  }

  private showIndicator(list: HTMLElement, y: number): void {
    const after = this.getDragAfterElement(list, y);
    const existing = list.querySelector<HTMLElement>(".nk-drop-indicator");
    // Already in the right slot? Leave it put so the layout doesn't jitter.
    if (existing && existing.nextElementSibling === (after ?? null)) return;
    if (existing) existing.remove();
    const indicator = createDiv({ cls: "nk-drop-indicator" });
    if (after) list.insertBefore(indicator, after);
    else list.appendChild(indicator);
  }

  private getDragAfterElement(list: HTMLElement, y: number): HTMLElement | null {
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>(".nk-card:not(.nk-card-dragging)")
    );
    let closest: { offset: number; el: HTMLElement | null } = {
      offset: Number.NEGATIVE_INFINITY,
      el: null,
    };
    for (const child of cards) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset, el: child };
      }
    }
    return closest.el;
  }

  private indicatorIndex(list: HTMLElement): number {
    const children = Array.from(list.children);
    const idx = children.findIndex((c) => c.hasClass("nk-drop-indicator"));
    if (idx < 0) return (this.config.cardOrder[list.getAttr("data-col") || ""] || []).length;
    // Count real cards before the indicator, excluding the one being dragged
    // (it's removed from the order array before we insert at this index).
    let count = 0;
    for (let i = 0; i < idx; i++) {
      const c = children[i] as HTMLElement;
      if (c.hasClass("nk-card") && !c.hasClass("nk-card-dragging")) count++;
    }
    return count;
  }

  private async moveCard(
    path: string,
    fromCol: string,
    toCol: string,
    index: number
  ): Promise<void> {
    return this.track(fromCol === toCol ? "Reorder card" : "Move card", async (tx) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      if (this.isQuestMode()) {
        await this.moveQuestCard(file, fromCol, toCol, index, tx);
        return;
      }

      // Remove from every column order (defensive), then insert into target.
      for (const key of Object.keys(this.config.cardOrder)) {
        this.config.cardOrder[key] = (this.config.cardOrder[key] || []).filter(
          (p) => p !== path
        );
      }
      const target = this.config.cardOrder[toCol] ?? [];
      const clamped = Math.max(0, Math.min(index, target.length));
      target.splice(clamped, 0, path);
      this.config.cardOrder[toCol] = target;

      const crossColumn = fromCol !== toCol;
      if (crossColumn) {
        // Optimistic: mark the new group so the repaint below places the card
        // in the target column immediately, without waiting on the disk write.
        this.pendingGroup.set(path, toCol);
        if (toCol !== UNCATEGORIZED) this.ensureGroupOption(toCol);
      }

      // Repaint + persist the board JSON now — the card moves with no lag.
      this.commit();

      // Write the card's group frontmatter in the background.
      if (crossColumn) {
        try {
          await tx.frontmatter(file);
          await setCardGroup(this.app, this.config, file, toCol);
        } finally {
          this.pendingGroup.delete(path);
        }
      }
    });
  }

  /** Quest mode: reorder within a quest, or move the note into another quest folder. */
  private async moveQuestCard(
    file: TFile,
    fromCol: string,
    toCol: string,
    index: number,
    tx: Tx
  ): Promise<void> {
    const order = (this.config.questCardOrder ??= {});
    const oldPath = file.path;
    // A moved card becomes its own journey step (the stack action re-adds it).
    const stacked = new Set(this.config.journeyStacked ?? []);
    this.detachFromStep(oldPath, fromCol, stacked);
    this.config.journeyStacked = [...stacked];
    for (const k of Object.keys(order)) order[k] = order[k].filter((p) => p !== oldPath);
    const moved =
      fromCol === toCol ? file : await moveFileToFolder(this.app, file, this.questKeyFolder(toCol));
    tx.moved(oldPath, moved.path);
    const list = order[toCol] ?? [];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, moved.path);
    order[toCol] = list;
    this.commit();
  }

  private async moveColumn(fromId: string, toId: string): Promise<void> {
    return this.track("Reorder groups", async () => {
      const cols = this.activeColumns();
      const from = cols.findIndex((c) => c.id === fromId);
      const to = cols.findIndex((c) => c.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = cols.splice(from, 1);
      cols.splice(to, 0, moved);
      this.commit();
    });
  }

  // ---- Actions ----------------------------------------------------------

  private async addCard(colId: string): Promise<void> {
    return this.track("New card", async (tx) => {
      const quest = this.isQuestMode();
      let file: TFile;
      if (quest) {
        // New task lands in the quest's folder, starting at the first status.
        const first = getProperty(this.config, this.config.groupBy)?.options?.[0]?.name;
        file = await createCard(
          this.app,
          this.config,
          first ?? UNCATEGORIZED,
          "Untitled",
          this.questKeyFolder(colId),
          this.newTaskProps(colId)
        );
        const order = (this.config.questCardOrder ??= {});
        (order[colId] ??= []).push(file.path);
      } else {
        file = await createCard(this.app, this.config, colId, "Untitled");
        (this.config.cardOrder[colId] ??= []).push(file.path);
        if (colId !== UNCATEGORIZED) this.ensureGroupOption(colId);
      }
      tx.created(file.path);
      this.commit();
      if (this.config.openNewCardAsNote) {
        this.app.workspace.getLeaf("tab").openFile(file);
      } else {
        // Open straight into the edit modal with the title ready to type.
        // isNew=true: if closed untouched, the card is discarded (see onDiscard).
        new CardModal(
          this.app,
          this.config,
          file,
          () => this.commit(),
          true,
          true,
          () => {
            const path = file.path;
            for (const map of [this.config.cardOrder, this.config.questCardOrder ?? {}]) {
              for (const key of Object.keys(map)) map[key] = (map[key] || []).filter((p) => p !== path);
            }
            this.commit();
          }
        ).open();
      }
    });
  }

  private columnMenu(pos: { x: number; y: number }, col: ColumnDef): void {
    if (this.isQuestMode()) {
      this.buildQuestMenu(col.id, true).showAtPosition(pos);
      return;
    }
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(async () => {
          const name = await promptText(this.app, "Rename group", "Group name", col.id);
          if (name && name !== col.id) await this.renameColumn(col, name);
        })
    );
    menu.addItem((i) =>
      i
        .setTitle(col.collapsed ? "Expand" : "Collapse")
        .setIcon(col.collapsed ? "chevron-down" : "chevron-right")
        .onClick(() => this.toggleCollapse(col.id))
    );
    menu.addItem((i) =>
      i.setTitle("Hide").setIcon("eye-off").onClick(() => {
        void this.track("Hide group", async () => {
          col.hidden = true;
          this.commit();
        });
      })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Color…")
        .setIcon("palette")
        .onClick(() => {
          new GroupColorModal(this.app, col.color, (c) =>
            this.setColumnColor(col, c)
          ).open();
        })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Delete group")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => this.deleteColumn(col))
    );
    menu.showAtPosition(pos);
  }

  /** Menu for a quest (board column header, or timeline row label). */
  private buildQuestMenu(name: string, onBoard: boolean): Menu {
    const menu = new Menu();
    const col = this.config.questColumns?.find((c) => c.id === name);
    menu.addItem((i) =>
      i.setTitle("Open quest note").setIcon("file-text").onClick(() => void this.openQuestNote(name))
    );
    const radiant = this.radiantQuests.has(name);
    if (!radiant) {
      menu.addItem((i) =>
        i.setTitle("Set start date…").setIcon("calendar").onClick(() => void this.setQuestDate(name, QUEST_START))
      );
      menu.addItem((i) =>
        i.setTitle("Set target date…").setIcon("flag").onClick(() => void this.setQuestDate(name, QUEST_TARGET))
      );
    }
    menu.addItem((i) =>
      i
        .setTitle(radiant ? "Make definite (has an end)" : "Make radiant (endless)")
        .setIcon(radiant ? "flag" : "infinity")
        .onClick(() => void this.setQuestRadiant(name, !radiant))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Rename quest").setIcon("pencil").onClick(async () => {
        const next = await promptText(this.app, "Rename quest", "Quest name", name);
        if (next && next !== name) await this.renameQuestCol(name, next);
      })
    );
    if (onBoard && col) {
      menu.addItem((i) =>
        i
          .setTitle(col.collapsed ? "Expand" : "Collapse")
          .setIcon(col.collapsed ? "chevron-down" : "chevron-right")
          .onClick(() => this.toggleCollapse(col.id))
      );
      menu.addItem((i) =>
        i.setTitle("Hide").setIcon("eye-off").onClick(() => {
          void this.track("Hide group", async () => {
            col.hidden = true;
            this.commit();
          });
        })
      );
    }
    if (col) {
      menu.addItem((i) =>
        i.setTitle("Color…").setIcon("palette").onClick(() => {
          new GroupColorModal(this.app, col.color, (c) => this.setColumnColor(col, c)).open();
        })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Delete quest").setIcon("trash").setWarning(true).onClick(() => void this.deleteQuestCol(name))
    );
    return menu;
  }

  /** New quest dialog (name, definite / radiant, color) — Board and Journey. */
  private newQuest(): void {
    new NewQuestModal(this.app, async (name, color, radiant) => {
      try {
        await this.track("New quest", async (tx) => {
          const clean = await createQuest(this.app, this.config, name, tx, radiant);
          const cols = (this.config.questColumns ??= []);
          const existing = cols.find((c) => c.id === clean);
          if (existing) existing.color = color; // a refresh may have synced it first
          else cols.push({ id: clean, color });
          this.commit();
        });
      } catch (e) {
        new Notice((e as Error).message);
      }
    }, (this.config.questColumns ?? []).map((c) => c.color)).open();
  }

  /** Switch a quest between definite (has an end) and radiant (endless). */
  private async setQuestRadiant(name: string, radiant: boolean): Promise<void> {
    const q = this.findQuest(name);
    if (!q) return;
    await this.track(radiant ? "Make quest radiant" : "Make quest definite", async (tx) => {
      const note = await ensureQuestNote(this.app, q, tx);
      await tx.frontmatter(note);
      await writeProp(this.app, note, QUEST_TYPE, radiant ? "radiant" : "");
    });
  }

  /** Extra frontmatter for a new task: radiant quests stamp when it was logged. */
  private newTaskProps(key: string): Record<string, unknown> {
    return key !== INBOX && this.radiantQuests.has(key)
      ? { [TASK_CREATED]: toISODateTime(new Date()) }
      : {};
  }

  /** When a task was logged: its Created stamp, else the file's creation time. */
  private createdOf(c: Card): number {
    return parseDateTime(c.props[TASK_CREATED])?.getTime() ?? c.file.stat.ctime;
  }

  private findQuest(name: string): Quest | undefined {
    return listQuests(this.app, this.config).find((q) => q.name === name);
  }

  private async openQuestNote(name: string): Promise<void> {
    const q = this.findQuest(name);
    if (!q) return;
    const note = await ensureQuestNote(this.app, q);
    this.app.workspace.getLeaf("tab").openFile(note);
  }

  private async setQuestDate(name: string, key: string): Promise<void> {
    return this.track("Set quest date", async (tx) => {
      const q = this.findQuest(name);
      if (!q) return;
      const current = parseDate(q.props[key]);
      const label = key === QUEST_START ? "Start date" : "Target date";
      const value = await promptDate(this.app, `${label} · ${name}`, current ? toISO(current) : "");
      if (value === null) return;
      const note = await ensureQuestNote(this.app, q, tx);
      await tx.frontmatter(note);
      await writeProp(this.app, note, key, value);
      // metadataCache "changed" re-renders once the frontmatter is indexed.
    });
  }

  private async renameQuestCol(oldName: string, newName: string): Promise<void> {
    return this.track("Rename quest", async (tx) => {
      try {
        const clean = await renameQuest(this.app, this.config, oldName, newName, tx);
        // Usually already done by onFolderRenamed; safe to repeat.
        renameQuestKey(this.config, oldName, clean);
        this.commit();
      } catch (e) {
        new Notice((e as Error).message);
      }
    });
  }

  private async deleteQuestCol(name: string): Promise<void> {
    return this.track("Delete quest", async (tx) => {
      const count = scanCards(this.app, this.config).filter((c) => c.quest === name).length;
      const ok = await confirmDialog(
        this.app,
        "Delete quest",
        count
          ? `Delete quest "${name}"? Its ${count} task(s) move to "No quest" (notes are kept). The quest note goes to the trash.`
          : `Delete quest "${name}"? The quest note goes to the trash.`
      );
      if (!ok) return;
      await deleteQuest(this.app, this.config, name, tx);
      this.config.questColumns = (this.config.questColumns ?? []).filter((c) => c.id !== name);
      if (this.config.questCardOrder) delete this.config.questCardOrder[name];
      this.commit();
    });
  }

  /** `quest`: offer quest moves (journey/timeline) instead of status moves. */
  private buildCardMenu(card: Card, quest = this.isQuestMode()): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Open as note")
        .setIcon("file-text")
        .onClick(() => this.app.workspace.getLeaf("tab").openFile(card.file))
    );
    menu.addItem((i) =>
      i
        .setTitle("Edit properties")
        .setIcon("sliders-horizontal")
        .onClick(() =>
          new CardModal(this.app, this.config, card.file, () => this.commit()).open()
        )
    );
    menu.addItem((i) =>
      i
        .setTitle(typeof card.props.icon === "string" && card.props.icon ? "Change icon" : "Add icon")
        .setIcon("smile")
        .onClick(() => {
          const cur = typeof card.props.icon === "string" ? card.props.icon : "";
          new EmojiPickerModal(this.app, cur, async (emoji) => {
            await this.track("Change icon", async (tx) => {
              await tx.frontmatter(card.file);
              await writeProp(this.app, card.file, "icon", emoji);
            });
            this.render();
          }).open();
        })
    );
    menu.addItem((i) =>
      i
        .setTitle("Duplicate")
        .setIcon("copy")
        .onClick(() => this.duplicateCard(card))
    );
    menu.addItem((i) =>
      i
        .setTitle("Copy link")
        .setIcon("link")
        .onClick(async () => {
          const link = this.app.fileManager.generateMarkdownLink(card.file, "");
          await navigator.clipboard.writeText(link);
          new Notice("Link copied.");
        })
    );
    addExportMenu(menu, this.app, card.file);

    // Journey branches: share a step with the previous task, or split off.
    if (quest) {
      const key = card.quest ?? INBOX;
      const list = this.config.questCardOrder?.[key] ?? [];
      const stacked = new Set(this.config.journeyStacked ?? []);
      if (stacked.has(card.path)) {
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Unstack (own step)").setIcon("git-branch").onClick(() => {
            void this.track("Unstack", async () => {
              stacked.delete(card.path);
              this.config.journeyStacked = [...stacked];
              this.commit();
            });
          })
        );
      } else if (list.indexOf(card.path) > 0) {
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle("Stack with previous step").setIcon("git-merge").onClick(() => {
            void this.track("Stack as branch", async () => {
              stacked.add(card.path);
              this.config.journeyStacked = [...stacked];
              this.commit();
            });
          })
        );
      }
    }

    // Move to another group (quest or status).
    const current = quest ? card.quest ?? INBOX : cardGroup(this.config, card);
    const ids = quest
      ? [...(this.config.questColumns ?? []).map((c) => c.id), INBOX]
      : this.config.columns.map((c) => c.id);
    const targets = ids.filter((id) => id !== current);
    if (targets.length) {
      menu.addSeparator();
      for (const t of targets) {
        menu.addItem((i) =>
          i
            .setTitle(t === INBOX ? `Move to "No quest"` : `Move to "${t}"`)
            .setIcon("corner-up-right")
            .onClick(() => this.moveCardToColumn(card, t, quest))
        );
      }
    }

    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Delete card")
        .setIcon("trash")
        .setWarning(true)
        .onClick(async () => {
          await this.track("Delete card", async (tx) => {
            await tx.deleted(card.file);
            await this.app.fileManager.trashFile(card.file);
          });
          new Notice(`Moved "${card.title}" to trash. Ctrl+Z to undo.`);
          this.render();
        })
    );
    return menu;
  }

  private async moveCardToColumn(card: Card, toCol: string, quest = this.isQuestMode()): Promise<void> {
    if (quest) {
      const end = (this.config.questCardOrder?.[toCol] ?? []).length;
      await this.journeyMove(card.path, card.quest ?? INBOX, toCol, end);
      return;
    }
    const target = this.config.cardOrder[toCol] ?? [];
    await this.moveCard(card.path, cardGroup(this.config, card), toCol, target.length);
  }

  private async duplicateCard(card: Card): Promise<void> {
    return this.track("Duplicate card", async (tx) => {
      const content = await this.app.vault.read(card.file);
      const parent = card.file.parent;
      const dir = parent && parent.path !== "/" ? parent.path + "/" : "";
      const base = `${card.file.basename} copy`;
      let target = normalizePath(`${dir}${base}.md`);
      let i = 2;
      while (this.app.vault.getAbstractFileByPath(target)) {
        target = normalizePath(`${dir}${base} ${i}.md`);
        i++;
      }
      const newFile = await this.app.vault.create(target, content);
      tx.created(newFile.path);
      // Insert right after the original in its column.
      const quest = this.isQuestMode();
      const col = quest ? card.quest ?? INBOX : cardGroup(this.config, card);
      const map = quest ? (this.config.questCardOrder ??= {}) : this.config.cardOrder;
      const order = map[col] ?? [];
      const idx = order.indexOf(card.path);
      order.splice(idx >= 0 ? idx + 1 : order.length, 0, newFile.path);
      map[col] = order;
      this.commit();
      new Notice(`Duplicated "${card.title}".`);
    });
  }

  private setColumnColor(col: ColumnDef, color: string): void {
    void this.track("Change color", async () => {
      col.color = color;
      if (!this.isQuestMode()) {
        // keep the matching group-by option color in sync so card chips match
        const def = getProperty(this.config, this.config.groupBy);
        const opt = def?.options?.find((o) => o.name === col.id);
        if (opt) opt.color = color;
      }
      this.commit();
    }, `color:${col.id}`);
  }

  private toggleCollapse(colId: string): void {
    const col = this.activeColumns().find((c) => c.id === colId);
    if (!col) return;
    col.collapsed = !col.collapsed;
    this.commit();
  }

  private async renameColumn(col: ColumnDef, newName: string): Promise<void> {
    return this.track("Rename group", async (tx) => {
      if (this.config.columns.some((c) => c.id === newName)) {
        new Notice("A group with that name already exists.");
        return;
      }
      const oldId = col.id;
      // Re-point every card in this group to the new value.
      const cards = scanCards(this.app, this.config).filter(
        (c) => cardGroup(this.config, c) === oldId
      );
      for (const c of cards) {
        await tx.frontmatter(c.file);
        await setCardGroup(this.app, this.config, c.file, newName);
      }
      // Update option name in the group-by property schema.
      const def = getProperty(this.config, this.config.groupBy);
      const opt = def?.options?.find((o) => o.name === oldId);
      if (opt) opt.name = newName;
      // Migrate order + column id.
      this.config.cardOrder[newName] = this.config.cardOrder[oldId] ?? [];
      delete this.config.cardOrder[oldId];
      col.id = newName;
      this.commit();
    });
  }

  private async deleteColumn(col: ColumnDef): Promise<void> {
    return this.track("Delete group", async (tx) => {
      const cards = scanCards(this.app, this.config).filter(
        (c) => cardGroup(this.config, c) === col.id
      );
      if (cards.length) {
        const ok = await confirmDialog(
          this.app,
          "Delete group",
          `Delete group "${col.id}"? Its ${cards.length} card(s) will move to "No ${this.config.groupBy}" (notes are kept).`
        );
        if (!ok) return;
        for (const c of cards) {
          await tx.frontmatter(c.file);
          await setCardGroup(this.app, this.config, c.file, UNCATEGORIZED);
        }
      }
      this.config.columns = this.config.columns.filter((c) => c.id !== col.id);
      delete this.config.cardOrder[col.id];
      const def = getProperty(this.config, this.config.groupBy);
      if (def?.options) def.options = def.options.filter((o) => o.name !== col.id);
      this.commit();
    });
  }

  /** Ensure the group-by select property has an option for this value. */
  private ensureGroupOption(value: string): void {
    const def = getProperty(this.config, this.config.groupBy);
    if (!def) return;
    if (def.type !== "select" && def.type !== "multiselect") return;
    if (!def.options) def.options = [];
    if (!def.options.some((o) => o.name === value)) {
      const col = this.config.columns.find((c) => c.id === value);
      def.options.push({ name: value, color: col?.color ?? autoColor(value) });
    }
  }
}
