// Where FlowKy keeps things, in one place.
//
// Inside a project, FlowKy shares the `.flowky/` folder with the FlowKy VS Code
// extension, which commits parts of it on purpose (`index/`, `audit/`,
// `skills/`, ...). The plugin therefore writes ONLY below `.flowky/cache/`,
// which carries its own `.gitignore` containing "*" (written before anything
// else), and it never adds an ignore rule anywhere else: the extension's files
// stay exactly as the extension and the user left them. The two config files
// are read only; the user writes and commits them by choice.
//
// Outside every project, the user's FlowKy folder is `~/.flowky/` (the
// `FLOWKY_HOME` variable may point elsewhere; see mods/home.ts).

/** The folder FlowKy shares with the VS Code extension. The plugin never writes here directly. */
export const FLOWKY_DIR = '.flowky'
/** The plugin's machine-local state: the only folder of the project the plugin writes on its own. */
export const STATE_DIR = '.flowky/cache'
/** The project's settings for the plugin (optional; read only). */
export const CONFIG_PATH = '.flowky/config.json'
/** FlowKy Pro: the project's router policy (read only, used only after the user's consent). */
export const POLICY_PATH = '.flowky/policy.json'
/** FlowKy Pro: the project's own price table for the cost report (read only). */
export const PRICES_PATH = '.flowky/prices.json'
/** The handoff summary, written by the assistant's own Write tool when the handoff skill asks for it. */
export const HANDOFF_PATH = '.flowky/cache/handoff.md'
/** The user's FlowKy folder below the home folder, when FLOWKY_HOME is not set. */
export const HOME_DIR_NAME = '.flowky'
/** The consent file of FlowKy Pro, in the user's FlowKy folder. */
export const CONSENT_FILE = 'consent.json'
