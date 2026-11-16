import { App, TFile, moment } from "obsidian";
import { BoardConfig, Card, KANBAN_EXT, QUEST_START, QUEST_TARGET, TASK_DUE } from "./types";
import { getProperty, parseBoard, questsRootPath, scanCards } from "./store";
import { listQuests } from "./quests";
import { applyColor } from "./colors";
import { dayNum, parseDate, shortDate, today } from "./dates";
import { randomIconFor } from "./modals/emoji-picker";
import { isAbandoned, isArchived, isDone, progressOf } from "./status";

/** Where a note sits relative to a board. */
export interface QuestContext {
  /** Quest folder name, or null for a task in the board folder ("No quest"). */
  quest: string | null;
  /** True for the quest's own note (Quests/<q>/<q>.md). */
  isQuestNote: boolean;
}

/** Work out if `file` is a task (or quest note) of this board. */
export function questContext(config: BoardConfig, file: TFile): QuestContext | null {
  if (file.extension !== "md" || !file.parent) return null;
  const parent = file.parent.path === "/" ? "" : file.parent.path;
  // Inbox tasks only for boards with their own folder, so a vault-root board
  // doesn't stamp a banner on every root note.
  if (config.folder && parent === config.folder) return { quest: null, isQuestNote: false };
  const grand = file.parent.parent;
  if (grand && grand.path === questsRootPath(config)) {
    return { quest: file.parent.name, isQuestNote: file.basename === file.parent.name };
  }
  return null;
}

/** Keeps every board config in the vault, so any note can find its board. */
export class BoardIndex {
  private boards: { path: string; config: BoardConfig }[] = [];
  constructor(private app: App) {}

  async rebuild(): Promise<void> {
    const out: { path: string; config: BoardConfig }[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== KANBAN_EXT) continue;
      try {
        out.push({ path: f.path, config: parseBoard(await this.app.vault.cachedRead(f)) });
      } catch {
        /* unreadable board — skip */
      }
    }
    this.boards = out;
  }

  /** Every board in the vault: its file path and (cached) config. */
  entries(): readonly { path: string; config: BoardConfig }[] {
    return this.boards;
  }

  lookup(file: TFile): { config: BoardConfig; ctx: QuestContext } | null {
    for (const { config } of this.boards) {
      const ctx = questContext(config, file);
      if (ctx) return { config, ctx };
    }
    return null;
  }
}


/**
 * Quest banner for a task / quest note: quest pill, progress, dates, last
 * edited time, and a mini quest line with this task highlighted.
 */
