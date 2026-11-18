/**
 * Proves the deferred render is faithful: for the same formulas, the patched
 * renderer produces exactly the element tree the shipped wrapper produced, so
 * hydration can swap one for the other without changing the result.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/render-equivalence.mjs [bundle]
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
if (patched === undefined) {
  console.error('FAIL: patchBundle returned undefined')
  process.exit(1)
}

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
if (convert === undefined || original === undefined || j2At < 0) {
  console.error('FAIL: cannot extract the wrappers')
  process.exit(1)
}

// React shims: the wrapper only needs element creation and node type tags.
const Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 }
const x = { createElement: (type, props, ...children) => ({ type, props: props ?? null, children }), Fragment: Symbol('Fragment'), useState: () => [true, () => {}], useRef: () => ({ current: null }), useEffect: () => {} }
const m = { jsx: (type, props, children) => ({ type, props: props ?? null, children: children ?? [] }) }
const document = { head: { appendChild() {} }, documentElement: { appendChild() {} }, getElementById: () => null, createElement: () => ({}) }
const window = { addEventListener() {} }
const IO = class { observe() {} unobserve() {} disconnect() {} }

const renderShipped = new Function('Zm', 'DOMParser', 'm', 'x', 'Node', convert + ';' + original + ';return J2')(katex, DOMParser, m, x, Node)
const renderPatched = new Function(
  'x', 'document', 'window', 'IntersectionObserver', 'Zm', 'DOMParser', 'm', 'Node',
  convert + ';' + runtimeSource + ';return __dshMathRender',
)(x, document, window, IO, katex, DOMParser, m, Node)

const cases = [
  String.raw`\frac{-b \pm \sqrt{b^2-4ac}}{2a}`,
  String.raw`\int_0^\infty e^{-x^2}\,dx`,
  String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
  String.raw`\begin{cases} 1 & x>0 \\ 0 & \text{else} \end{cases}`,
  String.raw`\text{中文与 English 混排} + \alpha_1^2`,
  String.raw`\sum_{i=1}^{n} i`,
  String.raw`\frac{1}{\text{incomplete}`,
  'x',
]
let checked = 0
for (const formula of cases) {
  for (const displayMode of [false, true]) {
    const expected = JSON.stringify(renderShipped(formula, displayMode))
    const actual = JSON.stringify(renderPatched(formula, displayMode))
    if (expected !== actual) {
      console.error('FAIL: different output for ' + JSON.stringify(formula) + ' (display=' + displayMode + ')')
      console.error('  expected ' + expected.slice(0, 300))
      console.error('  actual   ' + actual.slice(0, 300))
      process.exit(1)
    }
    checked += 1
  }
}
console.log('compared ' + checked + ' renders against the shipped wrapper: identical trees')
console.log('OK: deferred rendering changes nothing but the timing')
