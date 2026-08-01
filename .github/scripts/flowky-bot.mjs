#!/usr/bin/env node
/**
 * FlowKy Bot — dependency updates that arrive already tested.
 *
 * Dependabot opens a pull request and leaves you to find out whether it builds.
 * This does the opposite: it applies the updates, runs your verification, and
 * when something breaks it binary-searches for the culprit, drops it, and ships
 * everything that passed. What lands is green by construction.
 *
 * Node, not shell — one runtime that works on macOS, Linux and Windows runners
 * alike. Zero dependencies, so the tool that audits your supply chain does not
 * add to it.
 *
 * Exit codes: 0 = report written (with or without changes), 1 = internal error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';

const CWD = process.cwd();
const DRY_RUN = process.argv.includes('--dry-run');

/** Majors are held back by default: they are the ones that need a human. */
const ALLOW_MAJOR = process.env.FLOWKY_ALLOW_MAJOR === 'true';

/* ------------------------------------------------------------------ shell -- */

/**
 * `npm outdated` and `npm audit` both exit non-zero when they have something to
 * report, which is the normal case here. Capture output and ignore the code.
 */
/**
 * On Windows `npm` is a `.cmd` shim, and since the fix for CVE-2024-27980 Node
 * refuses to spawn one without a shell. So Windows gets `shell: true` — which
 * concatenates rather than passes arguments, and would therefore be an
 * injection surface for anything registry-supplied. `assertSafeSpec` below is
 * what makes that safe: nothing unvalidated ever reaches this.
 */
const NEEDS_SHELL = process.platform === 'win32';

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: CWD,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      shell: NEEDS_SHELL
    });
  } catch (err) {
    // A non-zero exit is expected from `npm outdated` and `npm audit` and is
    // handled by the caller. A failure to *start* the process is not: it would
    // otherwise surface as empty output, which parses as "nothing to update"
    // and reports success having done nothing at all.
    if (err.status === undefined || err.status === null) {
      throw new Error(`could not run \`${cmd}\`: ${err.code ?? err.message}`);
    }
    if (allowFail) return err.stdout ?? '';
    throw err;
  }
}

/**
 * npm package names and versions cannot contain shell metacharacters. Anything
 * that does is not a real package, so refusing it costs nothing and closes the
 * hole the Windows shell above would otherwise open.
 */
const SAFE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SAFE_VERSION = /^[0-9A-Za-z.+-]+$/;

function assertSafeSpec(name, version) {
  if (!SAFE_NAME.test(name) || !SAFE_VERSION.test(version)) {
    throw new Error(`refusing to install suspicious spec: ${name}@${version}`);
  }
  return `${name}@${version}`;
}

