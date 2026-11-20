/**
 * dsh-math-perf — render KaTeX only where the reader can see it.
 *
 * The Web client's Markdown renderer turns every math node into KaTeX output
 * during React render: katex.renderToString() -> new DOMParser() -> a hand-built
 * React element tree of ~60-200 nodes per formula. A long formula-heavy
 * conversation renders all of its turns at once, so opening one costs thousands
 * of KaTeX renders and hundreds of thousands of DOM nodes before the first
 * paint; every streamed chunk then re-runs the tail blocks on top of that.
 *
 * This plugin serves a patched copy of the shipped client bundle that:
 *
 *  1. memoizes the KaTeX result per (formula, display mode), so a formula that
 *     was already rendered costs nothing when its block re-renders, and
 *  2. defers every formula outside the viewport. The original wrapper becomes
 *     __dshMathRender(), and the bundle's math nodes mount a tiny placeholder
 *     component that renders the real formula as soon as a shared
 *     IntersectionObserver reports it within LATENCY_PX of the viewport. Before
 *     printing, every pending formula renders for real.
 *
 * The bundle on disk is never touched; the patch lives in the route this plugin
 * registers. When the shipped bundle does not match what this plugin knows how
 * to rewrite (a DSH upgrade, a different build), the original bytes are served
 * unchanged and a warning is logged.
 * @module dsh-math-perf
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's version, stamped into the patch so a re-patch is detectable. */
const VERSION = createRequire(import.meta.url)('./package.json').version

/** Stable Cordis plugin name. */
export const name = 'math-perf'

/** The Web server is the only service this plugin needs. */
export const inject = ['webServer']

/** Bounded formula cache; clearing wholesale is cheap and keeps memory flat. */
const CACHE_LIMIT = 512

/** Distance outside the viewport, in CSS pixels, that still renders eagerly. */
const LATENCY_PX = 2000

/** A KaTeX wrapper without this call is not the function this plugin rewrites. */
const RENDER_CALL = 'renderToString('

/** The HTML-to-DOM hop that follows it; both live inside the same function. */
const DOM_HOP = 'new DOMParser().parseFromString('

/** Prefix of the cache declaration injected ahead of the wrapper. */
const CACHE_NAME = '__dshMathPerfCache'

/** Name the patched wrapper takes; the bundle's own J2 keeps the call sites. */
const RENDER_NAME = '__dshMathRender'

/** The backtick character, which a nested template literal cannot spell directly here. */
const BACKTICK = String.fromCharCode(96)

/** Where the patched page posts its performance report. */
const REPORT_PATH = '/__dsh_math_perf/report'

/** Name the shipped code-block component takes after the rename. */
const REAL_CODE_NAME = '__dshRealCodeBlock'

/** Placeholder styling plus off-screen row containment, injected once per page. */
const STYLE = '.dsh-math-pending{display:inline-block;min-width:.85em;height:1em;vertical-align:-.15em;'
  + 'border-radius:4px;background:currentColor;opacity:.09}'
  + '.dsh-math-pending[data-dsh-math=display]{display:block;width:min(58%,26rem);height:1.9em;'
  + 'margin:.55em auto;opacity:.07}'
  + '.dsh-math-live{animation:dshMathIn .16s ease-out both}'
  + '@keyframes dshMathIn{from{opacity:0}to{opacity:1}}'
  + '.dsh-defer-pending{display:block;margin:.4em 0;border-radius:8px;background:currentColor;opacity:.055}'
  + '[data-chat-node-key]{content-visibility:auto;contain-intrinsic-size:auto 240px}'

/** The placeholder component that mounts the real render on demand. */
const LAZY_NAME = '__dshMathLazy'

/**
 * Find the matching closing brace of the block opened at \`openIndex\`, skipping
 * string literals and comments. Minified module code is dense but flat, and the
 * wrapper this plugin targets contains no regular expressions or template
 * literals, so a character scanner is exact here.
 * @param source - the module text.
 * @param openIndex - index of the opening brace.
 * @returns index of the closing brace, or -1 when the block never closes.
 */
