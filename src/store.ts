import { App, TFile, TFolder, normalizePath, stringifyYaml } from "obsidian";
import {
  BoardConfig,
  BOARD_VERSION,
  Card,
  ColumnDef,
  defaultBoard,
  INBOX,
  PropertyDef,
  QUESTS_FOLDER_DEFAULT,
  TASK_CREATED,
  UNCATEGORIZED,
} from "./types";
import { toISODateTime } from "./dates";

/** Parse a `.kanban` file's text into a BoardConfig, applying defaults. */
export function parseBoard(raw: string): BoardConfig {
  let data: Partial<BoardConfig> = {};
  const trimmed = raw.trim();
  if (trimmed.length) {
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      console.error("Notion Kanban: could not parse board file, resetting.", e);
      data = {};
    }
  }
  const base = defaultBoard(data.folder ?? "");
  const merged: BoardConfig = {
    ...base,
    ...data,
    version: BOARD_VERSION,
    properties: data.properties ?? base.properties,
    columns: data.columns ?? base.columns,
    cardProps: data.cardProps ?? base.cardProps,
    cardOrder: data.cardOrder ?? {},
  };
  // Guarantee the group-by property exists in the schema.
  if (!merged.properties.some((p) => p.name === merged.groupBy)) {
    merged.properties.unshift({ name: merged.groupBy, type: "select", options: [] });
  }
  return merged;
}

export function serializeBoard(config: BoardConfig): string {
  return JSON.stringify(config, null, 2);
}

/** Group value for a card given the board's group-by property. */
export function cardGroup(config: BoardConfig, card: Card): string {
  const v = card.props[config.groupBy];
  if (v === undefined || v === null || v === "") return UNCATEGORIZED;
  if (Array.isArray(v)) return v.length ? String(v[0]) : UNCATEGORIZED;
  return String(v);
}

export function getProperty(
  config: BoardConfig,
  name: string
): PropertyDef | undefined {
  return config.properties.find((p) => p.name === name);
}

/** Resolve a vault folder by path ("" = vault root). */
export function getFolder(app: App, path: string): TFolder | null {
  const p = normalizePath(path || "/");
  const f = p === "/" || p === "" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(p);
  return f instanceof TFolder ? f : null;
}

/** Vault path of the board's quests folder, e.g. `Work/Quests`. */
export function questsRootPath(config: BoardConfig): string {
  const sub = config.questsFolder || QUESTS_FOLDER_DEFAULT;
  return normalizePath(config.folder ? `${config.folder}/${sub}` : sub);
}

/** Vault path of one quest's folder, e.g. `Work/Quests/WAF Rollout`. */
export function questFolderPath(config: BoardConfig, quest: string): string {
  return normalizePath(`${questsRootPath(config)}/${quest}`);
}

/**
 * A quest was renamed (folder + note): carry its column, task order, branch
 * paths and collapsed state over to the new name. Safe to call twice — it
 * only changes what still uses the old name. Returns true if anything changed.
 */
export function renameQuestKey(config: BoardConfig, oldName: string, newName: string): boolean {
  if (oldName === newName) return false;
  let changed = false;
  const from = questFolderPath(config, oldName) + "/";
  const to = questFolderPath(config, newName) + "/";
  const move = (p: string) => (p.startsWith(from) ? to + p.slice(from.length) : p);

  const cols = config.questColumns ?? [];
  const col = cols.find((c) => c.id === oldName);
  if (col && !cols.some((c) => c.id === newName)) {
    col.id = newName;
    changed = true;
  }
  const order = config.questCardOrder;
  if (order?.[oldName]) {
    order[newName] = order[oldName].map(move);
    delete order[oldName];
    changed = true;
  }
  if (config.journeyStacked?.some((p) => p.startsWith(from))) {
    config.journeyStacked = config.journeyStacked.map(move);
    changed = true;
  }
  for (const key of ["timelineCollapsed", "journeyCollapsed"] as const) {
    const list = config[key];
    if (list?.includes(oldName)) {
      config[key] = list.map((k) => (k === oldName ? newName : k));
      changed = true;
    }
  }
  return changed;
}

/**
 * Scan the board's tasks: notes directly in the board folder (the "No quest"
 * inbox) plus notes inside each `Quests/<quest>/` folder. A note named after
 * its own quest folder is the quest note, not a task, so it's skipped.
 */
