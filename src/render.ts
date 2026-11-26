import { Resvg } from "@resvg/resvg-js";

export function renderPngBuffer(svgText: string, scale = 1): Buffer {
  const s = scale <= 0 || !Number.isFinite(scale) ? 1 : scale;
  const withText = svgText.includes("<text");
  const resvg = new Resvg(svgText, {
    fitTo: { mode: "zoom", value: s },
    font: { loadSystemFonts: withText },
  });
  const out = resvg.render().asPng();
  return Buffer.from(out);
}
