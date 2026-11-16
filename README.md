# NoteBoard

A Notion-style **board for Obsidian where every card is a real markdown note** — grouped into
**quests**, viewed as a Board, a Journey or a Timeline.

Cards are plain `.md` files (frontmatter = properties), so everything stays searchable,
linkable and syncable like any other note.

## Views

Switch with **Board · Journey · Timeline** in the toolbar.

- **Board** — kanban columns, grouped by **Quests** (default) or by **Status**. Drag cards between
  columns and reorder; moving a card between quests moves the note into that quest's folder.
- **Journey** — one line per quest with its tasks hanging below it as ordered steps. The line fills up
  as steps are done. Tasks that run in parallel stack under one stop (a *branch*). Each quest shows its
  goal and scrolls sideways on its own.
- **Timeline** — one shared date axis, one row per quest (Start → Target, 🏁 at the end), tasks placed by
  their `Due` date. *Rows* or *Weeks* layout, week/month/quarter zoom, a Today marker, resizable quest
  pane. Drag a task to reschedule it; double-click to add one on a date.

## Quests

A quest is a folder with a same-named note inside it:

```
Work/
├── Work.kanban                 ← the board
├── Quests/
│   ├── WAF Rollout/
│   │   ├── WAF Rollout.md      ← quest note (Start, Target, Type, ## Goal)
│   │   └── Set up staging.md   ← tasks
│   └── Ad-hoc requests/
└── Loose note.md               ← "No quest" inbox
```

- **Definite quests** have a goal and an end: Start/Target dates, progress, numbered steps, branches.
- **Radiant quests** (`Type: radiant`) are endless logs for ad-hoc work: tasks in the order they were
  logged, finished ones folded into a ✓ bubble, no end.
- Renaming a quest's note **or** its folder renames the other; colour, order and branches follow.

## Statuses

Group-by status is a normal select property. Three names get special treatment:
**Done** (✓), **Abandoned** / Cancelled / Dropped / Won't do (red ✕, left out of progress) and
**Archived** (hidden from Journey and Timeline, still on the Board).

## Cards & notes

- **Card modal**: title, icon, properties, and Obsidian's own editor for the body. Footer:
  Delete · Open as note · OK. New cards you close untouched are discarded.
- **Quest banner** under the title of every task note: quest, progress, dates, last edited, and a mini
  quest line with this task highlighted.
- **Export** (card menus, the modal, a note's ⋯ menu, command palette): copy markdown, body only, rich
  text, the `.md` file itself, save as `.md`, or copy an `obsidian://` link.
- **Undo / redo** across the board, timeline, card modal and settings: `Ctrl/Cmd+Z`, `Ctrl+Shift+Z`
  or `Ctrl+Y`.
- Random icons, a dd/mm/yyyy date field, Notion colours for tags and columns, light and dark themes,
  adjustable column width and shadow.

## Touch / iPad

Buttons stay visible, menus open on long-press, and there are undo/redo buttons. To move something,
**hold ~0.4 s** until a ring appears, then drag; release in place for the menu.
*Touch support is new and has had little testing on real devices.*

## Install

**From a release** — download `main.js`, `manifest.json` and `styles.css` from the latest
[release](../../releases) into `<vault>/.obsidian/plugins/noteboard/`, then enable **NoteBoard** under
Settings → Community plugins.

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat)** — add this repository; BRAT keeps it updated.

Requires Obsidian 1.4.0 or newer. The first board: ribbon icon or **NoteBoard: Create new kanban board**.

## Install on iPad (with BRAT)

You'll need Obsidian **1.11.4 or newer** on the iPad (Settings → About) and your vault open.

1. **Open Settings.** Pull down from the top of the app (this opens the command palette), type
   `settings` and pick **Open settings**. The gear is usually at the bottom of the left sidebar too.
2. **Settings → Community plugins → Turn on community plugins.**
3. **Browse**, search **BRAT** (by TfTHacker), then **Install** and **Enable**.
4. Pull down again for the command palette and run **"BRAT: Add a beta plugin for testing"**.
   Paste `sennafaris28/noteboard` and confirm. Run it again with `sennafaris28/slashcommands`.
5. **Settings → Community plugins → Installed plugins** and switch **NoteBoard** and **SlashCommands** on
   (BRAT may already have done it).
6. Try it: run **"NoteBoard: Create new kanban board"**, and type `/` at the start of a line in a note.

**Updating later:** run BRAT's **Check for updates**. BRAT only sees *releases*, so a change isn't picked
up until a new release is published (see [Releasing](#releasing)).

**If something goes wrong**

- *BRAT says it can't find a release or manifest* — check the spelling of the repo path.
- *Plugins disappear after reopening the app* — a sync tool may be overwriting `.obsidian`;
  exclude it from sync.
- *Dragging doesn't work* — hold an item about 0.4 s until a ring appears, then drag.
  Touch support has had little testing on real devices, so please report what you see.

## Companion plugin

The Notion-style `/` menu (headings, to-do, lists, tables…) lives in a separate plugin,
**SlashCommands**. NoteBoard's card modal uses it for its *Insert table* button when it's enabled.

## Build

```bash
npm install
npm run build   # type-check + bundle to main.js
npm run dev     # watch mode
```

## Releasing

BRAT and Obsidian install from GitHub *releases*, not from plain pushes.

1. Bump `version` in `manifest.json` and add it to `versions.json`.
2. `npm run build`, then commit and `git push`.
3. Create the release — the tag must equal the manifest version exactly, with no `v`:

```bash
gh release create 1.0.1 main.js manifest.json styles.css --title "1.0.1" --notes "What changed"
```

## Notes & limits

- Column order, card order, colours, branches and the property schema live in the `.kanban` JSON.
- *Copy file* puts the real `.md` on the clipboard where the Electron build allows it; otherwise it
  copies the text and says why.
- Renames sync as delete + create on some sync tools, so a quest rename re-uploads its files.
