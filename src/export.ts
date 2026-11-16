import {
  App,
  Component,
  FileSystemAdapter,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  MenuItem,
  Notice,
  Platform,
  TFile,
} from "obsidian";
import { readBody } from "./store";

/** Everything you can do with a note's content. */
export type ExportKey = "copy-md" | "copy-body" | "copy-rich" | "copy-file" | "save" | "copy-uri";

interface Action {
  key: ExportKey;
  title: string;
  icon: string;
}

/** Menu entries, in order. Mobile folds "copy file" + "save" into one share sheet. */
function actions(): Action[] {
  const list: Action[] = [
    { key: "copy-md", title: "Copy markdown", icon: "clipboard-copy" },
    { key: "copy-body", title: "Copy body only (no properties)", icon: "clipboard-type" },
    { key: "copy-rich", title: "Copy as rich text", icon: "clipboard-paste" },
  ];
  if (Platform.isMobile) {
    list.push({ key: "save", title: "Share / save .md file…", icon: "share" });
  } else {
    list.push({ key: "copy-file", title: "Copy file (.md)", icon: "paperclip" });
    list.push({ key: "save", title: "Save as .md…", icon: "download" });
  }
  list.push({ key: "copy-uri", title: "Copy obsidian:// link", icon: "link-2" });
  return list;
}

const kb = (s: string) => `${Math.max(0.1, new Blob([s]).size / 1024).toFixed(1)} KB`;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "").trim() || "note";

/** Run one export action for a note. Errors become a notice, never a throw. */
export async function runExport(app: App, file: TFile, key: ExportKey, prepare?: () => Promise<void>): Promise<void> {
  try {
    await prepare?.();
    await flushOpenEditors(app, file);
    switch (key) {
      case "copy-md": {
        const md = await noteMarkdown(app, file, true);
        await copyText(md);
        new Notice(`Copied markdown (${kb(md)})`);
        return;
      }
      case "copy-body": {
        const md = await noteMarkdown(app, file, false);
        await copyText(md);
        new Notice(`Copied body (${kb(md)})`);
        return;
      }
      case "copy-rich": {
        const { html, text } = await noteHtml(app, file);
        await copyHtml(html, text);
        new Notice("Copied as rich text — paste into Docs, email or Slack");
        return;
      }
      case "copy-file": {
        const res = await copyFileToClipboard(app, file);
        if (res.ok) {
          new Notice(`Copied “${file.name}” as a file — paste it where you'd attach one`);
        } else {
          // At least get the content onto the clipboard.
          await copyText(await noteMarkdown(app, file, true));
          console.warn("NoteBoard: copy file unavailable —", res.why);
          new Notice(
            `Couldn't put the .md file on the clipboard (${res.why}). Copied its text instead — use “Save as .md…” for a real file.`,
            9000
          );
        }
        return;
      }
      case "save":
        await saveFile(app, file);
        return;
      case "copy-uri": {
        const uri = `obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(file.path)}`;
        await copyText(uri);
        new Notice("Copied obsidian:// link");
        return;
      }
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return; // user cancelled a dialog
    console.error("NoteBoard: export failed", e);
    new Notice(`Export failed: ${(e as Error)?.message ?? e}`);
  }
}

/** Flat menu (card modal button): one item per action. */
export function exportMenu(app: App, file: TFile, prepare?: () => Promise<void>): Menu {
  const menu = new Menu();
  for (const a of actions()) {
    menu.addItem((i) => i.setTitle(a.title).setIcon(a.icon).onClick(() => void runExport(app, file, a.key, prepare)));
  }
  return menu;
}

/** True where Obsidian's menus support nested submenus. */
const hasSubmenu = () =>
  typeof (MenuItem.prototype as unknown as { setSubmenu?: unknown }).setSubmenu === "function";

/** Add an "Export" submenu (or a flat group, if submenus aren't available) to an existing menu. */
export function addExportMenu(menu: Menu, app: App, file: TFile, prepare?: () => Promise<void>): void {
  menu.addSeparator();
  if (hasSubmenu()) {
    menu.addItem((item) => {
      item.setTitle("Export").setIcon("share");
      const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
      for (const a of actions()) {
        sub.addItem((i) => i.setTitle(a.title).setIcon(a.icon).onClick(() => void runExport(app, file, a.key, prepare)));
      }
    });
  } else {
    for (const a of actions()) {
      menu.addItem((i) => i.setTitle(`Export: ${a.title}`).setIcon(a.icon).onClick(() => void runExport(app, file, a.key, prepare)));
    }
  }
}

// ---- Clipboard with fallbacks -------------------------------------------------

/** Electron's renderer-side clipboard, if this Obsidian exposes it. */
function electronClipboard(): { writeText?: (t: string) => unknown } | undefined {
  try {
    const req = (window as unknown as { require?: (m: string) => any }).require;
    return req?.("electron")?.clipboard;
  } catch {
    return undefined;
  }
}

/** Select + copy via the oldest API — works even when the async clipboard is refused. */
function execCopy(fill: (host: HTMLElement) => void): boolean {
  const host = document.createElement("div");
  host.contentEditable = "true";
  Object.assign(host.style, { position: "fixed", left: "-9999px", top: "0", opacity: "0", whiteSpace: "pre-wrap" });
  fill(host);
  document.body.appendChild(host);
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(host);
  sel?.removeAllRanges();
  sel?.addRange(range);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  sel?.removeAllRanges();
  host.remove();
  return ok;
}

/** Plain text to the clipboard: browser API, then Electron's, then execCommand. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {
    console.warn("NoteBoard: navigator.clipboard.writeText failed, trying fallbacks", e);
  }
  try {
    const c = electronClipboard();
    if (c?.writeText) {
      await c.writeText(text);
      return;
    }
  } catch {
    /* next */
  }
  if (execCopy((h) => (h.textContent = text))) return;
  throw new Error("the system refused clipboard access");
}

