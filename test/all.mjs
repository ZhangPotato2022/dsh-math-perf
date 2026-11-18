/**
 * Run every check that needs the installed application, in one go.
 *
 *   node test/all.mjs
 *
 * Spawns the checks under the Electron binary in Node mode, which is what gives
 * them an asar-aware fs. Set DSH_EXE / DSH_BUNDLE to point elsewhere.
 */
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const exe = process.env.DSH_EXE ?? 'D:/DeepSeek Harness/DeepSeek Harness.exe'
// The installed archive is patched in place, so the checks need the shipped
// bundle: write it out of the backup archive first.
const bundle = process.env.DSH_BUNDLE ?? join(tmpdir(), 'dsh-math-perf-shipped-bundle.js')
if (process.env.DSH_BUNDLE === undefined) {
  const extracted = spawnSync(process.execPath, [join(here, '..', 'tools', 'patch-asar.mjs'), '--extract', bundle], { stdio: 'inherit' })
  if (extracted.status !== 0) {
    console.error('FAIL: could not extract the shipped bundle')
    process.exit(1)
  }
}

const runs = [
  ['patch semantics', [join(here, 'verify.mjs'), bundle]],
  ['render equivalence', [join(here, 'render-equivalence.mjs'), bundle]],
  ['route in the real install', [join(here, 'test-route.mjs')]],
  ['profile composition', [join(here, 'check-profile.mjs')]],
  ['plugin page inventory', [join(here, 'check-inventory.mjs')]],
]
let failed = 0
for (const [label, args] of runs) {
  console.log('\n=== ' + label + ' ===')
  const result = spawnSync(exe, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.status !== 0) failed += 1
}
if (failed > 0) {
  console.error('\n' + failed + ' check(s) failed')
  process.exit(1)
}
console.log('\nall checks passed')