/**
 * What the patch removes from opening a formula-heavy conversation.
 *
 * The numbers come from the client's own KaTeX wrapper (extracted verbatim from
 * the shipped bundle) running the real KaTeX build against a real DOMParser, so
 * they are the JavaScript half of the cost: renderToString + parse + element
 * construction. React's DOM work is not included and only makes the gap larger.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/bench.mjs [bundle]
 * Requires katex + linkedom: set DSH_MATH_BENCH_MODULES to that package.json.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { patchBundle } from '../index.js'

const bundlePath = process.argv[2]
  ?? 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-Ciz7DZxv.js'
const modules = process.env.DSH_MATH_BENCH_MODULES ?? 'C:/Users/ZMZ/AppData/Local/Temp/mathbench/package.json'
const require = createRequire(modules)
const katex = require('katex')
const { DOMParser } = require('linkedom')

const source = readFileSync(bundlePath, 'utf8')
const patched = patchBundle(source)
if (patched === undefined) { console.error('patch failed'); process.exit(1) }

function extractRaw(text, name) {
  const at = text.indexOf('function ' + name + '(')
  if (at === -1) return undefined
  let depth = 0
  let quote = ''
  for (let index = text.indexOf('{', at); index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}') { depth -= 1; if (depth === 0) return text.slice(at, index + 1) }
  }
  return undefined
}

const convert = extractRaw(source, 'Bb')
const original = extractRaw(source, 'J2')
const start = patched.indexOf('var __dshMathPerfCache=new Map;')
const j2At = patched.indexOf('function J2(e,t){', start)
let depth = 0
let end = -1
for (let index = patched.indexOf('{', j2At); index < patched.length; index += 1) {
  const char = patched[index]
  if (char === '{') depth += 1
  else if (char === '}') { depth -= 1; if (depth === 0) { end = index + 1; break } }
}
const runtimeSource = patched.slice(start, end)

const m = { jsx: (type, props, children) => ({ type, props, children }) }
const buildShipped = () => new Function('Zm', 'DOMParser', 'm', convert + ';' + original + ';return J2')(katex, DOMParser, m)
const buildPatched = () => {
  const state = { value: undefined }
  const x = {
    Fragment: Symbol('Fragment'),
    useState(init) { state.value = typeof init === 'function' ? init() : init; return [state.value, (next) => { state.value = next }] },
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const document = { head: { appendChild() {} }, documentElement: { appendChild() {} }, getElementById: () => null, createElement: () => ({}) }
  const window = { addEventListener() {} }
  return new Function(
    'x', 'document', 'window', 'IntersectionObserver', 'Zm', 'DOMParser', 'm',
    convert + ';' + runtimeSource + ';return { render: __dshMathRender, J2: J2 }',
  )(x, document, window, class { observe() {} unobserve() {} disconnect() {} }, katex, DOMParser, m)
}

const base = [
  String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
  String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`,
  String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
  String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
  String.raw`\lim_{x \to 0} \frac{\sin x}{x} = 1`,
  String.raw`\begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`,
  String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`,
  String.raw`\hat{H}\psi = E\psi`,
  String.raw`\mathcal{L} = \tfrac12 m \dot{q}^2 - V(q)`,
  String.raw`\mathbb{E}[X] = \int_{-\infty}^{\infty} x f(x)\,dx`,
]
const formulas = (count) => Array.from({ length: count }, (_, index) => base[index % base.length] + String.raw`\quad k=${index}`)
const now = () => Number(process.hrtime.bigint()) / 1e6

// The conversation that motivated this: 1347 formulas across 109 messages.
const TOTAL = 1347
const VIEWPORT = 45
const all = formulas(TOTAL)

const shipped = buildShipped()
const patch = buildPatched()
for (const f of formulas(5)) { shipped(f, true); patch.render(f, true) }

let t0 = now()
for (const f of all) shipped(f, false)
const eager = now() - t0

t0 = now()
for (const f of all) patch.J2(f, false)        // every math node mounts the placeholder
for (const f of all.slice(0, VIEWPORT)) patch.render(f, false)  // only what the viewport shows
const lazy = now() - t0

console.log('conversation: ' + TOTAL + ' formulas, ' + VIEWPORT + ' of them on screen')
console.log('shipped client: ' + eager.toFixed(0) + ' ms of KaTeX work before the first paint')
console.log('with the patch: ' + lazy.toFixed(0) + ' ms (' + VIEWPORT + ' formulas rendered, the rest wait for scroll)')
console.log('removed: ' + (eager - lazy).toFixed(0) + ' ms, ' + ((1 - lazy / eager) * 100).toFixed(1) + '%')
