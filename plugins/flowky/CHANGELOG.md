# Changelog

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