export function renderQuestBanner(
  el: HTMLElement,
  app: App,
  config: BoardConfig,
  file: TFile,
  ctx: QuestContext
): void {
  el.addClass("nk-quest-banner");
  const top = el.createDiv({ cls: "nk-qb-top" });

  const quest = ctx.quest ? listQuests(app, config).find((q) => q.name === ctx.quest) : undefined;
  const color = ctx.quest ? config.questColumns?.find((c) => c.id === ctx.quest)?.color : undefined;
  const pill = top.createSpan({ cls: "nk-col-pill nk-qb-pill" });
  applyColor(pill, color ?? "default");
  if (quest) {
    const qi = typeof quest.props.icon === "string" ? quest.props.icon.trim() : "";
    pill.createSpan({ cls: "nk-qb-icon", text: qi || randomIconFor(quest.folderPath) });
    pill.createSpan({ text: quest.name });
    if (!ctx.isQuestNote && quest.note) {
      const note = quest.note;
      pill.addClass("is-link");
      pill.setAttr("title", "Open quest note");
      pill.addEventListener("click", () => app.workspace.getLeaf("tab").openFile(note));
    }
  } else {
    pill.setText("No quest");
  }

  // Archived tasks are put away: out of the progress and the mini line.
  const tasks = ctx.quest
    ? scanCards(app, config).filter((c) => c.quest === ctx.quest && !isArchived(config, c))
    : [];
  const { done: doneN, abandoned: abN, counted, pct } = progressOf(config, tasks);
  // Radiant quests are endless: no Start/Target, no goal bar.
  const radiant = !!quest?.radiant;
  const qs = quest && !radiant ? parseDate(quest.props[QUEST_START]) : null;
  const qt = quest && !radiant ? parseDate(quest.props[QUEST_TARGET]) : null;
  const self = tasks.find((c) => c.path === file.path);
  const selfDue = self ? parseDate(self.props[TASK_DUE]) : null;

  if (quest) {
    const meta = top.createSpan({ cls: "nk-qb-meta" });
    const bits = radiant
      ? [`∞ radiant · ${tasks.length - doneN - abN} open · ${doneN} done`]
      : [`${doneN}/${counted} done · ${pct}%`];
    if (abN) bits.push(`✕ ${abN} abandoned`);
    if (qs || qt) bits.push(`${qs ? shortDate(qs) : "?"} → ${qt ? shortDate(qt) : "?"}`);
    if (self && !selfDue) bits.push("this task has no due date");
    meta.setText(bits.join(" · "));
  }
  top.createDiv({ cls: "nk-qb-spacer" });
  const updated = moment(file.stat.mtime);
  const upd = top.createSpan({ cls: "nk-qb-updated", text: `Updated ${updated.fromNow()}` });
  upd.setAttr("title", updated.format("dddd, DD/MM/YYYY HH:mm"));

  if (!quest) return;

  // ---- Mini quest line, scaled to fit the banner width.
  const now = today();
  const dated = tasks
    .map((c) => ({ c, d: parseDate(c.props[TASK_DUE]) }))
    .filter((x): x is { c: Card; d: Date } => x.d !== null);
  const all = [now, ...dated.map((x) => x.d), ...(qs ? [qs] : []), ...(qt ? [qt] : [])].map(dayNum);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 14) {
    lo -= 7;
    hi += 7;
  }
  const pos = (d: Date) => 3 + ((dayNum(d) - lo) / (hi - lo)) * 94; // % from left

  const line = el.createDiv({ cls: "nk-qb-line" });
  line.createDiv({ cls: "nk-qb-baseline" });
  const sorted = dated.map((x) => x.d.getTime()).sort((a, b) => a - b);
  const ls = radiant ? null : qs ?? (sorted.length ? new Date(sorted[0]) : null);
  const le = radiant ? null : qt ?? (sorted.length ? new Date(sorted[sorted.length - 1]) : null);
  if (ls && le) {
    const bar = line.createDiv({ cls: "nk-qb-bar" });
    if (color && color !== "default") applyColor(bar, color);
    const a = pos(ls);
    const b = pos(le);
    bar.style.left = `${Math.min(a, b)}%`;
    bar.style.width = `${Math.max(0.8, Math.abs(b - a))}%`;
    bar.createDiv({ cls: "nk-qb-bar-fill" }).style.width = `${pct}%`;
    const sl = line.createDiv({ cls: "nk-qb-end", text: shortDate(ls) });
    sl.style.left = `${Math.min(a, b)}%`;
    if (dayNum(le) !== dayNum(ls)) {
      const el2 = line.createDiv({ cls: "nk-qb-end is-right", text: shortDate(le) });
      el2.style.left = `${Math.max(a, b)}%`;
    }
  }
  if (qt) {
    const fl = line.createDiv({ cls: "nk-qb-flag", text: "🏁" });
    fl.style.left = `${pos(qt)}%`;
    fl.setAttr("title", `Target · ${shortDate(qt)}`);
  }
  const td = line.createDiv({ cls: "nk-qb-today" });
  td.style.left = `${pos(now)}%`;
  td.setAttr("title", `Today · ${shortDate(now)}`);

  const statusDef = getProperty(config, config.groupBy);
  for (const { c, d } of dated) {
    const dm = line.createDiv({ cls: "nk-qb-diamond" });
    const v = c.props[config.groupBy];
    const sc = statusDef?.options?.find((o) => o.name === String(Array.isArray(v) ? v[0] : v))?.color;
    if (sc) applyColor(dm, sc);
    dm.style.left = `${pos(d)}%`;
    const closedOk = isDone(config, c);
    const dropped = isAbandoned(config, c);
    dm.toggleClass("is-done", closedOk);
    dm.toggleClass("is-abandoned", dropped);
    dm.toggleClass("is-overdue", !closedOk && !dropped && dayNum(d) < dayNum(now));
    const isSelf = c.path === file.path;
    dm.toggleClass("is-self", isSelf);
    dm.setAttr("title", `${c.title} · Due ${shortDate(d)}`);
    if (isSelf) {
      const tag = line.createDiv({ cls: "nk-qb-self", text: `this task · ${shortDate(d)}` });
      tag.style.left = `${pos(d)}%`;
    } else {
      dm.addEventListener("click", () => app.workspace.getLeaf(false).openFile(c.file));
    }
  }
}
