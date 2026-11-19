// Runs the Claude Code CLI that has plugin and mod support (named host.mjs so that no file name
// carries the vendor's name): CLAUDE_BIN if set,
// else the binary bundled in the VS Code extension (newest), else `claude` on PATH.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function find() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  for (const root of ['.vscode', '.vscode-insiders', '.cursor']) {
    const ext = join(homedir(), root, 'extensions')
    if (!existsSync(ext)) continue
    const dirs = readdirSync(ext).filter(d => d.startsWith('anthropic.claude-code-')).sort()
    for (const d of dirs.reverse()) {
      for (const name of ['claude.exe', 'claude']) {
        const p = join(ext, d, 'resources', 'native-binary', name)
        if (existsSync(p)) return p
      }
    }
  }
  return 'claude'
}

const bin = find()
const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' })
if (r.error) {
  console.error(`could not run ${bin}: ${r.error.message}. Set CLAUDE_BIN to a Claude Code binary with mod support.`)
  process.exit(1)
}
process.exit(r.status ?? 1)
