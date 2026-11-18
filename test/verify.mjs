/**
 * Unit-level proof of the bundle patch, run without a browser:
 *
 *  - the patched bundle still parses as an ES module;
 *  - the memoized wrapper renders a formula once and reuses the result;
 *  - every math node now mounts the lazy component, which shows a placeholder
 *    until the shared IntersectionObserver reports it near the viewport, and
 *    renders the real formula exactly once after that;
 *  - a formula already in the cache starts hydrated (no placeholder flash);
 *  - \`beforeprint\` hydrates everything that is still pending.
 *
 * Run with: node --experimental-vm-modules test/verify.mjs <bundle>
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { patchBundle } from '../index.js'

const bundlePath = process.argv[2]
  ?? 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-Ciz7DZxv.js'
const original = readFileSync(bundlePath, 'utf8')
const patched = patchBundle(original)
if (patched === undefined) {
  console.error('FAIL: patchBundle returned undefined')
  process.exit(1)
}
console.log('original bytes ' + original.length + ', patched ' + patched.length + ' (+' + (patched.length - original.length) + ')')

const SourceTextModule = vm.SourceTextModule
if (SourceTextModule === undefined) {
  console.log('parse: skipped (run with --experimental-vm-modules to check syntax)')
} else {
  for (const [label, source] of [['original', original], ['patched', patched]]) {
    try {
      new SourceTextModule(source, { identifier: label + '.js' })
    } catch (error) {
      console.error('FAIL: ' + label + ' does not parse: ' + error.message)
      process.exit(1)
    }
  }
  console.log('parse: both modules parse')
}

// --- extract the injected runtime ----------------------------------------
const start = patched.indexOf('var __dshMathPerfCache=new Map;')
const j2At = patched.indexOf('function J2(e,t){', start)
if (start < 0 || j2At < 0) {
  console.error('FAIL: injected runtime not found')
  process.exit(1)
}
let depth = 0
let end = -1
for (let index = patched.indexOf('{', j2At); index < patched.length; index += 1) {
  const char = patched[index]
  if (char === '{') depth += 1
  else if (char === '}') {
    depth -= 1
    if (depth === 0) { end = index + 1; break }
  }
}
const runtimeSource = patched.slice(start, end)

// --- stubs ---------------------------------------------------------------
let renders = 0
const katex = {
  renderToString: (tex, options) => {
    renders += 1
    return '<span class="katex" data-tex="' + tex + '" data-display="' + options.displayMode + '"></span>'
  },
}
const DOMParser = class { parseFromString(html) { return { body: { childNodes: [{ nodeType: 1, tagName: 'SPAN', localName: 'span', attributes: [], childNodes: [], html }] } } } }
const convert = (node, key) => ({ tag: 'span', key, html: node.html })
const m = { jsx: (type, props, children) => ({ type, props, children }) }
const Fragment = Symbol('Fragment')
const observed = new Map()
let observerCallback
const IntersectionObserver = class {
  constructor(cb) { observerCallback = cb }
  observe(el) { observed.set(el, true) }
  unobserve(el) { observed.delete(el) }
  disconnect() { observed.clear() }
}
const makeReact = () => {
  const state = { value: undefined }
  const effects = []
  const x = {
    Fragment,
    useState(init) {
      if (state.value === undefined) state.value = typeof init === 'function' ? init() : init
      return [state.value, (next) => { state.value = next }]
    },
    useRef(value) { return { current: value } },
    useEffect(fn) { effects.push(fn) },
    createElement(type, props, ...children) { return { type, props: props ?? null, children } },
  }
  return { x, state, effects }
}
const styleSink = { id: undefined, textContent: undefined }
const document = {
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  getElementById: (id) => (styleSink.id === id ? styleSink : null),
  createElement: () => styleSink,
}
const listeners = new Map()
const window = { addEventListener: (name, fn) => listeners.set(name, fn) }
const build = (react) => new Function(
  'x', 'document', 'window', 'IntersectionObserver', 'Zm', 'DOMParser', 'Bb', 'm',
  runtimeSource + ';return { J2: J2, lazy: __dshMathLazy, render: __dshMathRender, cache: __dshMathPerfCache, queue: __dshMathQueue, prefetch: __dshMathPrefetch }',
)(react, document, window, IntersectionObserver, katex, DOMParser, convert, m)

// --- 1. memoized wrapper -------------------------------------------------
{
  const api = build(makeReact().x)
  const first = api.render('a+b', false)
  const second = api.render('a+b', false)
  if (renders !== 1) { console.error('FAIL: memo missed (' + renders + ' KaTeX calls)'); process.exit(1) }
  if (first !== second) { console.error('FAIL: memo returned a different array'); process.exit(1) }
  api.render('a+b', true)
  if (renders !== 2) { console.error('FAIL: display mode is not part of the key'); process.exit(1) }
  console.log('memo: one KaTeX call per (formula, display mode)')
}

// --- 2. math nodes mount the lazy component ------------------------------
let api
{
  renders = 0
  const react = makeReact()
  api = build(react.x)
  const nodes = api.J2('c^2', false)
  if (!Array.isArray(nodes) || nodes.length !== 1 || nodes[0].type !== api.lazy) {
    console.error('FAIL: J2 did not return a lazy component element')
    process.exit(1)
  }
  if (renders !== 0) { console.error('FAIL: formula rendered eagerly during render'); process.exit(1) }
  console.log('lazy: math node mounts the placeholder component, KaTeX not called during render')

  // first render of the component: placeholder
  const placeholder = api.lazy({ tex: 'c^2', displayMode: false })
  if (placeholder.type !== 'span' || placeholder.props.className !== 'dsh-math-pending') {
    console.error('FAIL: expected the pending placeholder, got ' + JSON.stringify(placeholder).slice(0, 120))
    process.exit(1)
  }
  // React attaches the ref before effects run; mirror that here.
  placeholder.props.ref.current = { marker: 'placeholder' }
  react.effects[0]()
  if (observed.size !== 1) { console.error('FAIL: placeholder was not observed'); process.exit(1) }
  // the observer reports it near the viewport -> state flips -> real render
  observerCallback([{ isIntersecting: true, target: [...observed.keys()][0] }])
  if (react.state.value !== true) { console.error('FAIL: intersection did not hydrate'); process.exit(1) }
  const hydrated = api.lazy({ tex: 'c^2', displayMode: false })
  if (hydrated.props.className !== 'dsh-math-live' || renders !== 1) {
    console.error('FAIL: hydrated render did not produce the fading formula wrapper')
    process.exit(1)
  }
  console.log('lazy: placeholder -> observed -> single KaTeX render inside the fade wrapper')
}

// --- 3. already-cached formulas start hydrated ---------------------------
{
  renders = 0
  const react = makeReact()
  const api2 = build(react.x)
  api2.render('d^2', false)
  const startRenders = renders
  const component = api2.lazy({ tex: 'd^2', displayMode: false })
  if (component.props.className !== 'dsh-math-live') { console.error('FAIL: cached formula started as a placeholder'); process.exit(1) }
  if (renders !== startRenders) { console.error('FAIL: cached formula re-rendered KaTeX'); process.exit(1) }
  console.log('lazy: a cached formula renders immediately from the memo')
}

// --- 4. beforeprint hydrates everything pending --------------------------
{
  renders = 0
  const react = makeReact()
  const api3 = build(react.x)
  const placeholder = api3.lazy({ tex: 'e^2', displayMode: true })
  if (placeholder.props.className !== 'dsh-math-pending') { console.error('FAIL: expected a placeholder'); process.exit(1) }
  placeholder.props.ref.current = { marker: 'print-placeholder' }
  react.effects[0]()
  const flush = listeners.get('beforeprint')
  if (flush === undefined) { console.error('FAIL: no beforeprint listener'); process.exit(1) }
  flush()
  if (react.state.value !== true) { console.error('FAIL: beforeprint did not hydrate pending math'); process.exit(1) }
  console.log('print: pending formulas hydrate before printing')
}

// --- 5. idle prefetch hydrates the queued placeholders --------------------
{
  renders = 0
  const react = makeReact()
  const api3 = build(react.x)
  const placeholder = api3.lazy({ tex: 'q1', displayMode: false })
  placeholder.props.ref.current = { marker: 'queued' }
  react.effects[0]()
  if (api3.queue.length !== 1) {
    console.error('FAIL: the placeholder did not join the prefetch queue (' + api3.queue.length + ')')
    process.exit(1)
  }
  api3.prefetch()
  if (react.state.value !== true) {
    console.error('FAIL: the idle prefetch did not hydrate the queued formula')
    process.exit(1)
  }
  console.log('prefetch: idle pass hydrates queued formulas from the tail upwards')
}
console.log('OK: lazy math patch verified')
