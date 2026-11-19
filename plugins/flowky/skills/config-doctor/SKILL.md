---
name: config-doctor
description: Check this project's Claude configuration (CLAUDE.md files, rules, skills, AGENTS.md, settings) for problems that waste context or are lost after compaction, and say what to change and where. Diagnoses only; changes nothing. Use when the user asks to check, audit or lint their CLAUDE.md, rules or Claude settings.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" config-doctor)
---

The FlowKy config doctor printed this report:

```text
!`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" config-doctor`
```

Show the report to the user exactly as printed, in a code block. Do not change any file unless the
user then asks for a specific change.
