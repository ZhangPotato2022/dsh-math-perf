/**
 * Compose the profile the way boot does and prove three things:
 *  - the plugin is a *bundle* of the profile (not a hand-edited patch row);
 *  - compatibility checks did not skip it;
 *  - the row its bundle patch inserts lands in the tree and its name resolves
 *    to a loadable module with the expected exports.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/check-profile.mjs
 * Overridable: DSH_INSTALL_ROOT, DSH_PROFILE_DIR.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const installRoot = process.env.DSH_INSTALL_ROOT
  ?? 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/ZMZ/.dsh/profiles/desktop'

const appBoot = await import(pathToFileURL(join(installRoot, 'dsh-app-boot/lib/index.js')).href)
const include = await import(pathToFileURL(join(installRoot, 'cordis-plugin-include/lib/index.js')).href)

const profile = appBoot.loadProfileDirectory('dsh', profileDir, join(installRoot, 'dsh/package.json'))
console.log('bundles: ' + profile.layers.map((layer) => layer.packageName).join(', '))
console.log('skipped: ' + JSON.stringify(profile.skippedBundles ?? []))

const bundle = profile.layers.find((layer) => layer.packageName === 'dsh-math-perf')
if (bundle === undefined) {
  console.error('FAIL: dsh-math-perf is not loaded as a profile bundle')
  process.exit(1)
}
if (!bundle.patchPaths.some((path) => path.endsWith('cordis.patch.yml'))) {
  console.error('FAIL: the bundle contributed no cordis.patch.yml: ' + bundle.patchPaths.join(', '))
  process.exit(1)
}
console.log('bundle layer: ' + bundle.packageDir + ' (' + bundle.patches.length + ' patch row(s))')

const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]
const tree = include.applyEntryPatches([], patches, (format, ...args) => console.log('patch warning: ' + format, ...args))
const rows = tree.filter((entry) => entry.id === 'math-perf')
if (rows.length !== 1) {
  console.error('FAIL: expected exactly one math-perf row, got ' + rows.length)
  process.exit(1)
}
console.log('row: ' + JSON.stringify(rows[0]))

const require = createRequire(join(profileDir, 'package.json'))
const plugin = await import(pathToFileURL(require.resolve('dsh-math-perf')).href)
if (plugin.name !== 'math-perf' || !plugin.inject?.includes('webServer') || typeof plugin.apply !== 'function') {
  console.error('FAIL: module exports are not a cordis plugin: ' + Object.keys(plugin).join(', '))
  process.exit(1)
}
console.log('module: name=' + plugin.name + ' inject=' + plugin.inject.join(',') + ' apply=' + typeof plugin.apply)
console.log('OK: bundle composition, compatibility, and module resolution verified')
