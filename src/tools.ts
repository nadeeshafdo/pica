import { z } from "zod";
import {
  atomicWriteFile,
  assertNoScript,
  assertWellFormedXml,
  buildPicaSvg,
  ensurePicaSkeleton,
  getElById,
  loadXmlDoc,
  parseAnimationsList,
  parseDims,
  parseMeta,
  parsePica,
  serializeDoc,
  stripDebugOverlay,
  type Bbox,
} from "./pica-file.js";
import { renderPngBuffer } from "./render.js";
import { captureFrames, chromeMissingMessage, findChromeBinary, getExactBboxes, screenshotAtTime } from "./chromium.js";
import { exportAnimated, exportPng, exportStaticRaster, exportSvgClean } from "./export.js";
import { notifyPreview, setCurrentSvg } from "./preview.js";

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

const AttrsRecord = z.record(z.string(), z.union([z.string(), z.number()]));

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

export const InspectSchema = z.object({
  path: z.string().min(1).describe("Input .pica.svg file path"),
  timeMs: z.number().min(0).default(0).describe("Animation timestamp to capture (0 = headless resvg)"),
  showGrid: z.boolean().default(false).describe("Overlay subtle 100px grid (non-persisted)"),
  showIds: z.boolean().default(false).describe("Overlay #id bounding-box badges (non-persisted)"),
  scale: z.number().positive().max(4).default(1).describe("Render scale factor"),
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
    await atomicWriteFile(input.path, svg);
    setCurrentSvg(input.path, svg);
    await notifyPreview(input.path).catch(() => undefined);
    return okText({
      ok: true,
      path: input.path,
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
  try {
    const includeRaw = input.includeRaw ?? false;
    const bboxMode = input.bboxMode ?? "fast";
    const tree = input.tree ?? false;
    let raw: string;
    try {
      raw = await Bun.file(input.path).text();
    } catch {
      return errText(`pica_read failed: file not found: ${input.path}. Create it first with pica_create.`);
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
      path: input.path,
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
const SVG_NS = "http://www.w3.org/2000/svg";

function sanitizeTag(tag: string): void {
  if (/^script$/i.test(tag)) throw new Error("Rejected: <script> elements are not allowed.");
  if (!/^[A-Za-z][\w-]*$/.test(tag)) throw new Error(`Invalid tag name: ${tag}.`);
}

function sanitizeAttrs(attrs: Record<string, string | number> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (/^on/i.test(k)) throw new Error(`Rejected: event-handler attribute '${k}' is not allowed.`);
    const val = String(v);
    if (/javascript\s*:/i.test(val)) throw new Error(`Rejected: javascript: URL in attribute '${k}'.`);
    if (/^script$/i.test(val)) throw new Error("Rejected: <script> is not allowed.");
    out[k] = val;
  }
  if (Object.keys(out).some((k) => /^script$/i.test(k))) {
    throw new Error("Rejected: <script> is not allowed.");
  }
  return out;
}

export async function handlePatch(input: z.input<typeof PatchSchema>): Promise<ToolResult> {
  let raw: string;
  try {
    raw = await Bun.file(input.path).text();
  } catch {
    return errText(`pica_patch failed: file not found: ${input.path}. Create it first with pica_create.`);
  }
  try {
    assertNoScript(raw);
    const doc = loadXmlDoc(raw);
    ensurePicaSkeleton(doc);

    for (const op of input.ops) {
      if (op.op === "add") {
        sanitizeTag(op.tag);
        const attrs = sanitizeAttrs(op.attrs);
        if (op.textContent && /<script[\s>]/i.test(op.textContent)) {
          throw new Error("Rejected: <script> elements are not allowed.");
        }
        if (getElById(doc, op.id)) throw new Error(`pica_patch add failed: id '#${op.id}' already exists.`);
        const parent = getElById(doc, op.parentId ?? "pica-root");
        if (!parent) throw new Error(`pica_patch add failed: parent '#${op.parentId ?? "pica-root"}' not found.`);
        const el = doc.createElementNS(SVG_NS, op.tag);
        el.setAttribute("id", op.id);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
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
        const el = getElById(doc, op.id);
        if (!el) throw new Error(`pica_patch update failed: target '#${op.id}' not found.`);
        const attrs = sanitizeAttrs(op.attrs);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        if (op.textContent !== undefined) {
          if (/<script[\s>]/i.test(op.textContent)) throw new Error("Rejected: <script> elements are not allowed.");
          el.textContent = op.textContent;
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
        assertNoScript(op.defsSvg);
        const wrapped = `<svg xmlns="${SVG_NS}"><defs>${op.defsSvg}</defs></svg>`;
        assertWellFormedXml(wrapped);
        const defs = getElById(doc, "pica-defs");
        if (!defs) throw new Error("pica_patch setDefs failed: #pica-defs not found.");
        defs.innerHTML = op.defsSvg;
      }
    }

    ensurePicaSkeleton(doc);
    const out = serializeDoc(doc);
    assertNoScript(out);
    assertWellFormedXml(out);
    await atomicWriteFile(input.path, out);
    setCurrentSvg(input.path, out);
    await notifyPreview(input.path).catch(() => undefined);
    return okText({ ok: true, path: input.path, applied: input.ops.length });
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

function removeRulesReferencing(css: string, name: string): string {
  return css.replace(/#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g, (full, _id: string, body: string) => {
    if (body.includes(name)) return "";
    return full;
  });
}

function upsertIdRule(css: string, id: string, animationValue: string): string {
  const re = new RegExp(`#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const decl = `animation: ${animationValue};`;
  let found = false;
  const next = css.replace(re, (full: string, body: string) => {
    found = true;
    if (/animation\s*:/.test(body)) {
      return full.replace(/animation\s*:[^;]+;?/, decl);
    }
    const trimmed = body.trim();
    const sep = trimmed.length > 0 && !trimmed.endsWith(";") ? ";" : "";
    return `#${id} { ${body}${sep} ${decl} }`;
  });
  if (found) return next;
  return `${next}\n#${id} { ${decl} }`;
}

export async function handleAnimate(input: z.input<typeof AnimateSchema>): Promise<ToolResult> {
  let raw: string;
  try {
    raw = await Bun.file(input.path).text();
  } catch {
    return errText(`pica_animate failed: file not found: ${input.path}. Create it first with pica_create.`);
  }
  try {
    assertNoScript(raw);
    if (input.keyframes && /<script[\s>]/i.test(input.keyframes)) {
      throw new Error("Rejected: <script> elements are not allowed.");
    }
    const doc = loadXmlDoc(raw);
    ensurePicaSkeleton(doc);
    const styleEl = getElById(doc, "pica-anim");
    if (!styleEl) throw new Error("pica_animate failed: #pica-anim not found.");
    let css = (styleEl.textContent ?? "").trim();

    if (input.remove) {
      css = removeKeyframesBlock(css, input.name);
      css = removeRulesReferencing(css, input.name);
      styleEl.textContent = css;
      const out = serializeDoc(doc);
      await atomicWriteFile(input.path, out);
      setCurrentSvg(input.path, out);
      await notifyPreview(input.path).catch(() => undefined);
      return okText({ ok: true, path: input.path, removed: input.name });
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
      css = removeKeyframesBlock(css, input.name);
      css = `${css}\n@keyframes ${input.name} { ${body} }`.trim();
    }

    let maxEnd = 0;
    for (const t of input.animations ?? []) {
      const target = getElById(doc, t.id);
      if (!target) throw new Error(`pica_animate failed: target '#${t.id}' not found.`);
      const dur = t.durationMs ?? 1000;
      const delay = t.delayMs ?? 0;
      const easing = t.easing ?? "ease";
      const iter = t.iterations ?? 1;
      const iterStr = typeof iter === "number" ? String(iter) : iter;
      const dir = t.direction ?? "normal";
      const fill = t.fill ?? "both";
      const value = `${input.name} ${dur}ms ${easing} ${delay}ms ${iterStr} ${dir} ${fill}`;
      css = upsertIdRule(css, t.id, value);
      const iterNum = typeof iter === "number" ? iter : 1;
      const end = delay + dur * iterNum;
      if (end > maxEnd) maxEnd = end;
    }

    styleEl.textContent = css;

    if (maxEnd > 0) {
      const metaEl = getElById(doc, "pica-meta");
      if (metaEl?.textContent) {
        try {
          const meta = parseMeta(doc);
          if (maxEnd > meta.durationMs) {
            metaEl.textContent = JSON.stringify({ ...meta, durationMs: Math.ceil(maxEnd) });
          }
        } catch {
          // ignore meta update failure
        }
      }
    }

    const out = serializeDoc(doc);
    assertNoScript(out);
    assertWellFormedXml(out);
    await atomicWriteFile(input.path, out);
    setCurrentSvg(input.path, out);
    await notifyPreview(input.path).catch(() => undefined);
    return okText({ ok: true, path: input.path, name: input.name, targets: (input.animations ?? []).map((t) => t.id) });
  } catch (e) {
    return errText(`pica_animate failed: ${e instanceof Error ? e.message : String(e)}`);
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
  const scale = input.scale ?? 1;
  const timeMs = input.timeMs ?? 0;
  let raw: string;
  try {
    raw = await Bun.file(input.path).text();
  } catch {
    return errText(`pica_inspect failed: file not found: ${input.path}.`);
  }
  try {
    const parsed = parsePica(stripDebugOverlay(raw));
    const clean = stripDebugOverlay(raw);
    let svgForRender = clean;
    if (showGrid || showIds) {
      const overlay = buildDebugOverlay(parsed.width, parsed.height, parsed.nodesFlat, showGrid, showIds);
      svgForRender = clean.replace(/<\/svg\s*>\s*$/i, `${overlay}</svg>`);
    }
    let png: Buffer;
    let renderer = "resvg";
    if (timeMs === 0) {
      png = renderPngBuffer(svgForRender, scale);
    } else {
      if (!findChromeBinary()) {
        return errText(`pica_inspect failed at timeMs=${timeMs}: ${chromeMissingMessage()}`);
      }
      png = await screenshotAtTime(svgForRender, parsed.width, parsed.height, timeMs, scale);
      renderer = "chromium-cdp";
    }
    const summary =
      `Preview ${parsed.width}x${parsed.height} (scale ${scale}) at t=${timeMs}ms via ${renderer}. ` +
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
  let raw: string;
  try {
    raw = await Bun.file(input.path).text();
  } catch {
    return errText(`pica_export failed: file not found: ${input.path}.`);
  }
  try {
    const parsed = parsePica(raw);
    const clean = stripDebugOverlay(raw);
    const w = Math.round(parsed.width * scale);
    const h = Math.round(parsed.height * scale);

    if (input.format === "svg") {
      await exportSvgClean(input.path, input.outPath);
      return okText({ ok: true, format: "svg", outPath: input.outPath, width: parsed.width, height: parsed.height });
    }
    if (input.format === "png") {
      await exportPng(input.path, input.outPath, scale);
      return okText({ ok: true, format: "png", outPath: input.outPath, width: w, height: h });
    }
    if (input.format === "jpg" || input.format === "jpeg") {
      if (!ffmpegExists()) {
        return errText("pica_export failed: ffmpeg not found in PATH. Install ffmpeg for jpg/jpeg encoding.");
      }
      await exportStaticRaster(input.path, input.outPath, "jpg", quality, scale);
      return okText({ ok: true, format: input.format, outPath: input.outPath, width: w, height: h, quality });
    }
    if (input.format === "webp" && !animated) {
      if (!ffmpegExists()) {
        return errText("pica_export failed: ffmpeg not found in PATH. Install ffmpeg for webp encoding.");
      }
      await exportStaticRaster(input.path, input.outPath, "webp", quality, scale);
      return okText({ ok: true, format: "webp", animated: false, outPath: input.outPath, width: w, height: h });
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
      await exportAnimated(clean, parsed.width, parsed.height, input.outPath, "mp4", fps, durationMs, scale, quality);
      return okText({ ok: true, format: "mp4", outPath: input.outPath, width: w, height: h, fps, durationMs });
    }
    // animated webp
    await exportAnimated(clean, parsed.width, parsed.height, input.outPath, "webp", fps, durationMs, scale, quality);
    return okText({ ok: true, format: "webp", animated: true, outPath: input.outPath, width: w, height: h, fps, durationMs });
  } catch (e) {
    return errText(`pica_export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Re-export for tests that drive frames directly
export { captureFrames };
