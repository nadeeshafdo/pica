import { Resvg } from "@resvg/resvg-js";

let resolvedFonts: { sans: string; serif: string; mono: string } | null = null;

function probeFont(request: string): string | null {
  try {
    const proc = Bun.spawnSync(["fc-match", request, "--format", "%{family}"]);
    if (proc.exitCode !== 0) return null;
    const out = Buffer.from(proc.stdout).toString().trim();
    const first = out.split(",")[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

function resolveFontFamilies(): { sans: string; serif: string; mono: string } {
  if (resolvedFonts) return resolvedFonts;
  // Prefer DejaVu (metric-stable, widely present); otherwise use whatever
  // fontconfig resolves for the generic alias. Resolved once per process.
  const sans = probeFont("DejaVu Sans") ?? probeFont("sans-serif") ?? "DejaVu Sans";
  const serif = probeFont("DejaVu Serif") ?? probeFont("serif") ?? "DejaVu Serif";
  const mono = probeFont("DejaVu Sans Mono") ?? probeFont("monospace") ?? "DejaVu Sans Mono";
  resolvedFonts = { sans, serif, mono };
  return resolvedFonts;
}

/**
 * usvg drops <text> when font-family lists unknown names (Inter, system-ui,
 * ...) with no usable fallback. Normalize CSS generic aliases the renderer
 * may not know, scoped to font-family declarations only so <text> content
 * is never touched. Render-only: the saved file is untouched.
 */
function normalizeAliasList(value: string): string {
  return value
    .replace(/system-ui/gi, "sans-serif")
    .replace(/-apple-system/gi, "sans-serif")
    .replace(/BlinkMacSystemFont/gi, "sans-serif");
}

export function normalizeFontAliases(svgText: string): string {
  return svgText
    .replace(/font-family\s*=\s*("[^"]*"|'[^']*')/gi, (m) => normalizeAliasList(m))
    .replace(/font-family\s*:\s*[^;}"']+/gi, (m) => normalizeAliasList(m));
}

function buildResvg(svgText: string, scale: number): Resvg {
  const s = scale <= 0 || !Number.isFinite(scale) ? 1 : scale;
  const withText = /<(?:[A-Za-z_][\w.-]*:)?text\b/i.test(svgText);
  const input = withText ? normalizeFontAliases(svgText) : svgText;
  if (!withText) {
    return new Resvg(input, {
      fitTo: { mode: "zoom", value: s },
      font: { loadSystemFonts: false },
    });
  }
  const f = resolveFontFamilies();
  return new Resvg(input, {
    fitTo: { mode: "zoom", value: s },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: f.sans,
      sansSerifFamily: f.sans,
      serifFamily: f.serif,
      monospaceFamily: f.mono,
    },
  });
}

export function renderPngBuffer(svgText: string, scale = 1): Buffer {
  const out = buildResvg(svgText, scale).render().asPng();
  return Buffer.from(out);
}

export function renderPixels(
  svgText: string,
  scale = 1,
): { pixels: Uint8Array; width: number; height: number } {
  const img = buildResvg(svgText, scale).render();
  return { pixels: img.pixels, width: img.width, height: img.height };
}
