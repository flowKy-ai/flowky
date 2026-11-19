# FlowKy for Claude Code

A map of your project at every session start, one clear hint before your context grows large, a
handoff summary so you can compact without losing work, four guardrails (a duplicate guard, a
three-strike loop breaker, a git staleness line and a configuration doctor), and a health check
that says what is running. The plugin makes no network request and no model call. MIT licence.

> FlowKy is an independent product. It is not affiliated with, endorsed or sponsored by Anthropic,
> or by the makers of the other tools named here. Claude and Claude Code are trademarks of
> Anthropic, PBC.

Status: version 0.4.0, an early version. There is no published benchmark and this README states no
savings figure. Tested on Claude Code 2.1.327 on Windows 11; other versions with plugin hooks should
work but have not been tested.

## What it does today

| Feature | What happens |
|---|---|
| Project map | At session start, a fast scan of the file tree (no model call, `.gitignore` respected, 1.5 s budget) writes `.flowky/cache/project-map.md`: stack, entry points, build, test and typecheck commands, key folders, 3D and UI modules, and the files too large or generated to read whole. It is rebuilt from the tree at every session start, because a copy on disk could have come from someone else, and added to Claude's context. `/flowky:map` rescans on demand; the `project-map` skill tells Claude to read the map before exploring. |
| Context hygiene and handoff | When Claude finishes a turn, the plugin reads the context size from the session's own usage records. Past a threshold (60k tokens by default) it shows you one hint and offers `/flowky:handoff`, which asks Claude for a technical summary (decisions, files touched, open items, next step) saved to `.flowky/cache/handoff.md`. You can then `/compact` or `/clear` and carry on. It never sends anything by itself. |
| Duplicate guard | Before Claude writes or edits a file that defines a function or class whose name is already defined in another file of the project, the write is paused once and Claude reads where the existing one is (file, line and its first line), to reuse or extend it. The same write sent again goes through: it asks once, it never blocks. Tests, generated and vendored files, re-exports, the file's own definitions, a rename in place and a name defined in five or more files are left alone. A `note` mode lets the write through at once and tells Claude the same facts. |
| Loop breaker | When the same shell command (Bash or PowerShell) fails three times in a row with the same error and nothing in the project changed in between, Claude reads the real error, quoted, and that running it unchanged will fail the same way. The next identical run is paused once; sent again, it runs. `/flowky:retry`, or the message `flowky retry` on its own, resets the count. |
| Staleness line | At session start, one line when the FlowKy VS Code extension's committed map (`.flowky/index`) was generated at another commit than HEAD (how many commits, which folders changed), or when the plugin's own index is still partial; during a session, one line when HEAD moves (a checkout or a pull). Silent otherwise. Local git data only. |
| Config doctor | `/flowky:config-doctor` checks your `CLAUDE.md` files, rules, skills, `AGENTS.md` and Claude Code settings: the nine checks of the FlowKy VS Code extension plus ten more (instructions lost after compaction, dead paths and commands, duplicates, a second copy of the guard...). It only diagnoses: every finding says what to change and where, and it changes nothing. Once a day, at session start, one line if it finds an error. |
| Health check | `/flowky:health` says what is active, what is off and why: config errors, a missing Node, which layer answered, the guardrails and their index, what the former name left behind, and whether two FlowKy plugins are enabled at once. |

## Coming

- FlowKy Pro, a separate plugin from flowky.ai. It is not on sale yet.

## Install

At the Claude Code prompt:

```text
/plugin marketplace add flowKy-ai/flowky
/plugin install flowky@flowky
```

From a shell: `claude plugin marketplace add flowKy-ai/flowky`, then
`claude plugin install flowky@flowky`. If a session is open, run `/reload-plugins`.

Requirement: Node.js 18 or later on `PATH`. The hooks are one small Node script, `dist/hook.mjs`,
with no dependencies, so nothing is installed. Without Node the hooks fail quietly
(`"onFailure": "continue"`) and your session is never blocked; the health skill needs Node too, so
run `node --version` in a terminal. Where the mods layer is active, `/flowky health` still answers
without Node and says that no hook has run.

## Works everywhere, better with mods

