/**
 * Scaffold a project for Project Forge Mode: the state boundary, four contract documents and the
 * claim directory, plus the `.gitignore` line the claims need.
 *
 * Usage: node release/init-project.mjs [projectRoot]
 *
 * privacy-guard: allow — this script's whole job is to create and mention the state
 * boundary, so the "source reaches into private/" rule cannot apply to it.
 *
 * Never overwrites an existing file — running it twice is safe, and it prints what it skipped.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? process.cwd());
const boundary = join(root, 'private');
const created = [];
const skipped = [];

function write(relative, content) {
  const target = join(root, relative);
  if (existsSync(target)) {
    skipped.push(relative);
    return;
  }
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content.replace(/\n/g, '\r\n'));
  created.push(relative);
}

write('private/steward.md', [
  '# steward.md — 本仓库自己的规则',
  '',
  '## 这个仓库是什么',
  '',
  '<!-- 一句话说清这个项目是什么、有哪些主要目录。 -->',
  '',
  '## 受控词汇',
  '',
  '<!-- 概念 → 唯一用词 → 不要写成。新词先查这里再创造。 -->',
  '',
].join('\n'));

write('private/plan.md', [
  '# plan.md — 全局计划',
  '',
  '# Goal',
  '',
  '<!-- 要达成什么，成功标准是什么（可检验）。 -->',
  '',
  '# 当前方向',
  '',
  '<!-- 一次只写一个当前方向：现在做什么、为什么。 -->',
  '',
  '# Phases',
  '',
  '# Risks and mitigations',
  '',
  '# Open questions',
  '',
  '# Corrections',
  '',
].join('\n'));

write('private/done.md', [
  '# done.md',
  '',
  '## Verification',
  '',
  '<!-- 跑过的命令与观察到的结果。 -->',
  '',
  '## Drift',
  '',
  '## Current state',
  '',
  '<!-- 现在存在且可工作的东西；最常改，所以放最后。 -->',
  '',
].join('\n'));

write('private/todo.md', [
  '# todo.md — 执行队列',
  '',
  '## 排队',
  '',
  '## 待验证',
  '',
  '## 等用户',
  '',
  '## 现在做',
  '',
].join('\n'));

// The claim directory is runtime state and must never be committed.
const gitignore = join(root, '.gitignore');
const claimLine = 'private/.forge-claims/';
const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
if (!current.split(/\r?\n/).includes(claimLine)) {
  appendFileSync(gitignore, (current.length > 0 && !current.endsWith('\n') ? '\n' : '') + claimLine + '\n');
  created.push('.gitignore (+1 line)');
} else {
  skipped.push('.gitignore (line already present)');
}

console.log(created.length > 0 ? 'created:' : 'nothing to create');
for (const path of created) console.log('  ' + path);
if (skipped.length > 0) {
  console.log('left alone (already there):');
  for (const path of skipped) console.log('  ' + path);
}
const nextStep = existsSync(join(root, '.git'))
  ? 'review the four documents the initializer wrote'
  : 'git init, then review the four documents the initializer wrote';
const layoutNote = existsSync(join(root, 'private'))
  ? 'the mode reads ' + boundary + ' on every session'
  : 'the mode also accepts documents kept at the project root';
console.log('\nnext: ' + nextStep + ' — ' + layoutNote + '.');
