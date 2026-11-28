import { z } from "zod";
import {
  assertBalancedBraces,
  assertNoScript,
  assertSafeAttributesRecord,
  assertSafeAttrValue,
  assertSafeDefsSvg,
  assertSafeSvgTree,
  assertWellFormedXml,
  atomicWriteFile,
  buildPicaSvg,
  ensurePicaSkeleton,
  getElById,
  isForbiddenTag,
  loadXmlDoc,
  localAttrName,
  normalizeCssForCheck,
  parseAnimationsList,
  parseDims,
  parseMeta,
  parsePica,
  resolveSafePath,
  serializeDoc,
  stripDebugOverlay,
  type Bbox,
} from "./pica-file.js";
import { renderPngBuffer } from "./render.js";
import {
  captureFrames,
  chromeMissingMessage,
  findChromeBinary,
  getExactBboxes,
  getRenderedBboxesAtTime,
  screenshotAtTime,
  screenshotInspectSinglePass,
} from "./chromium.js";
import {
  assertSafeFfmpegOutPath,
  exportAnimated,
  exportPng,
  exportPngAtTime,
  exportStaticRaster,
  exportStaticRasterAtTime,
  exportSvgClean,
} from "./export.js";
import { setCurrentSvg } from "./preview.js";

// ---------- Zod schemas ----------

export const CreateSchema = z.object({
  path: z.string().min(1).describe("Output .pica.svg file path"),
  width: z.number().int().positive().max(8192).default(800).describe("Canvas width in px"),
  height: z.number().int().positive().max(8192).default(600).describe("Canvas height in px"),
  background: z.string().default("#ffffff").describe("Canvas background color (CSS color)"),
  fps: z.number().positive().max(120).default(30).describe("Frames per second for animation export"),
  durationMs: z.number().int().positive().max(600000).default(2000).describe("Timeline duration in ms"),
});
export type CreateInput = z.infer<typeof CreateSchema>;

export const ReadSchema = z.object({
  path: z.string().min(1).describe("Input .pica.svg file path"),
  includeRaw: z.boolean().default(false).describe("Include raw SVG text in the response"),
  bboxMode: z.enum(["fast", "exact"]).default("fast").describe("fast = geometry math, exact = headless Chromium getBBox()"),
  tree: z.boolean().default(false).describe("Include nested tree in addition to flat node list"),
});
export type ReadInput = z.infer<typeof ReadSchema>;

