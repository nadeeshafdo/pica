# Security Policy

`pica` runs locally as an MCP server, reads and writes `.pica.svg` files, shells out to optional system `chromium` and `ffmpeg`, and serves a local-only preview. Thanks for helping keep that surface safe.

## Supported versions

| Version | Supported |
| :--- | :--- |
| `0.1.x` (latest `main`) | Yes |
| `< 0.1.0`, forks, pre-releases | Best effort only |

We patch the latest `main` first, then cut a release. If you are pinned to an old tag, please confirm the issue reproduces on latest `main`.

## Report a vulnerability

Do NOT open a public issue, discussion, or PR for suspected vulnerabilities.

Preferred path:

1. Use GitHub: `Security` tab > `Report a vulnerability` (private advisory).
2. Alternative: email `itsme@nadeeshafdo.dev` with subject `[pica security] short summary`.

Include:

- Affected commit or version, OS, Bun version
- Repro steps or PoC (minimal `.pica.svg`, tool call JSON, or script)
- Impact assessment (file overwrite, code execution, SSRF, XSS in preview, DoS, etc.)
- Any relevant `stderr` logs (redact secrets and absolute usernames/paths)

Please do NOT include live credentials, private customer data, or unrelated PII.

What to expect:

- Acknowledgement within 48 hours
- Triage and severity assessment within 7 days
- Fix prioritization by severity: RCE / file-escape / sandbox bypass first, then preview XSS, then DoS / correctness
- Coordinated disclosure: we fix, release, then publish an advisory and credit you (unless you prefer anonymity)

There is no paid bounty program. We offer public credit, a fast fix, and our gratitude.

## Scope and threat notes

In-scope:

- `pica_patch` sanitization bypass: `<script>` injection, `on*` event handlers, `javascript:` URLs, invalid XML acceptance, cyclic group reorder escape
- Path traversal or non-atomic writes in file engine (`pica-file.ts`)
- Command injection via `chromium` / `ffmpeg` spawn arguments or piped media paths (`chromium.ts`, `export.ts`)
- Preview server issues: binding beyond `127.0.0.1`, WebSocket origin bypass, stored XSS via unsanitized SVG in `viewer.html`
- MCP stdio breakage that leaks logs/secrets to `stdout`

Out of scope (but still welcome as regular bugs):

- Missing `chromium` / `ffmpeg` error messages
- Visual rendering differences between `resvg` fast path and Chromium exact path
- Performance tuning without a security boundary

Hardening already in place:

- DOM-based SVG sanitization via `linkedom`: rejects `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, and `<applet>`; `on*` handlers including no-space forms; entity-decoded `javascript:`, `vbscript:`, and limited `data:` URLs (allowlist: `data:image/png`, `data:image/jpeg`, `data:image/webp`, `data:image/gif`, `data:font/`, `data:application/font-woff`, `data:application/font-woff2`); and `<style>` CSS with `@import`, `javascript:`, `expression(`, or `url(` after comment and hex-escape normalization. Only `<style id="pica-anim">` is accepted.
- Skeleton element protection: `pica-meta`, `pica-defs`, `pica-anim`, and `pica-root` are blocked from `update`, `remove`, and `reorder`; `pica-bg` is restricted to `fill`, `opacity`, and `fill-opacity`; `id` mutation is blocked on all elements.
- `pica_animate` CSS checks on keyframe names, keyframe bodies (including `url(`, balanced-brace validation, comment and hex-escape normalization), and target properties (`easing`, `transformOrigin`, `direction`, `fill`, string `iterations`).
- `pica_configure` updates `width`, `height`, `viewBox`, `#pica-bg` fill, and `#pica-meta` (`fps`, `background`, `baseDurationMs`, recalculated `durationMs`) atomically; `pica_patch` keeps `#pica-meta.background` in sync when `#pica-bg` fill changes.
- Path handling via `resolveSafePath` (null-byte rejection and optional `PICA_ROOT` check with `realpathSync` canonicalization, walking to the nearest existing ancestor for new files) plus `ffmpeg` flag (`-...`) and protocol (`://`) rejection on the raw `outPath`.
- Headless Chromium CDP `Fetch.enable` request handling: external `http://`, `https://`, `file://`, and `ws://` requests are not allowed, allowing only `about:blank` and the same `data:` allowlist as above. Chromium launches with the sandbox by default; set `PICA_CHROME_NO_SANDBOX=1` to include `--no-sandbox`, with a single retry without it when the first launch does not start.
- Preview server bound to `127.0.0.1`, `/ws` `Origin` header validation (`403` on cross-origin), `DOMParser` SVG parsing for metadata with canvas rendering isolated in a sandboxed `<iframe sandbox="allow-same-origin" srcdoc>`, and `Content-Security-Policy` headers on `/` (`frame-src 'self'`, `font-src`) and `/svg`.
- Atomic `.tmp` plus `rename` writes with failed-write `.tmp` cleanup, so interrupted writes never leave partial files.
- Exports strip debug overlays (`showGrid`, `showIds` never persist).
- No cloud calls, no telemetry, no bundled secrets.

## Safe harbor

Good-faith research against your own local install is welcome. Do not access other users' machines, exfiltrate data, degrade shared services, or pivot from a local finding to third-party infrastructure.

## After going public

Once this repo is public, advisories will be published via GitHub Security Advisories and referenced from release notes. Please keep findings embargoed until a fix is released.
