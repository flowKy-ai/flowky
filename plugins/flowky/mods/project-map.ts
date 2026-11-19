// The project GPS map: a fast, deterministic scan of the tree (no model call,
// .gitignore respected, time-boxed) turned into .flowky/cache/project-map.md,
// about 30 lines that tell Claude where things are before it starts exploring.
//
// Repository text is data: every name, path and script name printed in the map
// is stripped of control characters and backticks and cut short, script names
// must look like script names, and an entry point is listed only when it is a
// file of the scan. The map lives in the plugin's ignored state folder and is
// always regenerated from the tree: a map a repository commits is never used.

import type { Io } from './io'
import { hash, join } from './io'
import { writeStateText } from './state'
import { STATE_DIR } from './paths'
import type { IgnoreRule } from './gitignore'
import { ALWAYS_SKIPPED, isIgnored, parseGitignore } from './gitignore'

export const MAP_PATH = `${STATE_DIR}/project-map.md`
/** Where the former name's 0.1.0 wrote the map; a file there is left alone and no longer read. */
export const LEGACY_MAP_PATH = '.claude/project-map.md'
const FINGERPRINT = /<!-- flowky-map fingerprint:([0-9a-f]+) -->/

export type ScanFile = { path: string; size: number }

export type Scan = {
  files: ScanFile[]
  /** Top-level and second-level directories seen, relative. */
  dirs: string[]
  /** Small manifest files at the root (and one level down), by relative path. */
  manifests: Record<string, string>
  partial: boolean
  partialReason?: string
  elapsedMs: number
}

/** Manifest files whose text the map reads (only when small). */
const MANIFEST_NAMES = new Set([
  'package.json', 'tsconfig.json', 'deno.json', 'pyproject.toml', 'requirements.txt', 'setup.cfg', 'setup.py',
  'Cargo.toml', 'go.mod', 'Makefile', 'makefile', 'CMakeLists.txt', 'composer.json', 'Gemfile', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'project.godot', 'pubspec.yaml', 'mix.exs', 'Package.swift', 'ruff.toml',
  'default.project.json', 'selene.toml', 'stylua.toml', '.luaurc', 'wally.toml', 'aftman.toml', 'rokit.toml',
])

const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * Walks the tree from `root`, breadth first, reading each folder's .gitignore
 * as it goes. Stops at the time budget or the file cap and says so.
 */
export async function scanTree(io: Io, root: string, budgetMs: number, maxFiles: number): Promise<Scan> {
  const started = await io.now()
  const deadline = started + budgetMs
  const files: ScanFile[] = []
  const dirs: string[] = []
  const manifests: Record<string, string> = {}
  let rules: IgnoreRule[] = []
  const info = await io.readText(join(root, '.git', 'info', 'exclude'))
  if (info) rules = rules.concat(parseGitignore(info, ''))
  const queue: string[] = ['']
  let partial = false
  let partialReason: string | undefined
  while (queue.length > 0) {
    if ((await io.now()) > deadline) {
      partial = true
      partialReason = `time budget of ${budgetMs} ms reached`
      break
    }
    const rel = queue.shift()!
    const entries = await io.list(rel === '' ? root : join(root, rel)).catch(() => [])
    const gi = entries.find(e => e.name === '.gitignore' && e.kind === 'file')
    if (gi) {
      const text = await io.readText(join(root, rel, '.gitignore'))
      if (text) rules = rules.concat(parseGitignore(text, rel))
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.kind === 'dir') {
        if (ALWAYS_SKIPPED.has(e.name) || (rel === '' && (e.name === '.claude' || e.name === '.flowky'))) continue
        if (isIgnored(rules, path, true)) continue
        if (!path.includes('/') || path.split('/').length === 2) dirs.push(path)
        queue.push(path)
      } else if (e.kind === 'file') {
        if (isIgnored(rules, path, false)) continue
        files.push({ path, size: e.size })
        const depth = path.split('/').length
        if (depth <= 2 && MANIFEST_NAMES.has(e.name) && e.size <= MANIFEST_MAX_BYTES) {
          const text = await io.readText(join(root, path))
          if (text !== undefined) manifests[path] = text
        }
        if (files.length >= maxFiles) {
          partial = true
          partialReason = `file cap of ${maxFiles} reached`
          queue.length = 0
          break
        }
      }
    }
  }
  return { files, dirs, manifests, partial, partialReason, elapsedMs: (await io.now()) - started }
}

