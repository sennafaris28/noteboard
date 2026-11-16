import { App, Modal } from "obsidian";

/** Frontmatter key used to store a card/page icon (an emoji). */
export const ICON_PROP = "icon";

/** Curated emoji set with search keywords — enough to feel like Notion's picker. */
const EMOJIS: { e: string; k: string }[] = [
  // Objects / work
  { e: "📝", k: "note memo write edit pencil" },
  { e: "📄", k: "page document file" },
  { e: "📋", k: "clipboard tasks list" },
  { e: "🗂️", k: "folder files organize" },
  { e: "📁", k: "folder" },
  { e: "📅", k: "calendar date schedule" },
  { e: "📆", k: "calendar date" },
  { e: "🗓️", k: "calendar planner" },
  { e: "⏰", k: "alarm clock time reminder" },
  { e: "⏳", k: "hourglass time waiting pending" },
  { e: "📌", k: "pin important" },
  { e: "📎", k: "paperclip attach" },
  { e: "🔖", k: "bookmark tag label" },
  { e: "🏷️", k: "label tag" },
  { e: "📊", k: "chart bar stats analytics" },
  { e: "📈", k: "chart up growth trend" },
  { e: "📉", k: "chart down decline" },
  { e: "💼", k: "briefcase work business job" },
  { e: "🗃️", k: "archive box files" },
  { e: "📦", k: "box package shipping" },
  { e: "✏️", k: "pencil write edit" },
  { e: "🖊️", k: "pen write" },
  { e: "🧾", k: "receipt invoice bill" },
  { e: "📑", k: "tabs bookmark sections" },
  // Status / symbols
  { e: "✅", k: "check done complete success ok" },
  { e: "☑️", k: "check box done" },
  { e: "✔️", k: "check done" },
  { e: "❌", k: "cross no fail wrong delete" },
  { e: "⚠️", k: "warning caution alert" },
  { e: "🚨", k: "alert siren urgent emergency" },
  { e: "🔥", k: "fire hot urgent trending" },
  { e: "⭐", k: "star favorite important" },
  { e: "🌟", k: "star sparkle special" },
  { e: "❓", k: "question help unknown" },
  { e: "❗", k: "exclamation important" },
  { e: "💡", k: "idea light bulb insight" },
  { e: "🎯", k: "target goal objective aim" },
  { e: "🚀", k: "rocket launch ship fast growth" },
  { e: "⚡", k: "bolt fast energy power zap" },
  { e: "🏁", k: "flag finish race goal done" },
  { e: "🚩", k: "flag mark report" },
  { e: "🔔", k: "bell notification reminder" },
  { e: "🔒", k: "lock secure private security" },
  { e: "🔓", k: "unlock open" },
  { e: "🔑", k: "key access password" },
  { e: "🛡️", k: "shield security protect defense" },
  { e: "🧩", k: "puzzle piece integration component" },
  { e: "⚙️", k: "gear settings config" },
  { e: "🔧", k: "wrench fix tool maintenance" },
  { e: "🔨", k: "hammer build tool" },
  { e: "🛠️", k: "tools build fix" },
  { e: "🧪", k: "test experiment lab beaker qa" },
  { e: "🔬", k: "microscope research analysis" },
  { e: "🔍", k: "search find magnify investigate" },
  { e: "🐛", k: "bug defect issue error" },
  // Tech
  { e: "💻", k: "laptop computer code dev" },
  { e: "🖥️", k: "desktop computer monitor" },
  { e: "⌨️", k: "keyboard type" },
  { e: "📱", k: "phone mobile app" },
  { e: "🖲️", k: "trackball" },
  { e: "💾", k: "save disk floppy" },
  { e: "🗄️", k: "cabinet files server" },
  { e: "🌐", k: "globe web internet network world" },
  { e: "🔌", k: "plug power connect integration" },
  { e: "🔗", k: "link url chain connect" },
  { e: "📡", k: "satellite signal network broadcast" },
  { e: "🛰️", k: "satellite space network" },
  { e: "☁️", k: "cloud server storage" },
  { e: "🔋", k: "battery power" },
  // People / comms
  { e: "👤", k: "user person profile account" },
  { e: "👥", k: "users people team group" },
  { e: "🧑‍💻", k: "developer engineer coder person" },
  { e: "🙋", k: "hand raise question ask" },
  { e: "💬", k: "chat message comment talk" },
  { e: "🗨️", k: "speech chat message" },
  { e: "📣", k: "megaphone announce broadcast" },
  { e: "📢", k: "loudspeaker announce" },
  { e: "✉️", k: "email mail envelope message" },
  { e: "📧", k: "email mail" },
  { e: "📞", k: "phone call" },
  { e: "🤝", k: "handshake deal agreement partner" },
  // Misc useful
  { e: "🏆", k: "trophy win award achievement" },
  { e: "🥇", k: "medal first gold win" },
  { e: "🎉", k: "party celebrate launch done" },
  { e: "🎁", k: "gift present reward" },
  { e: "💰", k: "money cash finance budget" },
  { e: "💵", k: "money dollar cash finance" },
  { e: "💳", k: "card payment credit finance" },
  { e: "🏦", k: "bank finance building" },
  { e: "📜", k: "scroll document policy contract" },
  { e: "⚖️", k: "balance legal compliance justice" },
  { e: "🧭", k: "compass direction navigate strategy" },
  { e: "🗺️", k: "map plan roadmap" },
  { e: "📍", k: "location pin place marker" },
  { e: "🏗️", k: "construction build wip progress" },
  { e: "🧱", k: "brick wall build infra" },
  { e: "🏢", k: "office building company" },
  { e: "🏠", k: "home house" },
  { e: "🌱", k: "seedling grow new start" },
  { e: "🌿", k: "plant growth" },
  { e: "🧠", k: "brain think smart knowledge" },
  { e: "👀", k: "eyes watch review look" },
  { e: "✨", k: "sparkles new shiny magic" },
  { e: "❤️", k: "heart love favorite red" },
  { e: "🩵", k: "heart blue" },
  { e: "💚", k: "heart green" },
  { e: "💜", k: "heart purple" },
  { e: "🟢", k: "green circle status ok active" },
  { e: "🟡", k: "yellow circle status pending" },
  { e: "🔴", k: "red circle status blocked stop" },
  { e: "🔵", k: "blue circle status" },
  { e: "🟣", k: "purple circle status" },
  { e: "⚫", k: "black circle status" },
  { e: "⚪", k: "white circle status" },
  { e: "🔺", k: "triangle up high priority" },
  { e: "🔻", k: "triangle down low priority" },
];

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * Pool of neutral, good-looking page icons for the auto-randomizer. Kept free of
 * status-loaded glyphs (no ✅ ❌ 🔴 🟢 etc.) so a random icon never looks like it
 * means something.
 */