/** Rich text: HTML + a plain-text fallback, with the same fallbacks. */
async function copyHtml(html: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return;
  } catch (e) {
    console.warn("NoteBoard: rich-text clipboard write failed, trying fallback", e);
  }
  if (execCopy((h) => (h.innerHTML = html))) return;
  throw new Error("the system refused clipboard access");
}

// ---- Content ----------------------------------------------------------------

/** Make sure anything typed into an open editor is on disk before we read it. */
async function flushOpenEditors(app: App, file: TFile): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as MarkdownView;
    if (view.file?.path === file.path) await view.save();
  }
}

/** The note as markdown: the whole file, or just the body under a `# Title`. */
export async function noteMarkdown(app: App, file: TFile, withProperties: boolean): Promise<string> {
  if (withProperties) return app.vault.read(file);
  const body = (await readBody(app, file)).trim();
  return /^#\s/.test(body) ? `${body}\n` : `# ${file.basename}\n\n${body}\n`;
}

/** The note rendered to clean HTML (what Obsidian shows), plus its markdown as the plain-text fallback. */
async function noteHtml(app: App, file: TFile): Promise<{ html: string; text: string }> {
  const text = await noteMarkdown(app, file, false);
  const host = document.createElement("div");
  const comp = new Component();
  comp.load();
  try {
    await MarkdownRenderer.render(app, text, host, file.path, comp);
    await inlineImages(app, host, file);
    cleanHtml(host);
  } finally {
    comp.unload();
  }
  return { html: host.innerHTML, text };
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** Embed vault images as data: URIs so they survive a paste into another app. */
async function inlineImages(app: App, host: HTMLElement, from: TFile): Promise<void> {
  for (const img of Array.from(host.querySelectorAll("img"))) {
    try {
      const name = (img.getAttribute("alt") ?? "").split("|")[0].trim();
      const dest = name ? app.metadataCache.getFirstLinkpathDest(name, from.path) : null;
      const mime = dest ? IMAGE_MIME[dest.extension.toLowerCase()] : undefined;
      if (dest && mime) {
        const buf = await app.vault.readBinary(dest);
        if (buf.byteLength <= 1.5 * 1024 * 1024) {
          let bin = "";
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          img.setAttribute("src", `data:${mime};base64,${btoa(bin)}`);
          continue;
        }
      }
      // A vault-only address means nothing outside Obsidian.
      if (/^(app|capacitor|file):/i.test(img.getAttribute("src") ?? "")) {
        img.replaceWith(document.createTextNode(`[image${name ? `: ${name}` : ""}]`));
      }
    } catch {
      /* leave this image as-is */
    }
  }
}

/** Strip Obsidian's UI chrome and styling hooks so the HTML pastes cleanly. */
function cleanHtml(host: HTMLElement): void {
  host
    .querySelectorAll(".copy-code-button, .edit-block-button, .collapse-indicator, .heading-collapse-indicator")
    .forEach((n) => n.remove());
  // Internal links only work inside Obsidian — keep their text.
  host.querySelectorAll("a.internal-link").forEach((a) => a.replaceWith(document.createTextNode(a.textContent ?? "")));
  host.querySelectorAll("input.task-list-item-checkbox").forEach((i) =>
    i.replaceWith(document.createTextNode((i as HTMLInputElement).checked ? "☑ " : "☐ "))
  );
  host.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^(class|style|dir|tabindex|draggable|contenteditable|role|data-.*|aria-.*)$/.test(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  });
}

