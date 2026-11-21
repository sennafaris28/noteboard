import { App, Modal, Platform } from "obsidian";

/**
 * Base for NoteBoard's dialogs. On iPad the on-screen keyboard otherwise
 * covers a centred dialog. The container is tagged so CSS can centre the
 * dialog in the space above the keyboard, using the larger of Obsidian's own
 * `--keyboard-height` and our measurement from `visualViewport` (`--nk-kb`),
 * in case one of them isn't reported.
 */
export class NkModal extends Modal {
  constructor(app: App) {
    super(app);
    this.containerEl.addClass("nk-kb-safe");
  }

  open(): void {
    super.open();
    const vv = window.visualViewport;
    if (!Platform.isMobile || !vv) return;
    const el = this.containerEl;
    const update = () => {
      if (!el.isConnected) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
        return;
      }
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.setProperty("--nk-kb", `${Math.round(kb)}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  }
}
