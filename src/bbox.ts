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

/**
 * Fast geometry-based bbox estimate directly from SVG attributes.
 * Ignores transforms, strokes, and filters by design (documented estimate).
 */
export function fastBbox(
  tag: string,
  attrs: Record<string, string>,
  textContent = "",
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
      const d = attrs["d"] ?? "";
      const nums: number[] = [];
      const re = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(d)) !== null) {
        const n = Number.parseFloat(m[0]);
        if (Number.isFinite(n)) nums.push(n);
      }
      const pts: Array<[number, number]> = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push([nums[i] as number, nums[i + 1] as number]);
      }
      return bboxOfPoints(pts);
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
      return { x, y: y - fontSize, w: Math.max(0, w), h: Math.max(0, h) };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}
