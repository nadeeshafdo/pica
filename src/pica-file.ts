import { DOMParser } from "linkedom";
import { fastBbox } from "./bbox.js";

export const SVG_NS = "http://www.w3.org/2000/svg";

export interface PicaMeta {
  version: 1;
  fps: number;
  durationMs: number;
  background: string;
}

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PicaNode {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  bbox: Bbox;
}

export interface PicaNodeTree extends PicaNode {
  children: PicaNodeTree[];
}

export interface PicaAnimations {
  name: string;
  keyframes: string;
  targets: string[];
}

export interface ParsedPica {
  width: number;
  height: number;
  meta: PicaMeta;
  cssText: string;
  animations: PicaAnimations[];
  nodesFlat: PicaNode[];
  nodesTree: PicaNodeTree[];
  raw: string;
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildPicaSvg(opts: {
  width: number;
  height: number;
  background: string;
  fps: number;
  durationMs: number;
}): string {
  const { width, height, background, fps, durationMs } = opts;
  const meta: PicaMeta = { version: 1, fps, durationMs, background };
  const metaJson = JSON.stringify(meta);
  return (
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<metadata id="pica-meta">${escapeAttr(metaJson)}</metadata>` +
    `<defs id="pica-defs"></defs>` +
    `<style id="pica-anim"></style>` +
    `<rect id="pica-bg" width="100%" height="100%" fill="${escapeAttr(background)}"/>` +
    `<g id="pica-root"></g>` +
    `</svg>`
  );
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  const { dirname } = await import("node:path");
  const { rename } = await import("node:fs/promises");
  const dir = dirname(path);
  if (dir && dir !== "." && dir !== "") {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${path}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
  if (typeof content === "string") {
    await Bun.write(tmp, content);
  } else {
    await Bun.write(tmp, content);
  }
  await rename(tmp, path);
}

export async function atomicWriteBinary(path: string, data: Uint8Array): Promise<void> {
  await atomicWriteFile(path, data);
}

/** Lightweight strict well-formedness check (linkedom DOMParser is lenient). */
export function assertWellFormedXml(xml: string): void {
  // Strip comments, CDATA, DOCTYPE, PIs to avoid false positives.
  let s = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  // Remove text inside <style> and <metadata>? Keep tags but blank inner text
  // so stray "<" inside CSS/JSON does not break the check. We replace inner
  // content of style/metadata with placeholder.
  s = s.replace(
    /<(style|metadata)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi,
    (_m, tag: string, attrs: string | undefined) => `<${tag}${attrs ?? ""}></${tag}>`,
  );
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s)) !== null) {
    const full = m[0] as string;
    const name = m[1] as string;
    if (full.startsWith("</")) {
      const top = stack.pop();
      if (top === undefined) {
        throw new Error(`Invalid XML: unexpected closing tag </${name}> with no open tag.`);
      }
      if (top !== name) {
        throw new Error(
          `Invalid XML: mismatched closing tag </${name}>; expected </${top}>.`,
        );
      }
    } else if (full.endsWith("/>")) {
      continue;
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    throw new Error(`Invalid XML: unclosed tag(s): ${stack.join(", ")}.`);
  }
}

export function assertNoScript(s: string): void {
  if (/<script[\s>]/i.test(s)) {
    throw new Error("Rejected: <script> elements are not allowed in .pica.svg files.");
  }
}

export function loadXmlDoc(svgText: string): Document {
  assertNoScript(svgText);
  assertWellFormedXml(svgText);
  const doc = new DOMParser().parseFromString(svgText, "text/xml") as unknown as Document;
  return doc;
}

export function serializeDoc(doc: Document): string {
  const raw = doc.toString();
  return raw.replace(/^<\?xml[^>]*\?>\s*/i, "");
}

export function getElById(doc: Document, id: string): Element | null {
  // getElementById exists on Document in linkedom
  const d = doc as unknown as { getElementById(id: string): Element | null };
  return d.getElementById(id);
}

export function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i] as Attr | undefined;
    if (!a) continue;
    out[a.name] = a.value;
  }
  return out;
}

export function parseDims(doc: Document): { width: number; height: number } {
  const svg = doc.documentElement;
  const wAttr = svg?.getAttribute("width");
  const hAttr = svg?.getAttribute("height");
  let w = wAttr !== null && wAttr !== undefined ? Number.parseFloat(wAttr) : Number.NaN;
  let h = hAttr !== null && hAttr !== undefined ? Number.parseFloat(hAttr) : Number.NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    const vb = svg?.getAttribute("viewBox");
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const pw = parts[2] as number;
        const ph = parts[3] as number;
        if (!Number.isFinite(w)) w = pw;
        if (!Number.isFinite(h)) h = ph;
      }
    }
  }
  if (!Number.isFinite(w)) w = 800;
  if (!Number.isFinite(h)) h = 600;
  return { width: w, height: h };
}

export function parseMeta(doc: Document): PicaMeta {
  const metaEl = getElById(doc, "pica-meta");
  const fallback: PicaMeta = { version: 1, fps: 30, durationMs: 2000, background: "#ffffff" };
  if (!metaEl || !metaEl.textContent) return fallback;
  try {
    const raw = metaEl.textContent.trim();
    const j = JSON.parse(raw) as Partial<PicaMeta>;
    return {
      version: 1,
      fps: typeof j.fps === "number" && Number.isFinite(j.fps) ? j.fps : fallback.fps,
      durationMs:
        typeof j.durationMs === "number" && Number.isFinite(j.durationMs)
          ? j.durationMs
          : fallback.durationMs,
      background: typeof j.background === "string" ? j.background : fallback.background,
    };
  } catch {
    return fallback;
  }
}

export function parseAnimationsList(cssText: string): PicaAnimations[] {
  const names = new Set<string>();
  const kfRe = /@keyframes\s+([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = kfRe.exec(cssText)) !== null) {
    const n = m[1];
    if (n) names.add(n);
  }
  const out: PicaAnimations[] = [];
  for (const name of names) {
    const body = extractKeyframesBody(cssText, name);
    const targets = findAnimationTargets(cssText, name);
    out.push({ name, keyframes: body, targets });
  }
  return out;
}

export function extractKeyframesBody(css: string, name: string): string {
  const idx = css.indexOf(`@keyframes ${name}`);
  const altIdx = css.indexOf(`@keyframes  ${name}`);
  let start = idx >= 0 ? idx : altIdx;
  if (start < 0) {
    // fallback regex search
    const re = new RegExp(`@keyframes\\s+${escapeRegExp(name)}\\s*\\{`, "g");
    const mm = re.exec(css);
    if (!mm || mm.index === undefined) return "";
    start = mm.index;
  }
  const brace = css.indexOf("{", start);
  if (brace < 0) return "";
  let depth = 0;
  for (let i = brace; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return css.slice(brace + 1, i).trim();
    }
  }
  return "";
}

function findAnimationTargets(css: string, name: string): string[] {
  const targets: string[] = [];
  // Match "#id { ... animation ... name ... }" blocks
  const ruleRe = /#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const id = m[1] as string;
    const body = m[2] as string;
    if (body.includes(name)) targets.push(id);
  }
  return targets;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nodeFromElement(el: Element): PicaNode {
  const tag = (el.tagName ?? "unknown").toLowerCase();
  const attrs = attrsOf(el);
  const id = attrs["id"] ?? "";
  const text = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 ? (el.textContent ?? "") : (tag === "text" ? (el.textContent ?? "") : "");
  const bbox = fastBbox(tag, attrs, text);
  return { id, tag, attrs, bbox };
}

function treeFromElement(el: Element): PicaNodeTree {
  const base = nodeFromElement(el);
  const children: PicaNodeTree[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i] as Element | undefined;
    if (!c) continue;
    children.push(treeFromElement(c));
  }
  return { ...base, children };
}

export function parsePica(svgText: string): ParsedPica {
  const doc = loadXmlDoc(svgText);
  const { width, height } = parseDims(doc);
  const meta = parseMeta(doc);
  const styleEl = getElById(doc, "pica-anim");
  const cssText = (styleEl?.textContent ?? "").trim();
  const animations = parseAnimationsList(cssText);
  const root = getElById(doc, "pica-root");
  const nodesFlat: PicaNode[] = [];
  const nodesTree: PicaNodeTree[] = [];
  if (root) {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as unknown as Element | undefined;
      if (!el) continue;
      nodesFlat.push(nodeFromElement(el));
    }
    for (let i = 0; i < root.children.length; i++) {
      const c = root.children[i] as Element | undefined;
      if (!c) continue;
      nodesTree.push(treeFromElement(c));
    }
  }
  return { width, height, meta, cssText, animations, nodesFlat, nodesTree, raw: svgText };
}

export function stripDebugOverlay(svgText: string): string {
  return svgText.replace(/<g\s[^>]*id=["']pica-debug-overlay["'][\s\S]*?<\/g\s*>/gi, "");
}

export function ensurePicaSkeleton(doc: Document): void {
  const ids = ["pica-meta", "pica-defs", "pica-anim", "pica-bg", "pica-root"];
  for (const id of ids) {
    if (!getElById(doc, id)) {
      throw new Error(`Invalid .pica.svg: missing required element #${id}.`);
    }
  }
}
