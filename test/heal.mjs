/**
 * The archive self-heal, tested without a DeepSeek Harness installation.
 *
 * A synthetic archive is built in the temporary directory: same on-disk layout
 * as a real app.asar, one entry holding the fixture bundle. healArchive() then
 * has to patch it through the same child process the plugin spawns at boot.
 *
 * Run with: node test/heal.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healArchive } from '../index.js'

const PAD = 'x'.repeat(80)

/** Build the smallest archive the patcher accepts. */
function buildArchive(file, bundle) {
  const bytes = Buffer.from(bundle, 'utf8')
  const tree = {
    files: {
      dsh: {
        files: {
          node_modules: {
            files: {
              '@deepseek-ai': {
                files: {
                  'dsh-web-frontend': {
                    files: {
                      dist: {
                        files: {
                          assets: {
                            files: {
                              'index-test.js': {
                                size: bytes.length,
                                offset: '0',
                                integrity: {
                                  algorithm: 'SHA256',
                                  hash: 'a'.repeat(64),
                                  blockSize: 4194304,
                                  blocks: ['a'.repeat(64)],
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
  // The patcher rewrites the header in place and refuses to grow it, so a real
  // archive carries slack between the JSON and the file data; mimic that with
  // trailing spaces inside the declared header length.
  const json = Buffer.from(JSON.stringify(tree) + ' '.repeat(256), 'utf8')
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(8 + json.length, 4)
  header.writeUInt32LE(json.length, 8)
  header.writeUInt32LE(json.length, 12)
  writeFileSync(file, Buffer.concat([header, json, bytes]))
  return json.length
}

/** Read the one entry back, the way the patcher would. */
function readEntry(file) {
  const raw = readFileSync(file)
  const payloadSize = raw.readUInt32LE(4)
  const jsonLength = raw.readUInt32LE(12)
  const header = JSON.parse(raw.subarray(16, 16 + jsonLength).toString('utf8'))
  const entry = header.files.dsh.files.node_modules.files['@deepseek-ai'].files['dsh-web-frontend']
    .files.dist.files.assets.files['index-test.js']
  const dataStart = 8 + payloadSize
  return raw.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + Number(entry.size))
}

const work = mkdtempSync(join(tmpdir(), 'dsh-math-perf-heal-'))
// Not named ".asar": when this suite runs under Electron, a path ending in
// ".asar" is intercepted by the asar-aware fs and cannot be written as a file.
const archive = join(work, 'app.bin')
const fixture = readFileSync(new URL('./fixture-bundle.js', import.meta.url))
buildArchive(archive, fixture.toString('utf8') + '\n// ' + PAD + '\n')

process.env.DSH_DESKTOP_APP_ASAR = archive
const notes = []
const warn = (message) => notes.push(String(message))

const first = await healArchive(warn)
if (first !== 'patched') {
  console.error('FAIL: healArchive did not patch a replaced archive (' + first + '); log: ' + notes.join(' | '))
  process.exit(1)
}
if (!readEntry(archive).toString('utf8').includes('__dshMathPerfCache')) {
  console.error('FAIL: the archive entry does not carry the patch after healing')
  process.exit(1)
}
console.log('heal: a replaced archive is patched on boot')

const second = await healArchive(warn)
if (second !== 'current') {
  console.error('FAIL: a second boot patched an already patched archive (' + second + ')')
  process.exit(1)
}
console.log('heal: a second boot is a no-op')

process.env.DSH_MATH_PERF_NO_ASAR = '1'
const disabled = await healArchive(warn)
if (disabled !== 'disabled') {
  console.error('FAIL: DSH_MATH_PERF_NO_ASAR did not disable healing (' + disabled + ')')
  process.exit(1)
}
console.log('heal: DSH_MATH_PERF_NO_ASAR=1 disables it')

delete process.env.DSH_MATH_PERF_NO_ASAR
// An explicit archive that is not there must be reported, never thrown: the test
// never lets the auto-detection reach the machine's real installation.
process.env.DSH_DESKTOP_APP_ASAR = join(work, 'missing.asar')
const absent = await healArchive(warn)
if (absent !== 'failed') {
  console.error('FAIL: a missing archive was not reported (' + absent + ')')
  process.exit(1)
}
console.log('heal: a missing archive is reported, not thrown')

console.log('OK: archive self-healing verified')