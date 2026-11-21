import { BoardConfig, PropertyDef, TASK_CREATED } from "./types";
import { getProperty } from "./store";

/** Date a task was closed (Done / Abandoned). Stamped automatically. */
export const TASK_CLOSED = "Closed";

/**
 * Fields that make a task easy to report on: which ticket, who asked, which
 * part of the business, and when it was closed. Added on demand by the
 * "Add intake fields" command; the select options are left for the user.
 */
export const INTAKE_FIELDS: PropertyDef[] = [
  { name: "Ticket", type: "text" },
  { name: "Requester", type: "text" },
  { name: "Entity", type: "select", options: [] },
  { name: TASK_CLOSED, type: "date" },
];

/** Add any missing intake fields to the board. Returns the names added. */
export function addIntakeFields(config: BoardConfig): string[] {
  const added: string[] = [];
  for (const f of INTAKE_FIELDS) {
    if (getProperty(config, f.name)) continue;
    config.properties.push({ ...f, options: f.options ? [] : undefined });
    added.push(f.name);
  }
  return added;
}

/** Properties the quick-add form never asks for: they're stamped automatically. */
export const AUTO_PROPS = new Set([TASK_CREATED, TASK_CLOSED]);

/** A task's status (the board's group-by value) as plain text. */
export function statusText(config: BoardConfig, props: Record<string, unknown>): string {
  const v = props[config.groupBy];
  return String(Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
}

/**
 * What the Closed stamp should become after a status change from `prev` to
 * the status in `props`: a date to set, null to remove it, or undefined to
 * leave it alone. Only a real change counts — editing an old Done note never
 * re-stamps it — and only boards that define a `Closed` property are stamped.
 */
export function closedStampUpdate(
  config: BoardConfig,
  prev: string | undefined,
  props: Record<string, unknown>,
  todayIso: string,
  isClosed: (status: string) => boolean,
  isArchived: (status: string) => boolean
): string | null | undefined {
  if (!getProperty(config, TASK_CLOSED)) return undefined;
  const status = statusText(config, props);
  if (prev === undefined || prev === status) return undefined;
  // Archiving puts a task away; keep whatever stamp it had.
  if (isArchived(status) || isArchived(prev)) return undefined;
  const c = props[TASK_CLOSED];
  const stamped = c !== undefined && c !== null && c !== "";
  if (isClosed(status) && !isClosed(prev)) return stamped ? undefined : todayIso;
  if (!isClosed(status) && isClosed(prev)) return stamped ? null : undefined;
  return undefined;
}
