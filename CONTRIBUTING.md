# Contributing to pica

Thanks for stopping by. `pica` is a tiny local design studio for AI agents: headless-first 2D vectors, keyframe animation, and local exports. We keep it fast, dependency-light, and fun to hack on.

## Ground rules

- Be kind and direct. No harassment, no spam, no drive-by PRs.
- Bun only. No Node, npm, npx, Playwright, Puppeteer, Sharp, Canvas, React, or Vite.
- Strict TypeScript. `noUncheckedIndexedAccess` is on, so index access accordingly.
- Keep `stdout` pure JSON-RPC. All logs go to `stderr`. Never `console.log`.
- Security first. `pica_patch` must keep rejecting `<script>`, `on*` handlers, `javascript:` URLs, invalid XML, and cyclic reorders.
- Atomic writes only (`.tmp` write + rename). No partial `.pica.svg` files.
- Small, focused PRs beat big rewrites.

## Prerequisites

- [Bun](https://bun.sh/) v1.2+
- Optional: system `chromium` (or `google-chrome`) for `bboxMode: "exact"`, animated `pica_inspect`, MP4 / animated WebP export
- Optional: system `ffmpeg` for JPG, WebP, and MP4 export

Missing `chromium` or `ffmpeg` is fine. Static SVG and PNG flows still work, and media tools return actionable errors.

## Setup

```bash
git clone https://github.com/nadeeshafdo/pica.git
cd pica
bun install
bun run typecheck
bun test
```

## Day-to-day commands

| Command | What it does |
| :--- | :--- |
| `bun src/index.ts` | Run the MCP server over stdio (+ preview on `127.0.0.1:4173`) |
| `bun run typecheck` | Strict `tsc --noEmit` check |
| `bun test` | Integration tests (skips Chromium/FFmpeg cases if absent) |
| `bun run build` | Bundle CLI to `./dist` |
| `PICA_PORT=4173 bun src/index.ts` | Run with explicit preview port |

Live preview: open `http://127.0.0.1:4173` for checkerboard artboard, zoom/pan, WebSocket live reload, and timeline scrubber.

## Project layout

```text
src/
  index.ts      CLI entry, stdio transport
  server.ts     MCP server wiring
  tools.ts      pica_create/read/patch/animate/inspect/export schemas
  pica-file.ts  .pica.svg atomic read/patch/animate
  bbox.ts       fast geometry bbox math
  render.ts     resvg static PNG path
  chromium.ts   lazy Chromium CDP frame capture
  export.ts     ffmpeg stdin pipes, clean asset export
  preview.ts    Hono HTTP + WebSocket viewer
  viewer.html   preview UI
tests/
  pica.test.ts  integration suite
```

## Making a change

1. Open or pick an issue first so work stays aligned.
2. Fork, then create a focused branch: `feat/inspect-scale-cap`, `fix/bbox-path-arc`, `docs/preview-shortcuts`.
3. Make the smallest change that fixes the issue. Update tests when behavior changes.
4. Run before you push:
   ```bash
   bun run typecheck
   bun test
   ```
5. Open a PR against `main` with: what changed, why, how you tested, and any Chromium/FFmpeg version notes if relevant.
6. One reviewer minimum. Keep history clean; squash if asked.

## What makes a good PR

- Follows existing patterns in `src/`, no new heavy deps without prior discussion.
- Includes or updates tests for file-engine, bbox, animation, inspect, or export changes.
- Docs updated when tool inputs, file format, or env vars change (`README.md`).
- No secrets, absolute local paths, or generated binaries committed.
- `bun.lock` changes only when deps actually change.

## Reporting bugs

Include: Bun version (`bun --version`), OS, `chromium`/`ffmpeg` presence and versions, minimal `.pica.svg` or repro ops, expected vs actual output, and relevant `stderr` logs. Security issues: do NOT open a public issue, see `SECURITY.md`.

## License

By contributing you agree your work is released under the MIT License in `LICENSE`.
