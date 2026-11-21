import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { BoardConfig, PropertyDef } from "../types";
import { applyColor } from "../colors";
import { readBody, renameCard, writeBody, writeProp } from "../store";
import { promptText } from "./prompt";
import { NewGroupModal } from "./color-picker";
import { EmojiPickerModal, ICON_PROP, randomIconFor } from "./emoji-picker";
import { questContext, renderQuestBanner } from "../banner";
import { dateField } from "../dateinput";
import { exportMenu } from "../export";
import { Tx, undo } from "../undo";

const TYPE_ICON: Record<string, string> = {
  text: "text",
  number: "hash",
  select: "chevron-down-circle",
  multiselect: "tags",
  date: "calendar",
  checkbox: "check-square",
};

function readFrontmatter(app: App, file: TFile): Record<string, unknown> {
  // Prefer the metadata cache; fall back to parsing is handled by caller refresh.
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm ? { ...fm } : {};
}

export class CardModal extends Modal {
  private props: Record<string, unknown> = {};
  /** Set once the user actually changes something (title, body, or a property). */
  private dirty = false;
  /** Lifecycle owner for rendered markdown (embeds, event cleanup). */
  private renderComp = new Component();
  /** Detached leaf hosting Obsidian's real editor inside the modal. */
  private editorLeaf: WorkspaceLeaf | null = null;
  /** Persist any unsaved body before actions like "Open as note". */
  private flushBody: () => Promise<void> = async () => {};
  /** Kept so an undo/redo (or any outside edit) can refresh the open modal. */
  private propsEl: HTMLElement | null = null;
  private titleInput: HTMLInputElement | null = null;
  private redrawIcon: () => void = () => {};

  constructor(
    private appRef: App,
    private config: BoardConfig,
    private file: TFile,
    private onChange: () => void,
    private focusTitle = false,
    /** New card: if closed without any change, discard it instead of leaving an empty "Untitled" card. */
    private isNew = false,
    private onDiscard?: () => void
  ) {
    super(appRef);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("nk-card-modal");
    // Export button, in the modal's top-right (outside contentEl, so it survives re-renders).
    this.modalEl.querySelector(".nk-modal-actions")?.remove();
    const actionsEl = this.modalEl.createDiv({ cls: "nk-modal-actions" });
    // Insert a table into the embedded note editor — provided by the SlashCommands plugin.
    const tableBtn = actionsEl.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Insert table" } });
    setIcon(tableBtn, "table");
    tableBtn.addEventListener("click", () => {
      const editor = (this.editorLeaf?.view as MarkdownView | undefined)?.editor;
      const slash = (this.appRef as unknown as {
        plugins?: { plugins?: Record<string, { api?: { openTablePicker(e: unknown): void } } | undefined> };
      }).plugins?.plugins?.slashcommands?.api;
      if (!slash) new Notice("Insert table comes from the SlashCommands plugin — enable it in Community plugins.");
      else if (!editor) new Notice("The note editor isn't ready — try again in a moment.");
      else slash.openTablePicker(editor);
    });
    const exportBtn = actionsEl.createDiv({ cls: "nk-icon-btn", attr: { "aria-label": "Export" } });
    setIcon(exportBtn, "share");
    exportBtn.addEventListener("click", (e) =>
      exportMenu(this.appRef, this.file, () => this.flushBody()).showAtMouseEvent(e)
    );
    this.renderComp.load();
    // Reflect frontmatter / title changes made outside the modal (e.g. Ctrl+Z).
    this.renderComp.registerEvent(
      this.appRef.metadataCache.on("changed", (f) => {
        if (f.path !== this.file.path) return;
        this.props = readFrontmatter(this.appRef, this.file);
        this.refreshProps();
        this.redrawIcon();
      })
    );
    this.renderComp.registerEvent(
      this.appRef.vault.on("rename", (f) => {
        const t = this.titleInput;
        if (f === this.file && t && document.activeElement !== t) t.value = this.file.basename;
      })
    );
    this.props = readFrontmatter(this.appRef, this.file);
    const body = await readBody(this.appRef, this.file);
    this.renderAll(body);
  }

  async onClose(): Promise<void> {
    this.detachEditor();
    this.renderComp.unload();
    this.contentEl.empty();
    // Fresh card the user never touched → clean it up.
    if (this.isNew && !this.dirty) {
      const body = await readBody(this.appRef, this.file).catch(() => "");
      if (!body.trim()) {
        await this.appRef.fileManager.trashFile(this.file).catch(() => {});
        this.onDiscard?.();
      }
    }
  }

  private detachEditor(): void {
    if (this.editorLeaf) {
      this.editorLeaf.detach();
      this.editorLeaf = null;
    }
  }