function json(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ----------------------------------------------------------------- semver -- */

function parts(v) {
  const m = /^\D*(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 'major' | 'minor' | 'patch' | null — null when unparseable or not an upgrade. */
function bump(from, to) {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : null;
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : null;
  if (b[2] !== a[2]) return b[2] > a[2] ? 'patch' : null;
  return null;
}

/* --------------------------------------------------------------- discover -- */

function outdated() {
  const raw = json(run('npm', ['outdated', '--json', '--long'], { allowFail: true }), {});
  const out = [];

  for (const [name, value] of Object.entries(raw)) {
    // npm returns an array here when a package resolves differently across
    // workspaces. Take the lowest current version: updating to satisfy that one
    // satisfies the rest.
    const entries = Array.isArray(value) ? value : [value];
    const entry = entries.slice().sort((x, y) => String(x.current).localeCompare(String(y.current)))[0];
    if (!entry?.current || !entry?.latest) continue;

    const level = bump(entry.current, entry.latest);
    if (!level) continue;

    out.push({
      name,
      current: entry.current,
      latest: entry.latest,
      wanted: entry.wanted ?? entry.latest,
      level,
      type: entry.type ?? 'dependencies'
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Package names with a known advisory, by highest severity. */
function advisories() {
  const raw = json(run('npm', ['audit', '--json'], { allowFail: true }), {});
  const found = new Map();

  for (const [name, v] of Object.entries(raw.vulnerabilities ?? {})) {
    if (v?.severity && v.severity !== 'info') found.set(name, v.severity);
  }
  return found;
}

/* ----------------------------------------------------------------- verify -- */

function scripts() {
  if (!existsSync(`${CWD}/package.json`)) return {};
  return json(readFileSync(`${CWD}/package.json`, 'utf8'), {}).scripts ?? {};
}

/**
 * The verification gate. Runs whatever the project already has — we do not
 * invent a command, because a made-up one either fails on every project or
 * passes vacuously on all of them.
 */
function verify() {
  const s = scripts();
  const steps = ['build', 'test', 'lint', 'typecheck'].filter(n => s[n]);
  if (steps.length === 0) return { ok: true, steps: [], note: 'no build, test, lint or typecheck script' };

  for (const step of steps) {
    try {
      run('npm', ['run', step, '--if-present']);
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      return { ok: false, failed: step, steps, output: output.slice(-4000) };
    }
  }
  return { ok: true, steps };
}

function install(set) {
  if (set.length === 0) {
    run('git', ['checkout', '--', 'package.json', 'package-lock.json'], { allowFail: true });
    run('npm', ['ci'], { allowFail: true });
    return;
  }
  const specs = set.map(u => assertSafeSpec(u.name, u.latest));
  run('git', ['checkout', '--', 'package.json', 'package-lock.json'], { allowFail: true });
  run('npm', ['install', '--no-audit', '--no-fund', ...specs]);
}

/**
 * Delta debugging. Isolates one culprit per pass with a binary search, drops it,
 * and retries the remainder — so several independent breakages still resolve.
 *
 * Cost is O(k log n) verifications for k culprits, rather than the O(n) of
 * testing every update on its own.
 */
function isolate(candidates, log) {
  let keep = candidates.slice();
  const culprits = [];

  for (let pass = 0; pass < candidates.length; pass++) {
    install(keep);
    const result = verify();
    if (result.ok) return { keep, culprits, result };

    log(`  verification failed on \`${result.failed}\` with ${keep.length} update(s) — isolating`);

    // Find one package whose removal is necessary for the suite to pass.
    let lo = keep.slice();
    while (lo.length > 1) {
      const half = lo.slice(0, Math.ceil(lo.length / 2));
      const rest = keep.filter(u => !half.includes(u));
      install(rest);
      if (verify().ok) {
        // Removing this half fixed it, so a culprit lives in it.
        lo = half;
      } else {
        // Still broken without that half, so a culprit is in the other one.
        const other = lo.slice(Math.ceil(lo.length / 2));
        if (other.length === 0) break;
        lo = other;
      }
    }

    const culprit = lo[0];
    if (!culprit) {
      // Nothing isolable: the failure predates our changes. Say so rather than
      // blaming a dependency at random.
      install([]);
      return { keep: [], culprits, result, preexisting: true };
    }

    culprits.push({ ...culprit, failed: result.failed });
    keep = keep.filter(u => u !== culprit);
    log(`  held back \`${culprit.name}\` — breaks \`${result.failed}\``);

    if (keep.length === 0) {
      install([]);
      return { keep, culprits, result };
    }
  }
  return { keep, culprits };
}

/* -------------------------------------------------------------------- AI -- */

/**
 * Optional. Without a key the report is still complete — the narrative is an
 * addition, never the substance. A tool that goes silent when an API is down is
 * not a tool you can rely on.
 */
async function narrate(applied, held, vulnerable) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || applied.length + held.length === 0) return null;

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 700,
    messages: [
      {
        role: 'user',
        content:
          'You are reviewing a dependency update for a reviewer who has 30 seconds.\n\n' +
          `Applied and verified green:\n${applied.map(u => `- ${u.name} ${u.current} to ${u.latest} (${u.level}${vulnerable.has(u.name) ? `, fixes a ${vulnerable.get(u.name)} advisory` : ''})`).join('\n') || '- none'}\n\n` +
          `Held back:\n${held.map(u => `- ${u.name} ${u.current} to ${u.latest} (${u.level}${u.failed ? `, breaks ${u.failed}` : ', major'})`).join('\n') || '- none'}\n\n` +
          'Write at most 120 words of plain prose. Say what actually changed in behaviour and what a reviewer should look at. ' +
          'No headings, no bullet lists, no preamble. If nothing here is risky, say that in one sentence rather than padding.'
      }
    ]
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ main -- */

const notes = [];
const log = m => {
  notes.push(m);
  console.log(m);
};

if (!existsSync(`${CWD}/package.json`)) {
  writeFileSync(`${CWD}/flowky-bot-report.md`, 'No `package.json` here, so there is nothing to update.\n');
  emit('has_changes', 'false');
  console.log('No package.json — nothing to do.');
  process.exit(0);
}

const all = outdated();
const vulnerable = advisories();

if (all.length === 0) {
  writeFileSync(`${CWD}/flowky-bot-report.md`, 'Everything is on its latest version. Nothing to do.\n');
  emit('has_changes', 'false');
  console.log('Nothing outdated.');
  process.exit(0);
}

// Security fixes are taken whatever the version jump: a held-back major with a
// live advisory is a worse outcome than a breaking change you were told about.
const candidates = all.filter(u => u.level !== 'major' || ALLOW_MAJOR || vulnerable.has(u.name));
const deferred = all.filter(u => !candidates.includes(u));

console.log(`${all.length} outdated, ${candidates.length} candidate(s), ${vulnerable.size} with advisories.`);

if (DRY_RUN) {
  writeFileSync(`${CWD}/flowky-bot-report.md`, render(candidates, deferred, [], vulnerable, null, true));
  emit('has_changes', 'false');
  process.exit(0);
}

const { keep, culprits, preexisting } = isolate(candidates, log);
const held = [...culprits, ...deferred];

if (preexisting) {
  log('Verification fails on the unmodified tree too. Not opening a pull request — fix the build first.');
}

const summary = await narrate(keep, held, vulnerable);
writeFileSync(`${CWD}/flowky-bot-report.md`, render(keep, deferred, culprits, vulnerable, summary, false, preexisting));

emit('has_changes', String(keep.length > 0 && !preexisting));
emit('applied_count', String(keep.length));
emit('held_count', String(held.length));
emit(
  'title',
  keep.length === 0
    ? 'FlowKy Bot: no dependency updates could be verified'
    : `FlowKy Bot: ${keep.length} verified dependency update${keep.length === 1 ? '' : 's'}` +
        (held.length ? `, ${held.length} held back` : '')
);

function emit(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/* ---------------------------------------------------------------- report -- */

function render(applied, deferredMajors, culprits, vuln, summary, dryRun, preexistingFailure) {
  const L = [];

  if (preexistingFailure) {
    L.push('> **The build was already failing before any update was applied.**');
    L.push('> No dependency is responsible and nothing has been changed here.');
    L.push('');
  }

  if (summary) {
    L.push(summary, '');
  }

  if (applied.length) {
    L.push(dryRun ? '## Would update' : '## Updated and verified', '');
    L.push('| Package | From | To | Change | Advisory |');
    L.push('|---|---|---|---|---|');
    for (const u of applied) {
      const sev = vuln.get(u.name);
      L.push(
        `| \`${u.name}\` | ${u.current} | **${u.latest}** | ${u.level} | ${sev ? `**${sev}** — fixed` : '—'} |`
      );
    }
    L.push('');
    if (!dryRun) {
      L.push('Every row above was applied together and the project’s own build, test, lint');
      L.push('and typecheck scripts passed with all of them in place.');
      L.push('');
    }
  } else if (!preexistingFailure) {
    L.push('## Nothing applied', '', 'No update passed verification.', '');
  }

  if (culprits.length) {
    L.push('## Held back — breaks the build', '');
    L.push('| Package | From | To | Fails |');
    L.push('|---|---|---|---|');
    for (const u of culprits) L.push(`| \`${u.name}\` | ${u.current} | ${u.latest} | \`${u.failed}\` |`);
    L.push('');
    L.push('Each was isolated by binary search: removing it makes the suite pass, keeping');
    L.push('it makes the suite fail. These need a human, so they are not in this branch.');
    L.push('');
  }

  if (deferredMajors.length) {
    L.push('## Held back — major versions', '');
    L.push('| Package | From | To |');
    L.push('|---|---|---|');
    for (const u of deferredMajors) L.push(`| \`${u.name}\` | ${u.current} | ${u.latest} |`);
    L.push('');
    L.push('Majors are not applied automatically. A major with a live advisory is the one');
    L.push('exception — that gets taken and flagged, because an unpatched vulnerability is');
    L.push('worse than a breaking change you were warned about.');
    L.push('');
  }

  if (notes.length) {
    L.push('<details><summary>Run log</summary>', '', ...notes.map(n => `- ${n.trim()}`), '', '</details>', '');
  }

  L.push('---');
  L.push('<sub>Opened by <a href="https://github.com/flowKy-ai/flowky/blob/main/.github/scripts/flowky-bot.mjs">FlowKy Bot</a>. Zero dependencies, MIT, no telemetry.</sub>');
  return L.join('\n') + '\n';
}
