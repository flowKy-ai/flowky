<div align="center">

# FlowKy

**The sidekick for your coding agent.**

Your agent forgets your codebase between sessions. It rewrites the helper you wrote last week, retries the command that just failed, and spends your tokens relearning a project it already knew yesterday.

FlowKy gives it memory, guardrails, and a map that tells you when it has gone stale.

[Website](https://flowky.ai) · [Docs](./docs) · [API reference](./docs/api) · [Starter](./starter) · [Tips](./TIPS.md)

</div>

---

## What it does

Works alongside Claude Code, Cursor, Copilot, Gemini CLI, Windsurf and Cline. It does not replace them.

| | |
|---|---|
| **Stops duplicate code** | Every function and class in your project is indexed. When your agent starts writing one that exists, it gets the file and the line — before the write lands. |
| **Breaks the retry loop** | Third time the same command has failed, FlowKy interrupts and surfaces the error the agent kept skipping past. |
| **Keeps the map honest** | The project map records the commit it was built from and reports how far it has drifted, so a stale map is never mistaken for a current one. |
| **Costs nothing until used** | Your directory tree, symbols and import graph live in a skill your agent opens on demand. Sessions that never need them pay zero tokens. |
| **Audits your config** | Finds duplicated rules, dead weight, and instructions that silently stop applying after a compaction. |
| **Your keys, your machine** | OpenAI, Anthropic, Google or any OpenAI-compatible endpoint. Keys stay in your editor and no inference request passes through us. |

## Install

```bash
# VS Code
code --install-extension FlowKy.flowky

# Or generate the config directly in any repo
npx flowky init
```

That writes:

```
your-project/
├── CLAUDE.md                        # gotchas only, kept under 200 lines
├── .claude/
│   ├── rules/                       # path-scoped conventions
│   ├── skills/project-map/          # tree, symbols, imports — loaded on demand
│   └── settings.json                # hooks wiring
└── .flowky/
    ├── index/symbols.tsv            # what the duplicate guard queries
    └── hooks/flowky-guard.mjs       # runs on macOS, Linux and Windows
```

## The perfect flow

The whole product is seven steps, and the extension walks you through them
(`Welcome: Open Walkthrough` → *FlowKy: the perfect flow*): connect →
kick off → **equip your agent with the standards** (each playbook becomes a
Claude Code skill, auto-loaded by relevance, plus an AGENTS.md section for
Cursor, Copilot and Codex) → give it a map → audit → hand a finding to the
agent → sync to your project page. The written version lives at
[flowky.ai/docs/the-perfect-flow](https://flowky.ai/en/docs/the-perfect-flow).

## How the guard works

The guard is a hook, not a prompt. That distinction is the whole product: instructions in a context file are advisory and drift as the window fills, while a hook is checked on every single write regardless of what the model decided.

```
$ your agent writes safeRedirectPath()

FlowKy: this symbol already exists in this codebase.
  • safeRedirectPath — already defined in src/lib/safe-redirect.ts:14

Import and reuse the existing definition, or extend it.
```

It asks rather than blocks. Overloads and re-exports are legitimate, and a hard block produces false positives that get the hook switched off within a week.

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