function closingBrace(source, openIndex) {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== '') {
      if (char === '\\\\') {
        index += 1
        continue
      }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === BACKTICK) {
      quote = char
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      if (end === -1) return -1
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) return -1
      index = end + 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * The runtime injected next to the wrapper: the stylesheet for placeholders,
 * one shared IntersectionObserver, the print flush, the lazy mounts for math and
 * code blocks, render counters, and a one-shot page report the plugin writes to
 * disk so the remaining cost of a slow transcript can be measured from outside.
 * @param withCodeBlock - whether the shipped bundle's code-block component was
 *   found and renamed, i.e. whether the code-block wrapper may be emitted.
 * @returns ES5-style module-top-level statements, safe inside a minified bundle.
 */
function runtime(withCodeBlock) {
  const pieces = []
  pieces.push(`;(function(){try{var d=document;if(d==null||d.getElementById("dsh-math-perf-css")!=null)return;`
    + `var s=d.createElement("style");s.id="dsh-math-perf-css";`
    + `s.textContent=${JSON.stringify(STYLE)};`
    + `(d.head||d.documentElement).appendChild(s)}catch(e){}})();`)
  pieces.push(`var __dshMathCalls=0,__dshMathMs=0,__dshMathQueue=[],__dshMathPrefetchBudget=400,__dshMathPrefetchIdle=false;`)
  pieces.push(`var __dshDeferWaiters=typeof WeakMap==="function"?new WeakMap:null,__dshDeferObserver=null,`
    + `__dshDeferPending=typeof Set==="function"?new Set:null;`
    + `function __dshDeferFlush(){if(__dshDeferPending!==null){var a=[];__dshDeferPending.forEach(function(f){a.push(f)});`
    + `__dshDeferPending.clear();for(var i=0;i<a.length;i++){try{a[i]()}catch(e){}}}`
    + `if(__dshDeferObserver!==null){__dshDeferObserver.disconnect();__dshDeferObserver=null}}`
    + `try{window.addEventListener("beforeprint",__dshDeferFlush)}catch(e){}`)
  // Idle prefetch: after the page settles, keep hydrating the pending formulas from
  // the tail upwards in short slices, so scrolling up meets finished math instead
  // of placeholders. Bounded, and only while the main thread is idle.
  pieces.push(`function __dshMathNow(){return typeof performance!=="undefined"&&performance.now?performance.now():Date.now()}`
    + `function __dshMathPrefetch(){__dshMathPrefetchIdle=false;var t0=__dshMathNow();`
    + `while(__dshMathQueue.length>0&&__dshMathPrefetchBudget>0){var e=__dshMathQueue.pop();if(e===undefined)break;`
    + `__dshMathPrefetchBudget--;try{e[1]()}catch(x){}`
    + `if(__dshMathNow()-t0>6)break}`
    + `if(__dshMathQueue.length>0&&__dshMathPrefetchBudget>0)__dshMathSchedule()}`
    + `function __dshMathSchedule(){if(__dshMathPrefetchIdle||__dshMathPrefetchBudget<=0)return;__dshMathPrefetchIdle=true;`
    + `if(typeof requestIdleCallback==="function")requestIdleCallback(__dshMathPrefetch,{timeout:500});else setTimeout(__dshMathPrefetch,250)}`
    + `try{setTimeout(__dshMathSchedule,700);`
    + `var __dshScrollTimer=0;`
    + `window.addEventListener("scroll",function(){if(__dshScrollTimer)clearTimeout(__dshScrollTimer);`
    + `__dshScrollTimer=setTimeout(__dshMathSchedule,220)},{passive:true})}catch(e){}`)
  pieces.push(`function __dshDeferObserve(el,cb){`
    + `if(__dshDeferWaiters===null||typeof IntersectionObserver==="undefined"){cb();return null}`
    + `if(__dshDeferObserver===null){__dshDeferObserver=new IntersectionObserver(function(es){`
    + `for(var i=0;i<es.length;i++){var e=es[i];if(!e.isIntersecting)continue;`
    + `var f=__dshDeferWaiters.get(e.target);if(f===undefined)continue;`
    + `__dshDeferWaiters.delete(e.target);__dshDeferObserver.unobserve(e.target);`
    + `if(__dshDeferPending!==null)__dshDeferPending.delete(f);f()}},{rootMargin:"${LATENCY_PX}px 0px ${LATENCY_PX}px 0px"});}`
    + `__dshDeferWaiters.set(el,cb);if(__dshDeferPending!==null)__dshDeferPending.add(cb);`
    + `__dshDeferObserver.observe(el);`
    + `return function(){__dshDeferWaiters.delete(el);if(__dshDeferPending!==null)__dshDeferPending.delete(cb);`
    + `if(__dshDeferObserver!==null)__dshDeferObserver.unobserve(el)}}`)
  pieces.push(`function __dshDeferMount(p){`
    + `var st=x.useState(false),ready=st[0],set=st[1],ref=x.useRef(null);`
    + `x.useEffect(function(){if(ready)return;var el=ref.current;`
    + `if(el===null){set(true);return}`
    + `var stop=__dshDeferObserve(el,function(){set(true)});return stop===null?void 0:stop},[ready]);`
    + `if(ready)return p.render();`
    + `return x.createElement("div",{ref:ref,className:"dsh-defer-pending","data-dsh-defer":p.kind,style:{height:(p.estimate||160)+"px"}})`
    + `}`)
  pieces.push(`function __dshMathLazy(p){`
    + `var k=(p.displayMode?"d:":"i:")+p.tex;`
    + `var st=x.useState(function(){return __dshMathPerfCache.has(k)}),ready=st[0],set=st[1],ref=x.useRef(null);`
    + `x.useEffect(function(){if(ready)return;var el=ref.current;`
    + `if(el===null){set(true);return}`
    + `var entry=[el,function(){set(true)}];__dshMathQueue.push(entry);`
    + `var stop=__dshDeferObserve(el,function(){set(true)});`
    + `return function(){var at=__dshMathQueue.indexOf(entry);if(at>=0)__dshMathQueue.splice(at,1);`
    + `if(stop!==null)stop()}},[ready]);`
    + `if(ready)return x.createElement("span",{className:"dsh-math-live",style:p.displayMode?{display:"block"}:void 0},`
    + `x.createElement(x.Fragment,null,__dshMathRender(p.tex,p.displayMode)));`
    + `return x.createElement("span",{ref:ref,className:"dsh-math-pending","data-dsh-math":p.displayMode?"display":"inline"})}`
    + `function J2(e,t){return[x.createElement(__dshMathLazy,{key:0,tex:e,displayMode:t})]}`)
  if (withCodeBlock) {
    pieces.push(`function Zb(p){`
      + `var n=String(p&&p.code!=null?p.code:"").split("\\n").length;`
      + `var est=Math.min(900,56+n*20);`
      + `return x.createElement(__dshDeferMount,{kind:"code",estimate:est,`
      + `render:function(){return x.createElement(__dshRealCodeBlock,p)}})}`)
  }
  pieces.push(`;(function(){try{`
    + `var stack=[];`
    + `try{if(typeof PerformanceObserver==="function"){new PerformanceObserver(function(l){`
    + `var es=l.getEntries();for(var i=0;i<es.length;i++)stack.push([Math.round(es[i].startTime),Math.round(es[i].duration)])`
    + `}).observe({entryTypes:["longtask"],buffered:true})}}catch(e){}`
    + `var sent=false;`
    + `function send(){if(sent)return;sent=true;try{`
    + `var q=function(s){return document.querySelectorAll(s).length};`
    + `var body={v:"${VERSION}",href:location.pathname,`
    + `nodes:q("*"),katex:q(".katex"),mathPending:q(".dsh-math-pending"),deferPending:q(".dsh-defer-pending"),`
    + `shiki:q(".shiki"),pre:q("pre"),rows:q("[data-chat-node-key]"),`
    + `height:document.documentElement.scrollHeight,`
    + `mathCalls:__dshMathCalls,mathMs:Math.round(__dshMathMs),tasks:stack.slice(-60)};`
    + `fetch("/__dsh_math_perf/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).catch(function(){})`
    + `}catch(e){}}`
    + `setTimeout(send,12000);try{window.addEventListener("load",function(){setTimeout(send,12000)})}catch(e){}`
    + `}catch(e){}})();`)
  return pieces.join('')
}
/**
 * Locate the shipped bundle's code-block component: the Shiki CSS-variable
 * theme constant is immediately followed by it.
 * @param source - module text.
 * @returns the function's declaration index and name, when found.
 */