| | Any Claude Code with plugins (baseline) | With the mods API (enhanced) |
|---|---|---|
| Project map | the SessionStart hook writes it and adds it to the context | the same, plus `/flowky map` with no model turn |
| Context hint | at the end of each turn, from the transcript's usage rows, as a message to you | a live status line from `session.measure`, and one toast at the threshold |
| Handoff | the `/flowky:handoff` skill (one model turn: the summary itself) | `/flowky handoff` puts the request in your prompt box; it sends it only if `context.autoSubmit` asks for it AND you confirmed that yourself with `/flowky handoff auto on` |
| Health check | the `/flowky:health` skill (one short turn) | `/flowky health`, answered at once, with no model turn |
| Guardrails | command hooks: the same in both layers | the same |
| Config doctor, retry | the `/flowky:config-doctor` and `/flowky:retry` skills (one short turn) | `/flowky config-doctor` and `/flowky retry`, with no model turn |

The mods layer was tested on Claude Code 2.1.327. Where mods are unavailable or switched off by an
organisation, the baseline does all the work.

## Upgrading from Autopilot Lite 0.2.x

FlowKy is the new name of Autopilot Lite. At the first session start after the upgrade:

- the plugin looks at the old state folder `.claude/autopilot/`. Its files were display-only and
  carry no machine stamp, so none of them is trusted or copied: the new state is rebuilt at once;
- nothing is deleted. `/flowky:health` lists what the old name left behind (`.claude/autopilot/`,
  and `.claude/autopilot.json` if you had one) as old Autopilot state, safe to delete;
- an old `.claude/autopilot.json` is no longer read. Move what you need to `.flowky/config.json`
  yourself: the plugin never writes outside `.flowky/cache/`.

Uninstall the old plugin (`/plugin uninstall autopilot-lite@claude-autopilot-free`) so that its
hooks stop running beside these.

## Configuration

An optional file, `.flowky/config.json`, in your project; every key has a default:

```json
{
  "map": { "enabled": true, "timeBudgetMs": 1500, "maxFiles": 20000, "addToContext": true },
  "context": { "enabled": true, "thresholdTokens": 60000, "autoSubmit": false },
  "guardrails": {
    "duplicateGuard": { "mode": "pause-once", "ignore": [] },
    "loopBreaker": { "mode": "pause-once", "threshold": 3 },
    "staleness": true,
    "configDoctor": true
  }
}
```

Guardrails: each can be switched off (`false` or `"off"`); the duplicate guard and the loop breaker
can be set to `"note"` (Claude is told, nothing is paused); the loop breaker's threshold can be
raised up to 10; `ignore` lists names the duplicate guard never reports; `configDoctor: false` stops
the daily one-line summary (the command still works). Because this file can come with a repository
you clone, it can only make the guardrails quieter: nothing in it can lower the threshold below 3,
pause more than once, run a command, or put text of its own into Claude's context.

`autoSubmit` affects only the mods layer's `/flowky handoff`; the baseline never sends a prompt.
Because this file can come with a repository you clone, `autoSubmit: true` alone does nothing: the
request is sent only after you also typed `/flowky handoff auto on` yourself (Claude Code stamps the
command as yours; when a plugin or the model runs it, it is refused). That confirmation is kept in
the plugin's own store in your Claude folder, never in the project. A broken file never breaks a
session: the defaults apply and the health check says `BROKEN`.

## What it writes, and where

The FlowKy VS Code extension also uses the `.flowky/` folder of a project, and commits parts of it
on purpose (its index, audit and skills). This plugin therefore writes only inside
`.flowky/cache/`, never anywhere else in `.flowky/`, and never adds an ignore rule that would hide
the extension's files.

- `.flowky/cache/` holds the map, the handoff Claude writes with its own Write tool, small JSON
  state for the health check, the duplicate guard's symbol index (`index/`) and the guardrails'
  per-session state (`guard/`, kept at most 7 days and 30 sessions, 64 KB each). It carries its own `.gitignore` containing `*`, written before
  anything else, so none of it is committed by accident.
- Every write refuses a path outside the project and a symbolic link or junction on the way, and
  goes through a temporary file renamed over the target. A `.flowky/cache` folder or a `handoff.md`
  that is a link is removed at session start (the link, never what it points to). Two hook
  processes writing the same state take a short lock instead of overwriting each other.
- Names and texts from your repository (folder names, `package.json` fields) are stripped of control
  characters before they reach the map, and an entry point is listed only when it is a file.

Before workspace trust: a `claude -p` or SDK session never shows the trust dialog, and neither does
a folder under a trusted parent, so plugin hooks can run in a folder you never trusted. The
SessionStart hook therefore writes only inside the project's ignored `.flowky/cache/` folder.

## Privacy

