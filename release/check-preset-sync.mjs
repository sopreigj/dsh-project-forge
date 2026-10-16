#!/usr/bin/env node
/**
 * release/check-preset-sync.mjs — is this bundle's preset still in sync with the shipped one?
 *
 * `cordis.patch.yml` does not inherit from the shipped `standard` preset: it copies its rows so
 * that the mode is self-contained (`config.plugins` are matched by id, and the profile patch can
 * override them). Copying means the copy can lag: when the harness gains a row, or a row gains a
 * config key, this bundle silently keeps the old shape. That is the same class of defect as the
 * patch↔schema drift that once broke session resume, so it gets the same treatment — a check that
 * fails, with the difference printed, and a short list of differences that are deliberate.
 *
 * The list below is the *whole* allowed difference. Anything else fails, which forces a decision:
 * either adopt the upstream row/key, or record it here as deliberate (and say why).
 *
 * Point it at a DSH checkout with `--source <dir>` or `$DSH_SOURCE` (either the checkout root or
 * the `presets/` directory). Without one it prints a skip note and exits 0 — a machine that has no
 * DSH source tree is not a failure, and no path is hard-coded into this file.
 *
 * Usage: node release/check-preset-sync.mjs [--source <dsh-checkout>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Rows the shipped `standard` preset has and this bundle deliberately does not. */
const DELIBERATE_ABSENCE = new Map([
  ['delegation/tool-ralph', 'a ralph loop is not project work; enable it per session if wanted'],
  ['delegation/tool-subagent-codex', 'codex delegation is not part of this mode'],
  ['delegation/tool-subagent-claude-code', 'claude-code delegation is not part of this mode'],
]);
/** Rows this bundle adds on top of the shipped preset. */
const DELIBERATE_ADDITION = new Map([
  ['project-forge', 'the mode itself'],
  ['tool-str-replace-editor', 'the mode edits files structure-aware; `standard` ships no such row'],
]);
/** Config keys this bundle adds to a shared row (the row exists in both). */
const DELIBERATE_CONFIG_ADDITION = new Map([
  ['skill-filesystem.config.customSkillDirs', 'ships the mode’s own grilling skill'],
]);

/** Indentation-aware row scanner: `- id: x` lines, plus each row's own and config keys. */
function parseRows(text) {
  const rows = new Map();
  const lines = text.split('\n');
  const stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const hit = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line);
    if (hit === null) continue;
    const indent = hit[1].length;
    const id = hit[2].replace(/^['"]|['"]$/g, '');
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1].id : '';
    const path = parent === '' ? id : `${parent}/${id}`;
    stack.push({ indent, id: path });

    const keys = new Set();
    let inConfig = false;
    let configIndent = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === '' || /^\s*#/.test(next)) continue;
      const nextIndent = next.match(/^\s*/)[0].length;
      if (nextIndent <= indent) break; // the row ended
      const key = /^\s*([A-Za-z_][\w-]*):/.exec(next);
      if (key !== null) {
        if (nextIndent === indent + 2) {
          if (key[1] === 'config') {
            inConfig = true;
            configIndent = nextIndent;
          } else {
            keys.add(key[1]);
          }
        } else if (inConfig && nextIndent === configIndent + 2) {
          keys.add(`config.${key[1]}`);
        }
      }
    }
    rows.set(path, keys);
  }
  return rows;
}

function findShippedPreset() {
  const given = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : process.env.DSH_SOURCE;
  if (given === undefined || given === '') return null;
  const candidates = [
    join(given, 'standard.patch.yml'),
    join(given, 'packages', 'bundle', 'web-app', 'presets', 'standard.patch.yml'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const shippedPath = findShippedPreset();
if (shippedPath === null) {
  console.log('preset sync: skipped（未提供 DSH 源码树；用 --source <dir> 或 $DSH_SOURCE 指定）');
  process.exit(0);
}

/** Compare inside the preset: drop the outer preset row, whose id differs by design. */
function insidePreset(rows) {
  const inner = new Map();
  for (const [path, keys] of rows) {
    const cut = path.indexOf('/');
    if (cut === -1) continue; // the preset row itself
    inner.set(path.slice(cut + 1), keys);
  }
  return inner;
}

const shipped = insidePreset(parseRows(readFileSync(shippedPath, 'utf8')));
const ours = insidePreset(parseRows(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')));

const failures = [];
const notes = [];

for (const [path, keys] of shipped) {
  if (!ours.has(path)) {
    if (DELIBERATE_ABSENCE.has(path)) notes.push(`缺 ${path}（刻意：${DELIBERATE_ABSENCE.get(path)}）`);
    else failures.push(`shipped 有、本仓没有：${path}——要么采用它，要么加进 DELIBERATE_ABSENCE 并说明理由`);
    continue;
  }
  for (const key of keys) {
    if (key === 'name' || key === 'id' || key === 'disabled') continue;
    if (ours.get(path).has(key)) continue;
    const full = `${path}.${key}`;
    if (DELIBERATE_CONFIG_ADDITION.has(full) || DELIBERATE_ABSENCE.has(full)) continue;
    failures.push(`共同行 ${path} 丢了 shipped 设的字段 ${key}`);
  }
}
for (const path of ours.keys()) {
  if (shipped.has(path)) continue;
  if (DELIBERATE_ADDITION.has(path)) notes.push(`多出 ${path}（本仓自有：${DELIBERATE_ADDITION.get(path)}）`);
  else failures.push(`本仓有、shipped 没有：${path}——确认它是否需保留，并加进 DELIBERATE_ADDITION`);
}
for (const path of ours.keys()) {
  if (!shipped.has(path)) continue;
  for (const key of ours.get(path)) {
    if (key === 'name' || key === 'id' || key === 'disabled') continue;
    if (shipped.get(path).has(key)) continue;
    const full = `${path}.${key}`;
    if (DELIBERATE_CONFIG_ADDITION.has(full)) notes.push(`额外字段 ${full}（刻意：${DELIBERATE_CONFIG_ADDITION.get(full)}）`);
    else notes.push(`额外字段 ${full}（本仓新增；确认后加进 DELIBERATE_CONFIG_ADDITION）`);
  }
}

for (const note of notes) console.log(`· ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\npreset sync: ${failures.length} 处需要处理（shipped: ${shippedPath}）`);
  process.exit(1);
}
console.log(`preset sync: ok（本仓 ${ours.size} 行 / shipped ${shipped.size} 行，差异全部已记录）`);
