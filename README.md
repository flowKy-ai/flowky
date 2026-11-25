<div align="center">

# FlowKy

**The sidekick for your coding agent.**

Your agent forgets your codebase between sessions. It rewrites the helper you wrote last week, retries the command that just failed, and spends your tokens relearning a project it already knew yesterday.

FlowKy gives it memory, guardrails, and a map that tells you when it has gone stale.

[Website](https://flowky.ai) · [Docs](./docs) · [API reference](./docs/api) · [Starter](./starter) · [Tips](./TIPS.md)

</div>

---

## What it does

Built for Claude Code. The project map and the generated configuration also work with Cursor, Copilot and other agents that read files in your repository. FlowKy does not replace your agent.

**In the VS Code extension today**

| | |
|---|---|
| **Gives your agent a map** | Your directory tree, symbols and import graph live in a skill your agent opens on demand. Sessions that never need them pay zero tokens. |
| **Writes the configuration** | One command writes `CLAUDE.md`, path-scoped rules and the project-map skill from your real codebase. |
| **Your keys, your machine** | OpenAI, Anthropic, Google or any OpenAI-compatible endpoint. Keys stay in your editor, and model calls go straight to your provider, not through us. |

**In FlowKy Guard (the plugin), today**

| | |
|---|---|
| **Stops duplicate code** | Your project's top-level exported functions and classes (TypeScript, JavaScript, Python, Go, Rust) are indexed on your machine. Before Claude writes one whose name is already exported elsewhere, FlowKy pauses that write once and shows where the existing one is. It applies to Claude's Write and Edit, once per file and name per session. |
| **Breaks the retry loop** | The same command fails three times with the same error? Claude is told so, with the error line, and the next identical run is paused once. A command piped into a filter without `pipefail` is not seen. |
| **Keeps the map honest** | The map and the index are rebuilt at every session start. One line tells you and Claude when a committed map is behind HEAD, or when HEAD moves during the session. |
| **Audits your config** | 19 local checks on `CLAUDE.md`, rules and settings. The doctor diagnoses; it changes nothing. |

These four are in the plugin ([`plugins/flowky`](plugins/flowky/README.md), version 0.4.0, an early version). They are **not in the published VS Code extension yet**.

## Install

```bash
# VS Code
code --install-extension FlowKy.flowky
```

Then open the Command Palette and run **Generate Claude Configuration**. A command-line installer is not published yet.

The plugin for Claude Code installs at the Claude Code prompt:

```text
/plugin marketplace add flowKy-ai/flowky
/plugin install flowky@flowky
```

It makes no network request and no model call; what it does and its limits are in [its own README](plugins/flowky/README.md).

The command writes:

```
your-project/
├── CLAUDE.md                        # gotchas only, kept under 200 lines
├── .claude/
│   ├── rules/                       # path-scoped conventions
│   └── skills/project-map/          # tree, symbols, imports — loaded on demand
└── .flowky/
    └── index/symbols.tsv            # the symbol index the map is built from
```

> **If your project already has a `.claude/settings.json`, back it up first.** The published version can leave that file invalid when it adds its own entry. The fix, and the hook that powers the guards listed under "Coming", ship with the next release.

## The perfect flow

The whole product is seven steps, and the extension walks you through them
(`Welcome: Open Walkthrough` → *FlowKy: the perfect flow*): connect →
kick off → **equip your agent with the standards** (each playbook becomes a
Claude Code skill, auto-loaded by relevance, plus an AGENTS.md section for
Cursor, Copilot and Codex) → give it a map → audit → hand a finding to the
agent → sync to your project page. The written version lives at
[flowky.ai/docs/the-perfect-flow](https://flowky.ai/en/docs/the-perfect-flow).

## How the guard works

*Status: in the plugin for Claude Code today; not in the published VS Code extension yet. The transcript below is an illustration: the exact words are in the plugin's README.*

The guard is a hook, not a prompt. That distinction is the whole product: instructions in a context file are advisory and drift as the window fills, while a hook is checked on every single write regardless of what the model decided.

```
$ your agent writes safeRedirectPath()

FlowKy: this symbol already exists in this codebase.
  • safeRedirectPath — already defined in src/lib/safe-redirect.ts:14

Import and reuse the existing definition, or extend it.
```

It asks once and never blocks. Overloads and re-exports are legitimate, and a hard block produces false positives that get the hook switched off within a week.

## FlowKy Bot

A dependency pull request that says "tests failing" has moved the work to you, not away from you. So ours does not open one until it knows what passes.

```console
2 outdated, 2 candidates, 1 with advisories.
  verification failed on `test` with 2 updates — isolating
  held back `ms` — breaks `test`

→ Updated and verified:  semver 7.5.0 → 7.8.5  (fixes a high advisory)
→ Held back:             ms     2.0.0 → 2.1.3  (breaks `test`)
```

It applies the updates, runs your own `build`, `test`, `lint` and `typecheck` scripts, and when something breaks it binary-searches for the culprit, drops it and ships the rest. Isolation costs O(k log n) runs for k culprits rather than testing every update on its own. Majors are held back unless one carries a live advisory — an unpatched vulnerability is worse than a breaking change you were warned about.

Zero dependencies, because a tool that audits your supply chain should not enlarge it. [Read it](./.github/scripts/flowky-bot.mjs) — it is one file.

```yaml
jobs:
  dependencies:
    uses: flowKy-ai/flowky/.github/workflows/flowky-bot.yml@main
    permissions:
      contents: write
      pull-requests: write
```

Optional secrets: `ANTHROPIC_API_KEY` adds a written risk summary; `FLOWKY_BOT_TOKEN` (a fine-grained PAT with contents and pull-requests write) makes CI actually run on the bot's branch, which a pull request opened with `GITHUB_TOKEN` will not do.

## Repositories

| Repo | Visibility | What it is |
|---|---|---|
| `flowky` | public | This one — docs, API reference, starter |
| `flowky-web` | private | flowky.ai |
| `flowky-vscode` | private | VS Code extension |
| `flowky-chrome` | private | Chrome side panel |

## Contributing

The starter and the documentation take pull requests. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Found a security issue? Do not open an issue — see [SECURITY.md](./SECURITY.md).

## Licence

[MIT](./LICENSE) for everything in this repository, including the starter. The FlowKy extension and web application are separately licensed.

## Trademarks

FlowKy is an independent product. It is not affiliated with, endorsed or sponsored by Anthropic, or by the makers of the other tools named in this repository. Claude and Claude Code are trademarks of Anthropic, PBC; all other names are trademarks of their respective owners.

