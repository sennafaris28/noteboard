/**
 * Notion's tag color palette. Each key maps to a CSS class suffix used in
 * styles.css (e.g. `nk-color-blue`). The values here are only used for the
 * color-picker swatches; the actual rendered colors live in CSS so they adapt
 * to Obsidian's light / dark themes.
 */
export const NOTION_COLORS: Record<string, { label: string; swatch: string }> = {
  default: { label: "Default", swatch: "#e3e2e0" },
  gray: { label: "Gray", swatch: "#e3e2e0" },
  brown: { label: "Brown", swatch: "#eee0da" },
  orange: { label: "Orange", swatch: "#fadec9" },
  yellow: { label: "Yellow", swatch: "#fdecc8" },
  green: { label: "Green", swatch: "#dbeddb" },
  blue: { label: "Blue", swatch: "#d3e5ef" },
  purple: { label: "Purple", swatch: "#e8deee" },
  pink: { label: "Pink", swatch: "#f5e0e9" },
  red: { label: "Red", swatch: "#ffe2dd" },
};

export const COLOR_KEYS = Object.keys(NOTION_COLORS);

/** Deterministically pick a color for a freshly-created option/column. */
export function autoColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  // skip "default" so auto options get a visible tint
  const pickable = COLOR_KEYS.filter((c) => c !== "default");
  return pickable[h % pickable.length];
}

/**
 * A random palette colour for a new quest, preferring ones no other quest
 * uses yet so quests stay easy to tell apart.
 */
export function randomColor(used: readonly (string | undefined)[] = []): string {
  const pickable = COLOR_KEYS.filter((c) => c !== "default");
  const taken = new Set(used);
  const fresh = pickable.filter((c) => !taken.has(c));
  const pool = fresh.length ? fresh : pickable;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function colorClass(color: string | undefined): string {
  const key = color && NOTION_COLORS[color] ? color : "default";
  return `nk-color-${key}`;
}

/** A handful of common hex colors for the quick-pick row in the color picker. */
export const COMMON_COLORS = [
  "#eb5757", "#f2994a", "#f2c94c", "#6fcf97", "#27ae60",
  "#56ccf2", "#2f80ed", "#9b51e0", "#bb6bd9", "#eb2f96",
  "#111827", "#6b7280", "#d1d5db", "#ffffff",
];

export function isHexColor(color?: string): boolean {
  return !!color && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color.trim());
}

/** Normalize user hex input (#abc, abc, #aabbcc, aabbcc) to #aabbcc, or null. */
export function normalizeHex(input: string): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  if (!v.startsWith("#")) v = "#" + v;
  const short = /^#([0-9a-f]{3})$/.exec(v);
  if (short) {
    v = "#" + short[1].split("").map((c) => c + c).join("");
  }
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** Pick readable text color (near-black / white) for a hex background. */
export function contrastColor(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return "#ffffff";
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}

/**
 * Apply a color (palette key OR hex) to an element that styles itself via the
 * `--nk-bg` / `--nk-fg` custom properties (chips, pills, swatches).
 */
export function applyColor(el: HTMLElement, color: string | undefined): void {
  for (const k of COLOR_KEYS) el.removeClass(`nk-color-${k}`);
  el.style.removeProperty("--nk-bg");
  el.style.removeProperty("--nk-fg");
  if (isHexColor(color)) {
    const hex = color as string;
    el.style.setProperty("--nk-bg", hex);
    el.style.setProperty("--nk-fg", contrastColor(hex));
  } else {
    el.addClass(colorClass(color));
  }
}
