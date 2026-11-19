// The Claude Code adapter of the guardrails: Claude Code's hook input becomes an AgentEvent, and
// a Decision becomes Claude Code's hook output. Every field name below is from the hooks
// reference (code.claude.com/docs/en/hooks, read 19 Nov 2026):
//
// Input
//   common: session_id ("Current session identifier"), cwd, hook_event_name; agent_id ("Unique
//     identifier for the subagent or in-process teammate the hook fires in": present only there,
//     so a sub-agent's failures are counted apart from the main thread's).
//   PreToolUse / PostToolUse / PostToolUseFailure: tool_name, tool_input. Write {file_path,
//     content}; Edit {file_path, old_string, new_string}; Bash and PowerShell {command,
//     run_in_background}. "For the file tools Write, Edit, and Read, tool_input.file_path is
//     always absolute" and "On Windows, the path arrives with backslash separators".
//     MultiEdit {file_path, edits[{old_string, new_string}]} is no longer in the reference; it is
//     still read for older Claude Code versions that have the tool. NotebookEdit's input is not
//     given in the reference: only its notebook_path is read, to count the change.
//   PostToolUse: "Runs immediately after a tool completes successfully."
//   PostToolUseFailure: error, is_interrupt. "For Bash and PowerShell, a command that ran and
//     exited produces a first line `Exit code N`, then any output the command produced";
//     "Key your hook on tool_name, is_interrupt, and the Exit code N first line".
//   UserPromptSubmit: prompt. SessionStart: source (startup, resume, clear, compact, fork).
// Output
//   deny -> hookSpecificOutput.permissionDecision "deny" + permissionDecisionReason
//     ("For "deny", shown to Claude"). "ask" is never used: its reason is "shown to the user".
//   contextForAgent -> hookSpecificOutput.additionalContext ("String added to Claude's context
//     alongside the tool result" / "alongside the error" / "at the start of the conversation").
//   messageForUser -> systemMessage ("Warning message shown to the user").
//   answerWithoutTurn -> UserPromptSubmit decision "block" + reason ("Shown to the user ... Not
//     added to context") with suppressOriginalPrompt.

import type { Io } from '../mods/io'
import type { AgentEvent, Decision, SessionSource, ToolCall } from '../mods/guardrails/events'
import { isEmpty } from '../mods/guardrails/events'
import { guardrailsOnEvent } from './guardrails'
import type { HookInput, HookOutput } from './session-start'
import { projectRoot } from './session-start'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The tool call as the core sees it. */
export function claudeTool(name: string, input: Record<string, unknown>): ToolCall {
  switch (name) {
    case 'Write':
      return { kind: 'write', path: str(input.file_path), content: str(input.content) }
    case 'Edit':
      return { kind: 'edit', path: str(input.file_path), edits: [{ before: str(input.old_string), after: str(input.new_string) }] }
    case 'MultiEdit':
      return {
        kind: 'edit',
        path: str(input.file_path),
        edits: (Array.isArray(input.edits) ? input.edits : []).slice(0, 100).map(e => ({ before: str(obj(e).old_string), after: str(obj(e).new_string) })),
      }
    case 'NotebookEdit':
      return { kind: 'notebook', path: str(input.notebook_path) }
    case 'Bash':
    case 'PowerShell':
      return { kind: 'shell', shell: name, command: str(input.command), background: input.run_in_background === true }
    case 'Read':
      return { kind: 'read', path: str(input.file_path) }
    default:
      return { kind: 'other', name: name.slice(0, 100) }
  }
}

/** Splits "Exit code N\n<output>" (the documented first line) from the output. */
export function splitExitCode(error: string): { exitCode?: number; output: string } {
  const m = /^Exit code (-?\d{1,6})[ \t]*(?:\r?\n|$)/.exec(error)
  return m ? { exitCode: Number(m[1]), output: error.slice(m[0].length) } : { output: error }
}

const SOURCES = new Set<SessionSource>(['startup', 'resume', 'clear', 'compact', 'fork'])