/** Changes when files appear, disappear or a manifest changes; edits inside source files do not count. */
export function fingerprint(scan: Scan): string {
  const parts = scan.files.map(f => f.path).sort()
  for (const k of Object.keys(scan.manifests).sort()) parts.push(`${k}#${hash(scan.manifests[k]!)}`)
  return hash(parts.join('\n'))
}

// ---- What the map says ----

export type MapFacts = {
  languages: string[]
  frameworks: string[]
  entryPoints: string[]
  commands: { build?: string; test?: string; typecheck?: string; lint?: string }
  keyDirs: { path: string; files: number; purpose: string }[]
  visual: string[]
  heavy: string[]
  /** The project has 3D, shader or engine work. */
  is3D: boolean
  /** The project has typescript in its dependencies or a tsconfig. */
  hasTypescript: boolean
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#',
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', c: 'C', h: 'C/C++', rb: 'Ruby', php: 'PHP', swift: 'Swift',
  lua: 'Lua', luau: 'Luau', gd: 'GDScript', dart: 'Dart', ex: 'Elixir', exs: 'Elixir', scala: 'Scala',
  vue: 'Vue', svelte: 'Svelte', glsl: 'GLSL', wgsl: 'WGSL', hlsl: 'HLSL', zig: 'Zig',
}

const PURPOSE: Record<string, string> = {
  src: 'source', lib: 'library code', app: 'application', apps: 'apps (monorepo)', packages: 'packages (monorepo)',
  test: 'tests', tests: 'tests', __tests__: 'tests', spec: 'tests', e2e: 'end-to-end tests', docs: 'documentation',
  doc: 'documentation', scripts: 'scripts', tools: 'tooling', bin: 'executables', cmd: 'commands (entry points)',
  public: 'static assets', static: 'static assets', assets: 'assets', examples: 'examples', config: 'configuration',
  components: 'UI components', pages: 'pages/routes', routes: 'routes', api: 'API', server: 'server', client: 'client',
  shaders: 'shaders', shader: 'shaders', models: 'models', internal: 'internal packages', pkg: 'packages',
  migrations: 'database migrations', include: 'headers', styles: 'styles', hooks: 'hooks', utils: 'utilities',
  shared: 'shared code', core: 'core logic', engine: 'engine code', game: 'game code', ui: 'UI', web: 'web front end',
  benches: 'benchmarks', bench: 'benchmarks', fixtures: 'test fixtures', '.github': 'CI and repository settings',
}

const VISUAL_DEPS: Record<string, string> = {
  three: '3D: three.js', '@react-three/fiber': '3D: react-three-fiber', '@react-three/drei': '3D: drei helpers',
  '@babylonjs/core': '3D: Babylon.js', babylonjs: '3D: Babylon.js', playcanvas: '3D: PlayCanvas', aframe: '3D: A-Frame',
  'cannon-es': 'physics: cannon-es', cannon: 'physics: cannon', 'ammo.js': 'physics: ammo.js',
  '@dimforge/rapier3d': 'physics: Rapier', '@dimforge/rapier3d-compat': 'physics: Rapier', 'matter-js': 'physics: matter.js',
  'pixi.js': '2D GPU: PixiJS', phaser: 'game: Phaser', regl: 'WebGL: regl', ogl: 'WebGL: OGL', 'gl-matrix': 'math: gl-matrix',
  '@react-three/rapier': 'physics: react-three-rapier', 'postprocessing': '3D: postprocessing',
  react: 'UI: React', 'react-dom': 'UI: React DOM', vue: 'UI: Vue', svelte: 'UI: Svelte', 'solid-js': 'UI: Solid',
  '@angular/core': 'UI: Angular', next: 'UI: Next.js', nuxt: 'UI: Nuxt', tailwindcss: 'UI: Tailwind CSS',
  pygame: 'game: pygame', panda3d: '3D: Panda3D', pyglet: '3D: pyglet', moderngl: 'WebGL: ModernGL', open3d: '3D: Open3D',
  trimesh: '3D: trimesh', bevy: '3D: Bevy', wgpu: 'GPU: wgpu', 'three-d': '3D: three-d', macroquad: 'game: macroquad',
}

