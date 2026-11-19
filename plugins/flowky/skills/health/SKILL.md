---
name: health
description: Show what FlowKy has active in this project, and why a feature is not active. Use when the user asks whether FlowKy works, why the map, the context hint or a module did nothing, or asks for the FlowKy health check.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" health)
---

The FlowKy health check printed this report:

```text
!`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" health`
```

Show the report to the user exactly as printed, in a code block, with no commentary unless a line
says BROKEN, OFF, REFUSED, WARNING or "not detected"; for each of those lines add one short sentence on
how to fix it, taken from the README of the plugin (`${CLAUDE_PLUGIN_ROOT}/README.md`).
