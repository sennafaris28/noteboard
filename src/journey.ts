import { setIcon } from "obsidian";
import { BoardConfig, Card, INBOX, Quest, TASK_DUE } from "./types";
import { applyColor } from "./colors";
import { dayNum, parseDate, shortDate, today } from "./dates";
import { randomIconFor } from "./modals/emoji-picker";
import { onHold, onLongPress } from "./touch";

type Pos = { x: number; y: number };

/** Everything the journey view needs from the board view. */
export interface JourneyCtx {
  config: BoardConfig;
  quests: Quest[];
  /** Tasks per quest key (quest name, or INBOX), in board order. */
  ordered: Map<string, Card[]>;
  /** How many of this quest's tasks are archived (hidden from the view). */
  archivedCount(questKey: string): number;
  /** True if this task shares a step with the task before it (a branch). */
  isStacked(path: string): boolean;
  /** Goal text from the quest note ("" if none / not loaded yet). */
  goalOf(questName: string): string;
  touch: boolean;
  questColor(name: string): string | undefined;
  statusColor(card: Card): string | undefined;
  statusText(card: Card): string;
  isDone(card: Card): boolean;
  /** Dropped tasks: closed like Done, but shown with a red ✕. */
  isAbandoned(card: Card): boolean;
  openCard(card: Card): void;
  cardMenu(pos: Pos, card: Card): void;
  openQuest(name: string): void;
  questMenu(pos: Pos, name: string): void;
  /** Give a task its own step at flat `index` in quest `toKey`. */
  move(path: string, fromKey: string, toKey: string, index: number): void;
  /** Stack a task into the step of `ontoPath` (a parallel branch). */
  stack(path: string, fromKey: string, toKey: string, ontoPath: string): void;
  addTask(questKey: string): void;
  toggleRow(key: string): void;
  /** When a task was logged (ms) — orders radiant quests. */
  createdOf(card: Card): number;
  newQuest(): void;
  /** Re-render without changing anything (UI-only state changed). */
  refresh(): void;
  savedScroll: { left: number; top: number } | null;
  /** Each quest lane's own horizontal scroll, by quest key. */
  laneScroll: Map<string, number>;
}

const START_X = 28; // start dot
const FIRST_X = 64; // left edge of the first step's cards
const LINE_Y = 24; // y of the quest line
const STEM = 20; // line → first card gap
const CARD_H = 78;
const STACK_GAP = 10; // between stacked (parallel) cards
const GAP = 22; // between steps
const RAIL = 11; // branch rail sits this far left of a stacked step

/** Task being dragged (module scope survives a re-render mid-drag). */
let drag: { path: string; fromKey: string } | null = null;
/** Radiant quests whose done tasks are expanded. */
const shownDone = new Set<string>();

/**
 * Journey view: one line per quest, tasks hanging below it in order — no
 * dates, just the path. Tasks that run in parallel (same work, different
 * platform) share a step and stack under one stop. The line fills up to the
 * last fully-done step; ＋ adds the next task; 🏁 marks the goal.
 */
