#!/usr/bin/env node
/**
 * dsh-math-perf command line.
 *
 * The Desktop shell serves the SPA out of app.asar, so the plugin's Web-server
 * route never reaches its window: a Desktop install also needs the archive
 * rewritten. This forwards to tools/patch-asar.mjs.
 *
 *   dsh-math-perf patch [--asar <path>] [--dry-run]
 *   dsh-math-perf restore [--asar <path>]
 *   dsh-math-perf extract <file> [--asar <path>]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tool = join(here, '..', 'tools', 'patch-asar.mjs')

const HELP = `dsh-math-perf — render math and code only near the viewport

Usage:
  dsh-math-perf patch [--asar <path>] [--dry-run]   rewrite the installed app.asar
  dsh-math-perf restore [--asar <path>]             restore the archive backup
  dsh-math-perf extract <file> [--asar <path>]      write the shipped bundle out

The archive is found automatically; --asar or DSH_DESKTOP_APP_ASAR overrides it.
Restart DeepSeek Harness after patching. A DSH update replaces app.asar, so run
patch again afterwards.`

const args = process.argv.slice(2)
const command = args[0]

if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  console.log(HELP)
  process.exit(0)
}

let forwarded
if (command === 'patch') forwarded = args.slice(1)
else if (command === 'restore') forwarded = ['--restore', ...args.slice(1)]
else if (command === 'extract') {
  const target = args[1]
  if (target === undefined || target.startsWith('--')) {
    console.error('extract needs an output file: dsh-math-perf extract <file>')
    process.exit(2)
  }
  forwarded = ['--extract', target, ...args.slice(2)]
} else {
  console.error('unknown command: ' + command + '\n')
  console.error(HELP)
  process.exit(2)
}

const result = spawnSync(process.execPath, [tool, ...forwarded], { stdio: 'inherit' })
process.exit(result.status === null ? 1 : result.status)
