import { BoardConfig, Card } from "./types";

/** Status values that mean the task was finished. */
const DONE_RE = /^(done|complete|completed)$/i;
/** Status values that mean the task was dropped — closed, but not achieved. */
const ABANDONED_RE = /^(abandoned|cancell?ed|dropped|won'?t do)$/i;
/** Archived tasks are put away: hidden from Journey/Timeline, out of progress. */
const ARCHIVED_RE = /^archived?$/i;

/** The card's status (the board's group-by property) as text. */
export function statusOf(config: BoardConfig, card: Card): string {
  const v = card.props[config.groupBy];
  if (v === undefined || v === null) return "";
  return String(Array.isArray(v) ? v[0] ?? "" : v).trim();
}

export function isDone(config: BoardConfig, card: Card): boolean {
  return DONE_RE.test(statusOf(config, card));
}

export function isAbandoned(config: BoardConfig, card: Card): boolean {
  return ABANDONED_RE.test(statusOf(config, card));
}

export function isArchived(config: BoardConfig, card: Card): boolean {
  return ARCHIVED_RE.test(statusOf(config, card));
}

/**
 * Progress that ignores abandoned tasks: done ÷ (total − abandoned).
 * Pass cards with archived ones already filtered out.
 */
export function progressOf(config: BoardConfig, cards: Card[]) {
  const done = cards.filter((c) => isDone(config, c)).length;
  const abandoned = cards.filter((c) => isAbandoned(config, c)).length;
  const counted = cards.length - abandoned;
  return { done, abandoned, counted, pct: counted ? Math.round((done / counted) * 100) : 0 };
}

/** Done or abandoned — the task is closed. Works on a raw status string. */
export function isClosedStatus(status: string): boolean {
  return DONE_RE.test(status) || ABANDONED_RE.test(status);
}

export function isArchivedStatus(status: string): boolean {
  return ARCHIVED_RE.test(status);
}
