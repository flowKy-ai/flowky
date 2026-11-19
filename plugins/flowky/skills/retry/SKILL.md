---
name: retry
description: Reset the FlowKy loop breaker for this session, so a command it paused after repeated identical failures starts counting from zero again. Use when the user says to retry, to reset the loop breaker, or that the repeated command is intended.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" retry --session ${CLAUDE_SESSION_ID})
---

```text
!`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" retry --session ${CLAUDE_SESSION_ID}`
```

Tell the user in one line what was reset, as printed above.