export function renderJourney(root: HTMLElement, ctx: JourneyCtx): void {
  const cardW = ctx.touch ? 220 : 200;
  const step = cardW + GAP;
  const now = today();

  const scroll = root.createDiv({ cls: "nk-jr" });
  const inner = scroll.createDiv({ cls: "nk-jr-inner" });

  const rows: { key: string; quest: Quest | null }[] = ctx.quests.map((q) => ({ key: q.name, quest: q }));
  if ((ctx.ordered.get(INBOX) ?? []).length) rows.push({ key: INBOX, quest: null });
  if (!rows.length) {
    inner.createDiv({ cls: "nk-jr-empty", text: "No quests yet." });
  }

  const collapsed = new Set(ctx.config.journeyCollapsed ?? []);

  /** Each quest's lane scrolls sideways on its own; the page only scrolls down. */
  const laneHost = (block: HTMLElement, key: string, cls: string) => {
    const wrap = block.createDiv({ cls: "nk-jr-lanewrap", attr: { "data-key": key } });
    return { wrap, lane: wrap.createDiv({ cls }) };
  };
  /** Put a lane back where it was (now, and again next frame — see below). */
  const restoreLane = (wrap: HTMLElement, key: string) => {
    const x = ctx.laneScroll.get(key);
    if (!x) return;
    wrap.scrollLeft = x;
    window.requestAnimationFrame(() => (wrap.scrollLeft = x));
  };

  // Radiant quests (endless logs) sit on top, then "New quest", then the
  // definite quests and finally "No quest".
  const radiantRows = rows.filter((r) => r.quest?.radiant);
  const otherRows = rows.filter((r) => !r.quest?.radiant);
  const sequence: ({ key: string; quest: Quest | null } | "new-quest")[] = [
    ...radiantRows,
    "new-quest",
    ...otherRows,
  ];

  for (const row of sequence) {
    if (row === "new-quest") {
      const nq = inner.createDiv({ cls: "nk-jr-newquest" });
      setIcon(nq.createSpan({ cls: "nk-footer-icon" }), "plus");
      nq.createSpan({ text: " New quest" });
      nq.addEventListener("click", () => ctx.newQuest());
      continue;
    }
    const tasks = ctx.ordered.get(row.key) ?? [];
    // Group into steps: a stacked task joins the step before it.
    const steps: Card[][] = [];
    for (const c of tasks) {
      if (steps.length && ctx.isStacked(c.path)) steps[steps.length - 1].push(c);
      else steps.push([c]);
    }
    const doneN = tasks.filter((c) => ctx.isDone(c)).length;
    const abN = tasks.filter((c) => ctx.isAbandoned(c)).length;
    // Abandoned tasks don't count against progress.
    const counted = tasks.length - abN;
    const pct = counted ? Math.round((doneN / counted) * 100) : 0;
    const abText = abN ? ` · ✕ ${abN}` : "";
    const isCollapsed = collapsed.has(row.key);
    const color = row.quest ? ctx.questColor(row.key) : undefined;
    const goal = row.quest ? ctx.goalOf(row.key) : "";

    const block = inner.createDiv({ cls: "nk-jr-block" });
    block.toggleClass("is-collapsed", isCollapsed);

    // ---- Header (sticky left so the name stays visible while scrolling)
    const head = block.createDiv({ cls: "nk-jr-head" });
    const chev = head.createDiv({ cls: "nk-icon-btn nk-sm" });
    setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
    chev.setAttr("aria-label", isCollapsed ? "Expand" : "Collapse");
    chev.addEventListener("click", () => ctx.toggleRow(row.key));
    if (row.quest) {
      const qi = typeof row.quest.props.icon === "string" ? row.quest.props.icon.trim() : "";
      head.createSpan({ cls: "nk-jr-qicon", text: qi || randomIconFor(row.quest.folderPath) });
    }
    const pill = head.createSpan({ cls: "nk-col-pill nk-jr-qname", text: row.quest ? row.key : "No quest" });
    applyColor(pill, color ?? "default");
    const radiant = !!row.quest?.radiant;
    if (radiant) {
      // Endless quest: no % — just what's open and what's been handled.
      head.createSpan({ cls: "nk-jr-radiant", text: "∞ radiant" });
      head.createSpan({
        cls: "nk-jr-qmeta",
        text: `${tasks.length - doneN - abN} open · ${doneN} done${abN ? ` · ${abN} abandoned` : ""}`,
      });
    } else {
      const mini = head.createDiv({ cls: "nk-tl-mini" });
      mini.createDiv({ cls: "nk-tl-mini-fill" }).style.width = `${pct}%`;
      head.createSpan({ cls: "nk-jr-qmeta", text: `${doneN}/${counted} · ${pct}%${abText}` });
    }
    const archivedN = ctx.archivedCount(row.key);
    if (archivedN) {
      head.createSpan({
        cls: "nk-jr-archived",
        text: `🗄 ${archivedN}`,
        attr: { title: `${archivedN} archived — hidden here, still on the Board` },
      });
    }
    if (row.quest) {
      pill.setAttr("title", "Open quest note");
      pill.addEventListener("click", () => ctx.openQuest(row.key));
      const more = head.createDiv({ cls: "nk-icon-btn nk-sm nk-jr-more" });
      setIcon(more, "more-horizontal");
      more.addEventListener("click", (e) => ctx.questMenu({ x: e.clientX, y: e.clientY }, row.key));
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ctx.questMenu({ x: e.clientX, y: e.clientY }, row.key);
      });
      onLongPress(head, (p) => ctx.questMenu(p, row.key));
    }
    if (goal) {
      const g = block.createDiv({ cls: "nk-jr-goal" });
      g.createSpan({ cls: "nk-jr-goal-label", text: "🎯 Goal " });
      g.createSpan({ text: goal });
    }

    if (radiant) {
      radiantLane(block, row.key, tasks, isCollapsed);
      continue;
    }

    // ---- Lane: line, numbered stops, cards below, ＋ stop, 🏁
    const { wrap, lane } = laneHost(block, row.key, "nk-jr-lane");
    const leftOf = (i: number) => FIRST_X + i * step;
    const centerOf = (i: number) => leftOf(i) + cardW / 2;
    const cardTop = (k: number) => LINE_Y + STEM + k * (CARD_H + STACK_GAP);
    const addX = centerOf(steps.length);
    const flagX = addX + cardW / 2 + 36;
    const width = (row.quest ? flagX : addX + cardW / 2) + 40;
    const deepest = Math.max(1, ...steps.map((s) => s.length));
    const height = isCollapsed ? LINE_Y + 24 : cardTop(deepest) - STACK_GAP + 18;
    lane.style.width = `${width}px`;
    lane.style.height = `${height}px`;

    const line = lane.createDiv({ cls: "nk-jr-line" });
    line.style.left = `${START_X}px`;
    line.style.width = `${(row.quest ? flagX : addX) - START_X}px`;
    line.style.top = `${LINE_Y}px`;
    // A step is finished once every task in it is Done or Abandoned.
    const closed = (c: Card) => ctx.isDone(c) || ctx.isAbandoned(c);
    const stepDone = (s: Card[]) => s.every(closed);
    let lastDone = -1;
    steps.forEach((s, i) => {
      if (stepDone(s)) lastDone = i;
    });
    if (lastDone >= 0) {
      const walked = lane.createDiv({ cls: "nk-jr-walked" });
      if (color && color !== "default") applyColor(walked, color);
      walked.style.left = `${START_X}px`;
      walked.style.width = `${centerOf(lastDone) - START_X}px`;
      walked.style.top = `${LINE_Y}px`;
    }
    const startDot = lane.createDiv({ cls: "nk-jr-start" });
    if (color && color !== "default") applyColor(startDot, color);
    startDot.style.left = `${START_X}px`;
    startDot.style.top = `${LINE_Y}px`;

    /** Card boxes per step, for drop targeting. */
    const stepBoxes: { paths: string[]; left: number; right: number }[] = [];

    steps.forEach((s, i) => {
      const cx = centerOf(i);
      const allClosed = stepDone(s);
      // ✓ if anything in the step got done; ✕ if it was all abandoned.
      const allAbandoned = allClosed && !s.some((c) => ctx.isDone(c));
      const allDone = allClosed && !allAbandoned;
      const anyOverdue = s.some((c) => {
        const d = parseDate(c.props[TASK_DUE]);
        return !!d && !closed(c) && dayNum(d) < dayNum(now);
      });
      const node = lane.createDiv({
        cls: "nk-jr-node",
        text: allAbandoned ? "✕" : allDone ? "✓" : String(i + 1),
      });
      const sc = ctx.statusColor(s[0]);
      if (sc) applyColor(node, sc);
      node.toggleClass("is-done", allDone);
      node.toggleClass("is-abandoned", allAbandoned);
      node.toggleClass("is-overdue", anyOverdue);
      node.toggleClass("is-branch", s.length > 1);
      node.style.left = `${cx}px`;
      node.style.top = `${LINE_Y}px`;
      node.setAttr(
        "title",
        s.map((c) => `${c.title} · ${ctx.statusText(c) || "No status"}`).join("\n")
      );
      node.addEventListener("click", () => ctx.openCard(s[0]));
      if (s.length > 1) {
        const badge = lane.createDiv({ cls: "nk-jr-branch", text: `⑂ ${s.length}` });
        badge.style.left = `${cx + 16}px`;
        badge.style.top = `${LINE_Y}px`;
      }
      stepBoxes.push({ paths: s.map((c) => c.path), left: leftOf(i), right: leftOf(i) + cardW });
      if (isCollapsed) return;

      const stem = lane.createDiv({ cls: "nk-jr-stem" });
      stem.style.left = `${cx}px`;
      stem.style.top = `${LINE_Y}px`;
      stem.style.height = `${STEM}px`;

      // Branch rail: a fork down the left of a stacked step, one tick per card.
      if (s.length > 1) {
        const railX = leftOf(i) - RAIL;
        const rail = lane.createDiv({ cls: "nk-jr-rail" });
        rail.style.left = `${railX}px`;
        rail.style.top = `${LINE_Y}px`;
        rail.style.height = `${cardTop(s.length - 1) + CARD_H / 2 - LINE_Y}px`;
        s.forEach((_, k) => {
          const tick = lane.createDiv({ cls: "nk-jr-tick" });
          tick.style.left = `${railX}px`;
          tick.style.top = `${cardTop(k) + CARD_H / 2}px`;
          tick.style.width = `${RAIL}px`;
        });
      }

      s.forEach((c, k) => renderCard(lane, c, leftOf(i), cardTop(k), row.key));
    });

    // ＋ stop: add the next task.
    const addNode = lane.createDiv({ cls: "nk-jr-node is-add" });
    setIcon(addNode, "plus");
    addNode.style.left = `${addX}px`;
    addNode.style.top = `${LINE_Y}px`;
    addNode.setAttr("title", "Add task");
    addNode.addEventListener("click", () => ctx.addTask(row.key));
    if (!isCollapsed) {
      const ghost = lane.createDiv({ cls: "nk-jr-ghost" });
      ghost.style.left = `${leftOf(steps.length)}px`;
      ghost.style.top = `${cardTop(0)}px`;
      ghost.style.width = `${cardW}px`;
      ghost.style.height = `${CARD_H}px`;
      setIcon(ghost.createSpan({ cls: "nk-footer-icon" }), "plus");
      ghost.createSpan({ text: tasks.length ? " Add next task" : " Add the first task" });
      ghost.addEventListener("click", () => ctx.addTask(row.key));
    }
    if (row.quest) {
      const flag = lane.createDiv({ cls: "nk-jr-flag", text: "🏁" });
      flag.style.left = `${flagX}px`;
      flag.style.top = `${LINE_Y}px`;
      flag.setAttr("title", goal ? `Goal: ${goal}` : "Goal");
    }

    // ---- Drop: onto a card = stack into its step (branch);
    //            in a gap between steps = its own step there.
    const gapFor = (x: number) => {
      const others = stepBoxes
        .map((b) => ({ ...b, paths: b.paths.filter((p) => p !== drag?.path) }))
        .filter((b) => b.paths.length);
      const before = others.filter((b) => (b.left + b.right) / 2 < x);
      const index = before.reduce((n, b) => n + b.paths.length, 0); // flat card index
      const prev = before[before.length - 1];
      const next = others[before.length];
      const at = prev && next
        ? (prev.right + next.left) / 2
        : prev
          ? prev.right + GAP / 2
          : next
            ? next.left - GAP / 2
            : FIRST_X - GAP / 2;
      return { index, at };
    };
    const clearMarks = () => {
      root.findAll(".nk-jr-drop").forEach((n) => n.remove());
      root.findAll(".nk-jr-card.is-stack-target").forEach((n) => n.removeClass("is-stack-target"));
    };
    const stackTarget = (e: DragEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".nk-jr-card");
      const path = el?.getAttr("data-path");
      return el && path && path !== drag?.path ? { el, path } : null;
    };
    lane.addEventListener("dragover", (e) => {
      if (!drag || isCollapsed) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearMarks();
      const onto = stackTarget(e);
      if (onto) {
        onto.el.addClass("is-stack-target");
        return;
      }
      const { at } = gapFor(e.clientX - lane.getBoundingClientRect().left);
      const bar = lane.createDiv({ cls: "nk-jr-drop" });
      bar.style.left = `${at}px`;
      bar.style.top = `${cardTop(0) - 4}px`;
      bar.style.height = `${cardTop(deepest) - STACK_GAP - cardTop(0) + 8}px`;
    });
    lane.addEventListener("dragleave", (e) => {
      if (!lane.contains(e.relatedTarget as Node)) clearMarks();
    });
    lane.addEventListener("drop", (e) => {
      if (!drag || isCollapsed) return;
      e.preventDefault();
      const d = drag;
      drag = null;
      const onto = stackTarget(e);
      const { index } = gapFor(e.clientX - lane.getBoundingClientRect().left);
      clearMarks();
      if (onto) ctx.stack(d.path, d.fromKey, row.key, onto.path);
      else ctx.move(d.path, d.fromKey, row.key, index);
    });
    restoreLane(wrap, row.key);
  }

  /**
   * Radiant lane: tasks in the order they were logged (no steps, no goal
   * line). Done tasks fold into a "✓ N" bubble at the start; the line runs
   * past ＋ into a dashed ∞. Dropping a task from another quest appends it.
   */
  function radiantLane(block: HTMLElement, key: string, tasks: Card[], isCollapsed: boolean): void {
    const byLogged = (a: Card, b: Card) => ctx.createdOf(a) - ctx.createdOf(b);
    const isClosed = (c: Card) => ctx.isDone(c) || ctx.isAbandoned(c);
    const open = tasks.filter((c) => !isClosed(c)).sort(byLogged);
    const done = tasks.filter(isClosed).sort(byLogged); // done + abandoned
    const abandonedN = done.filter((c) => ctx.isAbandoned(c)).length;
    const showDone = shownDone.has(key);
    const items = [...(showDone ? done : []), ...open];

    const { wrap, lane } = laneHost(block, key, "nk-jr-lane is-radiant");
    const first = done.length ? FIRST_X + 44 : FIRST_X;
    const leftOf = (i: number) => first + i * step;
    const centerOf = (i: number) => leftOf(i) + cardW / 2;
    const addX = centerOf(items.length);
    const endX = addX + cardW / 2 + 70;
    const width = endX + 40;
    lane.style.width = `${width}px`;
    lane.style.height = `${isCollapsed ? LINE_Y + 24 : LINE_Y + STEM + CARD_H + 18}px`;

    const line = lane.createDiv({ cls: "nk-jr-line" });
    line.style.left = `${START_X}px`;
    line.style.width = `${addX - START_X}px`;
    line.style.top = `${LINE_Y}px`;
    const tail = lane.createDiv({ cls: "nk-jr-line is-tail" });
    tail.style.left = `${addX}px`;
    tail.style.width = `${endX - addX - 16}px`;
    tail.style.top = `${LINE_Y}px`;
    const inf = lane.createDiv({ cls: "nk-jr-infinity", text: "∞" });
    inf.style.left = `${endX}px`;
    inf.style.top = `${LINE_Y}px`;
    inf.setAttr("title", "Radiant quest — it never ends");
    const startDot = lane.createDiv({ cls: "nk-jr-start" });
    startDot.style.left = `${START_X}px`;
    startDot.style.top = `${LINE_Y}px`;

    if (done.length) {
      const doneOnly = done.length - abandonedN;
      const bubble = lane.createDiv({ cls: "nk-jr-donebubble" });
      if (doneOnly) bubble.createSpan({ text: `✓ ${doneOnly}` });
      if (abandonedN) bubble.createSpan({ cls: "nk-jr-x", text: `${doneOnly ? " " : ""}✕ ${abandonedN}` });
      bubble.toggleClass("is-open", showDone);
      bubble.style.left = `${(START_X + first) / 2 + 6}px`;
      bubble.style.top = `${LINE_Y}px`;
      bubble.setAttr("title", showDone ? "Hide done tasks" : "Show done tasks");
      bubble.addEventListener("click", () => {
        if (showDone) shownDone.delete(key);
        else shownDone.add(key);
        ctx.refresh();
      });
    }

    items.forEach((c, i) => {
      const isDone = ctx.isDone(c);
      const isAb = ctx.isAbandoned(c);
      const due = parseDate(c.props[TASK_DUE]);
      const dot = lane.createDiv({ cls: "nk-jr-dot" });
      const sc = ctx.statusColor(c);
      if (sc) applyColor(dot, sc);
      dot.toggleClass("is-done", isDone);
      dot.toggleClass("is-abandoned", isAb);
      dot.toggleClass("is-overdue", !!due && !isDone && !isAb && dayNum(due) < dayNum(now));
      dot.style.left = `${centerOf(i)}px`;
      dot.style.top = `${LINE_Y}px`;
      dot.setAttr("title", `${c.title} · ${ctx.statusText(c) || "No status"}`);
      dot.addEventListener("click", () => ctx.openCard(c));
      if (isCollapsed) return;
      const stem = lane.createDiv({ cls: "nk-jr-stem" });
      stem.style.left = `${centerOf(i)}px`;
      stem.style.top = `${LINE_Y}px`;
      stem.style.height = `${STEM}px`;
      renderCard(lane, c, leftOf(i), LINE_Y + STEM, key, new Date(ctx.createdOf(c)));
    });

    const addNode = lane.createDiv({ cls: "nk-jr-node is-add" });
    setIcon(addNode, "plus");
    addNode.style.left = `${addX}px`;
    addNode.style.top = `${LINE_Y}px`;
    addNode.setAttr("title", "Log new task");
    addNode.addEventListener("click", () => ctx.addTask(key));
    if (!isCollapsed) {
      const ghost = lane.createDiv({ cls: "nk-jr-ghost" });
      ghost.style.left = `${leftOf(items.length)}px`;
      ghost.style.top = `${LINE_Y + STEM}px`;
      ghost.style.width = `${cardW}px`;
      ghost.style.height = `${CARD_H}px`;
      setIcon(ghost.createSpan({ cls: "nk-footer-icon" }), "plus");
      ghost.createSpan({ text: " Log new task" });
      ghost.addEventListener("click", () => ctx.addTask(key));
    }

    // Order is by logged time, so only drops from other quests count (appended).
    lane.addEventListener("dragover", (e) => {
      if (!drag || drag.fromKey === key || isCollapsed) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      lane.addClass("is-drop-target");
    });
    lane.addEventListener("dragleave", (e) => {
      if (!lane.contains(e.relatedTarget as Node)) lane.removeClass("is-drop-target");
    });
    lane.addEventListener("drop", (e) => {
      lane.removeClass("is-drop-target");
      if (!drag || drag.fromKey === key || isCollapsed) return;
      e.preventDefault();
      const d = drag;
      drag = null;
      ctx.move(d.path, d.fromKey, key, tasks.length);
    });
    restoreLane(wrap, key);
  }

  function renderCard(
    lane: HTMLElement,
    c: Card,
    left: number,
    top: number,
    key: string,
    logged?: Date
  ): void {
    const done = ctx.isDone(c);
    const abandoned = ctx.isAbandoned(c);
    const due = parseDate(c.props[TASK_DUE]);
    const card = lane.createDiv({ cls: "nk-jr-card" });
    card.toggleClass("is-done", done);
    card.toggleClass("is-abandoned", abandoned);
    card.toggleClass("is-overdue", !!due && !done && !abandoned && dayNum(due) < dayNum(now));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.width = `${cardW}px`;
    card.style.height = `${CARD_H}px`;
    card.setAttr("draggable", "true");
    card.setAttr("data-path", c.path);
    const values = Object.values(c.props).flatMap((v) => (Array.isArray(v) ? v : [v]));
    card.setAttr("data-search", [c.title, ...values.map(String)].join(" "));

    // Icon in its own column; title and status stack beside it so they align.
    const explicit = typeof c.props.icon === "string" ? c.props.icon.trim() : "";
    const icon = explicit || (ctx.config.randomIcons !== false ? randomIconFor(c.path) : "");
    if (icon) card.createSpan({ cls: "nk-jr-cicon", text: icon });
    const body = card.createDiv({ cls: "nk-jr-cbody" });
    body.createSpan({ cls: "nk-jr-ctitle", text: c.title });
    const menuBtn = card.createDiv({ cls: "nk-card-menu-btn nk-jr-cmenu", attr: { "aria-label": "Card actions" } });
    setIcon(menuBtn, "more-horizontal");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.cardMenu({ x: e.clientX, y: e.clientY }, c);
    });

    const foot = body.createDiv({ cls: "nk-jr-cfoot" });
    const status = ctx.statusText(c);
    if (status) {
      const chip = foot.createSpan({ cls: "nk-chip", text: status });
      applyColor(chip, ctx.statusColor(c) ?? "default");
    }
    if (due) foot.createSpan({ cls: "nk-jr-cdate", text: logged ? `due ${shortDate(due)}` : shortDate(due) });
    else if (logged) {
      foot.createSpan({
        cls: "nk-jr-cdate",
        text: shortDate(logged),
        attr: { title: `Logged ${shortDate(logged)}` },
      });
    }

    card.addEventListener("click", () => ctx.openCard(c));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      ctx.cardMenu({ x: e.clientX, y: e.clientY }, c);
    });
    onHold(card, { menu: (p) => ctx.cardMenu(p, c), drag: true });
    card.addEventListener("dragstart", (e) => {
      drag = { path: c.path, fromKey: key };
      card.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", c.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      drag = null;
      card.removeClass("is-dragging");
      root.findAll(".nk-jr-drop").forEach((n) => n.remove());
      root.findAll(".is-stack-target").forEach((n) => n.removeClass("is-stack-target"));
    });
  }

  // Restore right away (not just next frame): a second re-render can land
  // before the frame and would otherwise read — and keep — a 0 scroll.
  const restore = () => {
    if (ctx.savedScroll) scroll.scrollTop = ctx.savedScroll.top;
  };
  restore();
  window.requestAnimationFrame(restore);
}
