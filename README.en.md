# dsh-math-perf

[![ci](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-math-perf.svg)](https://www.npmjs.com/package/dsh-math-perf)

English | [简体中文](README.md)

A DeepSeek Harness plugin: **render only the math and code you can see**. Long conversations no
longer stall on open or while scrolling.

## The problem

The client lays out a whole conversation in one pass, and every math node pays the full chain
during React rendering:

```
katex.renderToString()  →  new DOMParser().parseFromString()  →  one React element per DOM node
```

A single formula produces 60–200 DOM nodes. A 90-turn conversation with 1300+ formulas means:

| Item | Value |
|---|---|
| formulas (inline included) | 1300+ |
| code blocks | 250+ |
| first paint | the main thread is busy with KaTeX for seconds; scrolling does nothing meanwhile |

Those nodes also keep taking part in layout and paint every time you scroll.

## What it does

The plugin reads the client bundle from the installation, rewrites it, and serves the bytes on an
exact route for `/assets/index-*.js` (effective on the Web port). When it does not recognise the
bundle shape it **only warns and registers no route**, so the client keeps its shipped behaviour.
Four changes:

1. **Math renders near the viewport.** The KaTeX wrapper becomes `__dshMathRender()` and memoises
   its result per (formula, display mode). Every math node goes through the placeholder component
   `__dshMathLazy`, which renders when it approaches the viewport and straight from the memo when
   it has been rendered before.
2. **Code blocks highlight near the viewport.** The Shiki component becomes
   `__dshRealCodeBlock` behind `__dshDeferMount`; off-screen blocks skip highlighting entirely.
3. **Off-screen rows leave the layout.** An injected rule,
   `[data-chat-node-key]{content-visibility:auto;contain-intrinsic-size:auto 240px}`.
4. **Smooth scrolling.** While the main thread is idle, `requestIdleCallback` pre-renders queued
   formulas from the tail upwards (at most 6ms per slice, 400 formulas, re-armed 220ms after
   scrolling stops). Placeholders are light grey blocks rather than full-width bars, and a finished
   formula fades in over 160ms. The prefetch margin is two screens.

`beforeprint` hydrates everything still pending, so printing and export are unaffected.

## Install

```bash
npm i -g dsh-math-perf

# wire it into a profile (dependencies and dsh.profile.bundles)
dsh plugin --profile <profile> add dsh-math-perf
```

Both entries must be present in the profile's `package.json`:

```jsonc
{
  "dependencies": { "dsh-math-perf": "^0.4.0" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-math-perf" ] } }
}
```

The Desktop build also needs its front-end archive rewritten (see below), then **restart** DeepSeek
Harness:

```bash
dsh-math-perf patch
```

This is a one-time step. When an upgrade replaces the archive, the plugin repairs it on
boot (see below).

## Why the Desktop build needs app.asar rewritten

The Desktop window's origin is `dsh-app://app`, and the main process (`lib/main.js`) says:

```js
if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/assets/"))
  return serveWebDocument(request, join(resources.dsh, "node_modules/@deepseek-ai/dsh-web-frontend/dist"))
```

So `/assets/*` is **read straight out of app.asar** and never reaches the Web server. The route
this plugin registers therefore only affects browser access to the Web port; the Desktop window needs
the archive rewritten.

`patch` appends the rewritten bundle past the end of the archive, then moves that one header
entry to it and re-hashes it. The header keeps its length, so no other entry offset changes, and the
append happens before the header move, so an interrupted run leaves a usable archive. The original is
kept next to it as `app.asar.bak-mathperf`.

## Command line

| Command | What it does |
|---|---|
| `dsh-math-perf patch [--asar <path>] [--dry-run]` | rewrite the installed app.asar; the location is auto-detected |
| `dsh-math-perf restore [--asar <path>]` | restore the archive backup |
| `dsh-math-perf extract <file>` | write the untouched bundle out (debugging) |

When detection fails, pass `--asar` or set `DSH_DESKTOP_APP_ASAR`.

## The probe

Twelve seconds after load the page posts a small JSON document back to the plugin, which appends it
to `$DSH_HOME/math-perf-reports.jsonl`:

```bash
cat ~/.dsh/math-perf-reports.jsonl | tail -3 | jq -r .body | jq
```

`tasks` lists long tasks as `[startMs, durationMs]`; anything above 50ms is a stall. `nodes` is
the DOM node count, `shiki` the number of highlighted code blocks, `mathPending` the formulas still
unrendered. Nothing leaves the machine.

## Trade-offs

- **Ctrl+F does not find formulas that have not rendered yet** — they are not in the DOM. Scroll
  near them and they render.
- **Copying a selection that spans the screen** cannot restore unrendered formulas as LaTeX.
- Placeholder heights are estimates, so a new region may shift the scroll position slightly; the
  browser's scroll anchoring absorbs most of it.

## Uninstall and rollback

Remove `"dsh-math-perf"` from `dsh.profile.bundles` and the client is back to stock. On Desktop, run
`dsh-math-perf restore` as well.

## After a DSH upgrade

An upgrade replaces `app.asar`, so the patch is gone. The plugin **checks the archive on every boot
and repairs it in the background**, so nothing has to be done by hand:

- the repair lands at startup and is served from the **next** start — the Desktop window reads the
  archive header into memory when its process starts, so the current session cannot switch to it
- the patch carries a version stamp, so an already current archive is skipped instead of being
  appended to again
- `DSH_MATH_PERF_NO_ASAR=1` turns the repair off; `dsh-math-perf patch` remains the manual fallback
- if the upstream bundle shape changes, `patchBundle()` fails to match and only warns — it never
  writes half a patch

## Development

The package has no runtime dependencies. Two kinds of test:

```bash
node test/all.mjs                                                     # needs a local DSH install
node --experimental-vm-modules test/verify.mjs test/fixture-bundle.js # no DSH needed; this is what CI runs
```

| Script | What it checks |
|---|---|
| `test/verify.mjs` | the bundle parses; memo hits; placeholder → observed → one render; print flush; idle prefetch |
| `test/render-equivalence.mjs` | deferred rendering produces a byte-identical element tree |
| `test/test-route.mjs` | reads the real install; route 200/304/HEAD; report sink write |
| `test/check-profile.mjs` | it really is a bundle layer and is not skipped for compatibility |
| `test/check-inventory.mjs` | Settings → Plugins lists it as installed and enabled |
| `test/bench.mjs` | KaTeX workload benchmark (needs katex + linkedom) |

If the upstream bundle shape or naming changes, update `test/fixture-bundle.js` too — it is the
minimal stand-in CI runs against.

## License

MIT