const AttrsRecord = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const PatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    id: z.string().min(1).describe("New element id (must be unique)"),
    tag: z.string().min(1).describe("SVG tag name, e.g. rect, circle, path, text, g"),
    attrs: AttrsRecord.optional().describe("Attributes to set on the new element"),
    textContent: z.string().optional().describe("Text content (for text/tspan)"),
    parentId: z.string().default("pica-root").describe("Parent element id"),
    position: z.number().int().min(0).optional().describe("Child index within parent (append if omitted)"),
  }),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1).describe("Target element id"),
    attrs: AttrsRecord.optional().describe("Attributes to set/overwrite"),
    textContent: z.string().optional().describe("Replace text content"),
  }),
  z.object({
    op: z.literal("remove"),
    id: z.string().min(1).describe("Element id to remove"),
  }),
  z.object({
    op: z.literal("reorder"),
    id: z.string().min(1).describe("Element id to move"),
    parentId: z.string().optional().describe("New parent id (same parent if omitted)"),
    newIndex: z.number().int().min(0).optional().describe("New child index"),
    beforeId: z.string().optional().describe("Insert before this sibling id"),
  }),
  z.object({
    op: z.literal("setDefs"),
    defsSvg: z.string().describe("Raw SVG markup to place inside <defs id='pica-defs'>"),
  }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchSchema = z.object({
  path: z.string().min(1).describe("Target .pica.svg file path"),
  ops: z.array(PatchOpSchema).min(1).describe("Batch DOM mutations applied atomically by #id"),
});
export type PatchInput = z.infer<typeof PatchSchema>;

export const AnimateTargetSchema = z.object({
  id: z.string().min(1).describe("Target element id"),
  durationMs: z.number().positive().max(600000).optional().describe("One iteration duration in ms"),
  delayMs: z.number().min(0).max(600000).optional().describe("Start delay in ms"),
  easing: z.string().optional().describe("CSS easing, e.g. linear, ease, ease-in-out"),
  iterations: z.union([z.number().positive(), z.string()]).optional().describe("Count or 'infinite'"),
  direction: z.string().optional().describe("normal, reverse, alternate, alternate-reverse"),
  fill: z.string().optional().describe("none, forwards, backwards, both"),
  transformOrigin: z.string().optional().describe('CSS transform-origin, e.g. "center", "50% 50%", "left top"'),
});
export type AnimateTarget = z.infer<typeof AnimateTargetSchema>;

export const AnimateSchema = z.object({
  path: z.string().min(1).describe("Target .pica.svg file path"),
  name: z.string().min(1).describe("Keyframes name, e.g. spin, fadeUp"),
  keyframes: z.string().optional().describe("Keyframe body, e.g. '0%{opacity:0}100%{opacity:1}' (required when creating)"),
  animations: z.array(AnimateTargetSchema).optional().describe("Target animation rules to add/update"),
  remove: z.boolean().default(false).describe("Remove the keyframes and referencing rules"),
});
export type AnimateInput = z.infer<typeof AnimateSchema>;

export const ConfigureSchema = z.object({
  path: z.string().min(1).describe("Target .pica.svg file path"),
  width: z.number().int().positive().max(8192).optional().describe("Canvas width in px"),
  height: z.number().int().positive().max(8192).optional().describe("Canvas height in px"),
  background: z.string().optional().describe("Canvas background CSS color"),
  fps: z.number().positive().max(120).optional().describe("Frames per second for animated exports"),
  durationMs: z.number().int().positive().max(600000).optional().describe("Timeline duration in ms"),
});
export type ConfigureInput = z.infer<typeof ConfigureSchema>;

export const InspectSchema = z.object({
  path: z.string().min(1).describe("Input .pica.svg file path"),
  timeMs: z.number().min(0).default(0).describe("Animation timestamp in ms. Static designs render via resvg; animated designs (and any timeMs>0) capture via headless Chromium CDP when available, else static resvg fallback at timeMs=0"),
  showGrid: z.boolean().default(false).describe("Overlay subtle 100px grid (non-persisted)"),
  showIds: z.boolean().default(false).describe("Overlay #id bounding-box badges (non-persisted)"),
  scale: z.number().positive().max(4).default(1).describe("Render scale factor"),
  maxWidth: z.number().int().positive().max(8192).default(1024).describe("Cap preview width in px (effective scale is reduced to fit)"),
});
export type InspectInput = z.infer<typeof InspectSchema>;

export const ExportSchema = z.object({
  path: z.string().min(1).describe("Input .pica.svg file path"),
  format: z.enum(["svg", "png", "jpg", "jpeg", "webp", "mp4"]).describe("Output format"),
  outPath: z.string().min(1).describe("Output file path"),
  scale: z.number().positive().max(4).default(1).describe("Render scale factor"),
  quality: z.number().min(0).max(100).default(90).describe("Quality for jpg/webp/mp4 (0-100)"),
  fps: z.number().positive().max(120).optional().describe("FPS for animated export (defaults to file meta)"),
  animated: z.boolean().default(false).describe("For webp: true = animated via Chromium, false = static frame"),
  timeMs: z.number().min(0).default(0).describe("Static frame timestamp in ms. When > 0 requires Chromium; animated docs use Chromium at timeMs for accurate state."),
});
export type ExportInput = z.infer<typeof ExportSchema>;

// ---------- MCP content helper ----------

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

function okText(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function errText(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------- Handlers ----------

export async function handleCreate(input: z.input<typeof CreateSchema>): Promise<ToolResult> {
  try {
    const safePath = resolveSafePath(input.path);
    const width = input.width ?? 800;
    const height = input.height ?? 600;
    const background = input.background ?? "#ffffff";
    const fps = input.fps ?? 30;
    const durationMs = input.durationMs ?? 2000;
    const svg = buildPicaSvg({
      width,
      height,
      background,
      fps,
      durationMs,
    });
    assertNoScript(svg);
    await atomicWriteFile(safePath, svg);
    setCurrentSvg(safePath, svg);
    return okText({
      ok: true,
      path: safePath,
      width,
      height,
      background,
      fps,
      durationMs,
    });
  } catch (e) {
    return errText(`pica_create failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleRead(input: z.input<typeof ReadSchema>): Promise<ToolResult> {
  let safePath: string;
  try {
    safePath = resolveSafePath(input.path);
  } catch (e) {
    return errText(`pica_read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const includeRaw = input.includeRaw ?? false;
    const bboxMode = input.bboxMode ?? "fast";
    const tree = input.tree ?? false;
    let raw: string;
    try {
      raw = await Bun.file(safePath).text();
    } catch {
      return errText(`pica_read failed: file not found: ${safePath}. Create it first with pica_create.`);
    }
    const parsed = parsePica(raw);
    let nodes = parsed.nodesFlat;
    if (bboxMode === "exact") {
      if (!findChromeBinary()) {
        return errText(`pica_read exact bbox failed: ${chromeMissingMessage()}`);
      }
      try {
        const exact = await getExactBboxes(raw, parsed.width, parsed.height);
        const byId = new Map(exact.map((e) => [e.id, e.bbox]));
        nodes = parsed.nodesFlat.map((n) => {
          const b = n.id ? byId.get(n.id) : undefined;
          return b ? { ...n, bbox: { x: b.x, y: b.y, w: b.w, h: b.h } } : n;
        });
      } catch (e) {
        return errText(`pica_read exact bbox failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const out: Record<string, unknown> = {
      path: safePath,
      width: parsed.width,
      height: parsed.height,
      meta: parsed.meta,
      animations: parsed.animations,
      nodes,
      count: nodes.length,
      bboxMode,
    };
    if (tree) out["tree"] = parsed.nodesTree;
    if (includeRaw) out["raw"] = raw;
    return okText(out);
  } catch (e) {
    return errText(`pica_read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const PROTECTED_IDS = new Set(["pica-meta", "pica-defs", "pica-anim", "pica-bg", "pica-root"]);
const UPDATE_PROTECTED_IDS = new Set(["pica-meta", "pica-defs", "pica-anim", "pica-root"]);
const SAFE_BG_ATTRS = new Set(["fill", "opacity", "fill-opacity"]);
const SVG_NS = "http://www.w3.org/2000/svg";

const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function sanitizeTag(tag: string): void {
  const local = tag.includes(":") ? (tag.split(":").pop() ?? tag).toLowerCase() : tag.toLowerCase();
  if (isForbiddenTag(tag) || local === "script") {
    throw new Error(`Rejected: <${tag}> elements are not allowed.`);
  }
  if (!/^[A-Za-z][\w-]*$/.test(tag)) throw new Error(`Invalid tag name: ${tag}.`);
  if (/^script$/i.test(tag)) throw new Error("Rejected: <script> elements are not allowed.");
}

function sanitizeAttrs(attrs: Record<string, string | number | null> | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!attrs) return out;
  const record: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) {
      record[k] = null;
      continue;
    }
    record[k] = String(v);
  }
  assertSafeAttributesRecord(record);
  for (const [k, v] of Object.entries(record)) {
    out[k] = v;
  }
  if (Object.keys(out).some((k) => isForbiddenTag(k))) {
    throw new Error("Rejected: forbidden tag name in attributes.");
  }
  return out;
}

function sanitizeDefsSvg(defsSvg: string): void {
  assertSafeDefsSvg(defsSvg);
}

export async function handlePatch(input: z.input<typeof PatchSchema>): Promise<ToolResult> {
  let safePath: string;
  try {
    safePath = resolveSafePath(input.path);
  } catch (e) {
    return errText(`pica_patch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: string;
  try {
    raw = await Bun.file(safePath).text();
  } catch {
    return errText(`pica_patch failed: file not found: ${safePath}. Create it first with pica_create.`);
  }
  try {
    assertNoScript(raw);
    const doc = loadXmlDoc(raw);
    ensurePicaSkeleton(doc);

    for (const op of input.ops) {
      if (op.op === "add") {
        const localTag = op.tag.includes(":") ? (op.tag.split(":").pop() ?? op.tag).toLowerCase() : op.tag.toLowerCase();
        if (localTag === "style") {
          throw new Error('pica_patch add failed: <style> elements are managed by pica_animate.');
        }
        sanitizeTag(op.tag);
        if (!ID_RE.test(op.id)) {
          throw new Error(
            `pica_patch add failed: invalid id '#${op.id}'. Use /^[a-zA-Z_][a-zA-Z0-9_-]*$/.`,
          );
        }
        if (isForbiddenTag(op.id)) {
          throw new Error(`pica_patch add failed: id '#${op.id}' is forbidden.`);
        }
        const attrs = sanitizeAttrs(op.attrs);
        if (op.textContent) assertNoScript(op.textContent);
        if (getElById(doc, op.id)) throw new Error(`pica_patch add failed: id '#${op.id}' already exists.`);
        const parent = getElById(doc, op.parentId ?? "pica-root");
        if (!parent) throw new Error(`pica_patch add failed: parent '#${op.parentId ?? "pica-root"}' not found.`);
        const el = doc.createElementNS(SVG_NS, op.tag);
        el.setAttribute("id", op.id);
        for (const [k, v] of Object.entries(attrs)) {
          if (v === null) {
            throw new Error(`pica_patch add failed: attribute '${k}' cannot be null on add.`);
          }
          if (localAttrName(k).startsWith("on")) {
            throw new Error(`pica_patch add failed: event-handler attribute '${k}' is not allowed.`);
          }
          el.setAttribute(k, v);
        }
        if (op.textContent !== undefined) el.textContent = op.textContent;
        if (op.position !== undefined) {
          const idx = op.position;
          const kids = parent.children;
          if (idx >= kids.length) parent.appendChild(el);
          else {
            const ref = kids[idx];
            if (ref) parent.insertBefore(el, ref);
            else parent.appendChild(el);
          }
        } else {
          parent.appendChild(el);
        }
      } else if (op.op === "update") {
        if (UPDATE_PROTECTED_IDS.has(op.id)) {
          throw new Error(`pica_patch update failed: '#${op.id}' is protected and cannot be updated.`);
        }
        const el = getElById(doc, op.id);
        if (!el) throw new Error(`pica_patch update failed: target '#${op.id}' not found.`);
        if (op.id === "pica-bg") {
          if (op.textContent !== undefined) {
            throw new Error("pica_patch update failed: '#pica-bg' cannot have textContent.");
          }
          const attrs = sanitizeAttrs(op.attrs);
          for (const [k, v] of Object.entries(attrs)) {
            if (localAttrName(k) === "id" || k.toLowerCase() === "id") {
              throw new Error("pica_patch update failed: '#pica-bg' id cannot be changed.");
            }
            if (!SAFE_BG_ATTRS.has(localAttrName(k))) {
              throw new Error(`pica_patch update failed: attribute '${k}' is not allowed on '#pica-bg'. Allowed: fill, opacity, fill-opacity.`);
            }
          }
          for (const [k, v] of Object.entries(attrs)) {
            if (v === null) el.removeAttribute(k);
            else el.setAttribute(k, v);
          }
          if (Object.prototype.hasOwnProperty.call(attrs, "fill")) {
            const fillVal = attrs["fill"];
            if (typeof fillVal === "string") {
              const metaEl = getElById(doc, "pica-meta");
              if (metaEl?.textContent) {
                try {
                  const meta = parseMeta(doc);
                  metaEl.textContent = JSON.stringify({ ...meta, background: fillVal });
                } catch {
                  // keep existing metadata on parse issues
                }
              }
            }
          }
        } else {
          const attrs = sanitizeAttrs(op.attrs);
          for (const [k] of Object.entries(attrs)) {
            if (localAttrName(k) === "id") {
              throw new Error("pica_patch update failed: id attribute cannot be changed or removed.");
            }
          }
          for (const [k, v] of Object.entries(attrs)) {
            if (v === null) el.removeAttribute(k);
            else el.setAttribute(k, v);
          }
          if (op.textContent !== undefined) {
            assertNoScript(op.textContent);
            el.textContent = op.textContent;
          }
        }
      } else if (op.op === "remove") {
        if (PROTECTED_IDS.has(op.id)) {
          throw new Error(`pica_patch remove failed: '#${op.id}' is a protected skeleton element.`);
        }
        const el = getElById(doc, op.id);
        if (!el) throw new Error(`pica_patch remove failed: target '#${op.id}' not found.`);
        el.remove();
      } else if (op.op === "reorder") {
        const el = getElById(doc, op.id);
        if (!el) throw new Error(`pica_patch reorder failed: target '#${op.id}' not found.`);
        if (PROTECTED_IDS.has(op.id)) {
          throw new Error(`pica_patch reorder failed: '#${op.id}' is protected and cannot be moved.`);
        }
        const newParentId = op.parentId ?? (el.parentElement?.getAttribute("id") ?? "pica-root");
        const newParent = getElById(doc, newParentId);
        if (!newParent) throw new Error(`pica_patch reorder failed: parent '#${newParentId}' not found.`);
        // Guard: never move an element into itself or one of its descendants.
        let cursor: Element | null = newParent;
        while (cursor) {
          if (cursor === el) {
            throw new Error(`pica_patch reorder failed: cannot move '#${op.id}' into itself or its own descendant.`);
          }
          cursor = cursor.parentElement;
        }
        el.remove();
        if (op.beforeId) {
          const ref = getElById(doc, op.beforeId);
          if (!ref || ref.parentElement !== newParent) {
            throw new Error(`pica_patch reorder failed: beforeId '#${op.beforeId}' not found in parent '#${newParentId}'.`);
          }
          newParent.insertBefore(el, ref);
        } else if (op.newIndex !== undefined) {
          const kids = newParent.children;
          if (op.newIndex >= kids.length) newParent.appendChild(el);
          else {
            const ref = kids[op.newIndex];
            if (ref) newParent.insertBefore(el, ref);
            else newParent.appendChild(el);
          }
        } else {
          newParent.appendChild(el);
        }
      } else if (op.op === "setDefs") {
        sanitizeDefsSvg(op.defsSvg);
        const defs = getElById(doc, "pica-defs");
        if (!defs) throw new Error("pica_patch setDefs failed: #pica-defs not found.");
        defs.innerHTML = op.defsSvg;
      }
    }

    ensurePicaSkeleton(doc);
    const out = serializeDoc(doc);
    assertNoScript(out);
    assertWellFormedXml(out);
    assertSafeSvgTree(loadXmlDoc(out));
    await atomicWriteFile(safePath, out);
    setCurrentSvg(safePath, out);
    return okText({ ok: true, path: safePath, applied: input.ops.length });
  } catch (e) {
    return errText(`pica_patch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function removeKeyframesBlock(css: string, name: string): string {
  const re = new RegExp(`@keyframes\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "g");
  let out = css;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const start = m.index;
    const brace = out.indexOf("{", start);
    if (brace < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = brace; i < out.length; i++) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + 1);
    re.lastIndex = 0;
  }
  return out;
}

function animationTokenRe(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
}

function splitAnimationList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const t = cur.trim();
      if (t.length > 0) out.push(t);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const tail = cur.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

function animationEntryName(entry: string): string {
  const first = entry.trim().split(/\s+/)[0] ?? "";
  return first;
}

function parseEntryTiming(entry: string): { durationMs: number; delayMs: number; iterations: number } {
  const timeRe = /(\d+(?:\.\d+)?)(ms|s)\b/gi;
  const times: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = timeRe.exec(entry)) !== null) {
    const num = Number.parseFloat(m[1] as string);
    const unit = (m[2] as string).toLowerCase();
    if (!Number.isFinite(num)) continue;
    times.push(unit === "s" ? num * 1000 : num);
  }
  const durationMs = times[0] ?? 1000;
  const delayMs = times[1] ?? 0;
  let iterations = 1;
  if (/infinite/i.test(entry)) {
    iterations = 1;
  } else {
    const withoutTimes = entry.replace(/(\d+(?:\.\d+)?)(ms|s)\b/gi, " ");
    const withoutFuncs = withoutTimes.replace(/\([^)]*\)/g, " ");
    const withoutName = withoutFuncs.replace(/^\s*[A-Za-z_][A-Za-z0-9_-]*\s+/, " ");
    const numRe = /(^|\s)(\d+(?:\.\d+)?)(\s|,|$)/;
    const nm = numRe.exec(` ${withoutName} `);
    if (nm?.[2]) {
      const n = Number.parseFloat(nm[2]);
      if (Number.isFinite(n) && n > 0) iterations = n;
    }
  }
  return { durationMs, delayMs, iterations };
}

function extractAnimationDecl(body: string): string | null {
  const m = /animation\s*:\s*([^;]+);?/i.exec(body);
  return m?.[1]?.trim() ?? null;
}

function recalcDurationMs(css: string, baseDurationMs: number): number {
  let maxEnd = 0;
  const ruleRe = /#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const body = m[2] as string;
    const decl = extractAnimationDecl(body);
    if (!decl) continue;
    for (const entry of splitAnimationList(decl)) {
      if (!entry.trim()) continue;
      const { durationMs, delayMs, iterations } = parseEntryTiming(entry);
      const end = delayMs + durationMs * iterations;
      if (end > maxEnd) maxEnd = end;
    }
  }
  return Math.max(baseDurationMs, Math.ceil(maxEnd));
}

function removeRulesReferencing(css: string, name: string): string {
  const tokenRe = animationTokenRe(name);
  return css.replace(/#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g, (full: string, _id: string, body: string) => {
    if (!tokenRe.test(body)) return full;
    const animMatch = /animation\s*:\s*([^;]+);?/i.exec(body);
    if (!animMatch?.[1]) {
      return "";
    }
    const entries = splitAnimationList(animMatch[1] as string).filter(
      (e) => animationEntryName(e) !== name,
    );
    if (entries.length === 0) {
      return "";
    }
    const filteredDecl = `animation: ${entries.join(", ")};`;
    const updated = body.replace(/animation\s*:\s*[^;]+;?/i, filteredDecl);
    return `#${_id} { ${updated} }`;
  });
}

function upsertIdRule(css: string, id: string, animationValue: string, origin: string): string {
  const entryName = animationEntryName(animationValue);
  const re = new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const boxDecl = "transform-box: fill-box;";
  const originDecl = `transform-origin: ${origin};`;
  let found = false;
  const next = css.replace(re, (full: string, body: string) => {
    found = true;
    let updated = body;
    const existingDecl = extractAnimationDecl(updated);
    if (existingDecl) {
      const entries = splitAnimationList(existingDecl);
      let replaced = false;
      const nextEntries = entries.map((e) => {
        if (animationEntryName(e) === entryName) {
          replaced = true;
          return animationValue;
        }
        return e;
      });
      if (!replaced) nextEntries.push(animationValue);
      const newDecl = `animation: ${nextEntries.join(", ")};`;
      updated = updated.replace(/animation\s*:\s*[^;]+;?/i, newDecl);
    } else {
      const t = updated.trim();
      updated = `${updated}${t.length > 0 && !t.endsWith(";") ? ";" : ""} animation: ${animationValue};`;
    }
    // Ensure transform-box: fill-box.
    if (/transform-box\s*:/.test(updated)) {
      updated = updated.replace(/transform-box\s*:[^;]+;?/, boxDecl);
    } else {
      updated = `${updated} ${boxDecl}`;
    }
    // Ensure transform-origin matches requested origin.
    if (/transform-origin\s*:/.test(updated)) {
      updated = updated.replace(/transform-origin\s*:[^;]+;?/, originDecl);
    } else {
      updated = `${updated} ${originDecl}`;
    }
    return `#${id} { ${updated} }`;
  });
  if (found) return next;
  return `${next}\n#${id} { ${boxDecl} ${originDecl} animation: ${animationValue}; }`;
}

function assertSafeCssValue(field: string, value: string): void {
  if (/[{};<>]/.test(value)) {
    throw new Error(`Rejected: unsupported CSS in '${field}'.`);
  }
  const lowered = normalizeCssForCheck(value).toLowerCase();
  if (
    lowered.includes("@import") ||
    lowered.includes("javascript:") ||
    lowered.includes("expression(") ||
    lowered.includes("url(")
  ) {
    throw new Error(`Rejected: unsupported CSS in '${field}'.`);
  }
}

export async function handleAnimate(input: z.input<typeof AnimateSchema>): Promise<ToolResult> {
  let safePath: string;
  try {
    safePath = resolveSafePath(input.path);
  } catch (e) {
    return errText(`pica_animate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: string;
  try {
    raw = await Bun.file(safePath).text();
  } catch {
    return errText(`pica_animate failed: file not found: ${safePath}. Create it first with pica_create.`);
  }
  try {
    assertNoScript(raw);
    if (!ID_RE.test(input.name)) {
      throw new Error(`pica_animate failed: invalid keyframes name '${input.name}'. Use /^[a-zA-Z_][a-zA-Z0-9_-]*$/.`);
    }
    if (input.keyframes) assertNoScript(input.keyframes);
    const doc = loadXmlDoc(raw);
    ensurePicaSkeleton(doc);
    const styleEl = getElById(doc, "pica-anim");
    if (!styleEl) throw new Error("pica_animate failed: #pica-anim not found.");
    let css = (styleEl.textContent ?? "").trim();

    const persist = async (nextCss: string): Promise<void> => {
      styleEl.textContent = nextCss;
      const metaEl = getElById(doc, "pica-meta");
      if (metaEl) {
        try {
          const meta = parseMeta(doc);
          const base = meta.baseDurationMs ?? meta.durationMs;
          const recalc = recalcDurationMs(nextCss, base);
          metaEl.textContent = JSON.stringify({ ...meta, baseDurationMs: base, durationMs: recalc });
        } catch {
          // ignore meta update failure
        }
      }
      const out = serializeDoc(doc);
      assertNoScript(out);
      assertWellFormedXml(out);
      assertSafeSvgTree(loadXmlDoc(out));
      await atomicWriteFile(safePath, out);
      setCurrentSvg(safePath, out);
    };

    if (input.remove) {
      css = removeKeyframesBlock(css, input.name);
      css = removeRulesReferencing(css, input.name);
      await persist(css);
      return okText({ ok: true, path: safePath, removed: input.name });
    }

    const existing = parseAnimationsList(css).find((a) => a.name === input.name);
    let body = (input.keyframes ?? "").trim();
    if (body.startsWith("@keyframes")) {
      const inner = body.indexOf("{");
      const last = body.lastIndexOf("}");
      if (inner >= 0 && last > inner) body = body.slice(inner + 1, last).trim();
    }
    if (!body && !existing) {
      return errText(
        `pica_animate failed: keyframes body is required to create '@keyframes ${input.name}'. Provide keyframes like '0%{opacity:0}100%{opacity:1}'.`,
      );
    }
    if (body) {
      assertNoScript(body);
      assertBalancedBraces(body);
      const lowered = normalizeCssForCheck(body).toLowerCase();
      if (
        lowered.includes("javascript:") ||
        lowered.includes("expression(") ||
        lowered.includes("@import") ||
        lowered.includes("url(")
      ) {
        throw new Error("Rejected: unsupported CSS in keyframes.");
      }
      css = removeKeyframesBlock(css, input.name);
      css = `${css}\n@keyframes ${input.name} { ${body} }`.trim();
    }

    for (const t of input.animations ?? []) {
      const target = getElById(doc, t.id);
      if (!target) throw new Error(`pica_animate failed: target '#${t.id}' not found.`);
      if (["pica-meta", "pica-defs", "pica-anim", "pica-root", "pica-bg"].includes(t.id)) {
        throw new Error(`pica_animate failed: target '#${t.id}' is protected.`);
      }
      if (t.easing !== undefined) assertSafeCssValue("easing", t.easing);
      if (t.transformOrigin !== undefined) assertSafeCssValue("transformOrigin", t.transformOrigin);
      if (t.direction !== undefined) assertSafeCssValue("direction", t.direction);
      if (t.fill !== undefined) assertSafeCssValue("fill", t.fill);
      if (typeof t.iterations === "string") assertSafeCssValue("iterations", t.iterations);
      const dur = t.durationMs ?? 1000;
      const delay = t.delayMs ?? 0;
      const easing = t.easing ?? "ease";
      const iter = t.iterations ?? 1;
      const iterStr = typeof iter === "number" ? String(iter) : iter;
      const dir = t.direction ?? "normal";
      const fill = t.fill ?? "both";
      const origin = t.transformOrigin ?? "center";
      const value = `${input.name} ${dur}ms ${easing} ${delay}ms ${iterStr} ${dir} ${fill}`;
      css = upsertIdRule(css, t.id, value, origin);
    }

    await persist(css);

    return okText({ ok: true, path: safePath, name: input.name, targets: (input.animations ?? []).map((t) => t.id) });
  } catch (e) {
    return errText(`pica_animate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleConfigure(input: z.input<typeof ConfigureSchema>): Promise<ToolResult> {
  let safePath: string;
  try {
    safePath = resolveSafePath(input.path);
  } catch (e) {
    return errText(`pica_configure failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: string;
  try {
    raw = await Bun.file(safePath).text();
  } catch {
    return errText(`pica_configure failed: file not found: ${safePath}. Create it first with pica_create.`);
  }
  try {
    assertNoScript(raw);
    const doc = loadXmlDoc(raw);
    ensurePicaSkeleton(doc);
    const svg = doc.documentElement;
    if (!svg) throw new Error("pica_configure failed: missing <svg> root.");
    const current = parseDims(doc);
    const meta = parseMeta(doc);
    const styleEl = getElById(doc, "pica-anim");
    const css = (styleEl?.textContent ?? "").trim();
    const nextW = input.width ?? current.width;
    const nextH = input.height ?? current.height;
    if (input.width !== undefined) svg.setAttribute("width", String(nextW));
    if (input.height !== undefined) svg.setAttribute("height", String(nextH));
    if (input.width !== undefined || input.height !== undefined) {
      svg.setAttribute("viewBox", `0 0 ${nextW} ${nextH}`);
    }
    if (input.background !== undefined) {
      assertSafeAttrValue("fill", input.background);
      const bg = getElById(doc, "pica-bg");
      if (!bg) throw new Error("pica_configure failed: #pica-bg not found.");
      bg.setAttribute("fill", input.background);
    }
    const metaEl = getElById(doc, "pica-meta");
    if (!metaEl) throw new Error("pica_configure failed: #pica-meta not found.");
    const nextFps = input.fps ?? meta.fps;
    const nextBg = input.background ?? meta.background;
    const nextBase = input.durationMs ?? meta.baseDurationMs ?? meta.durationMs;
    const recalc = recalcDurationMs(css, nextBase);
    metaEl.textContent = JSON.stringify({
      ...meta,
      fps: nextFps,
      background: nextBg,
      baseDurationMs: nextBase,
      durationMs: recalc,
    });
    const out = serializeDoc(doc);
    assertNoScript(out);
    assertWellFormedXml(out);
    assertSafeSvgTree(loadXmlDoc(out));
    await atomicWriteFile(safePath, out);
    setCurrentSvg(safePath, out);
    const parsed = parsePica(out);
    return okText({
      ok: true,
      path: safePath,
      width: parsed.width,
      height: parsed.height,
      background: parsed.meta.background,
      fps: parsed.meta.fps,
      durationMs: parsed.meta.durationMs,
      baseDurationMs: parsed.meta.baseDurationMs,
    });
  } catch (e) {
    return errText(`pica_configure failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function buildDebugOverlay(width: number, height: number, nodes: Array<{ id: string; bbox: Bbox }>, showGrid: boolean, showIds: boolean): string {
  if (!showGrid && !showIds) return "";
  let inner = "";
  if (showGrid) {
    for (let x = 100; x < width; x += 100) {
      inner += `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#d4d4d8" stroke-width="1" opacity="0.7"/>`;
    }
    for (let y = 100; y < height; y += 100) {
      inner += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#d4d4d8" stroke-width="1" opacity="0.7"/>`;
    }
    inner += `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#a1a1aa" stroke-width="1"/>`;
  }
  if (showIds) {
    for (const n of nodes) {
      if (!n.id || n.bbox.w <= 0 || n.bbox.h <= 0) continue;
      // biome-ignore: overlay only
      inner += `<rect x="${n.bbox.x}" y="${n.bbox.y}" width="${n.bbox.w}" height="${n.bbox.h}" fill="none" stroke="#2563eb" stroke-width="1.5"/>`;
      const lx = n.bbox.x + 2;
      const ly = Math.max(10, n.bbox.y - 4);
      inner += `<text x="${lx}" y="${ly}" font-size="11" font-family="monospace" fill="#1d4ed8">#${n.id}</text>`;
    }
  }
  return `<g id="pica-debug-overlay" pointer-events="none">${inner}</g>`;
}

export async function handleInspect(input: z.input<typeof InspectSchema>): Promise<ToolResult> {
  const showGrid = input.showGrid ?? false;
  const showIds = input.showIds ?? false;
  const requestedScale = input.scale ?? 1;
  const maxWidth = input.maxWidth ?? 1024;
  const timeMs = input.timeMs ?? 0;
  let safePath: string;
  try {
    safePath = resolveSafePath(input.path);
  } catch (e) {
    return errText(`pica_inspect failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: string;
  try {
    raw = await Bun.file(safePath).text();
  } catch {
    return errText(`pica_inspect failed: file not found: ${safePath}.`);
  }
  try {
    const parsed = parsePica(stripDebugOverlay(raw));
    const clean = stripDebugOverlay(raw);
    const animated = parsed.animations.length > 0;
    // Cap preview width so 4K canvases never flood agent context.
    const effScale = Math.max(
      0.05,
      Math.min(requestedScale, maxWidth / Math.max(1, parsed.width)),
    );
    let png: Buffer;
    let renderer = "resvg";
    let note = "";
    if (timeMs === 0 && !animated) {
      let svgForRender = clean;
      if (showGrid || showIds) {
        const overlay = buildDebugOverlay(parsed.width, parsed.height, parsed.nodesFlat, showGrid, showIds);
        svgForRender = clean.replace(/<\/svg\s*>\s*$/i, `${overlay}</svg>`);
      }
      png = renderPngBuffer(svgForRender, effScale);
    } else if (findChromeBinary()) {
      if (showGrid || showIds) {
        png = await screenshotInspectSinglePass(clean, parsed.width, parsed.height, timeMs, effScale, showGrid, showIds);
      } else {
        png = await screenshotAtTime(clean, parsed.width, parsed.height, timeMs, effScale);
      }
      renderer = "chromium-cdp";
    } else if (timeMs === 0) {
      // No Chromium: fall back to a static resvg render; CSS keyframes
      // (e.g. opacity:0 initial states) are not evaluated.
      let svgForRender = clean;
      if (showGrid || showIds) {
        const overlay = buildDebugOverlay(parsed.width, parsed.height, parsed.nodesFlat, showGrid, showIds);
        svgForRender = clean.replace(/<\/svg\s*>\s*$/i, `${overlay}</svg>`);
      }
      png = renderPngBuffer(svgForRender, effScale);
      note = " (static fallback: CSS animations not evaluated, Chromium missing)";
    } else {
      return errText(`pica_inspect failed at timeMs=${timeMs}: ${chromeMissingMessage()}`);
    }
    const summary =
      `Preview ${parsed.width}x${parsed.height} (scale ${effScale}) at t=${timeMs}ms via ${renderer}${note}. ` +
      `${parsed.nodesFlat.length} nodes, ${parsed.animations.length} keyframes. ` +
      `${showGrid ? "grid on. " : ""}${showIds ? "ids on." : ""}`.trim();
    return {
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: summary },
      ],
    };
  } catch (e) {
    return errText(`pica_inspect failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function ffmpegExists(): boolean {
  const w = (Bun as unknown as { which?: (bin: string) => string | null }).which;
  if (typeof w === "function") {
    try {
      return !!w("ffmpeg");
    } catch {
      return false;
    }
  }
  return true;
}

export async function handleExport(input: z.input<typeof ExportSchema>): Promise<ToolResult> {
  const scale = input.scale ?? 1;
  const quality = input.quality ?? 90;
  const animated = input.animated ?? false;
  const timeMs = input.timeMs ?? 0;
  let safePath: string;
  let safeOut: string;
  try {
    safePath = resolveSafePath(input.path);
    safeOut = resolveSafePath(input.outPath);
    assertSafeFfmpegOutPath(input.outPath, safeOut);
  } catch (e) {
    return errText(`pica_export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: string;
  try {
    raw = await Bun.file(safePath).text();
  } catch {
    return errText(`pica_export failed: file not found: ${safePath}.`);
  }
  try {
    const parsed = parsePica(raw);
    const clean = stripDebugOverlay(raw);
    const w = Math.round(parsed.width * scale);
    const h = Math.round(parsed.height * scale);

    if (input.format === "svg") {
      if (timeMs !== 0) {
        return errText("pica_export failed: timeMs is only supported for raster/video exports.");
      }
      await exportSvgClean(safePath, safeOut);
      return okText({ ok: true, format: "svg", outPath: safeOut, width: parsed.width, height: parsed.height });
    }
    const needsChromiumFrame = timeMs > 0 || (parsed.animations.length > 0 && !!findChromeBinary());
    if (input.format === "png") {
      if (timeMs > 0 && !findChromeBinary()) {
        return errText(`pica_export failed at timeMs=${timeMs}: ${chromeMissingMessage()}`);
      }
      if (needsChromiumFrame && findChromeBinary()) {
        await exportPngAtTime(clean, parsed.width, parsed.height, safeOut, scale, timeMs);
      } else {
        await exportPng(safePath, safeOut, scale);
      }
      return okText({ ok: true, format: "png", outPath: safeOut, width: w, height: h, timeMs });
    }
    if (input.format === "jpg" || input.format === "jpeg") {
      if (!ffmpegExists()) {
        return errText("pica_export failed: ffmpeg not found in PATH. Install ffmpeg for jpg/jpeg encoding.");
      }
      if (timeMs > 0 && !findChromeBinary()) {
        return errText(`pica_export failed at timeMs=${timeMs}: ${chromeMissingMessage()}`);
      }
      if (needsChromiumFrame && findChromeBinary()) {
        await exportStaticRasterAtTime(clean, parsed.width, parsed.height, safeOut, "jpg", quality, scale, timeMs);
      } else {
        await exportStaticRaster(safePath, safeOut, "jpg", quality, scale);
      }
      return okText({ ok: true, format: input.format, outPath: safeOut, width: w, height: h, quality, timeMs });
    }
    if (input.format === "webp" && !animated) {
      if (!ffmpegExists()) {
        return errText("pica_export failed: ffmpeg not found in PATH. Install ffmpeg for webp encoding.");
      }
      if (timeMs > 0 && !findChromeBinary()) {
        return errText(`pica_export failed at timeMs=${timeMs}: ${chromeMissingMessage()}`);
      }
      if (needsChromiumFrame && findChromeBinary()) {
        await exportStaticRasterAtTime(clean, parsed.width, parsed.height, safeOut, "webp", quality, scale, timeMs);
      } else {
        await exportStaticRaster(safePath, safeOut, "webp", quality, scale);
      }
      return okText({ ok: true, format: "webp", animated: false, outPath: safeOut, width: w, height: h, timeMs });
    }
    // Animated paths need chromium + ffmpeg
    if (!findChromeBinary()) {
      return errText(`pica_export failed: ${chromeMissingMessage()}`);
    }
    if (!ffmpegExists()) {
      return errText("pica_export failed: ffmpeg not found in PATH. Install ffmpeg for video encoding.");
    }
    const fps = input.fps ?? parsed.meta.fps ?? 30;
    const durationMs = parsed.meta.durationMs ?? 2000;
    if (input.format === "mp4") {
      await exportAnimated(clean, parsed.width, parsed.height, safeOut, "mp4", fps, durationMs, scale, quality);
      return okText({ ok: true, format: "mp4", outPath: safeOut, width: w, height: h, fps, durationMs });
    }
    // animated webp
    await exportAnimated(clean, parsed.width, parsed.height, safeOut, "webp", fps, durationMs, scale, quality);
    return okText({ ok: true, format: "webp", animated: true, outPath: safeOut, width: w, height: h, fps, durationMs });
  } catch (e) {
    return errText(`pica_export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Re-export for tests that drive frames directly
export { captureFrames };