export function scanCards(app: App, config: BoardConfig): Card[] {
  const root = getFolder(app, config.folder);
  if (!root) return [];

  const cards: Card[] = [];
  const push = (file: TFile, quest: string | null) => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    cards.push({ file, path: file.path, title: file.basename, props: { ...fm }, quest });
  };

  for (const child of root.children) {
    if (child instanceof TFile && child.extension === "md") push(child, null);
  }

  const questsRoot = getFolder(app, questsRootPath(config));
  if (questsRoot) {
    for (const q of questsRoot.children) {
      if (!(q instanceof TFolder)) continue;
      for (const f of q.children) {
        if (f instanceof TFile && f.extension === "md" && f.basename !== q.name) {
          push(f, q.name);
        }
      }
    }
  }
  return cards;
}

/**
 * Order cards into quest columns (plus the INBOX key), honoring
 * config.questCardOrder and appending unordered cards by name.
 */
export function layoutQuestCards(
  config: BoardConfig,
  cards: Card[],
  questNames: string[]
): { byColumn: Map<string, Card[]>; changedOrder: boolean } {
  const order = (config.questCardOrder ??= {});
  const grouped = new Map<string, Card[]>();
  for (const c of cards) {
    const k = c.quest ?? INBOX;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(c);
  }
  const byColumn = new Map<string, Card[]>();
  let changedOrder = false;
  for (const key of [...questNames, INBOX]) {
    const present = grouped.get(key) ?? [];
    const byPath = new Map(present.map((c) => [c.path, c]));
    const saved = order[key] ?? [];
    const ordered: Card[] = [];
    for (const p of saved) {
      const c = byPath.get(p);
      if (c && !ordered.includes(c)) ordered.push(c);
    }
    present
      .filter((c) => !ordered.includes(c))
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((c) => ordered.push(c));
    const next = ordered.map((c) => c.path);
    if (JSON.stringify(next) !== JSON.stringify(saved)) {
      order[key] = next;
      changedOrder = true;
    }
    byColumn.set(key, ordered);
  }
  return { byColumn, changedOrder };
}

/**
 * Build the ordered column -> cards map. Honors config.cardOrder, appends any
 * unordered/new cards to the end of their column, and prunes stale paths.
 */
export function layoutCards(
  config: BoardConfig,
  cards: Card[]
): { columns: ColumnDef[]; byColumn: Map<string, Card[]>; changedOrder: boolean } {
  const byPath = new Map(cards.map((c) => [c.path, c]));
  const grouped = new Map<string, Card[]>();
  for (const card of cards) {
    const g = cardGroup(config, card);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(card);
  }

  // Ensure every present group has a column (uncategorized handled separately).
  const columns = [...config.columns];
  const known = new Set(columns.map((c) => c.id));
  for (const g of grouped.keys()) {
    if (g !== UNCATEGORIZED && !known.has(g)) {
      columns.push({ id: g, color: "default" });
      known.add(g);
    }
  }

  // Every category defined in the group-by schema always gets a column — even
  // with zero cards — so emptying a column never makes the category vanish.
  // A category only disappears via an explicit "Delete group".
  const groupDef = config.properties.find((p) => p.name === config.groupBy);
  if (groupDef && (groupDef.type === "select" || groupDef.type === "multiselect")) {
    for (const opt of groupDef.options ?? []) {
      if (!known.has(opt.name)) {
        columns.push({ id: opt.name, color: opt.color });
        known.add(opt.name);
      }
    }
  }

  const byColumn = new Map<string, Card[]>();
  let changedOrder = false;

  const place = (colId: string) => {
    const present = grouped.get(colId) ?? [];
    const presentPaths = new Set(present.map((c) => c.path));
    const savedOrder = config.cardOrder[colId] ?? [];
    const ordered: Card[] = [];
    const seen = new Set<string>();
    for (const p of savedOrder) {
      if (presentPaths.has(p) && !seen.has(p)) {
        ordered.push(byPath.get(p)!);
        seen.add(p);
      }
    }
    // append new cards not yet in saved order (sorted by name for stability)
    const leftovers = present
      .filter((c) => !seen.has(c.path))
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const c of leftovers) ordered.push(c);

    const newOrder = ordered.map((c) => c.path);
    if (JSON.stringify(newOrder) !== JSON.stringify(savedOrder)) {
      config.cardOrder[colId] = newOrder;
      changedOrder = true;
    }
    byColumn.set(colId, ordered);
  };

  for (const col of columns) place(col.id);
  place(UNCATEGORIZED);

  return { columns, byColumn, changedOrder };
}

