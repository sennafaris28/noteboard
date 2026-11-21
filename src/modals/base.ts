import { App, Modal } from "obsidian";

/**
 * Base for NoteBoard's dialogs. Tags the modal container so, on iPad, the
 * dialog is centred in the space above the on-screen keyboard instead of
 * behind it (Obsidian only does this for its own phone modals). The CSS reads
 * Obsidian's `--keyboard-height`, which is 0 on desktop.
 */
export class NkModal extends Modal {
  constructor(app: App) {
    super(app);
    this.containerEl.addClass("nk-kb-safe");
  }
}