function findCodeBlock(source) {
  const themeAt = source.indexOf('"shiki css-variables"')
  if (themeAt === -1) return undefined
  const signatureAt = source.indexOf('({code:', themeAt)
  if (signatureAt === -1) return undefined
  const at = source.lastIndexOf('function ', signatureAt)
  if (at === -1) return undefined
  const name = /^function\s+([A-Za-z_$][\w$]*)\s*\(\{code:/.exec(source.slice(at, signatureAt + 8))
  return name === null ? undefined : { at, name: name[1] }
}

/**
 * Rewrite the client bundle: memoize the KaTeX wrapper, route math through the
 * viewport-aware placeholder, defer off-screen code blocks (Shiki), and install
 * the page probe.
 * @param source - the shipped bundle text.
 * @returns the patched text, or undefined when the bundle is not the shape this
 *   plugin knows (already patched, renamed wrapper, different pipeline).
 */
export function patchBundle(source) {
  if (source.includes(CACHE_NAME)) return undefined
  const mathAt = source.indexOf(DOM_HOP)
  if (mathAt === -1) return undefined
  const functionAt = source.lastIndexOf('function ', mathAt)
  if (functionAt === -1) return undefined
  const head = /^function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/
    .exec(source.slice(functionAt, mathAt))
  if (head === null) return undefined
  const bodyAt = functionAt + head[0].length
  const endAt = closingBrace(source, bodyAt - 1)
  if (endAt === -1) return undefined
  const body = source.slice(bodyAt, endAt)
  // Both render attempts must be here: the strict one and the lenient retry.
  if (body.split(RENDER_CALL).length !== 3) return undefined
  const returnAt = body.lastIndexOf('return')
  if (returnAt === -1) return undefined
  // The minified bundle puts the final return right after a closing brace; a
  // formatted equivalent may keep whitespace there, which is equally valid.
  const before = body.slice(0, returnAt)
  const tail = before === '' ? '}' : before.at(-1)
  if (!'{};'.includes(tail) && !/\s/u.test(tail)) return undefined
  const [, , texName, modeName] = head
  const keyName = '__dshMathPerfKey'
  const hitName = '__dshMathPerfHit'
  const outName = '__dshMathPerfOut'
  const prefix = 'var ' + keyName + '=(((' + modeName + '?"d:":"i:")+' + texName + ')),'
    + hitName + '=' + CACHE_NAME + '.get(' + keyName + ');'
    + 'if(' + hitName + '!==void 0)return ' + hitName + ';'
  const suffix = ';if(' + CACHE_NAME + '.size>=' + CACHE_LIMIT + ')' + CACHE_NAME + '.clear();'
    + CACHE_NAME + '.set(' + keyName + ',' + outName + ');return ' + outName
  const render = 'function ' + RENDER_NAME + '(' + texName + ',' + modeName + '){'
    + 'var __t0=typeof performance!=="undefined"&&performance.now?performance.now():0;'
    + prefix
    + before
    + 'var ' + outName + '=' + body.slice(returnAt + 'return'.length)
    + suffix.slice(0, suffix.indexOf(';return ' + outName))
    + ';if(__t0){__dshMathCalls++;__dshMathMs+=performance.now()-__t0};return ' + outName
    + '}'
  const codeBlock = findCodeBlock(source)
  const out = source.slice(0, functionAt)
    + 'var ' + CACHE_NAME + '=new Map;'
    + render
    + runtime(codeBlock !== undefined)
    + source.slice(endAt + 1)
  // The stamp lets the archive patcher tell "already patched by this release"
  // from "patched by an older one", so healing at boot is a no-op instead of
  // appending another copy every time.
  const stamp = '/* dsh-math-perf ' + VERSION + ' */'
  if (codeBlock === undefined) return stamp + out
  // The code-block component sits earlier in the module, so its index is unchanged
  // by the insertion above.
  return stamp + out.slice(0, codeBlock.at)
    + 'function ' + REAL_CODE_NAME + out.slice(codeBlock.at + 'function '.length + codeBlock.name.length)
}
/**
 * Directories that may hold the built Web client, most specific first. The
 * desktop application keeps its packages inside \`app.asar\`, which Electron's
 * patched \`fs\` reads like a normal directory; a source checkout and a plain
 * npm install are covered by the same candidates.
 * @returns absolute candidate dist directories.
 */
function distCandidates() {
  const candidates = []
  const exeDir = process.execPath === '' ? undefined : dirname(process.execPath)
  const packages = ['node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist']
  if (exeDir !== undefined) {
    candidates.push(join(exeDir, 'resources', 'app.asar', 'dsh', ...packages))
    candidates.push(join(exeDir, 'resources', 'app', ...packages))
    candidates.push(join(exeDir, ...packages))
  }
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir !== undefined && installDir !== '') {
    // installDir is <root>/dsh/node_modules/@deepseek-ai/dsh
    candidates.push(join(installDir, '..', '..', 'dsh-web-frontend', 'dist'))
  }
  try {
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')
    candidates.push(join(dirname(manifest), 'dist'))
  } catch {
    /* Not installed next to this plugin; the other candidates still apply. */
  }
  return candidates
}

/**
 * Read every candidate bundle and patch the ones that carry the KaTeX wrapper.
 * @param warn - diagnostic sink for an unreadable candidate.
 * @returns one route per patched bundle, with its absolute request path.
 */
function bundleRoutes(warn) {
  const routes = []
  for (const dist of distCandidates()) {
    const assets = join(dist, 'assets')
    let entries
    try {
      entries = readdirSync(assets)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue
      let source
      try {
        source = readFileSync(join(assets, entry), 'utf8')
      } catch (error) {
        warn('math-perf: cannot read ' + entry + ': ' + String(error))
        continue
      }
      const patched = patchBundle(source)
      if (patched === undefined) continue
      const body = Buffer.from(patched, 'utf8')
      const etag = 'W/"' + createHash('sha1').update(body).digest('base64url') + '"'
      routes.push({
        kind: 'exact',
        path: '/assets/' + entry,
        resource: async (request) => {
          const headers = {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
            etag,
          }
          if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
          if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
          return new Response(body, { status: 200, headers })
        },
      })
    }
    if (routes.length > 0) break
  }
  return routes
}

/**
 * The report sink: the patched page posts one JSON line per load, which lands in
 * `$DSH_HOME/math-perf-reports.jsonl` so the remaining cost of a slow transcript
 * can be measured without a profiler.
 * @param warn - diagnostic sink for a failed write.
 * @returns the route answering `REPORT_PATH`.
 */
function reportRoute(warn) {
  return {
    kind: 'exact',
    path: REPORT_PATH,
    handler: (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 262144) {
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
          mkdirSync(home, { recursive: true })
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536)
          appendFileSync(join(home, 'math-perf-reports.jsonl'), JSON.stringify({ at: new Date().toISOString(), body }) + '\n')
          response.writeHead(204)
          response.end()
        } catch (error) {
          warn('math-perf: cannot record the page report: ' + String(error))
          response.writeHead(500)
          response.end()
        }
      })
      request.on('error', () => {
        try {
          response.writeHead(400)
          response.end()
        } catch {
          /* The socket is already gone. */
        }
      })
    },
  }
}

