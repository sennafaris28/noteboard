import { Platform } from "obsidian";

type Pos = { x: number; y: number };

/** True on phones/tablets (or any device without a hover-capable pointer). */
export function isTouch(): boolean {
  return Platform.isMobile || !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
}

/** How long a finger must rest on an item before it's "picked up". */
const HOLD_MS = 400;
/** Movement (px) that means "scrolling" before the hold, or "start dragging" after it. */
const SLOP = 10;
/** Auto-scroll while dragging near the edge of a scrollable area. */
const EDGE = 56;
const MAX_SCROLL = 18;

export interface HoldOpts {
  /** Hold, then release in place → open a menu at the finger. */
  menu?: (pos: Pos) => void;
  /** Hold, then move → drag the item (emulated HTML5 drag & drop). */
  drag?: boolean;
  ms?: number;
}

/** One handler per element; later calls merge their options into it. */
const holds = new WeakMap<HTMLElement, HoldOpts>();

/** Hold-then-release → menu. (Kept for callers that only need the menu.) */
export function onLongPress(el: HTMLElement, cb: (pos: Pos) => void, ms?: number): void {
  onHold(el, { menu: cb, ms });
}

/**
 * Touch gesture for an item: hold ≈0.4s (a ring shows it's armed), then
 *  - release in place → `menu`,
 *  - drag → move the item (`drag`), dropping wherever you let go.
 * Moving before the hold completes is just scrolling and cancels it.
 */
export function onHold(el: HTMLElement, opts: HoldOpts): void {
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  const existing = holds.get(el);
  if (existing) {
    Object.assign(existing, defined);
    return;
  }
  const o: HoldOpts = { ...defined };
  holds.set(el, o);

  let timer = 0;
  let start: Pos | null = null;
  let held = false;
  let fired = false; // a menu opened → swallow the click that follows
  let session: TouchDrag | null = null;

  const reset = () => {
    window.clearTimeout(timer);
    el.removeClass("nk-pressing");
    session?.cancel();
    session = null;
    start = null;
    held = false;
  };

  // A finger can't use iOS's own drag (flaky in Obsidian), so turn it off for
  // touch/pen and keep it on for a mouse or trackpad.
  el.addEventListener(
    "pointerdown",
    (e) => {
      if (o.drag) el.draggable = e.pointerType === "mouse";
    },
    true
  );

  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return reset();
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      held = false;
      fired = false;
      timer = window.setTimeout(() => {
        held = true;
        el.addClass("nk-pressing"); // armed: release for the menu, or drag to move
      }, o.ms ?? HOLD_MS);
    },
    { passive: true }
  );

  el.addEventListener(
    "touchmove",
    (e) => {
      if (!start) return;
      const t = e.touches[0];
      const pos = { x: t.clientX, y: t.clientY };
      if (session) {
        e.preventDefault(); // no page scroll while carrying an item
        session.move(pos);
        return;
      }
      const far = Math.hypot(pos.x - start.x, pos.y - start.y) > SLOP;
      if (!held) {
        if (far) reset(); // finger moved early: that's a scroll
        return;
      }
      if (!far) return;
      if (o.drag) {
        e.preventDefault();
        el.removeClass("nk-pressing");
        session = new TouchDrag(el, start);
        session.move(pos);
      } else {
        reset();
      }
    },
    { passive: false }
  );

  el.addEventListener("touchend", (e) => {
    window.clearTimeout(timer);
    el.removeClass("nk-pressing");
    if (session) {
      e.preventDefault();
      session.drop();
      session = null;
    } else if (held && start && o.menu) {
      fired = true;
      e.preventDefault();
      o.menu(start);
    }
    start = null;
    held = false;
  });
  el.addEventListener("touchcancel", reset);
  // A real (mouse) drag starting means this isn't a touch hold.
  el.addEventListener("dragstart", (e) => {
    if (e.isTrusted) reset();
  });
  el.addEventListener(
    "click",
    (e) => {
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
}

/* ---- Emulated HTML5 drag & drop for a finger ------------------------------
 * The board's drop logic listens for dragstart / dragover / drop / dragend,
 * so a finger drag just fires those same events at whatever is under it.   */

function makeDataTransfer(): DataTransfer | null {
  try {
    return new DataTransfer();
  } catch {
    return null;
  }
}

function dragEvent(type: string, pos: Pos, dt: DataTransfer | null, related: Element | null = null): Event {
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: pos.x,
    clientY: pos.y,
    screenX: pos.x,
    screenY: pos.y,
    relatedTarget: related,
    view: window,
  };
  try {
    return new DragEvent(type, { ...init, dataTransfer: dt });
  } catch {
    const ev = new MouseEvent(type, init);
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    return ev;
  }
}

