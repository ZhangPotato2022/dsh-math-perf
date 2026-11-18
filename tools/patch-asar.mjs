/**
 * Read or rewrite the SPA bundle inside the installed app.asar.
 *
 * The Desktop shell answers "/", "/index.html" and "/assets/*" straight from
 * app.asar (lib/main.js -> serveWebDocument), so a Web-server route can never
 * reach its window. This rewrites the archive instead.
 *
 * Archive layout:
 *   [u32 4][u32 payloadSize][u32 paddedSize][u32 jsonLength][json][padding][data...]
 *
 * The rewrite appends the patched bundle past the current end of the file and
 * moves that one header entry to it (re-hashed), keeping the JSON region the
 * same size so every other entry keeps its offset. Appending happens before the
 * header move: an interrupted run leaves a valid archive.
 *
 * The bundle is located by content, not by its hashed filename, so a DSH update
 * that renames the asset still works.
 *
 * Usage:
 *   node tools/patch-asar.mjs                 # patch the installed archive
 *   node tools/patch-asar.mjs --dry-run
 *   node tools/patch-asar.mjs --extract <file># write the shipped (unpatched) bundle out
 *   node tools/patch-asar.mjs --restore       # copy the archive backup back
 *   node tools/patch-asar.mjs --asar <path>   # explicit archive path
 *
 * The archive is found automatically when --asar is omitted; DSH_DESKTOP_APP_ASAR
 * overrides the search.
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { patchBundle } from '../index.js'

const BACKUP_SUFFIX = '.bak-mathperf'
const MARKER = '__dshMathPerfCache'
const BUNDLE_MARKER = 'new DOMParser().parseFromString('

/** Every location a packaged Desktop install is known to use. */
function candidateArchives() {
  const candidates = []
  const fromEnv = process.env.DSH_DESKTOP_APP_ASAR
  if (fromEnv !== undefined && fromEnv !== '') candidates.push(fromEnv)
  if (process.env.DSH_INSTALL_DIR) {
    // <root>/dsh/node_modules/@deepseek-ai/dsh -> <root>/../app.asar
    candidates.push(join(process.env.DSH_INSTALL_DIR, '..', '..', '..', '..', 'app.asar'))
  }
  const exeDir = process.execPath === '' ? undefined : process.execPath.replace(/[\\/][^\\/]+$/u, '')
  if (exeDir !== undefined) candidates.push(join(exeDir, 'resources', 'app.asar'))
  const home = homedir()
  if (platform() === 'win32') {
    candidates.push(join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push('C:/Program Files/DeepSeek Harness/resources/app.asar')
    candidates.push('D:/DeepSeek Harness/resources/app.asar')
  } else if (platform() === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
    candidates.push(join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'))
  } else {
    candidates.push(join(home, '.local', 'share', 'DeepSeek Harness', 'resources', 'app.asar'))
    candidates.push('/opt/DeepSeek Harness/resources/app.asar')
  }
  return candidates
}

function locateArchive(explicit) {
  if (explicit !== undefined) {
    if (!existsSync(explicit)) throw new Error('no archive at ' + explicit)
    return explicit
  }
  for (const candidate of candidateArchives()) if (candidate !== undefined && existsSync(candidate)) return candidate
  throw new Error('cannot find the DeepSeek Harness app.asar; pass --asar <path> or set DSH_DESKTOP_APP_ASAR')
}

function arg(name, fallback) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done)
    if (read <= 0) throw new Error('short read at ' + position)
    done += read
  }
  return buffer
}

/** Parse one archive header and index the candidate bundles inside it. */
function openArchive(file) {
  const fd = openSync(file, 'r')
  const prefix = readAt(fd, 0, 16)
  const payloadSize = prefix.readUInt32LE(4)
  const jsonLength = prefix.readUInt32LE(12)
  const jsonStart = 16
  const dataStart = 8 + payloadSize
  if (jsonStart + jsonLength > dataStart) throw new Error('unexpected archive layout in ' + file)
  const header = JSON.parse(readAt(fd, jsonStart, jsonLength).toString('utf8'))
  return { file, fd, header, jsonStart, jsonLength, dataStart }
}

function bundleEntries(archive) {
  const assets = archive.header?.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files?.['dsh-web-frontend']?.files?.dist?.files?.assets?.files
  if (assets === undefined) return []
  return Object.entries(assets)
    .filter(([name, entry]) => name.endsWith('.js') && entry.files === undefined)
    .map(([name, entry]) => ({ name, entry }))
}

