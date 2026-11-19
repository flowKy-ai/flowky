// The plugin tests are *.suite.ts modules grouped in a few *.test.ts files, because
// `claude plugin test` runs every *.test.ts in its own child, all at once, and each child commits
// about 450 MB while it loads (see tests/baseline-layer.test.ts).
// A suite that no group imports would never run: this test makes that loud.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TESTS = join(HERE, '..', 'tests')
const MAX_GROUPS = 2

test('every tests/*.suite.ts is imported by exactly one tests/*.test.ts, and the groups stay few', () => {
  const names = readdirSync(TESTS)
  const suites = names.filter(n => n.endsWith('.suite.ts')).map(n => n.slice(0, -'.ts'.length))
  const groups = names.filter(n => /\.test\.tsx?$/.test(n))
  assert.ok(suites.length > 0, 'no suite found')
  assert.ok(groups.length <= MAX_GROUPS, `${groups.length} *.test.ts files: each one is a child of about 450 MB started at the same time; import new suites from an existing group`)
  const importedBy = new Map(suites.map(s => [s, []]))
  for (const g of groups) {
    const text = readFileSync(join(TESTS, g), 'utf8')
    assert.doesNotMatch(text, /\btest\(/, `${g} is a group: put tests in a *.suite.ts it imports`)
    for (const m of text.matchAll(/^import '\.\/([\w.-]+)'$/gm)) {
      assert.ok(importedBy.has(m[1]), `${g} imports ./${m[1]}, which is not a tests/*.suite.ts`)
      importedBy.get(m[1]).push(g)
    }
  }
  for (const [s, by] of importedBy) assert.equal(by.length, 1, `tests/${s}.ts is imported by ${by.length} group(s): ${by.join(', ') || 'none, so it never runs'}`)
})
