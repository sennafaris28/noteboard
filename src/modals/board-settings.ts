import { App, Menu, Modal, Notice, Setting, setIcon } from "obsidian";
import {
  BoardConfig,
  COL_SHADOW_DEFAULT,
  COL_WIDTH_DEFAULT,
  PropertyDef,
  PropertyType,
} from "../types";
import { COLOR_KEYS, NOTION_COLORS, applyColor } from "../colors";
import { promptText } from "./prompt";
import { NewGroupModal } from "./color-picker";
import { dateField } from "../dateinput";
import { SPRINT_DAYS_DEFAULT } from "../sprint";

const TYPES: { value: PropertyType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "multiselect", label: "Multi-select" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
];

export class BoardSettingsModal extends Modal {
  constructor(
    private appRef: App,
    private config: BoardConfig,
    private onChange: () => void
  ) {
    super(appRef);
  }

  onOpen(): void {
    this.modalEl.addClass("nk-settings-modal");
    this.titleEl.setText("Board settings");
    this.draw();
  }

  private draw(): void {
    const { contentEl } = this;
    contentEl.empty();

    // --- Cards folder ---
    new Setting(contentEl)
      .setName("Cards folder")
      .setDesc("Vault folder that holds this board's card notes. Blank = vault root.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. Projects/Board")
          .setValue(this.config.folder)
          .onChange((v) => {
            this.config.folder = v.trim().replace(/^\/+|\/+$/g, "");
            this.onChange();
          })
      );

    // --- Group by ---
    new Setting(contentEl)
      .setName("Group by")
      .setDesc("The property whose values become columns.")
      .addDropdown((d) => {
        for (const p of this.config.properties) d.addOption(p.name, p.name);
        d.setValue(this.config.groupBy).onChange((v) => {
          this.config.groupBy = v;
          this.rebuildColumnsFromProperty(v);
          this.onChange();
          this.draw();
        });
      });

    // --- Behavior ---
    new Setting(contentEl)
      .setName("Open new cards as note")
      .setDesc("When you add a card, open the full note editor instead of the card popup.")
      .addToggle((t) =>
        t
          .setValue(this.config.openNewCardAsNote ?? false)
          .onChange((v) => {
            this.config.openNewCardAsNote = v;
            this.onChange();
          })
      );

    new Setting(contentEl)
      .setName("Random icons")
      .setDesc("Give every card a stable random icon when it doesn't have one set.")
      .addToggle((t) =>
        t
          .setValue(this.config.randomIcons !== false)
          .onChange((v) => {
            this.config.randomIcons = v;
            this.onChange();
          })
      );