  /**
   * Embed Obsidian's real markdown editor (live preview) in the modal by moving
   * a detached leaf's DOM into it. Edits autosave to the note, exactly like
   * opening the page. Falls back to a render/edit toggle if the internal API
   * isn't available.
   */
  private async mountEditor(host: HTMLElement, body: string): Promise<void> {
    this.detachEditor();
    try {
      // WorkspaceLeaf's constructor is internal; create a detached leaf to host
      // the editor without attaching it to the workspace.
      const LeafCtor = WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf;
      const leaf = new LeafCtor(this.appRef);
      this.editorLeaf = leaf;
      await leaf.openFile(this.file, {
        active: false,
        state: { mode: "source", source: false }, // live preview
      });
      host.addClass("nk-card-editor-host");
      const leafEl = (leaf as unknown as { containerEl: HTMLElement }).containerEl;
      host.appendChild(leafEl);
      this.flushBody = async () => {
        const view = leaf.view as MarkdownView;
        await view?.save?.();
      };
      window.setTimeout(() => {
        const view = leaf.view as MarkdownView;
        (leaf as unknown as { onResize?: () => void }).onResize?.();
        // New cards start in the title; don't let the editor steal focus.
        if (!this.isNew) view?.editor?.focus?.();
      }, 0);
    } catch (e) {
      console.error("NoteBoard: embedded editor unavailable, using fallback.", e);
      this.detachEditor();
      this.mountFallback(host, body);
    }
  }

