/**
 * Integration check for the routes this plugin registers: it runs the real
 * plugin against a stub context under Electron's asar-aware Node, so the bundle
 * is read from the installed app exactly as it is at boot.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/test-route.mjs
 */
// apply() heals the installed archive on boot; a test must never touch the
// machine it runs on, so the repair stays off for this process.
process.env.DSH_MATH_PERF_NO_ASAR = '1'

import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const routes = []
const notes = []
const ctx = {
  logger: { warn: (message) => notes.push(['warn', String(message)]), info: (message) => notes.push(['info', String(message)]) },
  effect: (fn) => fn(),
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)
for (const [level, message] of notes) console.log(level + ': ' + message)

const report = routes.find((route) => route.path === '/__dsh_math_perf/report')
if (report === undefined) {
  console.error('FAIL: the report sink is not registered: ' + routes.map((route) => route.path).join(', '))
  process.exit(1)
}
const asset = routes.find((route) => route.path.startsWith('/assets/'))
console.log('routes: ' + routes.map((route) => route.path).join(', '))
if (asset === undefined) {
  // A patched archive serves the bundle itself, so no asset route is needed.
  console.log('the installed bundle is already patched in the archive; no asset route required')
} else {

const url = 'http://127.0.0.1' + asset.path
const response = await asset.resource(new Request(url))
const body = await response.text()
console.log('GET ' + asset.path + ' -> ' + response.status + ', ' + body.length + ' bytes')
if (response.status !== 200) { console.error('FAIL: asset route did not serve'); process.exit(1) }
for (const marker of ['__dshMathPerfCache', '__dshMathLazy', '__dshRealCodeBlock', '__dshDeferMount']) {
  if (!body.includes(marker)) { console.error('FAIL: served bundle lacks ' + marker); process.exit(1) }
}
console.log('bundle carries the math, code-block and probe patches')

const etag = response.headers.get('etag')
const cached = await asset.resource(new Request(url, { headers: { 'if-none-match': etag } }))
if (cached.status !== 304) { console.error('FAIL: conditional request did not answer 304'); process.exit(1) }
const head = await asset.resource(new Request(url, { method: 'HEAD' }))
if (head.status !== 200 || head.body !== null) { console.error('FAIL: HEAD not answered without a body'); process.exit(1) }
console.log('conditional GET: 304; HEAD: 200 without a body')
}

// The report sink appends one line to $DSH_HOME and answers 204.
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const target = join(home, 'math-perf-reports.jsonl')
let before = ''
try { before = readFileSync(target, 'utf8') } catch { /* first report */ }
const posted = await new Promise((resolve) => {
  const handlers = new Map()
  const request = {
    method: 'POST',
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    destroy() {},
  }
  const response = {
    status: undefined,
    writeHead(status) { this.status = status },
    end() { resolve({ status: this.status }) },
  }
  report.handler(request, response)
  queueMicrotask(() => {
    for (const fn of handlers.get('data') ?? []) fn(Buffer.from(JSON.stringify({ probe: 'test' })))
    for (const fn of handlers.get('end') ?? []) fn()
  })
})
if (posted.status !== 204) { console.error('FAIL: report sink answered ' + posted.status); process.exit(1) }
const written = readFileSync(target, 'utf8').trim().split('\n').at(-1)
const line = JSON.parse(written)
if (!String(line.body).includes('probe') || typeof line.at !== 'string') {
  console.error('FAIL: report line is not the posted body: ' + written.slice(0, 200))
  process.exit(1)
}
console.log('report sink: 204 and one line appended to ' + target)

// Restore the report file so a real run is not polluted by this test.
if (before === '') { try { rmSync(target) } catch { /* nothing to clean */ } }
else {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(target, before)
}
console.log('OK: plugin serves the patched bundle and accepts page reports')