// ---- File: clipboard, save, share -------------------------------------------

interface ElectronClipboard {
  write?: (items: unknown[]) => unknown;
  writeBuffer?: (format: string, buffer: unknown) => void;
}

/**
 * Put the note's real .md file on the system clipboard (desktop). Electron
 * maps `text/uri-list` to the OS's "copied files" format. The note's text
 * rides along as plain text, for apps that only take text. Returns false if
 * this Obsidian can't do it (the caller then offers Save as…).
 */
async function copyFileToClipboard(app: App, file: TFile): Promise<{ ok: boolean; why?: string }> {
  if (Platform.isMobile) return { ok: false, why: "iOS can't put files on the clipboard" };
  const adapter = app.vault.adapter;
  const req = (window as unknown as { require?: (m: string) => any }).require;
  if (!(adapter instanceof FileSystemAdapter)) return { ok: false, why: "this vault isn't on a local disk" };
  if (!req) return { ok: false, why: "plugins can't reach Electron in this Obsidian" };

  let electron: { clipboard?: ElectronClipboard; ClipboardItem?: new (items: Record<string, unknown>) => unknown };
  let uri: string;
  try {
    electron = req("electron");
    uri = req("url").pathToFileURL(adapter.getFullPath(file.path)).href;
  } catch (e) {
    return { ok: false, why: `Electron isn't available to plugins (${(e as Error).message})` };
  }
  const clipboard = electron.clipboard;
  if (!clipboard) {
    const v = (window as unknown as { process?: { versions?: { electron?: string } } }).process?.versions?.electron;
    return { ok: false, why: `Electron ${v ?? ""} doesn't expose its clipboard to plugins`.replace("  ", " ") };
  }
  let lastError = "";
  const list = `${uri}\r\n`;
  const text = await app.vault.read(file);

  // Newer Electron: one write carries every representation together.
  if (typeof electron.ClipboardItem === "function" && typeof clipboard.write === "function") {
    const Item = electron.ClipboardItem;
    const variants: Record<string, unknown>[] = [
      {
        "text/uri-list": list,
        "text/plain": text,
        // GNOME Files' own copied-files format, if this Electron accepts raw formats.
        "electron application/osclipboard;format=x-special/gnome-copied-files": `copy\n${uri}`,
      },
      { "text/uri-list": list, "text/plain": text },
    ];
    for (const items of variants) {
      try {
        await clipboard.write([new Item(items)]);
        return { ok: true };
      } catch (e) {
        lastError = (e as Error)?.message ?? String(e);
      }
    }
  }
  // Older Electron.
  if (typeof clipboard.writeBuffer === "function") {
    try {
      // Node's Buffer, fetched explicitly — the bare global isn't guaranteed in a plugin bundle.
      const NodeBuffer = req("buffer").Buffer as { from(s: string): unknown };
      clipboard.writeBuffer("text/uri-list", NodeBuffer.from(list));
      return { ok: true };
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
    }
  }
  return {
    ok: false,
    why: lastError ? `Electron refused it: ${lastError}` : "this Electron has no file-clipboard API",
  };
}

