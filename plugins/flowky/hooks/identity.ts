// Who this plugin is. Each FlowKy plugin has its own copy of this file (it is
// not part of the shared core): FlowKy Pro's says `flowky-pro`.

/** The plugin's name in the `flowky` catalogue: its skills are `/flowky:<skill>`. */
export const PLUGIN = 'flowky'
export const DISPLAY_NAME = 'FlowKy'
export const VERSION = '0.4.0'
/** The mods-layer command (no model turn). Both plugins register the same one: enable only one plugin. */
export const COMMAND = 'flowky'
/** The handoff skill named in the context hint. */
export const HANDOFF_COMMAND = `/${PLUGIN}:handoff`
