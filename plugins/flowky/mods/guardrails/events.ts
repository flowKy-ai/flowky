// The guardrails' view of the world: normalised events in, normalised decisions out
// (spec section 3.3). Nothing in mods/guardrails/ names a Claude Code tool, reads a
// Claude Code variable or prints hook JSON: an adapter (hooks/claude-adapter.ts for
// Claude Code; a second one in the tests) maps an agent's hook input to an AgentEvent
// and a Decision back to that agent's output.

/** One edit of a file: the text replaced and the text that replaces it. */
export type TextEdit = { before: string; after: string }

export type ToolCall =
  /** A whole file written (created or overwritten). */
  | { kind: 'write'; path: string; content: string }
  /** One or more replacements in an existing file. */
  | { kind: 'edit'; path: string; edits: TextEdit[] }
  /** A notebook cell changed: counted as a change of the project, not read for definitions. */
  | { kind: 'notebook'; path: string }
  /**
   * A shell command. `shell` is the agent's own name for the shell tool, used only to tell two
   * shells apart in a failure fingerprint; the core never compares it with a fixed name.
   */
  | { kind: 'shell'; shell: string; command: string; background: boolean }
  | { kind: 'read'; path: string }
  | { kind: 'other'; name: string }

type Where = {
  /** The agent's session id. */
  session: string
  /** A sub-agent's own id when the agent says the event comes from one; absent for the main thread. */
  agent?: string
  /** The folder the event happened in (a shell command's working folder). */
  cwd: string
  /** The project root: where the session started. */
  root: string
}

export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork'

export type AgentEvent =
  | ({ kind: 'sessionStart'; source: SessionSource } & Where)
  | ({ kind: 'beforeTool'; tool: ToolCall } & Where)
  | ({
      kind: 'afterTool'
      tool: ToolCall
      ok: boolean
      /** The error text the agent received (output of a failed command), without the agent's own framing. */
      error?: string
      /** The output of a command that the shell reported as a success (read only to find a printed exit status). */
      output?: string
      exitCode?: number
      /** The failure was an abort or a cancellation, not an error the tool reported. */
      interrupted?: boolean
    } & Where)
  | ({ kind: 'promptSubmit'; text: string } & Where)
  | ({ kind: 'stop' } & Where)

export type Decision = {
  /** Text the model reads next to the tool result (or at the start of the session). */
  contextForAgent?: string
  /** One line shown to the person, never to the model. */
  messageForUser?: string
  /** The tool call does not run; the model reads the reason. */
  deny?: { reasonForAgent: string }
  /** A whole-message order answered by the plugin: the prompt ends here, with no model turn. */
  answerWithoutTurn?: string
}

export const NOTHING: Decision = {}

export function isEmpty(d: Decision | undefined): boolean {
  return !d || (!d.contextForAgent && !d.messageForUser && !d.deny && !d.answerWithoutTurn)
}

/** Several decisions for one event: a deny or an answer wins; texts are joined. */
export function combine(...ds: (Decision | undefined)[]): Decision {
  const out: Decision = {}
  const ctx: string[] = []
  const msg: string[] = []
  for (const d of ds) {
    if (!d) continue
    if (d.contextForAgent) ctx.push(d.contextForAgent)
    if (d.messageForUser) msg.push(d.messageForUser)
    if (d.deny && !out.deny) out.deny = d.deny
    if (d.answerWithoutTurn && !out.answerWithoutTurn) out.answerWithoutTurn = d.answerWithoutTurn
  }
  if (ctx.length) out.contextForAgent = ctx.join('\n\n')
  if (msg.length) out.messageForUser = msg.join('\n')
  return out
}