const FRAMEWORK_DEPS: Record<string, string> = {
  vite: 'Vite', webpack: 'webpack', esbuild: 'esbuild', express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS',
  electron: 'Electron', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', vitest: 'Vitest', jest: 'Jest',
  mocha: 'Mocha', pytest: 'pytest', tokio: 'Tokio', axum: 'Axum', actix: 'Actix', 'actix-web': 'Actix',
  next: 'Next.js', nuxt: 'Nuxt', '@sveltejs/kit': 'SvelteKit', astro: 'Astro', remix: 'Remix', prisma: 'Prisma',
}

const SHADER_EXT = new Set(['glsl', 'vert', 'frag', 'wgsl', 'hlsl', 'shader', 'comp', 'geom', 'tesc', 'tese', 'metal', 'fx', 'usf', 'ush'])
const ASSET_3D_EXT = new Set(['gltf', 'glb', 'fbx', 'obj', 'blend', 'usd', 'usda', 'usdc', 'usdz', 'stl', 'dae', '3ds', 'ply', 'abc', 'ktx2', 'hdr', 'exr', 'rbxm', 'rbxl'])
const ENGINE_FILES = /(^|\/)(project\.godot|[^/]+\.uproject|ProjectSettings\/ProjectVersion\.txt|[^/]+\.unity|default\.project\.json)$/i
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'uv.lock', 'flake.lock', 'pubspec.lock', 'mix.lock', 'Podfile.lock', 'packages.lock.json', 'wally.lock'])
const GENERATED_DIRS = new Set(['dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'target', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'vendor', 'Library', 'obj'])
const BIG_TEXT_BYTES = 200 * 1024

function ext(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Repository text made safe to print on one map line: no control characters, no backticks, short. */
export function clean(text: string, max = 120): string {
  const t = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

function size(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

type Pkg = {
  main?: string; module?: string; bin?: string | Record<string, string>; scripts?: Record<string, string>
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>
}

function parsePkg(text: string | undefined): Pkg | undefined {
  if (!text) return undefined
  try {
    const o = JSON.parse(text) as Pkg
    return o && typeof o === 'object' ? o : undefined
  } catch {
    return undefined
  }
}

/** Package names a manifest depends on, lower-case. */
export function dependencyNames(manifests: Record<string, string>): Set<string> {
  const names = new Set<string>()
  for (const [path, text] of Object.entries(manifests)) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === 'package.json' || name === 'composer.json') {
      const p = parsePkg(text) as (Pkg & { require?: Record<string, string> }) | undefined
      for (const k of Object.keys({ ...p?.dependencies, ...p?.devDependencies, ...p?.peerDependencies, ...p?.require })) names.add(k.toLowerCase())
    } else if (name === 'requirements.txt') {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.-]+)/.exec(line)
        if (m && !line.trim().startsWith('#')) names.add(m[1]!.toLowerCase())
      }
    } else if (name === 'pyproject.toml' || name === 'Cargo.toml' || name === 'Gemfile' || name === 'pubspec.yaml' || name === 'mix.exs' || name === 'go.mod') {
      // Light-touch: quoted or bare names at the start of dependency lines.
      for (const m of text.matchAll(/^\s*["']?([A-Za-z0-9_.\-/@]+)["']?\s*(?:=|>=|==|~=|\^|\s+v?\d|,)/gm)) names.add(m[1]!.toLowerCase())
      for (const m of text.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=~!]=?[^"']*)?["']/g)) names.add(m[1]!.toLowerCase())
      for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) names.add(m[1]!.toLowerCase())
    }
  }
  return names
}

function packageManager(files: Set<string>): string {
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('yarn.lock')) return 'yarn'
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun'
  return 'npm'
}

function runScript(pm: string, script: string): string {
  if (script === 'test') return pm === 'npm' ? 'npm test' : `${pm} test`
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`
}

/** Build, test, typecheck and lint commands the project files declare. */
export function detectCommands(manifests: Record<string, string>, fileSet: Set<string>): MapFacts['commands'] {
  const cmds: MapFacts['commands'] = {}
  const pkg = parsePkg(manifests['package.json'])
  const pm = packageManager(fileSet)
  const scripts = pkg?.scripts ?? {}
  const pick = (names: string[]) => names.find(n => typeof scripts[n] === 'string' && !/no test specified/.test(scripts[n]!))
  // (the names above are fixed literals: no script name from the repository is ever printed)
  const build = pick(['build', 'compile'])
  const test = pick(['test', 'test:unit', 'tests'])
  const typecheck = pick(['typecheck', 'type-check', 'check-types', 'tsc', 'types', 'check'])
  const lint = pick(['lint', 'eslint'])
  if (build) cmds.build = runScript(pm, build)
  if (test) cmds.test = runScript(pm, test)
  if (typecheck) cmds.typecheck = runScript(pm, typecheck)
  if (lint) cmds.lint = runScript(pm, lint)
  if (!cmds.typecheck && fileSet.has('tsconfig.json')) cmds.typecheck = 'npx tsc --noEmit'
  if (manifests['Cargo.toml']) {
    cmds.build ??= 'cargo build'
    cmds.test ??= 'cargo test'
    cmds.typecheck ??= 'cargo check'
    cmds.lint ??= 'cargo clippy'
  }
  if (manifests['go.mod']) {
    cmds.build ??= 'go build ./...'
    cmds.test ??= 'go test ./...'
    cmds.typecheck ??= 'go vet ./...'
  }
  const py = manifests['pyproject.toml'] ?? ''
  if (py || manifests['requirements.txt'] || manifests['setup.py']) {
    const deps = dependencyNames(manifests)
    if (/\[tool\.pytest|pytest/.test(py) || deps.has('pytest') || [...fileSet].some(f => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))) cmds.test ??= 'pytest'
    if (/\[tool\.ruff/.test(py) || fileSet.has('ruff.toml') || deps.has('ruff')) cmds.lint ??= 'ruff check .'
    if (/\[tool\.mypy/.test(py) || deps.has('mypy')) cmds.typecheck ??= 'mypy .'
    if (/\[tool\.pyright/.test(py) || fileSet.has('pyrightconfig.json')) cmds.typecheck ??= 'pyright'
  }
  const make = manifests['Makefile'] ?? manifests['makefile']
  if (make) {
    for (const [key, target] of [['build', 'build'], ['test', 'test'], ['typecheck', 'check'], ['lint', 'lint']] as const) {
      if (new RegExp(`^${target}\\s*:`, 'm').test(make)) cmds[key] ??= `make ${target}`
    }
  }
  if (manifests['CMakeLists.txt']) cmds.build ??= 'cmake -S . -B build && cmake --build build'
  if ([...fileSet].some(f => /\.(sln|csproj)$/.test(f))) {
    cmds.build ??= 'dotnet build'
    cmds.test ??= 'dotnet test'
  }
  if (manifests['pom.xml']) {
    cmds.build ??= 'mvn -q package'
    cmds.test ??= 'mvn -q test'
  }
  if (manifests['build.gradle'] || manifests['build.gradle.kts']) {
    cmds.build ??= './gradlew build'
    cmds.test ??= './gradlew test'
  }
  if (manifests['default.project.json']) cmds.build ??= 'rojo build -o build.rbxl'
  if (manifests['selene.toml']) cmds.lint ??= 'selene .'
  return cmds
}

const ENTRY_CANDIDATES = [
  'src/main.ts', 'src/main.tsx', 'src/main.js', 'src/main.jsx', 'src/index.ts', 'src/index.tsx', 'src/index.js',
  'src/app.ts', 'src/server.ts', 'index.ts', 'index.js', 'main.ts', 'main.js', 'server.js', 'app.js', 'index.html',
  'main.py', 'app.py', 'manage.py', 'src/main.py', 'src/__main__.py', 'main.go', 'src/main.rs', 'src/lib.rs',
  'src/main.cpp', 'main.cpp', 'src/main.c', 'Program.cs', 'src/main.lua', 'init.lua', 'main.lua', 'src/init.luau',
]

/** Turns a scan into the facts the map prints (pure, deterministic). */
export function analyze(scan: Scan): MapFacts {
  const fileSet = new Set(scan.files.map(f => f.path))
  const deps = dependencyNames(scan.manifests)
  const langCount = new Map<string, number>()
  for (const f of scan.files) {
    const lang = LANG_BY_EXT[ext(f.path)]
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
  }
  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l} (${n})`)
  const frameworks = [...new Set(Object.entries(FRAMEWORK_DEPS).filter(([d]) => deps.has(d)).map(([, n]) => n))].slice(0, 6)

  const entryPoints: string[] = []
  const pkg = parsePkg(scan.manifests['package.json'])
  const declared: unknown[] = [pkg?.main, pkg?.module]
  if (typeof pkg?.bin === 'string') declared.push(pkg.bin)
  else if (pkg?.bin && typeof pkg.bin === 'object') declared.push(...Object.values(pkg.bin))
  // Only entry points that are files of the scan: raw manifest text never reaches the map.
  for (const v of declared) if (typeof v === 'string' && fileSet.has(v.replace(/^\.\//, ''))) entryPoints.push(v.replace(/^\.\//, ''))
  for (const c of ENTRY_CANDIDATES) if (fileSet.has(c)) entryPoints.push(c)
  for (const f of scan.files) if (/^cmd\/[^/]+\/main\.go$/.test(f.path)) entryPoints.push(f.path)
  const entries = [...new Set(entryPoints)].slice(0, 6).map(e => clean(e))

  const top = new Map<string, number>()
  for (const f of scan.files) {
    const i = f.path.indexOf('/')
    if (i > 0) top.set(f.path.slice(0, i), (top.get(f.path.slice(0, i)) ?? 0) + 1)
  }
  const keyDirs = [...top.entries()]
    .filter(([d]) => !GENERATED_DIRS.has(d))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, files]) => ({ path: clean(path, 60), files, purpose: clean(purposeOf(path, scan)) }))

  const visual: string[] = []
  for (const [d, label] of Object.entries(VISUAL_DEPS)) if (deps.has(d)) visual.push(label)
  const shaders = scan.files.filter(f => SHADER_EXT.has(ext(f.path)))
  if (shaders.length > 0) visual.push(`shaders: ${shaders.length} file(s), e.g. ${shaders.slice(0, 2).map(s => clean(s.path, 60)).join(', ')}`)
  const assets = scan.files.filter(f => ASSET_3D_EXT.has(ext(f.path)))
  if (assets.length > 0) visual.push(`3D assets: ${assets.length} file(s) (${[...new Set(assets.map(a => ext(a.path)))].slice(0, 4).join(', ')}): do not read them as text`)
  const engines = scan.files.filter(f => ENGINE_FILES.test(f.path))
  if (engines.length > 0) visual.push(`engine project: ${engines.slice(0, 2).map(e => clean(e.path, 60)).join(', ')}`)
  const is3D = visual.some(v => /^(3D|physics|shaders|WebGL|GPU|engine project|3D assets)/.test(v))

  const heavy: string[] = []
  for (const f of scan.files) {
    const name = f.path.slice(f.path.lastIndexOf('/') + 1)
    const shown = clean(f.path, 80)
    if (LOCKFILES.has(name)) heavy.push(`${shown} (lockfile, ${size(f.size)})`)
    else if (/\.min\.(js|css)$|\.map$/.test(name)) heavy.push(`${shown} (minified or source map, ${size(f.size)})`)
    else if (f.size > BIG_TEXT_BYTES && LANG_BY_EXT[ext(f.path)] !== undefined) heavy.push(`${shown} (${size(f.size)}: read a range or use the outline)`)
  }
  for (const d of scan.dirs) if (!d.includes('/') && GENERATED_DIRS.has(d)) heavy.push(`${d}/ (generated output, not in .gitignore)`)
  heavy.sort((a, b) => (a.includes('lockfile') ? 1 : 0) - (b.includes('lockfile') ? 1 : 0))

  return {
    languages,
    frameworks,
    entryPoints: entries,
    commands: detectCommands(scan.manifests, fileSet),
    keyDirs,
    visual: visual.slice(0, 5),
    heavy: heavy.slice(0, 6),
    is3D,
    hasTypescript: fileSet.has('tsconfig.json') || deps.has('typescript'),
  }
}

function purposeOf(dir: string, scan: Scan): string {
  const known = PURPOSE[dir] ?? PURPOSE[dir.toLowerCase()]
  const subs = scan.dirs.filter(d => d.startsWith(dir + '/')).map(d => clean(d.slice(dir.length + 1), 30)).slice(0, 4)
  const base = known ?? 'project files'
  return subs.length > 0 ? `${base}; ${subs.join(', ')}` : base
}

/** The map's text: at most about 30 lines, the fingerprint on the first line. */
/** Byte-stable for a given tree: no date, no timing, so the prompt cache keeps it. */
export function renderMap(facts: MapFacts, scan: Scan, fp: string): string {
  const lines: string[] = []
  lines.push(`<!-- flowky-map fingerprint:${fp} -->`)
  lines.push('# Project map (written by FlowKy; read this before exploring)')
  const stack = [...facts.languages, ...facts.frameworks]
  lines.push(`- Stack: ${stack.length > 0 ? stack.join(', ') : 'not detected'}`)
  if (facts.entryPoints.length > 0) lines.push(`- Entry points: ${facts.entryPoints.join(', ')}`)
  const c = facts.commands
  const cmd = [c.build && `build \`${c.build}\``, c.test && `test \`${c.test}\``, c.typecheck && `typecheck \`${c.typecheck}\``, c.lint && `lint \`${c.lint}\``].filter(Boolean)
  lines.push(`- Commands: ${cmd.length > 0 ? cmd.join(' · ') : 'none found in the project files'}`)
  if (facts.keyDirs.length > 0) {
    lines.push('- Key directories:')
    for (const d of facts.keyDirs) lines.push(`  - ${d.path}/ (${d.files} files): ${d.purpose}`)
  }
  if (facts.visual.length > 0) {
    lines.push('- 3D and UI:')
    for (const v of facts.visual) lines.push(`  - ${v}`)
  }
  if (facts.heavy.length > 0) {
    lines.push('- Too large or generated to read whole (grep or read a range):')
    for (const h of facts.heavy) lines.push(`  - ${h}`)
  }
  const note = scan.partial ? ` PARTIAL scan: ${scan.partialReason}.` : ''
  lines.push(`- Scan: ${scan.files.length} files, .gitignore respected.${note} Refreshed when files are added, removed or a manifest changes.`)
  return lines.join('\n') + '\n'
}

export function fingerprintOf(mapText: string | undefined): string | undefined {
  return mapText ? FINGERPRINT.exec(mapText)?.[1] : undefined
}

export type MapOutcome = {
  status: 'written' | 'unchanged' | 'disabled' | 'error'
  text?: string
  facts?: MapFacts
  scan?: Scan
  reason?: string
}

/**
 * Scans, renders, and writes the map only when its text changed. The text handed to Claude is
 * always the one just rendered from the tree, never the file on disk.
 */
export async function refreshMap(io: Io, root: string, opts: { budgetMs: number; maxFiles: number }): Promise<MapOutcome> {
  const scan = await scanTree(io, root, opts.budgetMs, opts.maxFiles)
  const fp = fingerprint(scan)
  const path = join(root, MAP_PATH)
  const existing = await io.readText(path)
  const facts = analyze(scan)
  const text = renderMap(facts, scan, fp)
  if (existing === text) return { status: 'unchanged', text, facts, scan }
  try {
    await writeStateText(io, root, 'project-map.md', text)
  } catch (err) {
    return { status: 'error', reason: `could not write ${MAP_PATH}: ${String(err).slice(0, 160)}`, text, facts, scan }
  }
  return { status: 'written', text, facts, scan }
}
