// The baseline layer's dispatcher: one entry point for every command hook the
// plugin declares in hooks/hooks.json, and for the commands its skills run.
// Pure: the Node driver (cli/hook.ts) supplies the Io and prints the result.

import type { Io } from '../mods/io'
import { onSessionStart, projectRoot } from './session-start'
import type { HookInput, HookOutput } from './session-start'
import { onStopContext } from './context-guard'
import { healthReport } from './health'
import { HANDOFF_COMMAND } from './identity'
import { refreshMap } from '../mods/project-map'
import { loadConfig } from '../mods/config'
import { onClaudeGuardHook } from './claude-adapter'
import { configDoctorCommand, retryCommand } from './guardrails'

export type Dispatched = { output?: HookOutput; text?: string; stderr?: string; exitCode: number }

/**
 * `event` is the hook event name, or a skill command (`health`, `map`). The last two arguments are
 * the shared entry point's (cli/hook.ts): FlowKy Pro uses both; this plugin uses the arguments for its commands.
 */
export async function dispatch(io: Io, event: string, input: HookInput, runtime: string, _wait?: (ms: number) => Promise<void>, args: string[] = []): Promise<Dispatched> {
  switch (event) {
    case 'SessionStart':
      // May run before the folder is trusted: only the project's ignored state folder is written.
      return { output: await onSessionStart({ ...io, beforeTrust: true }, input), exitCode: 0 }
    case 'Stop':
      return { output: await onStopContext(io, input, HANDOFF_COMMAND), exitCode: 0 }
    // The guardrails (duplicate guard, loop breaker, staleness line): hooks/guardrails.ts.
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'UserPromptSubmit':
      return { output: await onClaudeGuardHook(io, event, input), exitCode: 0 }
    // The same PostToolUse, under the name FlowKy Pro gives its own synchronous guardrail entry (its
    // PostToolUse entry runs the verifier in the background); accepted here so the shared tests run on both.
    case 'GuardPostToolUse':
      return { output: await onClaudeGuardHook(io, 'PostToolUse', input), exitCode: 0 }
    case 'config-doctor':
      return { text: await configDoctorCommand(io, projectRoot(io, input), args.includes('--json')), exitCode: 0 }
    case 'retry': {
      const i = args.indexOf('--session')
      const id = i >= 0 ? args[i + 1] : undefined
      return { text: await retryCommand(io, projectRoot(io, input), id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined), exitCode: 0 }
    }
    case 'health':
    {
      // The health skill passes `--session ${CLAUDE_SESSION_ID}`, so the report can say whether the mods layer runs in this session.
      const i = args.indexOf('--session')
      const id = i >= 0 && /^[A-Za-z0-9_-]{1,80}$/.test(args[i + 1] ?? '') ? args[i + 1] : typeof input.session_id === 'string' ? input.session_id : undefined
      return { text: await healthReport(io, projectRoot(io, input), { layer: 'baseline', runtime, sessionId: id }), exitCode: 0 }
    }
    case 'map': {
      const root = projectRoot(io, input)
      const { config } = await loadConfig(io, root)
      const r = await refreshMap(io, root, { budgetMs: config.map.timeBudgetMs, maxFiles: config.map.maxFiles })
      return { text: `Project map ${r.status}${r.reason ? ` (${r.reason})` : ''}:\n${r.text ?? ''}`, exitCode: 0 }
    }
    default:
      return { exitCode: 0 }
  }
}