/** Save the note as a .md file: share sheet on mobile, a save dialog on desktop. */
async function saveFile(app: App, file: TFile): Promise<void> {
  const md = await app.vault.read(file);
  const name = `${safeName(file.basename)}.md`;

  if (Platform.isMobile) {
    const f = new File([md], name, { type: "text/markdown" });
    if (navigator.canShare?.({ files: [f] })) {
      await navigator.share({ files: [f], title: file.basename });
      return;
    }
  } else {
    const picker = (window as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }> }>;
    }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: name,
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
        });
        const w = await handle.createWritable();
        await w.write(md);
        await w.close();
        new Notice(`Saved ${name}`);
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return; // cancelled
        /* picker unavailable here — use a download instead */
      }
    }
  }
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  new Notice(`Exporting ${name}…`);
}

/** What this Obsidian lets the plugin do with the clipboard — for debugging "copy failed". */
export async function exportDiagnostics(app: App, file: TFile | null): Promise<string[]> {
  const w = window as unknown as {
    require?: (m: string) => any;
    process?: { versions?: Record<string, string> };
    showSaveFilePicker?: unknown;
  };
  const lines: string[] = [];
  const v = w.process?.versions;
  lines.push(`Obsidian ${(app as unknown as { appVersion?: string }).appVersion ?? "?"} · Electron ${v?.electron ?? "?"} · Chrome ${v?.chrome ?? "?"}`);
  lines.push(`Platform: ${Platform.isMobile ? "mobile" : "desktop"}${Platform.isLinux ? " · Linux" : ""}`);
  let electron: any;
  try {
    electron = w.require?.("electron");
  } catch {
    electron = undefined;
  }
  lines.push(`require("electron"): ${electron ? "yes" : "NO"}`);
  lines.push(`  .clipboard: ${electron?.clipboard ? "yes" : "NO"}   .ClipboardItem: ${electron?.ClipboardItem ? "yes" : "NO"}`);
  lines.push(`  clipboard.writeBuffer: ${typeof electron?.clipboard?.writeBuffer === "function" ? "yes" : "NO"}`);
  lines.push(`navigator.clipboard: ${navigator.clipboard ? "yes" : "NO"}`);
  try {
    const supports = (t: string) => (ClipboardItem as unknown as { supports?: (x: string) => boolean }).supports?.(t);
    lines.push(`  async clipboard supports text/html: ${supports("text/html")} · text/uri-list: ${supports("text/uri-list")}`);
  } catch {
    /* older engines */
  }
  try {
    const st = await navigator.permissions.query({ name: "clipboard-write" as PermissionName });
    lines.push(`  clipboard-write permission: ${st.state}`);
  } catch {
    lines.push("  clipboard-write permission: (can't query)");
  }
  lines.push(`showSaveFilePicker: ${w.showSaveFilePicker ? "yes" : "NO"}`);
  const adapter = app.vault.adapter;
  lines.push(`Local vault path: ${adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "no (not a local disk)"}`);
  if (file && adapter instanceof FileSystemAdapter) lines.push(`Active note path: ${adapter.getFullPath(file.path)}`);
  return lines;
}
