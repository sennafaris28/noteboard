import { setIcon } from "obsidian";
import {
  BoardConfig,
  Card,
  INBOX,
  Quest,
  QUEST_START,
  QUEST_TARGET,
  TASK_DUE,
  TimelineZoom,
} from "./types";
import { applyColor } from "./colors";
import { MONTHS, addDays, dayNum, parseDate, shortDate, toISO, today } from "./dates";
import { randomIconFor } from "./modals/emoji-picker";
import { isTouch, onHold, onLongPress } from "./touch";

type Pos = { x: number; y: number };

/** Everything the timeline needs from the board view. */
export interface TimelineCtx {
  config: BoardConfig;
  quests: Quest[];
  cards: Card[];
  questColor(name: string): string | undefined;
  statusColor(card: Card): string | undefined;
  statusText(card: Card): string;
  isDone(card: Card): boolean;
  /** Dropped tasks: closed like Done, but shown with a red ✕. */
  isAbandoned(card: Card): boolean;
  openCard(card: Card): void;
  openQuest(name: string): void;
  questMenu(pos: Pos, name: string): void;
  cardMenu(pos: Pos, card: Card): void;
  /** date: "YYYY-MM-DD" to set, null to clear, undefined to keep. */
  reschedule(path: string, date: string | null | undefined, toQuest: string): void;
  toggleRow(key: string): void;
  /** Persist a new Quests pane width (after a resize drag). */
  setLabelWidth(px: number): void;
  /** Create a task in this quest (INBOX = no quest), optionally due on `date`. */
  addTask(questKey: string, date: string | null): void;
  /** Re-render without changing anything (UI-only state changed). */
  refresh(): void;
  savedScroll: { left: number; top: number } | null;
}

export interface TimelineHandle {
  scrollToToday(): void;
}

const LABEL_W = 280; // default width of the sticky Quests pane
const LABEL_MIN = 180;
const LABEL_MAX = 560;
/** Position `px` from the start of the date track (after the Quests pane). */
const afterPane = (px: number) => `calc(var(--nk-tl-label-w) + ${px}px)`;
const HEAD_H = 52; // quest header row (also the collapsed row)
const TASK_H = 32; // one task row (Rows layout); taller on touch
const FOOT_H = 30; // "+ Add task" row
const BAR_Y = 26; // y of the quest bar inside the header track
const CARD_H = 28; // card height in week buckets
const CARD_GAP = 4;
const CLUSTER_PX = 22; // diamonds closer than this merge into a "+n" bubble
// px per day — Week ≈ 450px/week, Month ≈ 850px/month, Quarter ≈ 300px/month.
const PPD: Record<TimelineZoom, number> = { week: 64, month: 28, quarter: 10 };
const PAD_DAYS: Record<TimelineZoom, number> = { week: 7, month: 14, quarter: 30 };
const MIN_DAYS: Record<TimelineZoom, number> = { week: 28, month: 90, quarter: 270 };

/** The task being dragged (module scope survives re-renders mid-drag). */
let drag: { path: string; due: Date | null } | null = null;
/** Quests whose "Unscheduled" list is expanded in the Weeks layout. */
const openTrays = new Set<string>();

interface RowInfo {
  key: string;
  quest: Quest | null;
  tasks: Card[];
  dated: { c: Card; d: Date }[]; // sorted by date
  undated: Card[]; // sorted by title
  doneN: number;
  abandonedN: number;
  pct: number; // done ÷ (total − abandoned)
  qs: Date | null; // quest Start
  qt: Date | null; // quest Target
  ls: Date | null; // bar start (Start, else earliest task)
  le: Date | null; // bar end (Target, else latest task)
  color: string | undefined;
}

/**
 * Quest timeline. One date axis pinned on top; each quest is a block:
 *  - collapsed → a single line with task diamonds (nearby ones cluster)
 *  - expanded, Rows layout → a header bar, then one row per task
 *  - expanded, Weeks layout → a header bar, then cards stacked in week columns
 */
