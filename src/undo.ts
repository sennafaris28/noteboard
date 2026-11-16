import { App, Notice, TFile, TFolder, normalizePath, parseYaml } from "obsidian";

/**
 * One reversible change. Each step records what happened, so it knows how to
 * put things back. Applying a step's inverse records the opposite step,
 * which is how redo works.
 */
type Step =
  | { kind: "config"; board: string; json: string } // board config before
  | { kind: "fm"; path: string; fm: Record<string, unknown> } // frontmatter before
  | { kind: "move"; from: string; to: string } // file/folder moved from → to
  | { kind: "create"; path: string } // note created
  | { kind: "delete"; path: string; content: string } // note deleted
  | { kind: "mkdir"; path: string } // folder created
  | { kind: "rmdir"; path: string }; // folder removed

interface Entry {
  label: string;
  steps: Step[];
  mergeKey?: string;
  time: number;
}

/** An open board view the manager can read / restore config on. */
export interface BoardHost {
  path(): string | undefined;
  config(): object;
  getJson(): string;
  setJson(json: string): void;
}

const MAX_ENTRIES = 100;
const MERGE_MS = 2000;

/** Collects the steps of one user action. */
export class Tx {
  readonly steps: Step[] = [];
  constructor(private m: UndoManager) {}

  config(board: string, json: string): void {
    this.steps.push({ kind: "config", board, json });
  }
  /** Snapshot the config of whichever open board owns this config object. */
  configOf(config: object): void {
    const h = this.m.hostFor(config);
    const p = h?.path();
    if (h && p) this.config(p, h.getJson());
  }
  async frontmatter(file: TFile): Promise<void> {
    this.steps.push({ kind: "fm", path: file.path, fm: await readFm(this.m.app, file) });
  }
  moved(from: string, to: string): void {
    if (from !== to) this.steps.push({ kind: "move", from, to });
  }
  created(path: string): void {
    this.steps.push({ kind: "create", path });
  }
  async deleted(file: TFile): Promise<void> {
    this.steps.push({ kind: "delete", path: file.path, content: await this.m.app.vault.read(file) });
  }
  mkdir(path: string): void {
    this.steps.push({ kind: "mkdir", path });
  }
  rmdir(path: string): void {
    this.steps.push({ kind: "rmdir", path });
  }
}

export class UndoManager {
  app!: App;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private hosts = new Set<BoardHost>();
  /** True while undoing/redoing, so the replay itself isn't recorded. */
  private busy = false;

  init(app: App): void {
    this.app = app;
    this.undoStack = [];
    this.redoStack = [];
  }

  registerHost(host: BoardHost): () => void {
    this.hosts.add(host);
    return () => this.hosts.delete(host);
  }
  hostFor(config: object): BoardHost | undefined {
    return [...this.hosts].find((h) => h.config() === config);
  }
  private hostByPath(path: string): BoardHost | undefined {
    return [...this.hosts].find((h) => h.path() === path);
  }

  /**
   * Run one user action and record it. `fn` snapshots state through `tx`
   * before changing it. Actions sharing a `mergeKey` within 2s (e.g. clicking
   * through colors) collapse into one undo step.
   */
  async record<T>(label: string, fn: (tx: Tx) => Promise<T>, mergeKey?: string): Promise<T> {
    const tx = new Tx(this);
    if (this.busy) return fn(tx);
    try {
      return await fn(tx);
    } finally {
      if (tx.steps.length) this.push({ label, steps: tx.steps, mergeKey, time: Date.now() });
    }
  }

  /** Record a config-only change made elsewhere (e.g. the settings modal). */
  pushConfig(label: string, board: string, before: string): void {
    this.push({ label, steps: [{ kind: "config", board, json: before }], time: Date.now() });
  }

  private push(e: Entry): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (e.mergeKey && last?.mergeKey === e.mergeKey && e.time - last.time < MERGE_MS) {
      last.time = e.time; // keep the earliest snapshot
    } else {
      this.undoStack.push(e);
      if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(): Promise<void> {
    return this.replay(this.undoStack, this.redoStack, "Undo");
  }
  redo(): Promise<void> {
    return this.replay(this.redoStack, this.undoStack, "Redo");
  }

  private async replay(from: Entry[], to: Entry[], verb: string): Promise<void> {
    const e = from.pop();
    if (!e) {
      new Notice(`Nothing to ${verb.toLowerCase()}`, 1500);
      return;
    }
    const tx = new Tx(this);
    this.busy = true;
    try {
      for (const s of [...e.steps].reverse()) await this.apply(s, tx);
      new Notice(`${verb === "Undo" ? "↶" : "↷"} ${verb}: ${e.label}`, 1500);
    } catch (err) {
      console.error(`NoteBoard: ${verb} failed`, err);
      new Notice(`${verb} failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
    if (tx.steps.length) to.push({ label: e.label, steps: tx.steps, time: Date.now() });
  }

  /** Reverse one step, recording the opposite step on `tx`. */
  private async apply(s: Step, tx: Tx): Promise<void> {
    const { vault, fileManager } = this.app;
    const get = (p: string) => vault.getAbstractFileByPath(normalizePath(p));
    switch (s.kind) {
      case "config": {
        const h = this.hostByPath(s.board);
        if (h) {
          tx.config(s.board, h.getJson());
          h.setJson(s.json);
        } else {
          const f = get(s.board);
          if (f instanceof TFile) {
            tx.config(s.board, await vault.read(f));
            await vault.modify(f, s.json);
          }
        }
        return;
      }
      case "fm": {
        const f = get(s.path);
        if (!(f instanceof TFile)) return;
        await tx.frontmatter(f);
        await fileManager.processFrontMatter(f, (cur) => {
          for (const k of Object.keys(cur)) if (!(k in s.fm)) delete cur[k];
          Object.assign(cur, JSON.parse(JSON.stringify(s.fm)));
        });
        return;
      }
      case "move": {
        const f = get(s.to);
        if (!f) return;
        if (get(s.from)) throw new Error(`"${s.from}" already exists`);
        await ensureParent(this.app, s.from);
        await fileManager.renameFile(f, normalizePath(s.from));
        tx.moved(s.to, s.from);
        return;
      }
      case "create": {
        const f = get(s.path);
        if (!(f instanceof TFile)) return;
        await tx.deleted(f);
        await fileManager.trashFile(f);
        return;
      }
      case "delete": {
        if (get(s.path)) return;
        await ensureParent(this.app, s.path);
        await vault.create(normalizePath(s.path), s.content);
        tx.created(s.path);
        return;
      }
      case "mkdir": {
        const f = get(s.path);
        if (f instanceof TFolder && f.children.length === 0) {
          await fileManager.trashFile(f);
          tx.rmdir(s.path);
        }
        return;
      }
      case "rmdir": {
        if (get(s.path)) return;
        await ensureParent(this.app, `${s.path}/x`);
        tx.mkdir(s.path);
        return;
      }
    }
  }
}

/** The plugin-wide undo history (board, timeline, card modal, settings). */
export const undo = new UndoManager();

async function readFm(app: App, file: TFile): Promise<Record<string, unknown>> {
  const raw = await app.vault.read(file);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const parsed = parseYaml(m[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Make sure the folder containing `path` exists. */
async function ensureParent(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (!dir) return;
  const parts = dir.split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => {});
  }
}