/** Write a single frontmatter property on a note (adds/updates/removes). */
export async function writeProp(
  app: App,
  file: TFile,
  name: string,
  value: unknown
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (value === undefined || value === null || value === "") {
      delete fm[name];
    } else {
      fm[name] = value;
    }
  });
}

/** Set a card's group value (the group-by property). */
export async function setCardGroup(
  app: App,
  config: BoardConfig,
  file: TFile,
  group: string
): Promise<void> {
  const value = group === UNCATEGORIZED ? "" : group;
  await writeProp(app, file, config.groupBy, value);
}

/** Create a folder (and any missing parents). No-op if it exists. */
export async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p || p === "/" || app.vault.getAbstractFileByPath(p)) return;
  const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (parent) await ensureFolder(app, parent);
  await app.vault.createFolder(p).catch(() => {});
}

/**
 * Move a note into `folderPath` (collision-safe name). Links across the vault
 * are updated by Obsidian. Returns the moved file.
 */
export async function moveFileToFolder(
  app: App,
  file: TFile,
  folderPath: string
): Promise<TFile> {
  const folder = folderPath ? normalizePath(folderPath) : "";
  const parent = file.parent && file.parent.path !== "/" ? file.parent.path : "";
  if (parent === folder) return file;
  if (folder) await ensureFolder(app, folder);
  const base = file.basename;
  const ext = file.extension;
  const pathFor = (n: string) => normalizePath(folder ? `${folder}/${n}.${ext}` : `${n}.${ext}`);
  let target = pathFor(base);
  let i = 2;
  while (app.vault.getAbstractFileByPath(target)) {
    target = pathFor(`${base} ${i}`);
    i++;
  }
  await app.fileManager.renameFile(file, target);
  const after = app.vault.getAbstractFileByPath(target);
  return after instanceof TFile ? after : file;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Untitled";
}

/** Create a new card note (in the board folder, or `folderPath` if given). */
export async function createCard(
  app: App,
  config: BoardConfig,
  group: string,
  title: string,
  folderPath?: string,
  extra: Record<string, unknown> = {}
): Promise<TFile> {
  const target = folderPath ?? config.folder;
  const folder = target ? normalizePath(target) : "";
  // ensure folder exists
  if (folder) await ensureFolder(app, folder);
  let base = sanitizeFileName(title);
  let fileName = `${base}.md`;
  let path = normalizePath(folder ? `${folder}/${fileName}` : fileName);
  let i = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    fileName = `${base} ${i}.md`;
    path = normalizePath(folder ? `${folder}/${fileName}` : fileName);
    i++;
  }

  // Seed frontmatter with the group value and empty known props.
  const fm: Record<string, unknown> = {};
  if (group !== UNCATEGORIZED) fm[config.groupBy] = group;
  Object.assign(fm, extra);
  // Every card remembers when it was made (shown read-only as "Created").
  fm[TASK_CREATED] ??= toISODateTime(new Date());
  const yaml = Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n\n` : "";
  const file = await app.vault.create(path, yaml);
  return file;
}

/** Rename a card note (its title). Updates links across the vault. */
export async function renameCard(
  app: App,
  file: TFile,
  newTitle: string
): Promise<void> {
  const clean = sanitizeFileName(newTitle);
  if (clean === file.basename) return;
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  let target = normalizePath(`${dir}${clean}.md`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(target) && target !== file.path) {
    target = normalizePath(`${dir}${clean} ${i}.md`);
    i++;
  }
  await app.fileManager.renameFile(file, target);
}

/** Read the markdown body (content below frontmatter) of a note. */
export async function readBody(app: App, file: TFile): Promise<string> {
  const raw = await app.vault.read(file);
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

/** Write the markdown body while preserving frontmatter. */
export async function writeBody(
  app: App,
  file: TFile,
  body: string
): Promise<void> {
  const raw = await app.vault.read(file);
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const fmBlock = m ? m[0] : "";
  await app.vault.modify(file, fmBlock + body);
}