/** Location of the archive patcher shipped inside this package. */
const HEAL_TOOL = new URL('./tools/patch-asar.mjs', import.meta.url)

/**
 * Re-apply the archive patch after an upgrade replaced app.asar.
 *
 * The Desktop window reads "/assets/*" straight out of app.asar, so the route
 * this plugin registers never reaches it: the archive itself has to carry the
 * patch. An upgrade replaces that archive, so the patch is re-applied on every
 * boot instead of asking the user to reinstall. The shell has already parsed the
 * archive header by the time the host starts, so a repair made here is served
 * from the next start onwards.
 * @param warn - diagnostic sink.
 * @returns what happened, once the child process exits.
 */
export function healArchive(warn) {
  if (process.env.DSH_MATH_PERF_NO_ASAR === '1') return Promise.resolve('disabled')
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(process.execPath, [fileURLToPath(HEAL_TOOL), 'patch'], {
        // The patcher must read the archive as a plain file, not through the
        // asar-aware fs this process runs on.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      warn('math-perf: cannot re-apply the archive patch: ' + String(error))
      resolve('failed')
      return
    }
    const collect = (chunk) => {
      output += String(chunk)
      if (output.length > 16384) output = output.slice(-8192)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      warn('math-perf: cannot re-apply the archive patch: ' + String(error))
      resolve('failed')
    })
    child.on('exit', (code) => {
      if (code === 0) {
        const patched = output.includes('patched in place')
        if (patched) {
          warn('math-perf: an upgrade replaced app.asar; the patch was re-applied. Restart DeepSeek Harness to load it.')
        }
        resolve(patched ? 'patched' : 'current')
        return
      }
      // A Web-only install has no archive to heal; anything else is a real failure.
      const absent = /cannot find the DeepSeek Harness app.asar|no client bundle inside/u.test(output)
      if (!absent) {
        warn('math-perf: archive patch failed: ' + output.trim().split('\n').slice(-2).join(' | '))
      }
      resolve(absent ? 'skipped' : 'failed')
    })
  })
}

