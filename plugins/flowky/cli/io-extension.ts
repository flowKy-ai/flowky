// Per-plugin driver extension (part of the per-plugin interface in core.json, not of the shared
// core): cli/hook.ts hands the Node driver through extendIo before any hook runs. The free plugin
// adds nothing: its driver loads no project module and removes no file outside the state folder
// (safety review F9). FlowKy Pro's copy of this file adds its two consented primitives.

import type { Io } from '../mods/io'

export function extendIo(io: Io): Io {
  return io
}
