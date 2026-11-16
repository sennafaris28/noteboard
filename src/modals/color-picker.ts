import { App, Modal, Notice, Setting } from "obsidian";
import {
  COLOR_KEYS,
  COMMON_COLORS,
  NOTION_COLORS,
  applyColor,
  isHexColor,
  normalizeHex,
} from "../colors";

/**
 * Render a color picker into `container`: the full named palette (each shown as
 * a colored chip so the box + colored text explains the color), a row of common
 * hex swatches, and a free-form hex input. `onPick` fires with a palette key or
 * a normalized hex string.
 */
export function renderColorPicker(
  container: HTMLElement,
  current: string,
  onPick: (color: string) => void
): void {
  const wrap = container.createDiv({ cls: "nk-colorpicker" });

  // --- Palette (horizontal, wraps into rows) ---
  wrap.createDiv({ cls: "nk-cp-label", text: "Palette" });
  const list = wrap.createDiv({ cls: "nk-cp-list" });
  for (const key of COLOR_KEYS) {
    const chip = list.createSpan({ cls: "nk-chip nk-cp-chip" });
    applyColor(chip, key);
    chip.setText(NOTION_COLORS[key].label);
    if (current === key) chip.addClass("is-sel");
    chip.addEventListener("click", () => onPick(key));
  }

  // --- Common colors ---
  wrap.createDiv({ cls: "nk-cp-label", text: "Common colors" });
  const swatches = wrap.createDiv({ cls: "nk-cp-swatches" });
  for (const hex of COMMON_COLORS) {
    const sw = swatches.createSpan({ cls: "nk-cp-swatch" });
    sw.style.background = hex;
    sw.setAttr("aria-label", hex);
    if (current.toLowerCase() === hex.toLowerCase()) sw.addClass("is-sel");
    sw.addEventListener("click", () => onPick(hex));
  }

  // --- Hex input ---
  const hexRow = wrap.createDiv({ cls: "nk-cp-hexrow" });
  hexRow.createSpan({ cls: "nk-cp-label nk-cp-label-inline", text: "Hex" });
  const preview = hexRow.createSpan({ cls: "nk-cp-hexpreview" });
  if (isHexColor(current)) preview.style.background = current;
  const input = hexRow.createEl("input", {
    cls: "nk-cp-hexinput",
    attr: { type: "text", placeholder: "#8b5cf6", spellcheck: "false" },
  });
  if (isHexColor(current)) input.value = current;
  const apply = () => {
    const v = normalizeHex(input.value);
    if (v) {
      onPick(v);
    } else if (input.value.trim()) {
      new Notice("Enter a valid hex color, e.g. #8b5cf6");
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  });
  input.addEventListener("blur", apply);
  input.addEventListener("input", () => {
    const v = normalizeHex(input.value);
    preview.style.background = v ?? "transparent";
  });
}

/** Modal to create a new group: name + color picker. */
export class NewGroupModal extends Modal {
  private name = "";
  private color = "blue";
  private pickerEl!: HTMLElement;

  constructor(
    app: App,
    private onSubmit: (name: string, color: string) => void,
    private title = "New group",
    private placeholder = "Group name"
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const { contentEl } = this;

    new Setting(contentEl).setName("Name").addText((t) => {
      t.setPlaceholder(this.placeholder).onChange((v) => (this.name = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    this.pickerEl = contentEl.createDiv();
    this.drawPicker();

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Create").setCta().onClick(() => this.submit())
      );
  }

  private drawPicker(): void {
    this.pickerEl.empty();
    renderColorPicker(this.pickerEl, this.color, (c) => {
      this.color = c;
      this.drawPicker();
    });
  }

  private submit(): void {
    const n = this.name.trim();
    if (!n) {
      new Notice("Enter a name.");
      return;
    }
    this.close();
    this.onSubmit(n, this.color);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Modal to change an existing group's color (applies live). */
export class GroupColorModal extends Modal {
  constructor(
    app: App,
    private current: string,
    private onPick: (color: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Group color");
    this.draw();
  }

  private draw(): void {
    this.contentEl.empty();
    renderColorPicker(this.contentEl, this.current, (c) => {
      this.current = c;
      this.onPick(c);
      this.draw();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Modal to create a quest: name, type (definite / radiant) and color. */
export class NewQuestModal extends Modal {
  private name = "";
  private color = "blue";
  private radiant = false;
  private typeEl!: HTMLElement;
  private pickerEl!: HTMLElement;

  constructor(
    app: App,
    private onSubmit: (name: string, color: string, radiant: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("New quest");
    const { contentEl } = this;

    new Setting(contentEl).setName("Name").addText((t) => {
      t.setPlaceholder("e.g. WAF rollout, Ad-hoc requests").onChange((v) => (this.name = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    this.typeEl = contentEl.createDiv({ cls: "nk-qtype-row" });
    this.drawType();

    this.pickerEl = contentEl.createDiv();
    this.drawPicker();

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Create").setCta().onClick(() => this.submit()));
  }

  private drawType(): void {
    this.typeEl.empty();
    const options: { radiant: boolean; icon: string; title: string; desc: string }[] = [
      {
        radiant: false,
        icon: "🏁",
        title: "Definite",
        desc: "Has a goal and an end: ordered steps, progress, start / target dates.",
      },
      {
        radiant: true,
        icon: "∞",
        title: "Radiant",
        desc: "Endless log of mostly unrelated tasks — e.g. ad-hoc requests.",
      },
    ];
    for (const o of options) {
      const card = this.typeEl.createDiv({ cls: "nk-qtype" });
      card.toggleClass("is-sel", o.radiant === this.radiant);
      const head = card.createDiv({ cls: "nk-qtype-head" });
      head.createSpan({ cls: "nk-qtype-icon", text: o.icon });
      head.createSpan({ text: o.title });
      card.createDiv({ cls: "nk-qtype-desc", text: o.desc });
      card.addEventListener("click", () => {
        this.radiant = o.radiant;
        this.drawType();
      });
    }
  }

  private drawPicker(): void {
    this.pickerEl.empty();
    renderColorPicker(this.pickerEl, this.color, (c) => {
      this.color = c;
      this.drawPicker();
    });
  }

  private submit(): void {
    const n = this.name.trim();
    if (!n) {
      new Notice("Enter a name.");
      return;
    }
    this.close();
    this.onSubmit(n, this.color, this.radiant);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
