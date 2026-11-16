import { App, TFile, TFolder, normalizePath } from "obsidian";
import { BoardConfig, Quest, QUEST_TYPE } from "./types";
import type { Tx } from "./undo";
import {
  ensureFolder,
  getFolder,
  moveFileToFolder,
  questFolderPath,
  questsRootPath,
  sanitizeFileName,
} from "./store";

/**
 * Quest folders being renamed by NoteBoard itself, so the vault-wide
 * note↔folder sync (main.ts) doesn't race it.
 */
export const questRenamesInFlight = new Set<string>();

/** Every quest folder under the board's `Quests/` folder, sorted by name. */
export function listQuests(app: App, config: BoardConfig): Quest[] {
  const root = getFolder(app, questsRootPath(config));
  if (!root) return [];
  const out: Quest[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const note = app.vault.getAbstractFileByPath(
      normalizePath(`${child.path}/${child.name}.md`)
    );
    const file = note instanceof TFile ? note : null;
    const props = file ? { ...(app.metadataCache.getFileCache(file)?.frontmatter ?? {}) } : {};
    const radiant = /^radiant$/i.test(String(props[QUEST_TYPE] ?? "").trim());
    out.push({ name: child.name, folderPath: child.path, note: file, props, radiant });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The goal text of a quest note: a `Goal` frontmatter property, else the
 * text under a "## Goal" heading (up to the next heading).
 */
export function extractGoal(markdown: string, fm: Record<string, unknown>): string {
  if (typeof fm.Goal === "string" && fm.Goal.trim()) return fm.Goal.trim();
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const m = /^#{1,6}\s*goal\s*$/im.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = /^#{1,6}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest)
    .split("\n")
    .map((l) => l.replace(/^\s*[-*+]\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 280);
}

/** Create `Quests/<name>/` and its quest note. Returns the clean name used. */
export async function createQuest(
  app: App,
  config: BoardConfig,
  name: string,
  tx?: Tx,
  radiant = false
): Promise<string> {
  const clean = sanitizeFileName(name);
  const folder = questFolderPath(config, clean);
  if (app.vault.getAbstractFileByPath(folder)) {
    throw new Error(`A quest named "${clean}" already exists.`);
  }
  const root = questsRootPath(config);
  const rootExisted = !!app.vault.getAbstractFileByPath(root);
  await ensureFolder(app, folder);
  if (!rootExisted) tx?.mkdir(root);
  tx?.mkdir(folder);
  const notePath = normalizePath(`${folder}/${clean}.md`);
  // Radiant quests never end, so they get no Start/Target.
  const fm = radiant ? `${QUEST_TYPE}: radiant\n` : "Start: \nTarget: \n";
  await app.vault.create(notePath, `---\n${fm}---\n\n## Goal\n\n`);
  tx?.created(notePath);
  return clean;
}

/** Ensure a quest folder has its quest note (e.g. folders made by hand). */
export async function ensureQuestNote(app: App, quest: Quest, tx?: Tx): Promise<TFile> {
  if (quest.note) return quest.note;
  const note = await app.vault.create(
    normalizePath(`${quest.folderPath}/${quest.name}.md`),
    "---\nStart: \nTarget: \n---\n\n## Goal\n\n"
  );
  tx?.created(note.path);
  return note;
}

/** Rename a quest: its folder and its quest note. Returns the clean new name. */
export async function renameQuest(
  app: App,
  config: BoardConfig,
  oldName: string,
  newName: string,
  tx?: Tx
): Promise<string> {
  const clean = sanitizeFileName(newName);
  const from = app.vault.getAbstractFileByPath(questFolderPath(config, oldName));
  if (!(from instanceof TFolder)) throw new Error(`Quest "${oldName}" not found.`);
  const toPath = questFolderPath(config, clean);
  if (app.vault.getAbstractFileByPath(toPath)) {
    throw new Error(`A quest named "${clean}" already exists.`);
  }
  const fromPath = from.path;
  questRenamesInFlight.add(toPath);
  try {
    await app.fileManager.renameFile(from, toPath);
    tx?.moved(fromPath, toPath);
    const oldNote = normalizePath(`${toPath}/${oldName}.md`);
    const note = app.vault.getAbstractFileByPath(oldNote);
    if (note instanceof TFile) {
      const newNote = normalizePath(`${toPath}/${clean}.md`);
      await app.fileManager.renameFile(note, newNote);
      tx?.moved(oldNote, newNote);
    }
  } finally {
    questRenamesInFlight.delete(toPath);
  }
  return clean;
}

/**
 * Delete a quest: its tasks move back to the board folder (the "No quest"
 * inbox), then the quest note and folder go to the trash.
 */
export async function deleteQuest(
  app: App,
  config: BoardConfig,
  name: string,
  tx?: Tx
): Promise<void> {
  const folder = app.vault.getAbstractFileByPath(questFolderPath(config, name));
  if (!(folder instanceof TFolder)) return;
  for (const child of [...folder.children]) {
    if (child instanceof TFile && child.extension === "md" && child.basename !== name) {
      const from = child.path;
      const moved = await moveFileToFolder(app, child, config.folder);
      tx?.moved(from, moved.path);
    }
  }
  // Snapshot what's left (the quest note) so undo can bring it back.
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") await tx?.deleted(child);
  }
  tx?.rmdir(folder.path);
  await app.fileManager.trashFile(folder);
}
