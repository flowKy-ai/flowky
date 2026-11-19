// Bundles cli/hook.ts (and everything it imports) into dist/hook.mjs, the one
// file the command hooks run. dist/ is committed: installing the plugin runs
// no build. `--check` rebuilds in memory and fails when dist/ is stale.
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const check = process.argv.includes('--check')
const result = await build({
  entryPoints: ['cli/hook.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  write: false,
  legalComments: 'none',
  banner: { js: '// Built from cli/hook.ts by scripts/build.mjs. Do not edit: edit the sources and run npm run build.' },
})
const text = result.outputFiles[0].text
if (check) {
  const current = await readFile('dist/hook.mjs', 'utf8').catch(() => '')
  if (current !== text) {
    console.error('dist/hook.mjs is out of date: run npm run build')
    process.exit(1)
  }
  console.log('dist/hook.mjs is up to date')
} else {
  await mkdir('dist', { recursive: true })
  await writeFile('dist/hook.mjs', text)
  console.log(`dist/hook.mjs written (${text.length} bytes)`)
}