- No network request, no model call and no telemetry from the plugin. A test fails the build if the
  shipped code imports a network module or opens a connection.
- The hooks start one program, git, looked up on `PATH`, never in the project folder: at session
  start `git rev-parse HEAD`, and when the extension's map exists `git rev-list --count` and
  `git diff --name-only` between two commits (2 s each, no fetch, no network, the stored commit
  accepted only as plain hex); the health check runs `git ls-files` to flag plugin files committed
  in the repository. Every git call switches off what a folder's own git configuration could make
  git run (file-system monitor, pager, hooks, external diff and text conversion, credential
  helpers, every transport, so no lazy fetch either), ignores inherited `GIT_*` variables, and
  never uses a git found inside the project folder.
- Every file the plugin reads from a project is read the same way: a plain file only (never through
  a symbolic link or junction, never a device or a pipe), size-capped, and inside the project by
  real path. Session start has one 8 s deadline shared by the map, the index, git and the doctor.
- The loop breaker keeps, per session in `.flowky/cache/guard/`, a digest of each failing command and
  the first error line of its output (at most 300 characters, so it can hold whatever the command
  printed there). That line is erased after 24 hours, the session file after 7 days (30 sessions
  at most); the folder is never committed and is safe to delete.
- The duplicate guard reads the source files of the project to index their top-level definitions,
  and, before it names one, the line of that file again. What reaches Claude is a file name, a line
  number, a name and that one line, stripped of control characters and cut short.
- The hooks read your file tree (names and sizes), small manifest files (`package.json`,
  `pyproject.toml`, `Cargo.toml` and similar), `.gitignore` files, the tail of the session transcript
  (only the usage numbers of the last answers), and the `enabledPlugins` lists of your Claude Code
  settings files.
- Check it yourself: `claude plugin validate <plugin folder>` lists the hooks and every call of the
  mods layer. `dist/hook.mjs` is built from the TypeScript in `cli/`, `hooks/` and `mods/` by
  `npm run build`, and `npm test` fails when `dist/` is stale.

## How to measure it on your own work

There is no published benchmark, so measure for yourself. Start two sessions on the same task, one
with the plugin disabled, and compare `/cost` (or `/usage`) and the number of `Read`, `Glob` and
`ls` calls before the first edit. For context hygiene, run `/context` before and after a handoff and
`/compact`.

## Limits

- The map is a heuristic: it reads manifests and file names, not code. A `PARTIAL scan` line means
  the time budget ran out on a very large tree; raise `map.timeBudgetMs`.
- In the baseline layer the context is measured when a turn ends, from the transcript, which Claude
  Code writes asynchronously, so the figure can lag by one request.
- Hooks cannot change the model or compact the conversation for you: the plugin only informs.
- The duplicate guard is lexical, not a parser. It indexes top-level definitions of TypeScript and
  JavaScript (exported functions, classes and arrow constants), Python (`def` and `class` at column
  0, not starting with `_`), Go (capitalised `func`, not methods) and Rust (`pub fn`, `pub struct`,
  `pub enum`, `pub trait`). Other languages are not indexed. It misses a definition spread over
  several lines before its name, one made by a macro or a decorator factory, and CommonJS
  `module.exports` exports; two unrelated exported functions with the same name in different
  modules are reported once, and the same write sent again goes through.
- The index is built at session start within 2.5 s (about 1.5 s for 10,000 files on the test
  machine), then incrementally from file sizes and times; a larger tree is finished over the next
  sessions.
- The loop breaker sees only what Claude runs: a fix made in your editor between two failures is not
  seen as a change (a different error still ends the streak).

## Development

The shared core of FlowKy and FlowKy Pro lives in this folder and is listed in `core.json`. FlowKy
Pro is built from a pinned commit of these files, so a change to a core file is a change to both.

```text
npm ci               # development tools only: esbuild, typescript
npm run build        # bundles cli/hook.ts into dist/hook.mjs
npm test             # stale-build check, Node end-to-end tests, then `claude plugin test`
npm run test:node    # the same without Claude Code (what CI runs)
npm run typecheck    # needs the mods API types, see scripts/typecheck.mjs
npm run validate     # claude plugin validate .
```

`scripts/host.mjs` finds a Claude Code binary with mod support (`CLAUDE_BIN`, else the one inside
the VS Code extension, else `claude` on `PATH`).

## Licence

MIT, the same licence as the rest of this repository. See the `LICENSE` file in this folder.
