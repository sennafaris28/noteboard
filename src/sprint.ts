import { setIcon } from "obsidian";
import { BoardConfig, Card, TASK_CREATED, TASK_DUE } from "./types";
import { applyColor } from "./colors";
import { addDays, dayNum, formatDMY, parseDate, shortDate, today } from "./dates";
import { randomIconFor } from "./modals/emoji-picker";
import { onHold } from "./touch";
import { TASK_CLOSED } from "./intake";

type Pos = { x: number; y: number };

export const SPRINT_DAYS_DEFAULT = 14;

// ---- Sprint maths (pure) ----------------------------------------------------

/** A sprint window: `start` and `end` are inclusive local days. */
export interface Sprint {
  /** Sprint number as the team counts it. */
  number: number;
  start: Date;
  end: Date;
}

/** Monday of the week `d` falls in — the fallback anchor when none is set. */
export function mondayOf(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}

/**
 * The sprint containing `day`, counting from the board's anchor sprint
 * (`sprintStart` = first day of sprint number `sprintNumber`). Without an
 * anchor, sprints start on this week's Monday.
 */
export function sprintAt(config: BoardConfig, day: Date): Sprint {
  const len = Math.max(1, Math.round(config.sprintDays ?? SPRINT_DAYS_DEFAULT));
  const anchor = parseDate(config.sprintStart) ?? mondayOf(today());
  const first = Math.round(config.sprintNumber ?? 1);
  const idx = Math.floor((dayNum(day) - dayNum(anchor)) / len);
  const start = addDays(anchor, idx * len);
  return { number: first + idx, start, end: addDays(start, len - 1) };
}

/** The sprint `offset` sprints away from the one containing `day`. */
export function sprintOffset(config: BoardConfig, day: Date, offset: number): Sprint {
  const len = Math.max(1, Math.round(config.sprintDays ?? SPRINT_DAYS_DEFAULT));
  return sprintAt(config, addDays(sprintAt(config, day).start, offset * len));
}

/** Why a task is in a sprint — shown as a tag on the card. */
export type SprintReason = "closed" | "due" | "logged" | "carried" | "active";

export interface SprintEntry {
  card: Card;
  reasons: SprintReason[];
}

/** Status words that mean someone is working on it right now. */
const ACTIVE_RE = /progress|doing|wip|active|review|blocked|ongoing/i;
const DONE_NAME_RE = /^(done|complete|completed)$/i;

export interface SprintRules {
  isDone(card: Card): boolean;
  isAbandoned(card: Card): boolean;
  isArchived(card: Card): boolean;
  statusText(card: Card): string;
}

/**
 * Which tasks belong to a sprint, from their dates alone (no planning):
 * - closed in the window (`Closed` stamp) — or closed with no stamp but due /
 *   logged in it;
 * - open and due in the window, or logged (`Created`) in it;
 * - in the current sprint also: open tasks that are in progress, or overdue
 *   from an earlier sprint (carried over).
 * Archived tasks are put away and never shown.
 */
export function sprintEntries(
  cards: Card[],
  sprint: Sprint,
  rules: SprintRules,
  now: Date = today()
): SprintEntry[] {
  const s = dayNum(sprint.start);
  const e = dayNum(sprint.end);
  const t = dayNum(now);
  const isCurrent = s <= t && t <= e;
  const inWin = (d: Date | null) => !!d && dayNum(d) >= s && dayNum(d) <= e;
  const out: SprintEntry[] = [];

  for (const card of cards) {
    if (rules.isArchived(card)) continue;
    const due = parseDate(card.props[TASK_DUE]);
    const created = parseDate(card.props[TASK_CREATED]);
    const closed = parseDate(card.props[TASK_CLOSED]);
    const reasons: SprintReason[] = [];
    const isClosed = rules.isDone(card) || rules.isAbandoned(card);

    if (isClosed) {
      if (closed) {
        if (!inWin(closed)) continue; // closed in another sprint
        reasons.push("closed");
      } else if (!inWin(due) && !inWin(created)) {
        continue;
      }
      if (inWin(due)) reasons.push("due");
      if (inWin(created)) reasons.push("logged");
    } else {
      if (inWin(due)) reasons.push("due");
      if (inWin(created)) reasons.push("logged");
      if (isCurrent) {
        if (due && dayNum(due) < s) reasons.push("carried");
        if (ACTIVE_RE.test(rules.statusText(card))) reasons.push("active");
      }
    }
    if (reasons.length) out.push({ card, reasons });
  }
  return out;
}

