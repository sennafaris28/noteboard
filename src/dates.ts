/** Local-calendar date helpers. Dates are stored in frontmatter as YYYY-MM-DD. */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parse a frontmatter date value ("2026-11-20", "2026-11-20T09:00") to a local date. */
export function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (local) to a Date, keeping the time. */
export function parseDateTime(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v).trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

/** Local "YYYY-MM-DDTHH:mm" — what Obsidian's date & time property expects. */
export function toISODateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${toISO(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** Day number that ignores DST shifts, so day differences are exact. */
export function dayNum(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Short day-first label, e.g. "12 Nov". */
export function shortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** dd/mm/yyyy — the display/entry format everywhere in NoteBoard. */
export function formatDMY(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Parse dd/mm/yyyy (also d/m/yy, with - or . separators). Null if invalid. */
export function parseDMY(text: string): Date | null {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\s*$/.exec(text);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const d = new Date(year, month - 1, day);
  // Reject roll-overs like 31/02 → 3 Mar.
  return d.getDate() === day && d.getMonth() === month - 1 ? d : null;
}
