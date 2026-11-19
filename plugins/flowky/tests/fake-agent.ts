// A second, fake coding agent for the guardrail tests (spec 3.3): its hook input and output look
// nothing like Claude Code's (its own event names, tool names and field names, an exit code as a
// number, a deny as a top-level decision). Its adapter maps them to the core's AgentEvent and back.
// If the core depended on a Claude Code field name, the scenarios run through this agent would fail.

import type { AgentEvent, Decision, ToolCall } from '../mods/guardrails/events'
import { guardrailsAtStart, guardrailsOnEvent } from '../hooks/guardrails'
import type { Io } from '../mods/io'

export type FakeInput = {
  event: 'Begin' | 'ToolWillRun' | 'ToolDidRun' | 'UserSaid'
  sid: string
  worker?: string
  dir: string
  workspace: string
  how?: 'new' | 'again' | 'squash'
  action?: { name: 'put_file' | 'patch_file' | 'exec' | 'look'; args: Record<string, unknown> }
  result?: { failed: boolean; code?: number; text?: string; aborted?: boolean }
  words?: string
}

export type FakeOutput = { verdict?: 'refuse'; why?: string; note?: string; toast?: string; handled?: string }

function toolOf(a: FakeInput['action']): ToolCall {
  const args = a?.args ?? {}
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (a?.name) {
    case 'put_file':
      return { kind: 'write', path: s('target'), content: s('body') }
    case 'patch_file':
      return { kind: 'edit', path: s('target'), edits: [{ before: s('from'), after: s('to') }] }
    case 'exec':
      return { kind: 'shell', shell: s('interpreter') || 'sh', command: s('line'), background: args.detached === true }
    case 'look':
      return { kind: 'read', path: s('target') }
    default:
      return { kind: 'other', name: String(a?.name ?? '') }
  }
}

export function fakeEvent(i: FakeInput): AgentEvent | undefined {
  const where = { session: i.sid, agent: i.worker, cwd: i.dir, root: i.workspace }
  switch (i.event) {
    case 'Begin':
      return { kind: 'sessionStart', source: i.how === 'squash' ? 'compact' : i.how === 'again' ? 'resume' : 'startup', ...where }
    case 'ToolWillRun':
      return { kind: 'beforeTool', tool: toolOf(i.action), ...where }
    case 'ToolDidRun':
      return { kind: 'afterTool', tool: toolOf(i.action), ok: !i.result?.failed, error: i.result?.text, exitCode: i.result?.code, interrupted: i.result?.aborted, ...where }
    case 'UserSaid':
      return { kind: 'promptSubmit', text: i.words ?? '', ...where }
  }
}

export function fakeOutput(d: Decision): FakeOutput {
  const o: FakeOutput = {}
  if (d.deny) {
    o.verdict = 'refuse'
    o.why = d.deny.reasonForAgent
  }
  if (d.contextForAgent) o.note = d.contextForAgent
  if (d.messageForUser) o.toast = d.messageForUser
  if (d.answerWithoutTurn) o.handled = d.answerWithoutTurn
  return o
}

export async function fakeHook(io: Io, input: FakeInput): Promise<FakeOutput> {
  const ev = fakeEvent(input)
  if (!ev) return {}
  return fakeOutput(ev.kind === 'sessionStart' ? await guardrailsAtStart(io, ev) : await guardrailsOnEvent(io, ev))
}