export interface SprintSummary {
  total: number;
  done: number;
  abandoned: number;
  open: number;
  carried: number;
  logged: number;
  /** Tasks in radiant (ad-hoc) quests. */
  adhoc: number;
  /** Count per value of the breakdown property (e.g. Entity); "" = unset. */
  breakdown: Map<string, number>;
}

export function summarize(
  entries: SprintEntry[],
  rules: SprintRules,
  isRadiant: (card: Card) => boolean,
  breakdownKey?: string
): SprintSummary {
  const sum: SprintSummary = {
    total: entries.length, done: 0, abandoned: 0, open: 0, carried: 0, logged: 0, adhoc: 0,
    breakdown: new Map(),
  };
  for (const { card, reasons } of entries) {
    if (rules.isDone(card)) sum.done++;
    else if (rules.isAbandoned(card)) sum.abandoned++;
    else sum.open++;
    if (reasons.includes("carried")) sum.carried++;
    if (reasons.includes("logged")) sum.logged++;
    if (isRadiant(card)) sum.adhoc++;
    if (breakdownKey) {
      const v = card.props[breakdownKey];
      const k = String(Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
      sum.breakdown.set(k, (sum.breakdown.get(k) ?? 0) + 1);
    }
  }
  return sum;
}

// ---- Rendering --------------------------------------------------------------

/** Everything the sprint view needs from the board view. */
export interface SprintCtx extends SprintRules {
  config: BoardConfig;
  cards: Card[];
  /** Sprints away from the current one (0 = current). */
  offset: number;
  setOffset(offset: number): void;
  /** Status columns: the board's status options, in order. */
  statuses: { name: string; color: string }[];
  /** Select property to break the summary down by (e.g. "Entity"), if any. */
  breakdown?: { key: string; color(value: string): string | undefined };
  isRadiant(card: Card): boolean;
  questColor(name: string): string | undefined;
  /** Draw the card-face properties (the board's `cardProps`). */
  renderProps(wrap: HTMLElement, card: Card): void;
  openCard(card: Card): void;
  cardMenu(pos: Pos, card: Card): void;
  setStatus(card: Card, status: string): void;
  openSettings(): void;
}

const REASON_LABEL: Record<SprintReason, string> = {
  closed: "closed",
  due: "due",
  logged: "logged",
  carried: "carried over",
  active: "in progress",
};

/** Card being dragged between status columns. */
let drag: Card | null = null;

export function renderSprint(root: HTMLElement, ctx: SprintCtx): void {
  const { config } = ctx;
  const now = today();
  const sprint = sprintOffset(config, now, ctx.offset);
  const isCurrent = ctx.offset === 0;
  const entries = sprintEntries(ctx.cards, sprint, ctx, now);
  const sum = summarize(entries, ctx, ctx.isRadiant, ctx.breakdown?.key);

  const wrap = root.createDiv({ cls: "nk-sprint" });

  // ---- Header: navigation + summary
  const head = wrap.createDiv({ cls: "nk-sp-head" });
  const nav = head.createDiv({ cls: "nk-sp-nav" });
  const prev = nav.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Previous sprint" } });
  setIcon(prev, "chevron-left");
  prev.addEventListener("click", () => ctx.setOffset(ctx.offset - 1));
  const title = nav.createDiv({ cls: "nk-sp-title" });
  title.createSpan({ cls: "nk-sp-name", text: `Sprint ${sprint.number}` });
  title.createSpan({
    cls: "nk-sp-dates",
    text: `${formatDMY(sprint.start)} – ${formatDMY(sprint.end)}`,
  });
  const next = nav.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Next sprint" } });
  setIcon(next, "chevron-right");
  next.addEventListener("click", () => ctx.setOffset(ctx.offset + 1));
  if (isCurrent) {
    const left = dayNum(sprint.end) - dayNum(now);
    nav.createSpan({
      cls: "nk-sp-badge",
      text: left === 0 ? "last day" : `${left + 1} days left`,
    });
  } else {
    const back = nav.createDiv({ cls: "nk-seg-solo", text: "This sprint" });
    back.addEventListener("click", () => ctx.setOffset(0));
  }

  const stats = head.createDiv({ cls: "nk-sp-stats" });
  const stat = (label: string, value: string, tip?: string) => {
    const s = stats.createDiv({ cls: "nk-sp-stat" });
    s.createDiv({ cls: "nk-sp-stat-val", text: value });
    s.createDiv({ cls: "nk-sp-stat-label", text: label });
    if (tip) s.setAttr("title", tip);
  };
  const counted = sum.total - sum.abandoned;
  stat("done", `${sum.done}/${counted}`, "Done ÷ tasks in this sprint (abandoned left out)");
  if (sum.open) stat("open", String(sum.open));
  if (sum.carried) stat("carried over", String(sum.carried), "Open tasks overdue from an earlier sprint");
  if (sum.logged) stat("logged", String(sum.logged), "Tasks created during this sprint");
  if (sum.total) {
    stat(
      "ad-hoc",
      `${Math.round((sum.adhoc / sum.total) * 100)}%`,
      `${sum.adhoc} of ${sum.total} tasks are in radiant (ad-hoc) quests`
    );
  }
  if (sum.abandoned) stat("abandoned", String(sum.abandoned));

  if (ctx.breakdown && sum.total) {
    const bd = head.createDiv({ cls: "nk-sp-breakdown" });
    const rows = [...sum.breakdown.entries()].sort((a, b) => b[1] - a[1]);
    for (const [value, n] of rows) {
      const chip = bd.createSpan({ cls: "nk-chip" });
      applyColor(chip, value ? ctx.breakdown.color(value) : "default");
      chip.setText(`${value || `No ${ctx.breakdown.key.toLowerCase()}`} · ${n}`);
    }
  }

  if (!config.sprintStart) {
    const hint = wrap.createDiv({ cls: "nk-sp-hint" });
    hint.setText("Sprints start on this week's Monday until you set your team's sprint dates. ");
    const link = hint.createSpan({ cls: "nk-sp-hint-link", text: "Set sprint dates…" });
    link.addEventListener("click", () => ctx.openSettings());
  }

  // ---- Status columns
  const board = wrap.createDiv({ cls: "nk-board nk-sp-board" });
  const byStatus = new Map<string, SprintEntry[]>();
  for (const en of entries) {
    const st = ctx.statusText(en.card);
    (byStatus.get(st) ?? byStatus.set(st, []).get(st)!).push(en);
  }
  const known = new Set(ctx.statuses.map((s) => s.name));
  const columns = [
    // Statuses with tasks, plus "in progress" and "done" so there's always somewhere to drag to.
    ...ctx.statuses.filter((s) => byStatus.has(s.name) || ACTIVE_RE.test(s.name) || DONE_NAME_RE.test(s.name)),
    ...[...byStatus.keys()].filter((k) => !known.has(k)).map((k) => ({ name: k, color: "default" })),
  ];
  if (!entries.length) {
    const empty = wrap.createDiv({ cls: "nk-sp-empty" });
    empty.setText(
      isCurrent
        ? "Nothing in this sprint yet: no task is due, logged, in progress or closed in these dates."
        : "No tasks were due, logged or closed in this sprint."
    );
  }

  for (const col of columns) {
    const list = byStatus.get(col.name) ?? [];
    const colEl = board.createDiv({ cls: "nk-column nk-sp-column" });
    const header = colEl.createDiv({ cls: "nk-col-header" });
    const tw = header.createDiv({ cls: "nk-col-title" });
    const pill = tw.createSpan({ cls: "nk-col-pill" });
    applyColor(pill, col.color);
    pill.setText(col.name || `No ${config.groupBy}`);
    tw.createSpan({ cls: "nk-col-count", text: String(list.length) });

    const cardsEl = colEl.createDiv({ cls: "nk-col-cards" });
    // Oldest due first; undated last.
    list.sort((a, b) => dueKey(a.card) - dueKey(b.card) || a.card.title.localeCompare(b.card.title));
    for (const en of list) renderSprintCard(cardsEl, en, ctx);

    cardsEl.addEventListener("dragover", (e) => {
      if (!drag) return;
      e.preventDefault();
      cardsEl.addClass("nk-col-dropzone");
    });
    cardsEl.addEventListener("dragleave", (e) => {
      if (!cardsEl.contains(e.relatedTarget as Node)) cardsEl.removeClass("nk-col-dropzone");
    });
    cardsEl.addEventListener("drop", (e) => {
      cardsEl.removeClass("nk-col-dropzone");
      if (!drag) return;
      e.preventDefault();
      const card = drag;
      drag = null;
      if (ctx.statusText(card) !== col.name) ctx.setStatus(card, col.name);
    });
  }
}

function dueKey(card: Card): number {
  const d = parseDate(card.props[TASK_DUE]);
  return d ? dayNum(d) : Number.MAX_SAFE_INTEGER;
}

function renderSprintCard(list: HTMLElement, en: SprintEntry, ctx: SprintCtx): void {
  const { card, reasons } = en;
  const el = list.createDiv({ cls: "nk-card nk-sp-card" });
  el.setAttr("draggable", "true");
  el.setAttr("data-path", card.path);
  el.setAttr(
    "data-search",
    [card.title, card.quest ?? "", ...Object.values(card.props).flat().map((v) => String(v ?? ""))].join(" ")
  );

  const titleEl = el.createDiv({ cls: "nk-card-title" });
  const explicit = typeof card.props.icon === "string" ? card.props.icon.trim() : "";
  const icon = explicit || (ctx.config.randomIcons !== false ? randomIconFor(card.path) : "");
  if (icon) {
    titleEl.createSpan({ cls: "nk-card-icon", text: icon });
    el.addClass("has-icon");
  }
  titleEl.createSpan({ cls: "nk-card-title-text", text: card.title });

  const props = el.createDiv({ cls: "nk-card-props" });
  const q = props.createSpan({ cls: "nk-chip nk-sp-quest" });
  applyColor(q, card.quest ? ctx.questColor(card.quest) ?? "default" : "default");
  q.setText(card.quest ?? "No quest");
  if (card.quest && ctx.isRadiant(card)) q.prepend("∞ ");
  ctx.renderProps(props, card);

  const tags = el.createDiv({ cls: "nk-sp-reasons" });
  for (const r of reasons) {
    const t = tags.createSpan({ cls: `nk-sp-reason is-${r}` });
    let text = REASON_LABEL[r];
    const d =
      r === "closed" ? parseDate(card.props[TASK_CLOSED])
      : r === "due" || r === "carried" ? parseDate(card.props[TASK_DUE])
      : r === "logged" ? parseDate(card.props[TASK_CREATED])
      : null;
    if (d) text += ` ${shortDate(d)}`;
    t.setText(text);
  }

  el.addEventListener("click", () => ctx.openCard(card));
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctx.cardMenu({ x: e.clientX, y: e.clientY }, card);
  });
  onHold(el, { menu: (p) => ctx.cardMenu(p, card), drag: true });
  el.addEventListener("dragstart", (e) => {
    drag = card;
    el.addClass("nk-card-dragging");
    e.dataTransfer?.setData("text/card", card.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    drag = null;
    el.removeClass("nk-card-dragging");
  });
}
