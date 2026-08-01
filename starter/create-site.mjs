#!/usr/bin/env node
/**
 * create-site — scaffold a website that an agent can navigate on day one.
 *
 * Not another framework starter. `npm create vite` already does that better than
 * we would. What this adds is the layer people skip and then pay for later: an
 * agent configuration that exists before the codebase is big enough to need one.
 *
 * The bet is simple. Agent configuration written on day one is short and true.
 * Written on day ninety, it is archaeology, and by then the agent has spent three
 * months rediscovering the same layout every session.
 *
 * Dependencies: none. It is one file so you can read it before you run it, which
 * is the correct instinct for any script that writes to your disk.
 *
 *   node create-site.mjs my-site
 *   node create-site.mjs my-site --stack next   (default)
 *   node create-site.mjs my-site --stack static
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const stackFlag = args.indexOf('--stack');
const stack = stackFlag !== -1 ? args[stackFlag + 1] : 'next';

if (!name) {
  console.error('usage: node create-site.mjs <name> [--stack next|static]');
  process.exit(1);
}
if (!['next', 'static'].includes(stack)) {
  console.error(`unknown stack "${stack}" — use "next" or "static"`);
  process.exit(1);
}

const root = resolve(process.cwd(), name);
if (existsSync(root)) {
  // Refuse rather than merge. Scaffolding into a directory with contents is how
  // someone loses a file they had not committed yet.
  console.error(`"${name}" already exists. Choose another name or remove it first.`);
  process.exit(1);
}

const project = basename(root);

function write(relativePath, contents) {
  const full = join(root, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents.replace(/\{\{NAME\}\}/g, project), 'utf8');
}

/* ── Agent configuration — the reason this exists ──────────────────────────── */

write('CLAUDE.md', `# {{NAME}}

${stack === 'next' ? 'Next.js site.' : 'Static site, no build step.'}

## Commands
${stack === 'next'
  ? '- Dev: `npm run dev`\n- Build: `npm run build`\n- Test: `npm test`'
  : '- Serve: `npx serve public`\n- No build step. Edit files in public/ directly.'}

## Gotchas
<!-- Facts an agent cannot work out by reading the code. Delete this comment and
     add real ones as you hit them. Keep the whole file under 200 lines: past
     that, adherence measurably drops.

     Do NOT list your directory structure here. The agent can read it, and a tree
     written down goes stale on your next refactor. -->
- Nothing yet. Add the first one the moment you explain something twice.
`);

write('.claude/rules/style.md', `# Style

- Two-space indentation.
- Prefer editing an existing file over creating a new one.
- No new dependency without saying why in the pull request.
`);

write('.claude/skills/project-map/SKILL.md', `---
name: project-map
description: Layout of this project — where things live and what each area is for. Use when locating code or deciding where something new belongs.
---

# {{NAME}} map

${stack === 'next'
  ? '- `app/` — routes. One directory per URL segment.\n- `components/` — shared UI.\n- `lib/` — logic with no UI.\n- `public/` — static assets served as-is.'
  : '- `public/` — everything served. index.html is the entry point.\n- `public/assets/` — images, fonts, downloads.'}

Regenerate this file when the layout changes. A map that has quietly gone stale is
worse than no map, because it reads as authoritative.
`);

/* ── Project files ────────────────────────────────────────────────────────── */

if (stack === 'next') {
  write('package.json', JSON.stringify({
    name: project,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint'
    },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' }
  }, null, 2) + '\n');

  write('app/layout.tsx', `export const metadata = {
  title: '{{NAME}}',
  description: 'Built with the FlowKy starter.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`);

  write('app/page.tsx', `export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>{{NAME}}</h1>
      <p>
        Edit <code>app/page.tsx</code> to get started. Your agent configuration is
        already in <code>CLAUDE.md</code> and <code>.claude/</code>.
      </p>
    </main>
  );
}
`);

  write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true, skipLibCheck: true, strict: true, noEmit: true,
      esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
      resolveJsonModule: true, isolatedModules: true, jsx: 'preserve',
      incremental: true, plugins: [{ name: 'next' }],
      paths: { '@/*': ['./*'] }
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules']
  }, null, 2) + '\n');
} else {
  write('public/index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>{{NAME}}</h1>
    <p>Edit <code>public/index.html</code> to get started.</p>
  </main>
</body>
</html>
`);

  write('public/style.css', `:root { color-scheme: light dark; }
body {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
  margin: 4rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}
`);
}

/* ── Repository hygiene ───────────────────────────────────────────────────── */

write('.gitignore', `node_modules/
.next/
out/
dist/
.env
.env.local
.DS_Store
*.log
`);

write('README.md', `# {{NAME}}

${stack === 'next' ? '\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`' : '\`\`\`bash\nnpx serve public\n\`\`\`'}

## Working with an agent

This project ships with agent configuration already in place:

- \`CLAUDE.md\` — commands and gotchas, loaded every session
- \`.claude/rules/\` — conventions, scoped to the files they apply to
- \`.claude/skills/project-map/\` — the layout, loaded only when needed

Add a gotcha the first time you explain something twice. That is the whole
maintenance burden, and skipping it is why agent configuration usually rots.
`);

console.log(`\n  Created ${project}/ (${stack})\n`);
console.log('  Next:');
console.log(`    cd ${project}`);
console.log(stack === 'next' ? '    npm install && npm run dev\n' : '    npx serve public\n');
console.log('  Agent config is already in CLAUDE.md and .claude/.\n');