export function renderTimeline(root: HTMLElement, ctx: TimelineCtx): TimelineHandle {
  const zoom = ctx.config.timelineZoom ?? "month";
  const layout = ctx.config.timelineLayout ?? "rows";
  const ppd = PPD[zoom];
  const now = today();
  const taskH = isTouch() ? 42 : TASK_H;
  const clampW = (w: number) => Math.round(Math.max(LABEL_MIN, Math.min(LABEL_MAX, w)));
  let labelW = clampW(ctx.config.timelineLabelW ?? LABEL_W);
  const dueOf = (c: Card) => parseDate(c.props[TASK_DUE]);

  // ---- Date range: everything with a date, plus today, padded and aligned.
  const stamps: number[] = [now.getTime()];
  for (const q of ctx.quests) {
    for (const k of [QUEST_START, QUEST_TARGET]) {
      const d = parseDate(q.props[k]);
      if (d) stamps.push(d.getTime());
    }
  }
  for (const c of ctx.cards) {
    const d = dueOf(c);
    if (d) stamps.push(d.getTime());
  }
  let start = addDays(new Date(Math.min(...stamps)), -PAD_DAYS[zoom]);
  const end = addDays(new Date(Math.max(...stamps)), PAD_DAYS[zoom]);
  start =
    zoom === "week"
      ? addDays(start, -((start.getDay() + 6) % 7)) // back to Monday
      : new Date(start.getFullYear(), start.getMonth(), 1); // back to the 1st
  const days = Math.max(MIN_DAYS[zoom], dayNum(end) - dayNum(start) + 1);
  const trackW = Math.ceil(days * ppd);
  const xOf = (d: Date) => (dayNum(d) - dayNum(start) + 0.5) * ppd;
  const dateAt = (x: number) =>
    addDays(start, Math.max(0, Math.min(days - 1, Math.floor(x / ppd))));

  // Week buckets (month buckets on Quarter zoom) for the Weeks layout.
  const bucketOf = (d: Date) => {
    if (zoom === "quarter") {
      return {
        start: new Date(d.getFullYear(), d.getMonth(), 1),
        end: new Date(d.getFullYear(), d.getMonth() + 1, 1),
      };
    }
    const s = addDays(d, -((d.getDay() + 6) % 7));
    return { start: s, end: addDays(s, 7) };
  };
  const bucketBox = (b: { start: Date; end: Date }) => ({
    left: Math.max(0, (dayNum(b.start) - dayNum(start)) * ppd),
    width: (dayNum(b.end) - dayNum(b.start)) * ppd,
  });
  /** Date for a drop into a bucket: keep the weekday (or day of month). */
  const bucketDrop = (x: number, prev: Date | null): Date => {
    const b = bucketOf(dateAt(x));
    if (zoom === "quarter") {
      const last = new Date(b.start.getFullYear(), b.start.getMonth() + 1, 0).getDate();
      return new Date(b.start.getFullYear(), b.start.getMonth(), Math.min(prev ? prev.getDate() : 1, last));
    }
    return addDays(b.start, prev ? (prev.getDay() + 6) % 7 : 0);
  };

  // ---- Skeleton
  const wrap = root.createDiv({ cls: "nk-tl" });
  wrap.addClass(`is-${layout}`);
  const scroll = wrap.createDiv({ cls: "nk-tl-scroll" });
  const grid = scroll.createDiv({ cls: "nk-tl-grid" });
  grid.style.width = afterPane(trackW);
  grid.style.setProperty("--nk-tl-label-w", `${labelW}px`);

  const gridlines = grid.createDiv({ cls: "nk-tl-gridlines" });
  gridlines.style.left = "var(--nk-tl-label-w)";
  gridlines.style.width = `${trackW}px`;

  const axis = grid.createDiv({ cls: "nk-tl-axis" });
  const corner = axis.createDiv({ cls: "nk-tl-corner", text: "Quests" });

  /** Drag the pane's right edge to resize it; saved on release. */
  const addResizer = (host: HTMLElement) => {
    const handle = host.createDiv({ cls: "nk-tl-resize", attr: { "aria-label": "Drag to resize" } });
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = labelW;
      handle.setPointerCapture(e.pointerId);
      grid.addClass("is-resizing");
      const move = (ev: PointerEvent) => {
        labelW = clampW(startW + ev.clientX - startX);
        grid.style.setProperty("--nk-tl-label-w", `${labelW}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        grid.removeClass("is-resizing");
        ctx.setLabelWidth(labelW);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
    handle.addEventListener("dblclick", () => {
      labelW = LABEL_W;
      grid.style.setProperty("--nk-tl-label-w", `${labelW}px`);
      ctx.setLabelWidth(labelW);
    });
  };
  addResizer(corner);
  const axisTrack = axis.createDiv({ cls: "nk-tl-axis-track" });
  axisTrack.style.width = `${trackW}px`;
  for (let i = 0; i < days; i++) {
    const tick = tickFor(addDays(start, i), i === 0, zoom);
    if (!tick) continue;
    const line = gridlines.createDiv({ cls: "nk-tl-gridline" });
    line.toggleClass("is-major", tick.major);
    line.style.left = `${i * ppd}px`;
    if (tick.label) {
      const label = axisTrack.createDiv({ cls: "nk-tl-tick", text: tick.label });
      label.toggleClass("is-major", tick.major);
      label.style.left = `${i * ppd}px`;
    }
  }

  // Today marker + a hover cursor line that shows the date under the mouse.
  const tx = xOf(now);
  grid.createDiv({ cls: "nk-tl-today" }).style.left = afterPane(tx);
  axisTrack.createDiv({ cls: "nk-tl-today-pill", text: "Today" }).style.left = `${tx}px`;
  const hoverLine = grid.createDiv({ cls: "nk-tl-hover" });
  const hoverPill = axisTrack.createDiv({ cls: "nk-tl-hover-pill" });
  grid.addEventListener("mousemove", (e) => {
    const x = e.clientX - grid.getBoundingClientRect().left - labelW;
    if (x < 0 || (e.target as HTMLElement).closest(".nk-tl-label, .nk-tl-corner")) {
      grid.removeClass("is-hovering");
      return;
    }
    const d = dateAt(x);
    hoverLine.style.left = afterPane(xOf(d));
    hoverPill.style.left = `${xOf(d)}px`;
    hoverPill.setText(shortDate(d));
    grid.addClass("is-hovering");
  });
  grid.addEventListener("mouseleave", () => grid.removeClass("is-hovering"));

  // ---- Shared building blocks
  const clearDrag = () => {
    drag = null;
    root.findAll(".nk-tl-guide, .nk-tl-bucket-hl").forEach((n) => n.remove());
    root.findAll(".is-drop-label").forEach((n) => n.removeClass("is-drop-label"));
    root.findAll(".is-dragging").forEach((n) => n.removeClass("is-dragging"));
  };

  const makeDraggable = (el: HTMLElement, c: Card) => {
    el.setAttr("draggable", "true");
    onHold(el, { drag: true }); // finger: hold, then drag
    el.addEventListener("dragstart", (e) => {
      drag = { path: c.path, due: dueOf(c) };
      el.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", c.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
    });
    el.addEventListener("dragend", clearDrag);
  };

  const searchText = (c: Card) =>
    [c.title, ...Object.values(c.props).flatMap((v) => (Array.isArray(v) ? v : [v])).map(String)].join(" ");
  const iconOf = (c: Card) => {
    const explicit = typeof c.props.icon === "string" ? c.props.icon.trim() : "";
    return explicit || (ctx.config.randomIcons !== false ? randomIconFor(c.path) : "");
  };
  const tip = (c: Card, d: Date | null) =>
    `${c.title} · ${d ? `Due ${shortDate(d)}` : "No date"} · ${ctx.statusText(c) || "No status"}`;
  const flags = (el: HTMLElement, c: Card, d: Date | null) => {
    const done = ctx.isDone(c);
    const abandoned = ctx.isAbandoned(c);
    el.toggleClass("is-done", done);
    el.toggleClass("is-abandoned", abandoned);
    el.toggleClass("is-overdue", !!d && !done && !abandoned && dayNum(d) < dayNum(now));
  };

  /** Right-click / long-press → the card menu. */
  const wireMenu = (el: HTMLElement, c: Card) => {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      ctx.cardMenu({ x: e.clientX, y: e.clientY }, c);
    });
    onLongPress(el, (p) => ctx.cardMenu(p, c));
  };

  /** A task as a pill: status dot, icon, title. Click opens, drag reschedules. */
  const taskPill = (parent: HTMLElement, c: Card, d: Date | null, cls: string) => {
    const el = parent.createDiv({ cls });
    el.setAttr("data-search", searchText(c));
    el.setAttr("title", tip(c, d));
    const sdot = el.createSpan({ cls: "nk-tl-sdot" });
    const sc = ctx.statusColor(c);
    if (sc) applyColor(sdot, sc);
    const ic = iconOf(c);
    if (ic) el.createSpan({ cls: "nk-tl-cicon", text: ic });
    el.createSpan({ cls: "nk-tl-ctitle", text: c.title });
    flags(el, c, d);
    el.addEventListener("click", () => ctx.openCard(c));
    wireMenu(el, c);
    makeDraggable(el, c);
    return el;
  };

  /** A task as a diamond on a line. */
  const diamond = (parent: HTMLElement, c: Card, d: Date, x: number, y: number) => {
    const el = parent.createDiv({ cls: "nk-tl-diamond" });
    const sc = ctx.statusColor(c);
    if (sc) applyColor(el, sc);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.setAttr("title", tip(c, d));
    flags(el, c, d);
    el.addEventListener("click", () => ctx.openCard(c));
    wireMenu(el, c);
    makeDraggable(el, c);
    return el;
  };

  /** One grid row: sticky label cell + a track the width of the date range. */
  const makeRow = (block: HTMLElement, cls: string, height: number) => {
    const rowEl = block.createDiv({ cls: `nk-tl-row ${cls}` });
    const label = rowEl.createDiv({ cls: "nk-tl-label" });
    addResizer(label);
    const track = rowEl.createDiv({ cls: "nk-tl-track" });
    track.style.width = `${trackW}px`;
    track.style.height = `${height}px`;
    return { rowEl, label, track };
  };
  const xIn = (e: MouseEvent, el: HTMLElement) => e.clientX - el.getBoundingClientRect().left;

  const addButton = (parent: HTMLElement, key: string) => {
    const btn = parent.createDiv({ cls: "nk-tl-add" });
    setIcon(btn.createSpan({ cls: "nk-footer-icon" }), "plus");
    btn.createSpan({ text: " Add task" });
    btn.addEventListener("click", () => ctx.addTask(key, null));
  };

  /** Quest header: label (name, progress, dates) + the quest bar in the track. */
  const headRow = (block: HTMLElement, info: RowInfo, collapsed: boolean, barH: number) => {
    const r = makeRow(block, "nk-tl-headrow", HEAD_H);
    const head = r.label.createDiv({ cls: "nk-tl-qhead" });
    const chev = head.createDiv({ cls: "nk-icon-btn nk-sm nk-tl-chev" });
    setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
    chev.setAttr("aria-label", collapsed ? "Expand" : "Collapse");
    chev.addEventListener("click", () => ctx.toggleRow(info.key));
    if (info.quest) {
      const qi = typeof info.quest.props.icon === "string" ? info.quest.props.icon.trim() : "";
      head.createSpan({ cls: "nk-tl-qicon", text: qi || randomIconFor(info.quest.folderPath) });
    }
    const name = head.createSpan({
      cls: "nk-col-pill nk-tl-qname",
      text: info.quest ? info.key : "No quest",
    });
    applyColor(name, info.color ?? "default");
    if (info.quest) {
      name.setAttr("title", "Open quest note");
      name.addEventListener("click", () => ctx.openQuest(info.key));
      const more = head.createDiv({ cls: "nk-icon-btn nk-sm nk-tl-more" });
      setIcon(more, "more-horizontal");
      more.addEventListener("click", (e) => ctx.questMenu({ x: e.clientX, y: e.clientY }, info.key));
      r.label.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ctx.questMenu({ x: e.clientX, y: e.clientY }, info.key);
      });
      onLongPress(r.label, (p) => ctx.questMenu(p, info.key));
    }

    const meta = r.label.createDiv({ cls: "nk-tl-qmeta" });
    const radiant = !!info.quest?.radiant;
    if (!radiant) {
      const mini = meta.createDiv({ cls: "nk-tl-mini" });
      mini.createDiv({ cls: "nk-tl-mini-fill" }).style.width = `${info.pct}%`;
    }
    const bits = radiant
      ? [`∞ ${info.tasks.length - info.doneN - info.abandonedN} open · ${info.doneN} done`]
      : [`${info.doneN}/${info.tasks.length - info.abandonedN}`];
    if (info.abandonedN) bits.push(`✕ ${info.abandonedN}`);
    if (info.quest && !radiant) {
      bits.push(
        info.qs || info.qt
          ? `${info.qs ? shortDate(info.qs) : "?"} → ${info.qt ? shortDate(info.qt) : "?"}`
          : "no dates"
      );
    }
    if (collapsed && info.undated.length) bits.push(`${info.undated.length} undated`);
    meta.createSpan({ cls: "nk-tl-qmeta-txt", text: bits.join(" · ") });

    // Track: faint baseline, quest bar (Start → Target) filled to progress, 🏁.
    r.track.createDiv({ cls: "nk-tl-baseline" }).style.top = `${BAR_Y}px`;
    if (info.ls && info.le) {
      const x1 = xOf(info.ls);
      const x2 = xOf(info.le);
      const qbar = r.track.createDiv({ cls: "nk-tl-bar" });
      if (info.color && info.color !== "default") applyColor(qbar, info.color);
      qbar.style.left = `${Math.min(x1, x2)}px`;
      qbar.style.width = `${Math.max(barH, Math.abs(x2 - x1))}px`;
      qbar.style.top = `${BAR_Y}px`;
      qbar.style.height = `${barH}px`;
      qbar.createDiv({ cls: "nk-tl-bar-fill" }).style.width = `${info.pct}%`;
    }
    if (info.qt) {
      const fl = r.track.createDiv({ cls: "nk-tl-flag", text: "🏁" });
      fl.style.left = `${xOf(info.qt)}px`;
      fl.style.top = `${BAR_Y}px`;
      fl.setAttr("title", `Target · ${shortDate(info.qt)}`);
    }
    r.track.setAttr("title", "Double-click to add a task on this date");
    r.track.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".nk-tl-diamond, .nk-tl-cluster")) return;
      ctx.addTask(info.key, toISO(dateAt(xIn(e, r.track))));
    });
    return r;
  };

  /**
   * Drop handling for a whole quest block: drop on a track to (re)schedule
   * the task in this quest; drop on the label column to unschedule it.
   */
  const wireBlock = (block: HTMLElement, key: string, mode: "date" | "bucket") => {
    const removeMarks = () =>
      block.findAll(".nk-tl-guide, .nk-tl-bucket-hl").forEach((n) => n.remove());
    block.addEventListener("dragover", (e) => {
      if (!drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const inLabel = !!(e.target as HTMLElement).closest(".nk-tl-label");
      block.toggleClass("is-drop-label", inLabel);
      // Only the block under the cursor shows a guide.
      root.findAll(".nk-tl-guide, .nk-tl-bucket-hl").forEach((n) => {
        if (!block.contains(n)) n.remove();
      });
      if (inLabel) {
        removeMarks();
        return;
      }
      const x = xIn(e, block) - labelW;
      if (mode === "bucket") {
        const box = bucketBox(bucketOf(dateAt(x)));
        let hl = block.querySelector<HTMLElement>(".nk-tl-bucket-hl");
        if (!hl) hl = block.createDiv({ cls: "nk-tl-bucket-hl" });
        hl.style.left = afterPane(box.left);
        hl.style.width = `${box.width}px`;
        return;
      }
      const d = dateAt(x);
      let guide = block.querySelector<HTMLElement>(".nk-tl-guide");
      if (!guide) {
        guide = block.createDiv({ cls: "nk-tl-guide" });
        guide.createSpan({ cls: "nk-tl-guide-label" });
      }
      guide.style.left = afterPane(xOf(d));
      (guide.firstElementChild as HTMLElement).setText(shortDate(d));
    });
    block.addEventListener("dragleave", (e) => {
      if (!block.contains(e.relatedTarget as Node)) {
        removeMarks();
        block.removeClass("is-drop-label");
      }
    });
    block.addEventListener("drop", (e) => {
      if (!drag) return;
      e.preventDefault();
      const d = drag;
      const inLabel = !!(e.target as HTMLElement).closest(".nk-tl-label");
      const x = xIn(e, block) - labelW;
      clearDrag();
      if (inLabel) {
        ctx.reschedule(d.path, null, key);
        return;
      }
      const date = mode === "bucket" ? bucketDrop(x, d.due) : dateAt(x);
      ctx.reschedule(d.path, toISO(date), key);
    });
  };

  // ---- Layout B: collapsed — one line, diamonds, clusters.
  const collapsedLayout = (block: HTMLElement, info: RowInfo) => {
    const r = headRow(block, info, true, 6);
    const pts = info.dated.map((it) => ({ ...it, x: xOf(it.d) }));
    const groups: (typeof pts)[] = [];
    for (const p of pts) {
      const g = groups[groups.length - 1];
      if (g && p.x - g[g.length - 1].x <= CLUSTER_PX) g.push(p);
      else groups.push([p]);
    }
    const centers = groups.map((g) => g.reduce((s, p) => s + p.x, 0) / g.length);
    groups.forEach((g, i) => {
      const cx = centers[i];
      if (g.length > 1) {
        const bubble = r.track.createDiv({ cls: "nk-tl-cluster", text: String(g.length) });
        bubble.style.left = `${cx}px`;
        bubble.style.top = `${BAR_Y}px`;
        bubble.setAttr("title", `${g.map((p) => p.c.title).join("\n")}\n\nClick to expand`);
        bubble.addEventListener("click", () => ctx.toggleRow(info.key));
        const late = (p: (typeof g)[number]) =>
          !ctx.isDone(p.c) && !ctx.isAbandoned(p.c) && dayNum(p.d) < dayNum(now);
        if (g.some(late)) bubble.addClass("is-overdue");
        return;
      }
      const p = g[0];
      diamond(r.track, p.c, p.d, cx, BAR_Y);
      // Name under the diamond when there's room before its neighbours.
      const room = Math.min(
        i > 0 ? cx - centers[i - 1] : Infinity,
        i < centers.length - 1 ? centers[i + 1] - cx : Infinity
      );
      const w = Math.min(150, room - 10);
      if (w >= 48) {
        const lbl = r.track.createDiv({ cls: "nk-tl-dname", text: p.c.title });
        lbl.style.left = `${cx}px`;
        lbl.style.maxWidth = `${w}px`;
      }
    });
    wireBlock(block, info.key, "date");
  };

  // ---- Layout A: rows — header bar, then one row per task.
  const rowsLayout = (block: HTMLElement, info: RowInfo) => {
    headRow(block, info, false, 10);
    const items = [...info.dated, ...info.undated.map((c) => ({ c, d: null as Date | null }))];
    for (const { c, d } of items) {
      const r = makeRow(block, "nk-tl-taskrow", taskH);
      r.rowEl.setAttr("data-search", searchText(c));
      const pill = taskPill(r.label, c, d, "nk-tl-task");
      if (!d) pill.createSpan({ cls: "nk-tl-nodate", text: "no date" });
      if (d) {
        diamond(r.track, c, d, xOf(d), taskH / 2);
        const dl = r.track.createDiv({ cls: "nk-tl-dlabel", text: shortDate(d) });
        dl.style.left = `${xOf(d) + 12}px`;
        flags(dl, c, d);
      }
      r.track.setAttr(
        "title",
        d ? "Drag the diamond to reschedule" : "Double-click to schedule this task here"
      );
      r.track.addEventListener("dblclick", (e) => {
        if ((e.target as HTMLElement).closest(".nk-tl-diamond")) return;
        ctx.reschedule(c.path, toISO(dateAt(xIn(e, r.track))), info.key);
      });
    }
    const f = makeRow(block, "nk-tl-footrow", FOOT_H);
    addButton(f.label, info.key);
    f.track.setAttr("title", "Double-click to add a task on this date");
    f.track.addEventListener("dblclick", (e) =>
      ctx.addTask(info.key, toISO(dateAt(xIn(e, f.track))))
    );
    wireBlock(block, info.key, "date");
  };

  // ---- Layout C: weeks — header bar, then cards stacked in week columns.
  const weeksLayout = (block: HTMLElement, info: RowInfo) => {
    headRow(block, info, false, 10);
    const groups = new Map<number, { b: { start: Date; end: Date }; items: { c: Card; d: Date }[] }>();
    for (const it of info.dated) {
      const b = bucketOf(it.d);
      const k = dayNum(b.start);
      if (!groups.has(k)) groups.set(k, { b, items: [] });
      groups.get(k)!.items.push(it);
    }
    const maxStack = Math.max(0, ...[...groups.values()].map((g) => g.items.length));
    const r = makeRow(
      block,
      "nk-tl-bucketrow",
      Math.max(48, maxStack * (CARD_H + CARD_GAP) + 10)
    );
    for (const g of groups.values()) {
      const box = bucketBox(g.b);
      const col = r.track.createDiv({ cls: "nk-tl-bucket" });
      col.style.left = `${box.left}px`;
      col.style.width = `${box.width}px`;
      for (const it of g.items) {
        const card = taskPill(col, it.c, it.d, "nk-tl-card");
        card.createSpan({ cls: "nk-tl-cdate", text: shortDate(it.d) });
      }
    }
    r.track.setAttr("title", "Double-click to add a task in this week");
    r.track.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".nk-tl-card")) return;
      ctx.addTask(info.key, toISO(bucketDrop(xIn(e, r.track), null)));
    });

    addButton(r.label, info.key);
    if (info.undated.length) {
      const open = openTrays.has(info.key);
      const toggle = r.label.createDiv({ cls: "nk-tl-tray-toggle" });
      setIcon(toggle.createSpan({ cls: "nk-footer-icon" }), open ? "chevron-down" : "chevron-right");
      toggle.createSpan({ text: ` Unscheduled · ${info.undated.length}` });
      toggle.addEventListener("click", () => {
        if (open) openTrays.delete(info.key);
        else openTrays.add(info.key);
        ctx.refresh();
      });
      if (open) {
        const tray = r.label.createDiv({ cls: "nk-tl-tray" });
        for (const c of info.undated) taskPill(tray, c, null, "nk-tl-chip");
      }
    }
    wireBlock(block, info.key, "bucket");
  };

  // ---- Blocks: one per quest, then "No quest" if it has tasks.
  const rows: { key: string; quest: Quest | null }[] = ctx.quests.map((q) => ({
    key: q.name,
    quest: q,
  }));
  if (ctx.cards.some((c) => c.quest === null)) rows.push({ key: INBOX, quest: null });
  if (!rows.length) {
    grid.createDiv({
      cls: "nk-tl-empty",
      text: 'No quests yet. Switch to Board → "Add a quest" to start one.',
    });
  }

  const collapsed = new Set(ctx.config.timelineCollapsed ?? []);
  for (const row of rows) {
    const tasks = ctx.cards.filter((c) => (c.quest ?? INBOX) === row.key);
    const dated = tasks
      .map((c) => ({ c, d: dueOf(c) }))
      .filter((x): x is { c: Card; d: Date } => x.d !== null)
      .sort((a, b) => a.d.getTime() - b.d.getTime());
    const undated = tasks.filter((c) => !dueOf(c)).sort((a, b) => a.title.localeCompare(b.title));
    const doneN = tasks.filter((c) => ctx.isDone(c)).length;
    const abandonedN = tasks.filter((c) => ctx.isAbandoned(c)).length;
    // Radiant quests are endless: no Start/Target, no goal bar.
    const definite = !!row.quest && !row.quest.radiant;
    const qs = definite ? parseDate(row.quest!.props[QUEST_START]) : null;
    const qt = definite ? parseDate(row.quest!.props[QUEST_TARGET]) : null;
    let ls = definite ? qs ?? dated[0]?.d ?? null : null;
    let le = definite ? qt ?? dated[dated.length - 1]?.d ?? null : null;
    if (ls && !le) le = ls;
    if (le && !ls) ls = le;
    const info: RowInfo = {
      key: row.key,
      quest: row.quest,
      tasks,
      dated,
      undated,
      doneN,
      abandonedN,
      pct: tasks.length - abandonedN ? Math.round((doneN / (tasks.length - abandonedN)) * 100) : 0,
      qs,
      qt,
      ls,
      le,
      color: row.quest ? ctx.questColor(row.key) : undefined,
    };

    const block = grid.createDiv({ cls: "nk-tl-block" });
    if (collapsed.has(row.key)) {
      block.addClass("is-collapsed");
      collapsedLayout(block, info);
    } else if (layout === "weeks") {
      weeksLayout(block, info);
    } else {
      rowsLayout(block, info);
    }
    const rowEls = block.findAll(".nk-tl-row");
    rowEls[0]?.addClass("is-first");
    rowEls[rowEls.length - 1]?.addClass("is-last");
  }

  const scrollToToday = () => {
    scroll.scrollLeft = Math.max(0, tx - 0.3 * (scroll.clientWidth - labelW));
  };
  // Restore right away (not just next frame): a second re-render can land
  // before the frame and would otherwise read — and keep — a 0 scroll.
  const saved = ctx.savedScroll;
  const restore = () => {
    if (saved) {
      scroll.scrollLeft = saved.left;
      scroll.scrollTop = saved.top;
    } else {
      scrollToToday();
    }
  };
  restore();
  window.requestAnimationFrame(restore);
  return { scrollToToday };
}

/** Axis tick for a given day: a label and/or a gridline, or nothing. */
function tickFor(
  d: Date,
  first: boolean,
  zoom: TimelineZoom
): { label: string; major: boolean } | null {
  const monthStart = d.getDate() === 1;
  const withYear = (m: string) => (first || d.getMonth() === 0 ? `${m} ${d.getFullYear()}` : m);
  if (zoom === "week") {
    if (d.getDay() === 1) {
      const yr = first || (d.getMonth() === 0 && d.getDate() <= 7) ? ` ${d.getFullYear()}` : "";
      return { label: `${shortDate(d)}${yr}`, major: monthStart };
    }
    return monthStart ? { label: "", major: true } : null;
  }
  if (zoom === "month") {
    if (monthStart || first) return { label: withYear(MONTHS[d.getMonth()]), major: true };
    return d.getDay() === 1 ? { label: `${d.getDate()}`, major: false } : null; // weekly ticks
  }
  if (monthStart || first) {
    return { label: withYear(MONTHS[d.getMonth()]), major: d.getMonth() % 3 === 0 };
  }
  return null;
}
