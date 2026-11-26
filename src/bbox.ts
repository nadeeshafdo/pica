import type { Bbox } from "./pica-file.js";

function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parsePoints(points: string): Array<[number, number]> {
  const toks = points.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  const nums = toks.map((t) => Number.parseFloat(t)).filter((n) => Number.isFinite(n));
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i] as number;
    const y = nums[i + 1] as number;
    out.push([x, y]);
  }
  return out;
}

function bboxOfPoints(pts: Array<[number, number]>): Bbox {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

export function unionBboxes(boxes: Bbox[]): Bbox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const b of boxes) {
    if (b.w <= 0 && b.h <= 0) continue;
    any = true;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!any) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Tokenize an SVG path `d` attribute into commands and numbers.
 * Numbers follow SVG grammar (optional sign, decimals, exponents).
 */
function tokenizePath(d: string): Array<{ kind: "cmd"; v: string } | { kind: "num"; v: number }> {
  const out: Array<{ kind: "cmd"; v: string } | { kind: "num"; v: number }> = [];
  const re = /([AaCcHhLlMmQqSsTtVvZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (m[1] !== undefined) {
      out.push({ kind: "cmd", v: m[1] });
    } else if (m[2] !== undefined && m[2].length > 0 && m[2] !== "-" && m[2] !== "." && m[2] !== "-.") {
      const n = Number.parseFloat(m[2]);
      if (Number.isFinite(n)) out.push({ kind: "num", v: n });
    }
  }
  return out;
}

function argCountForCmd(cmd: string): number {
  switch (cmd) {
    case "M":
    case "m":
    case "L":
    case "l":
    case "T":
    case "t":
      return 2;
    case "H":
    case "h":
    case "V":
    case "v":
      return 1;
    case "C":
    case "c":
      return 6;
    case "S":
    case "s":
    case "Q":
    case "q":
      return 4;
    case "A":
    case "a":
      return 7;
    case "Z":
    case "z":
      return 0;
    default:
      return 0;
  }
}

/**
 * Proper SVG path bbox: handles absolute and relative M/L/H/V/C/S/Q/T/A/Z.
 * Control points are included (conservative fast estimate); arcs contribute
 * their endpoints (radii ignored by design for the fast estimate).
 */
export function pathBbox(d: string): Bbox {
  const toks = tokenizePath(d);
  if (toks.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const pts: Array<[number, number]> = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd: string | null = null;
  let i = 0;
  const push = (x: number, y: number) => {
    pts.push([x, y]);
  };
  while (i < toks.length) {
    const t = toks[i] as { kind: string; v: string | number } | undefined;
    if (!t) break;
    if (t.kind === "cmd") {
      cmd = t.v as string;
      i++;
      if (cmd === "Z" || cmd === "z") {
        cx = sx;
        cy = sy;
        cmd = null;
      }
      continue;
    }
    if (cmd === null) {
      i++;
      continue;
    }
    const need = argCountForCmd(cmd);
    if (need === 0) {
      i++;
      continue;
    }
    // Collect one segment worth of numbers; stop if a command intervenes.
    const args: number[] = [];
    while (args.length < need && i < toks.length) {
      const nt = toks[i] as { kind: string; v: string | number } | undefined;
      if (!nt || nt.kind === "cmd") break;
      args.push(nt.v as number);
      i++;
    }
    if (args.length < need) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "M") {
      const x = (args[0] as number) + (rel ? cx : 0);
      const y = (args[1] as number) + (rel ? cy : 0);
      cx = x;
      cy = y;
      sx = x;
      sy = y;
      push(x, y);
      // Subsequent implicit pairs are lineto.
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      const x = (args[0] as number) + (rel ? cx : 0);
      const y = (args[1] as number) + (rel ? cy : 0);
      cx = x;
      cy = y;
      push(x, y);
    } else if (C === "H") {
      const x = (args[0] as number) + (rel ? cx : 0);
      cx = x;
      push(x, cy);
    } else if (C === "V") {
      const y = (args[0] as number) + (rel ? cy : 0);
      cy = y;
      push(cx, y);
    } else if (C === "C") {
      const x1 = (args[0] as number) + (rel ? cx : 0);
      const y1 = (args[1] as number) + (rel ? cy : 0);
      const x2 = (args[2] as number) + (rel ? cx : 0);
      const y2 = (args[3] as number) + (rel ? cy : 0);
      const x = (args[4] as number) + (rel ? cx : 0);
      const y = (args[5] as number) + (rel ? cy : 0);
      push(x1, y1);
      push(x2, y2);
      push(x, y);
      cx = x;
      cy = y;
    } else if (C === "S") {
      const x2 = (args[0] as number) + (rel ? cx : 0);
      const y2 = (args[1] as number) + (rel ? cy : 0);
      const x = (args[2] as number) + (rel ? cx : 0);
      const y = (args[3] as number) + (rel ? cy : 0);
      push(x2, y2);
      push(x, y);
      cx = x;
      cy = y;
    } else if (C === "Q") {
      const x1 = (args[0] as number) + (rel ? cx : 0);
      const y1 = (args[1] as number) + (rel ? cy : 0);
      const x = (args[2] as number) + (rel ? cx : 0);
      const y = (args[3] as number) + (rel ? cy : 0);
      push(x1, y1);
      push(x, y);
      cx = x;
      cy = y;
    } else if (C === "T") {
      const x = (args[0] as number) + (rel ? cx : 0);
      const y = (args[1] as number) + (rel ? cy : 0);
      cx = x;
      cy = y;
      push(x, y);
    } else if (C === "A") {
      // rx ry x-axis-rotation large-arc-flag sweep-flag x y
      const x = (args[5] as number) + (rel ? cx : 0);
      const y = (args[6] as number) + (rel ? cy : 0);
      push(x, y);
      cx = x;
      cy = y;
    }
    // Loop continues with same cmd for implicit repetition; a new cmd token
    // switches. M handled its switch to L above.
  }
  return bboxOfPoints(pts);
}

/**
 * Fast geometry-based bbox estimate directly from SVG attributes.
 * Ignores transforms, strokes, and filters by design (documented estimate).
 * Pass childBoxes for container elements (<g>) to get the union.
 */
export function fastBbox(
  tag: string,
  attrs: Record<string, string>,
  textContent = "",
  childBoxes?: Bbox[],
): Bbox {
  switch (tag) {
    case "rect":
    case "image":
    case "use": {
      return {
        x: num(attrs["x"], 0),
        y: num(attrs["y"], 0),
        w: Math.max(0, num(attrs["width"], 0)),
        h: Math.max(0, num(attrs["height"], 0)),
      };
    }
    case "circle": {
      const cx = num(attrs["cx"], 0);
      const cy = num(attrs["cy"], 0);
      const r = Math.max(0, num(attrs["r"], 0));
      return { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    }
    case "ellipse": {
      const cx = num(attrs["cx"], 0);
      const cy = num(attrs["cy"], 0);
      const rx = Math.max(0, num(attrs["rx"], 0));
      const ry = Math.max(0, num(attrs["ry"], 0));
      return { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
    }
    case "line": {
      const x1 = num(attrs["x1"], 0);
      const y1 = num(attrs["y1"], 0);
      const x2 = num(attrs["x2"], 0);
      const y2 = num(attrs["y2"], 0);
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      };
    }
    case "polygon":
    case "polyline": {
      return bboxOfPoints(parsePoints(attrs["points"] ?? ""));
    }
    case "path": {
      return pathBbox(attrs["d"] ?? "");
    }
    case "text": {
      const x = num(attrs["x"], 0);
      const y = num(attrs["y"], 0);
      const fsRaw = attrs["font-size"] ?? "16";
      const fs = Number.parseFloat(fsRaw);
      const fontSize = Number.isFinite(fs) ? fs : 16;
      const len = textContent.length;
      const w = 0.6 * fontSize * len;
      const h = 1.2 * fontSize;
      const anchor = (attrs["text-anchor"] ?? "start").trim().toLowerCase();
      const bx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      return { x: bx, y: y - fontSize, w: Math.max(0, w), h: Math.max(0, h) };
    }
    case "g":
    case "a":
    case "symbol":
    case "svg": {
      if (childBoxes) return unionBboxes(childBoxes);
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}
