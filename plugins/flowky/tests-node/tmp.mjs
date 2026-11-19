// Temporary folders for the Node tests: every folder made here is removed when the test file ends
// (review 2: the suites used to leave hundreds of folders in the system temp folder).
//
// Importing this file also points the user's own folders (FLOWKY_HOME, CLAUDE_CONFIG_DIR) at a
// temporary folder for this test process and every hook it starts with `{ ...process.env }`, so
// no test can read or write the real ~/.flowky or ~/.claude by forgetting to set them.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

const made = []

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

const user = tempDir('flowky-user-')
process.env.FLOWKY_HOME = join(user, '.flowky')
process.env.CLAUDE_CONFIG_DIR = join(user, '.claude')

after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
