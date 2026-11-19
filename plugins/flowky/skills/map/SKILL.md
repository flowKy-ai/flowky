---
name: map
description: Rescan the project tree now and rewrite .flowky/cache/project-map.md. Use when the user asks to refresh or regenerate the project map.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" map)
---

The project map was refreshed:

```text
!`node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" map`
```

Tell the user in one line whether it was written or unchanged, and use the new map from now on.