export function claudeEvent(io: Io, eventName: string, input: HookInput): AgentEvent | undefined {
  const where = {
    session: str(input.session_id) || 'unknown',
    agent: str(input.agent_id) || undefined,
    cwd: str(input.cwd) || projectRoot(io, input),
    root: projectRoot(io, input),
  }
  const tool = () => claudeTool(str(input.tool_name), obj(input.tool_input))
  switch (eventName) {
    case 'SessionStart':
      return { kind: 'sessionStart', source: SOURCES.has(input.source as SessionSource) ? (input.source as SessionSource) : 'startup', ...where }
    case 'PreToolUse':
      return { kind: 'beforeTool', tool: tool(), ...where }
    case 'PostToolUse': {
      // Older versions reported some failed commands here, with an exit code in the response.
      const r = obj(input.tool_response)
      const exit = typeof r.exit_code === 'number' ? r.exit_code : typeof r.exitCode === 'number' ? r.exitCode : undefined
      const failed = r.success === false || (exit !== undefined && exit !== 0)
      if (failed) return { kind: 'afterTool', tool: tool(), ok: false, exitCode: exit, error: str(r.error) || str(r.stderr), ...where }
      // PostToolUse for Bash: tool_response {stdout, stderr} (the reference's Bash output shape).
      const output = [str(r.stdout), str(r.stderr)].filter(Boolean).join('\n').slice(0, 200_000)
      return { kind: 'afterTool', tool: tool(), ok: true, output: output || undefined, ...where }
    }
    case 'PostToolUseFailure': {
      const { exitCode, output } = splitExitCode(str(input.error))
      return { kind: 'afterTool', tool: tool(), ok: false, error: output, exitCode, interrupted: input.is_interrupt === true, ...where }
    }
    case 'UserPromptSubmit':
      return { kind: 'promptSubmit', text: str(input.prompt), ...where }
    case 'Stop':
      return { kind: 'stop', ...where }
    default:
      return undefined
  }
}

export function claudeOutput(eventName: string, d: Decision): HookOutput {
  if (isEmpty(d)) return undefined
  const out: Record<string, unknown> = {}
  if (d.messageForUser) out.systemMessage = d.messageForUser
  if (eventName === 'UserPromptSubmit' && d.answerWithoutTurn) {
    return { decision: 'block', reason: d.answerWithoutTurn, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } }
  }
  const specific: Record<string, unknown> = { hookEventName: eventName }
  if (eventName === 'PreToolUse' && d.deny) {
    specific.permissionDecision = 'deny'
    specific.permissionDecisionReason = d.deny.reasonForAgent
  }
  if (d.contextForAgent) specific.additionalContext = d.contextForAgent
  if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific
  return Object.keys(out).length ? out : undefined
}

/** One Claude Code hook event through the guardrails. Never throws. */
export async function onClaudeGuardHook(io: Io, eventName: string, input: HookInput): Promise<HookOutput> {
  try {
    const ev = claudeEvent(io, eventName, input)
    if (!ev || ev.kind === 'sessionStart') return undefined
    return claudeOutput(eventName, await guardrailsOnEvent(io, ev))
  } catch {
    return undefined
  }
}

/** Two outputs for one event (a plugin's own hook and the guardrails): a deny or a block wins, texts are joined. */
export function mergeOutputs(a: HookOutput, b: HookOutput): HookOutput {
  if (!a) return b
  if (!b) return a
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  if (x.decision === 'block') return a
  if (y.decision === 'block') return b
  const hx = obj(x.hookSpecificOutput)
  const hy = obj(y.hookSpecificOutput)
  if (hx.permissionDecision === 'deny') return a
  if (hy.permissionDecision === 'deny') return { ...b, systemMessage: [x.systemMessage, y.systemMessage].filter(Boolean).join('\n') || undefined }
  const out: Record<string, unknown> = { ...x, ...y }
  const sys = [x.systemMessage, y.systemMessage].filter(m => typeof m === 'string' && m)
  if (sys.length) out.systemMessage = sys.join('\n')
  if (Object.keys(hx).length || Object.keys(hy).length) {
    const ctx = [hx.additionalContext, hy.additionalContext].filter(c => typeof c === 'string' && c)
    out.hookSpecificOutput = { ...hx, ...hy, ...(ctx.length ? { additionalContext: ctx.join('\n\n') } : {}) }
  }
  return out
}
