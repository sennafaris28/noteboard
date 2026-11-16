import { TFile } from "obsidian";

/** The property types Notion databases support (subset we implement). */
export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multiselect"
  | "date"
  | "checkbox";

/** A single option for a select / multi-select property. */
export interface SelectOption {
  name: string;
  color: string; // one of NOTION_COLORS keys
}

/** Schema definition for one property. */
export interface PropertyDef {
  name: string; // the frontmatter key, also the display name
  type: PropertyType;
  options?: SelectOption[]; // for select / multiselect
}

/** A column in the board. For a select group-by, `id` is the option value. */
export interface ColumnDef {
  id: string; // the group value this column represents ("" = uncategorized)
  color: string; // one of NOTION_COLORS keys
  collapsed?: boolean;
  hidden?: boolean;
}

/** The persisted board config, stored as JSON in a `.kanban` file. */
export interface BoardConfig {
  version: number;
  /** Folder (vault-relative) holding the card notes. "" = vault root. */
  folder: string;
  /** Property name used to group cards into columns. */
  groupBy: string;
  /** Full property schema for this board. */
  properties: PropertyDef[];
  /** Ordered columns. */
  columns: ColumnDef[];
  /** Property names shown on the card face, in order. */
  cardProps: string[];
  /** Per-column ordered list of card file paths. */
  cardOrder: Record<string, string[]>;
  /** Whether new cards get a date-stamped unique suffix to avoid collisions. */
  uniqueSuffix?: boolean;
  /** When adding a card, open the full note editor instead of the peek modal. */
  openNewCardAsNote?: boolean;
  /** Show a stable random icon on cards that don't have one set. Default on. */
  randomIcons?: boolean;
  /** Column width in pixels. Default 300. */
  colWidth?: number;
  /** Column drop-shadow strength as a percentage (0 = flat, 100 = default). */
  colShadow?: number;
  /** Board columns come from quest folders ("quest") or the status property. */
  groupMode?: GroupMode;
  /** Which view is shown: the kanban board or the quest timeline. */
  viewMode?: ViewMode;
  /** Subfolder (inside `folder`) holding one folder per quest. */
  questsFolder?: string;
  /** Ordered quest columns (id = quest folder name). */
  questColumns?: ColumnDef[];
  /** Per-quest ordered card paths (key = quest name, or INBOX). */
  questCardOrder?: Record<string, string[]>;
  /** Timeline zoom level. */
  timelineZoom?: TimelineZoom;
  /** Expanded quests show one row per task ("rows") or week buckets ("weeks"). */
  timelineLayout?: TimelineLayout;
  /** Quest rows collapsed in the timeline (key = quest name, or INBOX). */
  timelineCollapsed?: string[];
  /** Quest rows collapsed in the journey view (key = quest name, or INBOX). */
  journeyCollapsed?: string[];
  /** Task paths that share a journey step with the task before them (branches). */
  journeyStacked?: string[];
  /** Width of the timeline's Quests pane, in pixels. */
  timelineLabelW?: number;
}

export type GroupMode = "quest" | "status";
export type ViewMode = "board" | "journey" | "timeline";
export type TimelineZoom = "week" | "month" | "quarter";
export type TimelineLayout = "rows" | "weeks";

/** Appearance defaults, used when a board hasn't set its own. */
export const COL_WIDTH_DEFAULT = 300;
export const COL_SHADOW_DEFAULT = 100;

/** A runtime card, derived from scanning the folder — not persisted here. */
export interface Card {
  file: TFile;
  path: string;
  title: string; // file basename
  props: Record<string, unknown>; // frontmatter
  /** Quest folder this task lives in, or null for the "No quest" inbox. */
  quest: string | null;
}

/** A quest: a folder under `Quests/` plus its same-named quest note. */
export interface Quest {
  name: string;
  folderPath: string;
  /** `Quests/<name>/<name>.md` — holds Start / Target / goal. */
  note: TFile | null;
  props: Record<string, unknown>;
  /** Radiant quests are endless logs (ad-hoc work); definite ones have a goal and an end. */
  radiant: boolean;
}

export const BOARD_VERSION = 1;
export const KANBAN_EXT = "kanban";
export const KANBAN_VIEW_TYPE = "noteboard-view";

/** The value used internally for cards with no group value. */
export const UNCATEGORIZED = "__uncategorized__";

/** Key for tasks that sit in the board folder itself (no quest). */
export const INBOX = "__inbox__";
export const QUESTS_FOLDER_DEFAULT = "Quests";
/** Frontmatter keys on a quest note. */
export const QUEST_START = "Start";
export const QUEST_TARGET = "Target";
/** Task date that places a card on the timeline. */
export const TASK_DUE = "Due";
/** Quest note property: "radiant" for an endless quest (missing = definite). */
export const QUEST_TYPE = "Type";
/** When a task was logged (stamped on tasks created in radiant quests). */
export const TASK_CREATED = "Created";

export function defaultBoard(folder: string): BoardConfig {
  return {
    version: BOARD_VERSION,
    folder,
    groupBy: "Status",
    properties: [
      {
        name: "Status",
        type: "select",
        options: [
          { name: "Not started", color: "gray" },
          { name: "In progress", color: "blue" },
          { name: "Done", color: "green" },
        ],
      },
      { name: "Tags", type: "multiselect", options: [] },
      { name: "Due", type: "date" },
    ],
    columns: [
      { id: "Not started", color: "gray" },
      { id: "In progress", color: "blue" },
      { id: "Done", color: "green" },
    ],
    cardProps: ["Tags", "Due"],
    cardOrder: {},
    uniqueSuffix: false,
    openNewCardAsNote: false,
    randomIcons: true,
    colWidth: COL_WIDTH_DEFAULT,
    colShadow: COL_SHADOW_DEFAULT,
    groupMode: "quest",
    viewMode: "board",
    questsFolder: QUESTS_FOLDER_DEFAULT,
    questColumns: [],
    questCardOrder: {},
    timelineZoom: "month",
    timelineLayout: "rows",
    timelineCollapsed: [],
    journeyCollapsed: [],
    journeyStacked: [],
  };
}
