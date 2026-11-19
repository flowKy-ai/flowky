// Type-checks the sources with tsc, from the current folder (the plugin folder, or FlowKy Pro's
// assembled build). The mods API types (module 'claude-code') are written by Claude Code itself
// into .claude-plugin/types/ when it loads the plugin from a folder (claude --plugin-dir .); this
// script also accepts CLAUDE_CODE_TYPES=<path to claude-code.d.ts> and copies it there.
// TypeScript is found from the current folder upwards, so a build folder inside a checkout uses
// the checkout's own node_modules.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const target = '.claude-plugin/types/claude-code/index.d.ts'
if (process.env.CLAUDE_CODE_TYPES) {
  mkdirSync('.claude-plugin/types/claude-code', { recursive: true })
  copyFileSync(process.env.CLAUDE_CODE_TYPES, target)
}
if (!existsSync(target)) {
  console.error(`${target} is missing: run "claude --plugin-dir ." once, or set CLAUDE_CODE_TYPES.`)
  process.exit(1)
}
const tsc = createRequire(join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc')
let status = 0
for (const project of ['tsconfig.json', 'tsconfig.node.json']) {
  const r = spawnSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit' })
  if (r.status !== 0) status = 1
}
process.exit(status)
