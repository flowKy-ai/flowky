// Entry point of every command hook and skill command (bundled to dist/hook.mjs).
//
//   node dist/hook.mjs <EventName|command>   JSON on stdin, as Claude Code sends it
//
// Contract with Claude Code: print one JSON object (or nothing) on stdout and
// exit 0. Any internal failure is swallowed: the hook then says nothing and
// the session goes on, so a broken plugin can never block a user's work.

import { dispatch } from '../hooks/baseline'
import type { HookInput } from '../hooks/session-start'
import { nodeIo } from './node-io'
import { extendIo } from './io-extension'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 2000)
    process.stdin.on('data', c => chunks.push(Buffer.from(c)))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
  })
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? ''
  const raw = await readStdin()
  let input: HookInput = {}
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {}
  } catch {
    input = {}
  }
  if (!input.cwd) input.cwd = process.cwd()
  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const args = process.argv.slice(3)
  // A person at a terminal: both ends are a TTY. The assistant's shell tool gives neither.
  let io = extendIo({ ...nodeIo(), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })
  // --read-only (the bench): the hook runs as usual but writes nothing in the project it replays.
  if (args.includes('--read-only')) {
    const refuse = async () => {
      throw new Error('read-only run')
    }
    io = { ...io, writeInside: refuse, copyInside: refuse, removeInside: refuse, createExclusive: refuse, beforeTrust: true }
  }
  const result = await dispatch(io, event, input, `Node ${process.version} on ${process.platform}`, wait, args.filter(a => a !== '--read-only'))
  if (result.output) process.stdout.write(JSON.stringify(result.output))
  else if (result.text) process.stdout.write(result.text + '\n')
  if (result.stderr) process.stderr.write(`${result.stderr}\n`)
  process.exitCode = result.exitCode
}

main().catch(() => {
  process.exitCode = 0
})