class TouchDrag {
  private ghost: HTMLElement;
  private dt = makeDataTransfer();
  private target: Element | null = null;
  private accepted = false;
  private raf = 0;
  private pos: Pos;

  constructor(private src: HTMLElement, private from: Pos) {
    this.pos = from;
    const rect = src.getBoundingClientRect();
    // Floating copy that follows the finger (it ignores pointer hits).
    this.ghost = src.cloneNode(true) as HTMLElement;
    this.ghost.addClass("nk-touch-ghost");
    Object.assign(this.ghost.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    document.body.appendChild(this.ghost);
    src.dispatchEvent(dragEvent("dragstart", from, this.dt));
    this.raf = window.requestAnimationFrame(this.tick);
  }

  move(pos: Pos): void {
    this.pos = pos;
    this.ghost.style.transform = `translate(${pos.x - this.from.x}px, ${pos.y - this.from.y}px) scale(1.03)`;
    this.hover();
  }

  drop(): void {
    window.cancelAnimationFrame(this.raf);
    this.hover();
    if (this.target && this.accepted) this.target.dispatchEvent(dragEvent("drop", this.pos, this.dt));
    else if (this.target) this.target.dispatchEvent(dragEvent("dragleave", this.pos, this.dt));
    this.end();
  }

  cancel(): void {
    window.cancelAnimationFrame(this.raf);
    if (this.target) this.target.dispatchEvent(dragEvent("dragleave", this.pos, this.dt));
    this.end();
  }

  private end(): void {
    this.ghost.remove();
    this.src.dispatchEvent(dragEvent("dragend", this.pos, this.dt));
  }

  /** Tell whatever is under the finger that a drag is over it. */
  private hover(): void {
    const el = document.elementFromPoint(this.pos.x, this.pos.y);
    if (el !== this.target) {
      if (this.target) this.target.dispatchEvent(dragEvent("dragleave", this.pos, this.dt, el));
      this.target = el;
      if (el) el.dispatchEvent(dragEvent("dragenter", this.pos, this.dt));
    }
    // A handler that accepts the drop calls preventDefault() on dragover.
    this.accepted = this.target ? !this.target.dispatchEvent(dragEvent("dragover", this.pos, this.dt)) : false;
  }

  /** Auto-scroll every scrollable area under the finger when it's near an edge. */
  private tick = (): void => {
    this.raf = window.requestAnimationFrame(this.tick);
    let moved = false;
    const push = (d: number, edge: number) => {
      const speed = MAX_SCROLL * (1 - Math.min(d, edge) / edge);
      return Math.max(1, Math.ceil(speed));
    };
    for (let n = document.elementFromPoint(this.pos.x, this.pos.y); n && n !== document.body; n = n.parentElement) {
      const el = n as HTMLElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth) {
        const before = el.scrollLeft;
        if (this.pos.x - r.left < EDGE) el.scrollLeft -= push(this.pos.x - r.left, EDGE);
        else if (r.right - this.pos.x < EDGE) el.scrollLeft += push(r.right - this.pos.x, EDGE);
        moved ||= el.scrollLeft !== before;
      }
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
        const before = el.scrollTop;
        if (this.pos.y - r.top < EDGE) el.scrollTop -= push(this.pos.y - r.top, EDGE);
        else if (r.bottom - this.pos.y < EDGE) el.scrollTop += push(r.bottom - this.pos.y, EDGE);
        moved ||= el.scrollTop !== before;
      }
    }
    if (moved) this.hover(); // the drop spot changed under a stationary finger
  };
}
