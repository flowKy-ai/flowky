# Changelog

## 0.4.0

The four guardrails, in the shared core (FlowKy Pro runs the same code):

- Duplicate guard: a symbol index the plugin builds itself at session start (TypeScript and
  JavaScript, Python, Go, Rust; incremental; 2.5 s budget; `.flowky/cache/index/`), and a
  PreToolUse check on Write, Edit and MultiEdit that pauses a write once when it defines a name
  already defined in another file, with that file, line and first line. The same write sent again
  passes. `note` mode: context only.
- Loop breaker: failed Bash and PowerShell commands are counted from PostToolUseFailure, per session
  and per sub-agent; the third identical failure gives Claude the real error; the next identical run
  is paused once. Reset: success, a change of the project, `/flowky:retry` or the message
  `flowky retry`.
- Staleness line: the extension's committed map generated at another commit than HEAD, a partial
  index, and HEAD moving during a session, each said in one line; silent otherwise.
- Config doctor: `/flowky:config-doctor`, the extension's nine checks plus ten more; diagnoses only.
- New hook events: UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure. A project that
  still wires the FlowKy VS Code extension's old guard hook keeps the plugin's guardrails quiet,
  and the doctor and the health check say how to remove it.
- `.flowky/config.json` gets a `guardrails` section that can only make them quieter.
- Faster tree scan (file sizes read 32 at a time).

## 0.3.0

First release under the FlowKy name. The code comes from Autopilot Lite 0.2.2, an MIT plugin by the
same author, after two independent security reviews and the fixes that followed them; this history
starts again here, and the earlier one is not carried over. What changed from 0.2.2:

- Names: catalogue `flowky`, plugin `flowky`, skills `/flowky:map`, `/flowky:health` (the former
  doctor), `/flowky:handoff` and `/flowky:project-map`; the mods command is `/flowky`.
- Places: project state in `.flowky/cache/` (with its own `.gitignore` containing `*`, written
  first), project settings in `.flowky/config.json`. The plugin writes nothing else in `.flowky/`,
  which the FlowKy VS Code extension also uses.
- Move from the former name: at the first session start, old state in `.claude/autopilot/` is
  copied only when it carries a machine stamp (this plugin's never did, so nothing is copied), and
  nothing is deleted. The health check lists what is left as old Autopilot state, safe to delete.
- The health check also warns when FlowKy and FlowKy Pro are enabled together, and carries the
  independence notice.
- One shared core: the files listed in `core.json` are the only copy of the code FlowKy Pro also
  runs.
- Tests: the plugin suites are grouped in two test files; new tests for the move, the cache-only
  rule in a project that holds the extension's files, the FlowKy folder rules, the core contract
  and a network-free bundle.
