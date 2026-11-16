import { setIcon } from "obsidian";
import { formatDMY, parseDMY, parseDate, toISO } from "./dates";

/**
 * A dd/mm/yyyy date field. The browser's native date input follows the OS
 * locale (mm/dd/yyyy on US systems), so this is a text box that shows and
 * accepts day-first dates, plus a calendar button that opens the native
 * picker. Values in and out are ISO "YYYY-MM-DD" ("" = no date).
 */
export function dateField(
  parent: HTMLElement,
  iso: string,
  onChange: (iso: string) => void,
  opts: { autofocus?: boolean; onEnter?: () => void } = {}
): { input: HTMLInputElement; value: () => string } {
  const initial = parseDate(iso);
  let current = initial ? toISO(initial) : "";

  const wrap = parent.createDiv({ cls: "nk-datefield" });
  const input = wrap.createEl("input", {
    cls: "nk-datefield-input",
    attr: { type: "text", placeholder: "dd/mm/yyyy", spellcheck: "false" },
  });
  const show = () => {
    const d = parseDate(current);
    input.value = d ? formatDMY(d) : "";
  };
  show();

  const commit = () => {
    const text = input.value.trim();
    if (!text) {
      if (current !== "") {
        current = "";
        onChange("");
      }
      wrap.removeClass("is-invalid");
      return;
    }
    const d = parseDMY(text);
    if (!d) {
      wrap.addClass("is-invalid"); // keep what they typed so they can fix it
      return;
    }
    wrap.removeClass("is-invalid");
    const next = toISO(d);
    const changed = next !== current;
    current = next;
    show(); // normalise, e.g. "5/1/26" → "05/01/2026"
    if (changed) onChange(next);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      if (!wrap.hasClass("is-invalid")) opts.onEnter?.();
    }
  });

  // Calendar button → the native picker (its popup isn't locale-formatted text).
  const native = wrap.createEl("input", { cls: "nk-datefield-native", attr: { type: "date", tabindex: "-1" } });
  const btn = wrap.createDiv({ cls: "nk-datefield-btn", attr: { "aria-label": "Pick a date" } });
  setIcon(btn, "calendar");
  btn.addEventListener("click", () => {
    native.value = current;
    const picker = native as HTMLInputElement & { showPicker?: () => void };
    try {
      picker.showPicker ? picker.showPicker() : native.click();
    } catch {
      native.click();
    }
  });
  native.addEventListener("change", () => {
    if (!native.value) return;
    current = native.value;
    show();
    wrap.removeClass("is-invalid");
    onChange(current);
  });

  if (opts.autofocus) window.setTimeout(() => input.focus(), 0);
  return {
    input,
    /** Commit what's typed and return the ISO value (last valid one if invalid). */
    value: () => {
      commit();
      return current;
    },
  };
}