    // --- Sprints ---
    contentEl.createEl("h4", { text: "Sprints" });
    const startSetting = new Setting(contentEl)
      .setName("A sprint's first day")
      .setDesc("Any sprint your team has run (dd/mm/yyyy), so NoteBoard's sprints line up with theirs. Blank = sprints start this week's Monday.");
    dateField(startSetting.controlEl, this.config.sprintStart ?? "", (iso) => {
      this.config.sprintStart = iso || undefined;
      this.onChange();
    });
    new Setting(contentEl)
      .setName("That sprint's number")
      .setDesc("What the team calls the sprint starting on that day, e.g. 24. Later sprints count up from it.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.config.sprintNumber ?? 1)).onChange((v) => {
          const n = Math.round(Number(v));
          this.config.sprintNumber = Number.isFinite(n) && v.trim() !== "" ? n : undefined;
          this.onChange();
        });
      });
    new Setting(contentEl)
      .setName("Sprint length")
      .setDesc("In days. 14 = two weeks.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.setValue(String(this.config.sprintDays ?? SPRINT_DAYS_DEFAULT)).onChange((v) => {
          const n = Math.round(Number(v));
          this.config.sprintDays = n >= 1 ? n : undefined;
          this.onChange();
        });
      });

    // --- Appearance ---
    contentEl.createEl("h4", { text: "Appearance" });

    new Setting(contentEl)
      .setName("Column width")
      .setDesc("How wide each column is, in pixels.")
      .addSlider((s) =>
        s
          .setLimits(220, 560, 10)
          .setValue(this.config.colWidth ?? COL_WIDTH_DEFAULT)
          .setDynamicTooltip()
          .onChange((v) => {
            this.config.colWidth = v;
            this.onChange();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reset to default")
          .onClick(() => {
            this.config.colWidth = COL_WIDTH_DEFAULT;
            this.onChange();
            this.draw();
          })
      );

    new Setting(contentEl)
      .setName("Column shadow")
      .setDesc("Drop-shadow strength (0 = flat, 100 = default, higher = more pop).")
      .addSlider((s) =>
        s
          .setLimits(0, 200, 10)
          .setValue(this.config.colShadow ?? COL_SHADOW_DEFAULT)
          .setDynamicTooltip()
          .onChange((v) => {
            this.config.colShadow = v;
            this.onChange();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reset to default")
          .onClick(() => {
            this.config.colShadow = COL_SHADOW_DEFAULT;
            this.onChange();
            this.draw();
          })
      );

    // --- Visible card properties ---
    contentEl.createEl("h4", { text: "Shown on cards" });
    const shown = contentEl.createDiv({ cls: "nk-toggle-grid" });
    for (const p of this.config.properties) {
      if (p.name === this.config.groupBy) continue; // group shown as column
      const chip = shown.createDiv({ cls: "nk-toggle-chip" });
      const on = this.config.cardProps.includes(p.name);
      chip.toggleClass("is-on", on);
      chip.setText(p.name);
      chip.addEventListener("click", () => {
        const idx = this.config.cardProps.indexOf(p.name);
        if (idx >= 0) this.config.cardProps.splice(idx, 1);
        else this.config.cardProps.push(p.name);
        this.onChange();
        this.draw();
      });
    }
    if (!shown.childElementCount) shown.createSpan({ cls: "nk-muted", text: "No other properties yet." });

    // --- Properties schema ---
    contentEl.createEl("h4", { text: "Properties" });
    for (const def of this.config.properties) this.renderPropertyEditor(contentEl, def);

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("+ Add property")
        .onClick(async () => {
          const name = await promptText(this.appRef, "New property", "Property name");
          if (!name) return;
          if (this.config.properties.some((p) => p.name === name)) {
            new Notice("That property already exists.");
            return;
          }
          this.config.properties.push({ name, type: "text" });
          this.onChange();
          this.draw();
        })
    );
  }

  private renderPropertyEditor(parent: HTMLElement, def: PropertyDef): void {
    const isGroup = def.name === this.config.groupBy;
    const setting = new Setting(parent).setName(def.name);
    if (isGroup) setting.setDesc("Group-by property");

    setting.addDropdown((d) => {
      for (const t of TYPES) d.addOption(t.value, t.label);
      d.setValue(def.type).onChange((v) => {
        def.type = v as PropertyType;
        if ((def.type === "select" || def.type === "multiselect") && !def.options) {
          def.options = [];
        }
        this.onChange();
        this.draw();
      });
    });

    if (def.type === "select" || def.type === "multiselect") {
      setting.addButton((b) =>
        b.setButtonText("Options").onClick(() => this.editOptions(def))
      );
    }

    if (!isGroup) {
      setting.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Delete property")
          .onClick(() => {
            this.config.properties = this.config.properties.filter(
              (p) => p.name !== def.name
            );
            this.config.cardProps = this.config.cardProps.filter(
              (n) => n !== def.name
            );
            this.onChange();
            this.draw();
          })
      );
    }
  }

  private editOptions(def: PropertyDef): void {
    new OptionsModal(this.appRef, def, () => {
      // keep columns in sync if this is the group-by property
      if (def.name === this.config.groupBy) this.rebuildColumnsFromProperty(def.name);
      this.onChange();
      this.draw();
    }).open();
  }

  private rebuildColumnsFromProperty(name: string): void {
    const def = this.config.properties.find((p) => p.name === name);
    const opts = def?.options ?? [];
    const existing = new Map(this.config.columns.map((c) => [c.id, c]));
    this.config.columns = opts.map(
      (o) => existing.get(o.name) ?? { id: o.name, color: o.color }
    );
  }
}

/** Edits the option list (name + color) of a select / multiselect property. */
class OptionsModal extends Modal {
  constructor(
    private appRef: App,
    private def: PropertyDef,
    private onChange: () => void
  ) {
    super(appRef);
  }

  onOpen(): void {
    this.titleEl.setText(`Options · ${this.def.name}`);
    this.draw();
  }

  private draw(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.def.options) this.def.options = [];

    for (const opt of this.def.options) {
      const row = new Setting(contentEl);
      row.controlEl.addClass("nk-option-row");

      // color swatch button
      row.addExtraButton((b) => {
        applyColor(b.extraSettingsEl, opt.color);
        b.extraSettingsEl.addClass("nk-swatch");
        b.setTooltip(NOTION_COLORS[opt.color]?.label ?? "Color").onClick(() => {
          const menu = new Menu();
          for (const key of COLOR_KEYS) {
            menu.addItem((i) =>
              i
                .setTitle(NOTION_COLORS[key].label)
                .setChecked(opt.color === key)
                .onClick(() => {
                  opt.color = key;
                  this.onChange();
                  this.draw();
                })
            );
          }
          const rect = b.extraSettingsEl.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        });
      });

      row.addText((t) =>
        t.setValue(opt.name).onChange((v) => {
          const old = opt.name;
          opt.name = v;
          // Note: existing card notes keep the old value until re-set.
          void old;
          this.onChange();
        })
      );

      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Delete option")
          .onClick(() => {
            this.def.options = (this.def.options ?? []).filter((o) => o !== opt);
            this.onChange();
            this.draw();
          })
      );
    }

    const add = contentEl.createDiv({ cls: "nk-add-prop" });
    setIcon(add.createSpan({ cls: "nk-footer-icon" }), "plus");
    add.createSpan({ text: " Add option" });
    add.addEventListener("click", () => {
      new NewGroupModal(
        this.appRef,
        (name, color) => {
          if ((this.def.options ?? []).some((o) => o.name === name)) {
            new Notice("That option already exists.");
            return;
          }
          this.def.options!.push({ name, color });
          this.onChange();
          this.draw();
        },
        "New option",
        "Option name"
      ).open();
    });
  }
}
