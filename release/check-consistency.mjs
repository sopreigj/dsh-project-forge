/**
 * release/check-consistency.mjs — the two internal duplications that must not drift.
 *
 * 1. `docs/configuration.md` is the user-facing reference for every config field, and
 *    `plugin/config/schema.js`'s `DEFAULTS` is the code that implements them. Those two were written by
 *    hand from the same facts once, and drifted: the README still documented `digestTailLimits`
 *    after the schema renamed it, which is exactly what broke a session resume on 2026-10-16.
 *    The check parses the table's default column as JSON and compares it to `DEFAULTS`, so a
 *    rename or default change fails here instead of at the next restart.
 *
 * 2. The bundled grilling skill exists twice — `skills/` for the main bundle and
 *    `review/skills/` for the review bundle, because each bundle resolves its own package and
 *    cannot reach into the other (`cordis.patch.yml` in both points `customSkillDirs` at its own
 *    copy). The duplication is deliberate; silently letting the copies differ is not.
 *
 * 3. A rename is not finished while a retired word survives somewhere on the public surface — the
 *    two READMEs, a comment in the patch, the mode-picker cards and the patch row description all
 *    kept one at different times.
 *
 * 4. The public docs name repository paths, and a doc that still points at a renamed or deleted
 *    file is a stale doc — protocol §3 calls that a defect, and only a human reading it could
 *    notice. Both inline paths (`release/check-runtime.mjs`) and relative markdown link targets
 *    are resolved against the tree.
 *
 * Usage: node release/check-consistency.mjs   (exit 1 on any mismatch)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../plugin/config/schema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/** Key-order-independent form, so a table row and `DEFAULTS` compare equal when they say the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ── 1. the configuration reference versus the schema's defaults ────────────────
const reference = join(root, 'docs', 'configuration.md');
const documented = new Map();
for (const line of readFileSync(reference, 'utf8').split('\n')) {
  // `| \`field\` | \`default\` | meaning |` — the default cell is a JSON literal by design.
  const row = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
  if (row === null) continue;
  try {
    documented.set(row[1], JSON.parse(row[2]));
  } catch {
    failures.push(`docs/configuration.md: ${row[1]} 的默认值不是合法 JSON 字面量：${row[2]}`);
  }
}
for (const [field, value] of Object.entries(DEFAULTS)) {
  if (!documented.has(field)) {
    failures.push(`docs/configuration.md 没有记载字段 ${field}`);
    continue;
  }
  if (canonical(documented.get(field)) !== canonical(value)) {
    failures.push(`docs/configuration.md: ${field} 写作 ${canonical(documented.get(field))}，schema 是 ${canonical(value)}`);
  }
}
for (const field of documented.keys()) {
  if (!Object.hasOwn(DEFAULTS, field)) failures.push(`docs/configuration.md 多出一个 schema 里没有的字段：${field}`);
}

// ── 2. the two copies of the bundled skill ─────────────────────────────────────
const copies = ['skills/project-forge-grilling/SKILL.md', 'review/skills/project-forge-grilling/SKILL.md'];
const [primary, review] = copies.map((path) => readFileSync(join(root, path), 'utf8'));
if (primary !== review) {
  failures.push(`${copies[0]} 与 ${copies[1]} 内容不一致——两份自包含 bundle 各带一份，必须逐字节相同`);
}

// ── 3. retired vocabulary must not come back into the public surface ───────────
// A rename is finished only when *every* copy stopped using the old word, and this repository has
// been bitten four times by a copy that kept it (the two READMEs, a comment in the patch, the
// mode-picker cards, the patch row description). The check is mechanical: a retired term anywhere
// outside the state boundary fails, unless that very line carries the marker
// `vocabulary-guard: allow` next to a reason.
const RETIRED = new Map([
  ['tortuous.md', 'negative knowledge is append-only JSONL: `tortuous.jsonl`'],
  ['journal.md', 'the work record is append-only JSONL: `journal.jsonl`'],
  ['digestTailLimits', 'renamed to `documentBudgets` — the drift that once broke session resume'],
  ['digestDefaultTailLimit', 'renamed to `documentBudgetDefault`'],
  ['层级聚类', 'D11: 分层模块化 + 明确边界与依赖方向'],
  ['层级模块架构', 'D11 rendering variant: 分层模块化 + 明确边界与依赖方向'],
  ['layered module hierarchy', 'D11: layered modularity with explicit module boundaries'],
]);
const TEXT_FILE = /\.(md|json|jsonl|ya?ml|js|mjs|cjs|ts|ps1|sh|svg|txt)$/;
const SKIP_DIR = new Set(['.git', 'node_modules', 'private']);
const SELF = join(root, 'release', 'check-consistency.mjs');

/** The public surface: the state boundary and the tool directories are not part of it. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

let scanned = 0;
for (const file of walk(root)) {
  if (file === SELF || !TEXT_FILE.test(file)) continue; // `SELF` is where the list itself lives
  scanned += 1;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('vocabulary-guard: allow')) return;
      for (const [term, reason] of RETIRED) {
        if (line.includes(term)) {
          failures.push(`${relative(root, file)}:${index + 1} 出现退役用词「${term}」（${reason}）`);
        }
      }
    });
}

// ── 4. every repository path the public docs name must exist ───────────────────
// Two shapes are checked: an inline path whose first segment is a public top-level directory, and
// a relative markdown link target. A line may opt out with `path-guard: allow` plus its reason —
// for a path that belongs to the reader's project rather than to this repository.
const PUBLIC_DOCS = [
  'README.md',
  'README.zh.md',
  ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
];
const TOP_LEVEL = ['docs', 'plugin', 'release', 'skills', 'review', 'locale'];
const INLINE_PATH = new RegExp(`(?<![\\w./-])((?:${TOP_LEVEL.join('|')})/[\\w./-]*\\.(?:mjs|cjs|js|md|json|ya?ml|ps1))`, 'g');
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

let docPaths = 0;
for (const doc of PUBLIC_DOCS) {
  readFileSync(join(root, doc), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('path-guard: allow')) return;
      const candidates = [...line.matchAll(INLINE_PATH)].map((match) => match[1]);
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1].split('#')[0];
        if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
        candidates.push(relative(root, resolve(root, dirname(doc), target)).replace(/\\/g, '/'));
      }
      for (const candidate of candidates) {
        docPaths += 1;
        if (!existsSync(join(root, candidate))) failures.push(`${doc}:${index + 1} 引用了不存在的路径 ${candidate}`);
      }
    });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nconsistency: ${failures.length} 处不一致`);
  process.exit(1);
}
console.log(`consistency: clean（配置表 ${documented.size} 个字段 ↔ schema；技能两份副本一致；公开面 ${scanned} 个文件无退役用词；文档 ${docPaths} 处路径引用真实存在）`);