/**
 * Claim one exact route per patched bundle plus the report sink, and keep the
 * installed archive patched across upgrades. Registration is effect-scoped, so
 * disabling the plugin restores the shipped bundle on the next reload.
 * @param ctx - context carrying the Web server.
 */
export function apply(ctx) {
  const warn = (message) => { try { ctx.logger?.warn?.(message) } catch { /* logging must never break boot */ } }
  // Never block boot on the archive; the repair only matters from the next start.
  void healArchive(warn).catch(() => {})
  let routes = []
  try {
    routes = bundleRoutes(warn)
  } catch (error) {
    warn('math-perf: bundle scan failed: ' + String(error))
  }
  if (routes.length === 0) {
    // Either the archive already carries the patch or the bundle is a shape this
    // plugin does not know; the report sink is still useful, so keep going.
    warn('math-perf: no patchable client bundle over the Web server; the report sink stays available')
  }
  for (const route of [...routes, reportRoute(warn)]) {
    try {
      ctx.effect(() => ctx.webServer.register(route), 'math-perf: ' + route.path)
    } catch (error) {
      warn('math-perf: cannot register ' + route.path + ': ' + String(error))
    }
  }
  try {
    ctx.logger?.info?.('math-perf: lazy KaTeX rendering for ' + routes.map(route => route.path).join(', '))
  } catch {
    /* Diagnostics are optional. */
  }
}