  /** Render/edit toggle used when the embedded editor can't be created. */
  private mountFallback(host: HTMLElement, body: string): void {
    const preview = host.createDiv({ cls: "nk-card-render markdown-rendered" });
    const ta = host.createEl("textarea", {
      cls: "nk-card-body nk-hidden",
      attr: { placeholder: "Write something, or press 'Open as note' for the full editor…" },
    });
    ta.value = body;

    const renderPreview = async (md: string) => {
      preview.empty();
      if (md.trim()) {
        await MarkdownRenderer.render(this.appRef, md, preview, this.file.path, this.renderComp);
      } else {
        preview.createDiv({
          cls: "nk-render-empty",
          text: "Write something, or press 'Open as note' for the full editor…",
        });
      }
    };
    const toEdit = () => {
      preview.addClass("nk-hidden");
      ta.removeClass("nk-hidden");
      ta.focus();
    };
    const toView = async () => {
      if (ta.value.trim()) this.dirty = true;
      await writeBody(this.appRef, this.file, ta.value);
      ta.addClass("nk-hidden");
      preview.removeClass("nk-hidden");
      await renderPreview(ta.value);
    };
    preview.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, input, .task-list-item-checkbox")) return;
      toEdit();
    });
    ta.addEventListener("blur", () => void toView());
    this.flushBody = async () => {
      await writeBody(this.appRef, this.file, ta.value);
    };
    void renderPreview(body);
  }

  private renderAll(body: string): void {
    const { contentEl } = this;
    contentEl.empty();

    // --- icon ---
    this.renderIcon(contentEl);

    // --- title ---
    const titleInput = contentEl.createEl("input", {
      cls: "nk-card-modal-title",
      attr: { type: "text", placeholder: "New note" },
    });
    this.titleInput = titleInput;
    // New / still-untitled cards open empty so the "New note" placeholder shows
    // and you can just type the title; named cards show their current name.
    const isUntitled = /^Untitled( \d+)?$/.test(this.file.basename);
    titleInput.value = this.focusTitle || isUntitled ? "" : this.file.basename;
    const commitTitle = async () => {
      const v = titleInput.value.trim();
      if (v && v !== this.file.basename) {
        this.dirty = true;
        await undo.record("Rename card", async (tx) => {
          const from = this.file.path;
          await renameCard(this.appRef, this.file, v);
          tx.moved(from, this.file.path);
        });
        this.onChange();
      }
    };
    titleInput.addEventListener("blur", commitTitle);
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        titleInput.blur();
      }
    });
    if (this.focusTitle) {
      window.setTimeout(() => {
        titleInput.focus();
        titleInput.select();
      }, 0);
      this.focusTitle = false; // only on first render
    }

    // --- properties ---
    // --- quest banner (quest line + last edited) ---
    const qctx = questContext(this.config, this.file);
    if (qctx) renderQuestBanner(contentEl.createDiv(), this.appRef, this.config, this.file, qctx);

    // Properties sit on a quiet panel (like a board column); each value is a
    // raised field on top of it (like a card).
    const panel = contentEl.createDiv({ cls: "nk-card-modal-panel" });
    this.propsEl = panel.createDiv({ cls: "nk-card-modal-props" });
    this.refreshProps();

    const addProp = panel.createDiv({ cls: "nk-add-prop" });
    setIcon(addProp.createSpan({ cls: "nk-footer-icon" }), "plus");
    addProp.createSpan({ text: " Add a property" });
    addProp.addEventListener("click", () => this.addProperty());

    // --- body: embed Obsidian's own editor so it reads + edits like a page ---
    const bodyWrap = contentEl.createDiv({ cls: "nk-card-body-wrap" });
    void this.mountEditor(bodyWrap, body);

    // --- footer: Delete on the left; Open as note + OK on the right ---
    const footer = contentEl.createDiv({ cls: "nk-card-modal-footer" });
    const delBtn = footer.createEl("button", { cls: "nk-btn nk-btn-red", text: "Delete" });
    delBtn.addEventListener("click", async () => {
      this.dirty = true; // already trashing here; skip the auto-discard path
      await undo.record("Delete card", async (tx) => {
        tx.configOf(this.config);
        await tx.deleted(this.file);
        await this.appRef.fileManager.trashFile(this.file);
      });
      new Notice(`Moved "${this.file.basename}" to trash. Ctrl+Z on the board to undo.`);
      this.onChange();
      this.close();
    });
    footer.createDiv({ cls: "nk-card-modal-footer-spacer" });
    const openBtn = footer.createEl("button", { cls: "nk-btn nk-btn-green", text: "Open as note" });
    openBtn.addEventListener("click", async () => {
      this.dirty = true; // opening the note means they want to keep it
      await this.flushBody();
      this.close();
      this.appRef.workspace.getLeaf("tab").openFile(this.file);
    });
    const okBtn = footer.createEl("button", { cls: "nk-btn nk-btn-blue", text: "OK" });
    okBtn.addEventListener("click", async () => {
      await this.flushBody(); // edits autosave; make sure the body is written
      this.close();
    });
  }

  /** (Re)draw the property rows, unless the user is typing in one. */
  private refreshProps(): void {
    const el = this.propsEl;
    if (!el || el.contains(document.activeElement)) return;
    el.empty();
    for (const def of this.config.properties) this.renderPropRow(el, def);
  }

  private renderIcon(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "nk-icon-zone" });
    const draw = () => {
      wrap.empty();
      const explicit = typeof this.props[ICON_PROP] === "string"
        ? (this.props[ICON_PROP] as string).trim()
        : "";
      const random =
        this.config.randomIcons !== false ? randomIconFor(this.file.path) : "";
      if (explicit) {
        const btn = wrap.createDiv({ cls: "nk-icon-big", text: explicit });
        btn.setAttr("aria-label", "Change icon");
        btn.addEventListener("click", () => this.pickIcon(draw));
      } else if (random) {
        // Showing the auto-random icon — faded, click to pick a real one.
        const btn = wrap.createDiv({ cls: "nk-icon-big nk-icon-random", text: random });
        btn.setAttr("aria-label", "Random icon — click to choose one");
        btn.addEventListener("click", () => this.pickIcon(draw));
      } else {
        const add = wrap.createDiv({ cls: "nk-icon-add" });
        setIcon(add.createSpan({ cls: "nk-footer-icon" }), "smile");
        add.createSpan({ text: " Add icon" });
        add.addEventListener("click", () => this.pickIcon(draw));
      }
    };
    this.redrawIcon = draw;
    draw();
  }

  private pickIcon(redraw: () => void): void {
    const current = typeof this.props[ICON_PROP] === "string"
      ? (this.props[ICON_PROP] as string)
      : "";
    new EmojiPickerModal(this.appRef, current, async (emoji) => {
      this.dirty = true;
      this.props[ICON_PROP] = emoji;
      await undo.record("Change icon", async (tx) => {
        await tx.frontmatter(this.file);
        await writeProp(this.appRef, this.file, ICON_PROP, emoji);
      });
      this.onChange();
      redraw();
    }).open();
  }

  private renderPropRow(parent: HTMLElement, def: PropertyDef): void {
    const row = parent.createDiv({ cls: "nk-prop-row" });
    const label = row.createDiv({ cls: "nk-prop-label" });
    setIcon(label.createSpan({ cls: "nk-prop-type-icon" }), TYPE_ICON[def.type] ?? "text");
    label.createSpan({ text: def.name });

    const valueEl = row.createDiv({ cls: "nk-prop-value" });
    this.renderValueEditor(valueEl, def);
  }

  private renderValueEditor(host: HTMLElement, def: PropertyDef): void {
    host.empty();
    const value = this.props[def.name];

    switch (def.type) {
      case "select":
        this.renderSelect(host, def, false);
        break;
      case "multiselect":
        this.renderSelect(host, def, true);
        break;
      case "checkbox": {
        const cb = host.createEl("input", { attr: { type: "checkbox" } });
        cb.checked = value === true || value === "true";
        cb.addEventListener("change", () => this.setValue(def, cb.checked));
        break;
      }
      case "date": {
        // dd/mm/yyyy field (the native date input follows the OS locale).
        dateField(host, value ? String(value) : "", (iso) => void this.setValue(def, iso));
        break;
      }
      case "number": {
        const n = host.createEl("input", {
          cls: "nk-prop-input",
          attr: { type: "number", placeholder: "Empty" },
        });
        if (value !== undefined && value !== null) n.value = String(value);
        n.addEventListener("blur", () =>
          this.setValue(def, n.value === "" ? "" : Number(n.value))
        );
        break;
      }
      default: {
        const t = host.createEl("input", {
          cls: "nk-prop-input",
          attr: { type: "text", placeholder: "Empty" },
        });
        if (value !== undefined && value !== null) t.value = String(value);
        t.addEventListener("blur", () => this.setValue(def, t.value));
      }
    }
  }

  private renderSelect(host: HTMLElement, def: PropertyDef, multi: boolean): void {
    const current: string[] = multi
      ? Array.isArray(this.props[def.name])
        ? (this.props[def.name] as unknown[]).map(String)
        : this.props[def.name]
        ? [String(this.props[def.name])]
        : []
      : this.props[def.name]
      ? [String(this.props[def.name])]
      : [];

    const box = host.createDiv({ cls: "nk-select-box" });
    if (!current.length) {
      box.createSpan({ cls: "nk-select-empty", text: "Empty" });
    }
    for (const v of current) {
      const opt = def.options?.find((o) => o.name === v);
      const chip = box.createSpan({ cls: "nk-chip" });
      applyColor(chip, opt?.color);
      chip.createSpan({ text: v });
      if (multi) {
        const x = chip.createSpan({ cls: "nk-chip-x" });
        setIcon(x, "x");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = current.filter((c) => c !== v);
          this.setValue(def, next);
          this.renderSelect(host, def, true);
        });
      }
    }

    box.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openSelectMenu(e, host, def, multi, current);
    });
  }

  private openSelectMenu(
    e: MouseEvent,
    host: HTMLElement,
    def: PropertyDef,
    multi: boolean,
    current: string[]
  ): void {
    const menu = new Menu();
    const opts = def.options ?? [];
    for (const opt of opts) {
      const selected = current.includes(opt.name);
      menu.addItem((i) =>
        i
          .setTitle(opt.name)
          .setChecked(selected)
          .onClick(() => {
            let next: string[];
            if (multi) {
              next = selected
                ? current.filter((c) => c !== opt.name)
                : [...current, opt.name];
            } else {
              next = selected ? [] : [opt.name];
            }
            this.setValue(def, multi ? next : next[0] ?? "");
            this.renderSelect(host, def, multi);
          })
      );
    }
    if (!multi && current.length) {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Clear").setIcon("x").onClick(() => {
          this.setValue(def, "");
          this.renderSelect(host, def, multi);
        })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("New option…")
        .setIcon("plus")
        .onClick(() => {
          // Name + color, same picker as a new board group.
          new NewGroupModal(
            this.appRef,
            async (name, color) => {
              await undo.record("Add option", async (tx) => {
                tx.configOf(this.config);
                if (!def.options) def.options = [];
                if (!def.options.some((o) => o.name === name)) {
                  def.options.push({ name, color });
                }
                const next = multi ? [...current, name] : [name];
                await this.setValue(def, multi ? next : name, tx);
              });
              this.onChange(); // persist new option into board config
              this.renderSelect(host, def, multi);
            },
            `New ${def.name.toLowerCase()} option`,
            "Option name"
          ).open();
        })
    );
    menu.showAtMouseEvent(e);
  }

  private async setValue(def: PropertyDef, value: unknown, tx?: Tx): Promise<void> {
    this.dirty = true;
    this.props[def.name] = value;
    const write = async (t: Tx) => {
      await t.frontmatter(this.file);
      await writeProp(this.appRef, this.file, def.name, value);
    };
    if (tx) await write(tx);
    else await undo.record(`Edit ${def.name}`, write);
    this.onChange();
  }

  private async addProperty(): Promise<void> {
    const name = await promptText(this.appRef, "Add a property", "Property name");
    if (!name) return;
    if (this.config.properties.some((p) => p.name === name)) {
      new Notice("A property with that name already exists.");
      return;
    }
    await undo.record("Add property", async (tx) => {
      tx.configOf(this.config);
      this.config.properties.push({ name, type: "text" });
    });
    this.dirty = true;
    this.onChange();
    // re-render props section
    this.props = readFrontmatter(this.appRef, this.file);
    const body = await readBody(this.appRef, this.file);
    this.renderAll(body);
  }
}
