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

export type Dispatched = { output?: HookOutput; text?: string; stderr?: string; exitCode: number }

/**
 * `event` is the hook event name, or a skill command (`health`, `map`). The last two arguments are
 * the shared entry point's (cli/hook.ts): FlowKy Pro uses them, this plugin has no need of them.
 */
export async function dispatch(io: Io, event: string, input: HookInput, runtime: string, _wait?: (ms: number) => Promise<void>, _args: string[] = []): Promise<Dispatched> {
  switch (event) {
    case 'SessionStart':
      // May run before the folder is trusted: only the project's ignored state folder is written.
      return { output: await onSessionStart({ ...io, beforeTrust: true }, input), exitCode: 0 }
    case 'Stop':
      return { output: await onStopContext(io, input, HANDOFF_COMMAND), exitCode: 0 }
    case 'health':
      return { text: await healthReport(io, projectRoot(io, input), { layer: 'baseline', runtime, sessionId: input.session_id }), exitCode: 0 }
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