export const RANDOM_ICON_POOL = [
  "📘", "📗", "📙", "📕", "📓", "📔", "📒", "📝", "🗒️", "📑",
  "🔖", "📎", "📐", "🧮", "🗂️", "🗃️", "🗄️", "📦", "🎒", "🧰",
  "🧲", "🔭", "🔬", "🧪", "⚗️", "🧬", "🔑", "🗝️", "🧭", "🗺️",
  "🧩", "🎲", "🎯", "🎨", "🖼️", "🎸", "🎹", "🥁", "🎺", "🎧",
  "🪄", "✨", "🌟", "💫", "⚡", "🔥", "🌈", "☀️", "🌙", "🪐",
  "🚀", "🛸", "🧊", "🌱", "🌿", "🍀", "🌸", "🌼", "🌻", "🌵",
  "🍁", "🐙", "🦊", "🦉", "🐢", "🐳", "🦄", "🐝", "🦋", "🐬",
  "🍎", "🍄", "🪵", "🪸", "🧱", "⛩️", "🏔️", "🌋", "🗿", "🪩",
];

/** Deterministic icon for a seed (e.g. a note path) — stable across reloads. */
export function randomIconFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return RANDOM_ICON_POOL[(h >>> 0) % RANDOM_ICON_POOL.length];
}

/**
 * A lightweight Notion-style icon picker: filter box, emoji grid, free paste,
 * and a remove action. `onPick` receives an emoji string, or "" to clear.
 */
export class EmojiPickerModal extends Modal {
  private query = "";

  constructor(
    app: App,
    private current: string,
    private onPick: (emoji: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("nk-emoji-modal");
    this.titleEl.setText("Choose an icon");

    const { contentEl } = this;

    const top = contentEl.createDiv({ cls: "nk-emoji-top" });
    const search = top.createEl("input", {
      cls: "nk-emoji-search",
      attr: { type: "text", placeholder: "Filter or paste an emoji…", spellcheck: "false" },
    });
    const removeBtn = top.createEl("button", {
      cls: "nk-emoji-remove",
      text: "Remove",
    });
    removeBtn.toggleClass("nk-hidden", !this.current);
    removeBtn.addEventListener("click", () => {
      this.onPick("");
      this.close();
    });

    const grid = contentEl.createDiv({ cls: "nk-emoji-grid" });

    const draw = () => {
      grid.empty();
      const q = this.query.trim().toLowerCase();

      // If the user typed/pasted an actual emoji, offer it directly up top.
      const pasted = this.query.trim();
      if (pasted && EMOJI_RE.test(pasted)) {
        const seg = Array.from(pasted)[0]; // first glyph
        this.addCell(grid, seg);
      }

      const matches = q
        ? EMOJIS.filter((x) => x.k.includes(q) || x.e === pasted)
        : EMOJIS;
      for (const x of matches) this.addCell(grid, x.e);

      if (!grid.childElementCount) {
        grid.createDiv({ cls: "nk-emoji-empty", text: "No matches" });
      }
    };

    search.addEventListener("input", () => {
      this.query = search.value;
      draw();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = grid.querySelector<HTMLElement>(".nk-emoji-cell");
        if (first) first.click();
      }
    });

    draw();
    window.setTimeout(() => search.focus(), 0);
  }

  private addCell(grid: HTMLElement, emoji: string): void {
    const cell = grid.createDiv({ cls: "nk-emoji-cell", text: emoji });
    if (emoji === this.current) cell.addClass("is-sel");
    cell.addEventListener("click", () => {
      this.onPick(emoji);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
