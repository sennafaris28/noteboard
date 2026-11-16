import { App, Modal, Setting } from "obsidian";
import { dateField } from "../dateinput";

/** A tiny promise-based text prompt. Resolves to null on cancel. */
export function promptText(
  app: App,
  title: string,
  placeholder = "",
  initial = ""
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new PromptModal(app, title, placeholder, initial, resolve);
    modal.open();
  });
}

class PromptModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private initial: string,
    private resolve: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    let value = this.initial;

    const setting = new Setting(contentEl).addText((t) => {
      t.setPlaceholder(this.placeholder)
        .setValue(this.initial)
        .onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.finish(value);
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    setting.settingEl.addClass("nk-prompt-row");

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Cancel")
          .onClick(() => this.finish(null))
      )
      .addButton((b) =>
        b
          .setButtonText("OK")
          .setCta()
          .onClick(() => this.finish(value))
      );
  }

  private finish(value: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}

/**
 * Date prompt. Resolves to "YYYY-MM-DD", "" when the user clears the date,
 * or null on cancel.
 */
export function promptDate(app: App, title: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => new DatePromptModal(app, title, initial, resolve).open());
}

class DatePromptModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private title: string,
    private initial: string,
    private resolve: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const field = dateField(this.contentEl, this.initial, () => {}, {
      autofocus: true,
      onEnter: () => this.finish(field.value()),
    });

    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Clear").onClick(() => this.finish("")))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.finish(field.value())));
  }

  private finish(value: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}

/** Obsidian-style yes/no dialog (window.confirm isn't reliable on mobile). */
export function confirmDialog(
  app: App,
  title: string,
  message: string,
  cta = "Delete"
): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, title, message, cta, resolve).open());
}

class ConfirmModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private title: string,
    private message: string,
    private cta: string,
    private resolve: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((b) => b.setButtonText(this.cta).setWarning().onClick(() => this.finish(true)));
  }

  private finish(ok: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(ok);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }
  }
}
