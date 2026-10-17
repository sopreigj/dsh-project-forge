#!/usr/bin/env node
/**
 * release/check-prompt-variables.mjs — every `{{name}}` a preset contributes to the system
 * prompt must be a variable the harness actually registers.
 *
 * `dsh-system-prompt` interpolates every section and context entry strictly: a `{{name}}`
 * that is not registered throws during prompt assembly, *before any model request*. That
 * is not a warning the model can route around — it kills every turn of every session that
 * selected the preset. The failure this check was written for is real: both of this repo's
 * patches carried `suffix: Your working directory is {{cwd}}.` in their persona row, and
 * the loop registers only `provider` and `model`, so the mode was dead on arrival for
 * anyone who picked it.
 *
 * The registered set is derived from the source, not written here: agent-loop is the only
 * global registrar (`packages/core/agent-loop/src/index.ts`). A harness that adds a
 * variable widens what is allowed without touching this file; one that removes one turns
 * this check red until the patch stops relying on it. Without a source tree the check
 * fails closed on the documented minimum rather than silently allowing everything —
 * "we could not look" must not read as "it is fine".
 *
 * Scope: prompt text only. A `{{...}}` in a tool schema, a skill document, or a plugin's own
 * `interpolate: false` context is a different mechanism (or literal prose) and is not
 * scanned here.
 *
 * Usage: node release/check-prompt-variables.mjs [--source <dsh-checkout>]
 * Exit code 0 = every reference resolves; 1 = at least one does not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Variables the agent loop registers globally, read out of the harness source.
 */
function registeredVariables() {
  const given = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : process.env.DSH_SOURCE;
  const candidates = given
    ? [join(given, 'packages', 'core', 'agent-loop', 'src', 'index.ts'), join(given, 'src', 'index.ts')]
    : [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const found = new Set();
    for (const match of readFileSync(candidate, 'utf8').matchAll(/systemPrompt\.variable\(\s*['"](\w+)['"]/g)) {
      found.add(match[1]);
    }
    return { found, source: candidate };
  }
  return { found: new Set(), source: null };
}

const { found, source } = registeredVariables();
// Fail closed: the loop's own registrations are a stable contract, so a machine without the
// source tree still enforces them. Anything beyond that needs the source to prove.
const allowed = new Set(['provider', 'model']);
if (found.size > 0) for (const name of found) allowed.add(name);

/**
 * Every prompt-contributing text in a preset patch, with the line it came from.
 *
 * The rows that render into the system prompt are the ones carrying `prefix` / `suffix`
 * (persona) or `section` (plan mode) under a `config:` block. Scanning those keys by name
 * — rather than the whole file — keeps the check honest about what it covers: a `{{...}}`
 * elsewhere in the patch is a value for some other mechanism and is not this failure.
 */
function promptTexts(file, relative) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const entries = [];
  let configIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0) {
      configIndent = -1; // a top-level key ends any row's config block
      continue;
    }
    if (configIndent < 0) {
      if (/^\s*config:\s*$/.test(line)) configIndent = indent;
      continue;
    }
    if (indent <= configIndent) {
      configIndent = -1; // the config block ended
      continue;
    }
    // A prompt-text key. `|`/`>` block scalars are read on their following indented lines.
    const key = /^\s*(prefix|suffix|section):\s*(.*)$/.exec(line);
    if (key === null) continue;
    if (key[2].trim() !== '') {
      entries.push({ file: relative, line: i + 1, text: key[2] });
      continue;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j];
      if (body.trim() === '' || /^\s*#/.test(body)) continue;
      if (body.match(/^\s*/)[0].length <= indent) break;
      entries.push({ file: relative, line: j + 1, text: body });
    }
  }
  return entries;
}

const patches = [
  join(root, 'cordis.patch.yml'),
  join(root, 'review', 'cordis.patch.yml'),
].filter((path) => existsSync(path));

if (patches.length === 0) {
  console.error('prompt variables: 0 份 patch 被扫到——本检查失去了对象');
  process.exit(1);
}

const failures = [];
let references = 0;
for (const patch of patches) {
  const relative = patch.slice(root.length + 1).replace(/\\/g, '/');
  for (const entry of promptTexts(patch, relative)) {
    // Strip a trailing YAML comment so `{{...}} # note` is not read as part of the reference.
    const text = entry.text.replace(/\s+#.*$/, '');
    for (const match of text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
      references += 1;
      if (!allowed.has(match[1])) {
        failures.push(`${relative}:${entry.line} 的提示词文本引用了未注册的变量 {{${match[1]}}}——组装 system prompt 时会抛错，选中该模式的每个回合都会失败（已注册：${[...allowed].sort().join(', ')}）`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nprompt variables: ${failures.length} 处无法解析`);
  process.exit(1);
}
console.log(`prompt variables: ok（${patches.length} 份 patch 的 persona/section 文本共 ${references} 处 {{...}} 引用，全部在已注册集合内${source ? `；真值来自 ${source.replace(/\\/g, '/')}` : '；未提供源码树，按文档化的最小集合 provider/model 检查'}）`);