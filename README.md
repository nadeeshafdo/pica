# pica-mcp

Ultra-lightweight, headless-first 2D vector design and animation MCP server for local coding agents.

- Runtime: **Bun only** (strict TypeScript, `noUncheckedIndexedAccess`).
- MCP SDK **v2** (`@modelcontextprotocol/server` + `zod`). No `console.log`; all logs go to `console.error` so `stdout` stays pure JSON-RPC.
- Minimal deps: `@modelcontextprotocol/server`, `zod`, `hono`, `@resvg/resvg-js`, `linkedom`. System `chromium` (CDP over Bun native `WebSocket`) and `ffmpeg` only via `Bun.spawn`.
- File format: valid standalone `.pica.svg` with `#pica-meta` JSON, `#pica-defs`, `#pica-anim`, `#pica-bg`, `#pica-root`. All writes atomic (`.tmp` + rename). `<script>` rejected.

## Tools

- `pica_create` `{path, width?, height?, background?, fps?, durationMs?}`: init canvas, notify preview.
- `pica_read` `{path, includeRaw?, bboxMode?: fast|exact, tree?}`: dims, meta, animations, `{id, tag, attrs, bbox}` nodes. Fast = geometry math; exact = lazy Chromium `getBBox()`.
- `pica_patch` `{path, ops[]}`: atomic `add|update|remove|reorder|setDefs` by `#id`. `isError` if target missing or XML invalid.
- `pica_animate` `{path, name, keyframes?, animations?[{id,durationMs?,delayMs?,easing?,iterations?,direction?,fill?}], remove?}`: manage `@keyframes` + `#id` rules, auto-extends `durationMs`.
- `pica_inspect` `{path, timeMs?, showGrid?, showIds?, scale?, maxWidth?}`: returns `{type:image,data,mimeType:image/png}` + text summary. Static designs at `timeMs=0` use resvg; animated designs (and any `timeMs>0`) capture via headless Chromium CDP when available, else static resvg fallback at `timeMs=0`. Grid/id overlay is non-persisted.
- `pica_export` `{path, format: svg|png|jpg|jpeg|webp|mp4, outPath, scale?, quality?, fps?, animated?}`: svg copy (stripped), png via resvg, jpg/webp-static via ffmpeg stdin, mp4/animated-webp via Chromium frames piped to ffmpeg.

## Preview

Optional Hono server on `127.0.0.1:${PICA_PORT:-4173}` (fails to stderr if busy, never crashes stdio). Serves `src/viewer.html`: light neutral checkerboard artboard, wheel zoom, drag pan, fit button, WS live reload on create/patch/animate, bottom timeline (Play/Pause + slider synced with `document.getAnimations()`).

## Run

```sh
bun install
bunx tsc --noEmit
bun test
PICA_PORT=4173 bun src/index.ts
```

Chromium/ffmpeg optional: timed capture and video export return actionable `isError` messages when missing; tests skip animated cases gracefully.
