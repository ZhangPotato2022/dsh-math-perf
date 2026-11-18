/**
 * Mirrors what Settings → Plugins reads for this plugin: the profile
 * dependency list, its installed metadata, its bundle declaration, and the
 * version-compatibility gate the manager applies before listing a bundle.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/check-inventory.mjs
 * Overridable: DSH_INSTALL_ROOT, DSH_PROFILE_DIR.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const installRoot = process.env.DSH_INSTALL_ROOT
  ?? 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const profileDir = process.env.DSH_PROFILE_DIR ?? 'C:/Users/ZMZ/.dsh/profiles/desktop'
const appBoot = await import(pathToFileURL(join(installRoot, 'dsh-app-boot/lib/index.js')).href)

const installAnchor = join(installRoot, 'dsh/package.json')
const inventory = appBoot.readProfilePlugins({ binName: 'dsh', profileDir, installAnchor })
const row = inventory.dependencies.find((entry) => entry.name === 'dsh-math-perf')
console.log('dependencies: ' + JSON.stringify(inventory.dependencies))
if (row === undefined) {
  console.error('FAIL: dsh-math-perf is not a profile dependency, so Settings → Plugins cannot list it')
  process.exit(1)
}
if (!row.bundle) { console.error('FAIL: the installed package declares no dsh.bundle.patch'); process.exit(1) }
if (!row.enabled) { console.error('FAIL: the package is not selected in dsh.profile.bundles'); process.exit(1) }
console.log('listed: name=' + row.name + ' version=' + row.version + ' bundle=' + row.bundle + ' enabled=' + row.enabled)

const packageDir = join(profileDir, 'node_modules', 'dsh-math-perf')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const exemptions = appBoot.readProfileVersionExemptions(profileDir)
const compatibility = appBoot.evaluatePluginCompatibility(manifest, exemptions)
if (compatibility !== undefined && !compatibility.exempted) {
  console.error('FAIL: the manager would refuse the bundle: ' + JSON.stringify(compatibility))
  process.exit(1)
}
console.log('compatibility: ' + (compatibility === undefined ? 'ok' : 'exempted'))
console.log('OK: Settings → Plugins lists this bundle as installed and enabled')