function readEntry(archive, entry) {
  return readAt(archive.fd, archive.dataStart + Number(entry.offset), Number(entry.size))
}

/** The shipped bundle: the one that still carries the KaTeX pipeline. */
function findShipped(archive) {
  for (const candidate of bundleEntries(archive)) {
    const bytes = readEntry(archive, candidate.entry)
    const text = bytes.toString('utf8')
    if (!text.includes(BUNDLE_MARKER)) continue
    return { name: candidate.name, entry: candidate.entry, bytes, patched: text.includes(MARKER) }
  }
  return undefined
}

const dryRun = process.argv.includes('--dry-run')

if (process.argv.includes('--restore')) {
  const archivePath = locateArchive(arg('--asar', undefined))
  const backupPath = archivePath + BACKUP_SUFFIX
  if (!existsSync(backupPath)) {
    console.error('FAIL: no backup at ' + backupPath)
    process.exit(1)
  }
  copyFileSync(backupPath, archivePath)
  console.log('restored ' + archivePath)
  process.exit(0)
}

const asarPath = locateArchive(arg('--asar', undefined))
const backupPath = asarPath + BACKUP_SUFFIX

const extractTo = arg('--extract', undefined)
if (extractTo !== undefined) {
  for (const candidate of [backupPath, asarPath]) {
    if (!existsSync(candidate)) continue
    const archive = openArchive(candidate)
    const shipped = findShipped(archive)
    closeSync(archive.fd)
    if (shipped === undefined || shipped.patched) continue
    writeFileSync(extractTo, shipped.bytes)
    console.log('wrote ' + shipped.name + ' from ' + candidate + ' to ' + extractTo + ' (' + shipped.bytes.length + ' bytes)')
    process.exit(0)
  }
  console.error('FAIL: no unpatched bundle found in ' + asarPath + ' or ' + backupPath)
  process.exit(1)
}

// --- patch -----------------------------------------------------------------
const archive = openArchive(asarPath)
const current = findShipped(archive)
if (current === undefined) {
  console.error('FAIL: no client bundle inside ' + asarPath + ' (is this a DeepSeek Harness install?)')
  process.exit(1)
}
closeSync(archive.fd)
console.log('archive ' + asarPath + ' (' + current.name + ', ' + current.entry.size + ' bytes)')
console.log(current.patched ? 'already patched; the backup is the source' : 'unpatched')

let shipped = current.patched ? undefined : current
if (shipped === undefined && existsSync(backupPath)) {
  const backup = openArchive(backupPath)
  const fromBackup = findShipped(backup)
  closeSync(backup.fd)
  if (fromBackup !== undefined && !fromBackup.patched) shipped = fromBackup
}
if (shipped === undefined) {
  console.error('FAIL: no unpatched bundle to work from (missing ' + backupPath + ')')
  process.exit(1)
}

const patchedSource = patchBundle(shipped.bytes.toString('utf8'))
if (patchedSource === undefined) {
  console.error('FAIL: patchBundle refused this bundle (unexpected shape); nothing written')
  process.exit(1)
}
const patched = Buffer.from(patchedSource, 'utf8')
console.log('patched bundle: ' + shipped.bytes.length + ' -> ' + patched.length + ' bytes')

const appendAt = statSync(asarPath).size
current.entry.size = patched.length
current.entry.offset = String(appendAt - archive.dataStart)
current.entry.integrity = {
  algorithm: 'SHA256',
  hash: createHash('sha256').update(patched).digest('hex'),
  blockSize: 4194304,
  blocks: [createHash('sha256').update(patched).digest('hex')],
}

const rebuilt = Buffer.from(JSON.stringify(archive.header), 'utf8')
if (rebuilt.length > archive.jsonLength) {
  console.error('FAIL: header grew (' + rebuilt.length + ' > ' + archive.jsonLength + ')')
  process.exit(1)
}
const padded = Buffer.concat([rebuilt, Buffer.alloc(archive.jsonLength - rebuilt.length, 0x20)])
JSON.parse(padded.toString('utf8'))

if (dryRun) {
  console.log('dry run: nothing written')
  process.exit(0)
}

if (!existsSync(backupPath)) {
  console.log('backing up the archive to ' + backupPath)
  copyFileSync(asarPath, backupPath)
} else {
  console.log('backup kept at ' + backupPath)
}

const out = openSync(asarPath, 'r+')
writeSync(out, patched, 0, patched.length, appendAt)
writeSync(out, padded, 0, padded.length, archive.jsonStart)
closeSync(out)
console.log('patched in place. Restart DeepSeek Harness so the shell re-reads the archive.')
