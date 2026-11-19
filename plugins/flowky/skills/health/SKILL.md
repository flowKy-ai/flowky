---
name: health
description: Show what FlowKy has active in this project, and why a feature is not active - the project map, the context hint and the four guardrails (duplicate guard, loop breaker, staleness line, config doctor) with their state. Use when the user asks whether FlowKy works, why the map, the context hint, a guardrail or a module did nothing, or asks for the FlowKy health check.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" health *)
---

The FlowKy health check printed this report:

```text
!`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" health --session ${CLAUDE_SESSION_ID}`
```

Show the report to the user exactly as printed, in a code block, every line of it. Add nothing: no
advice, no suggested setting, no explanation. Each line that needs an action already says it.
