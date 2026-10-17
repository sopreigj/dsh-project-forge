/**
 * Fixtures shared by the Project Forge mode checks.
 *
 * privacy-guard: allow — this is a fixture set: it writes home paths, boundary paths and secret
 * literals into throwaway repositories to prove what the guards refuse, so the privacy scan is
 * deliberately not applied to it.
 *
 * Everything here is **state the checks share**, not a check: a stub Cordis context that records
 * what a plugin registered, a throwaway project holding the four documents, and the small helpers
 * (drive one `agent/created`, build a shell execution, initialise a real repository). The checks
 * live beside this file, one per slice, and the runner imports them in their original order.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pluginPath = resolve(process.argv[2] ?? '.');
export const plugin = await import(pathToFileURL(pluginPath).href);

// The shared slice, imported beside the plugin: the composition root does not re-export its
// helpers, and a check that proves something about one of them (the remote-URL fallback) must be
// able to call it rather than re-implement it.
export const sharedSlice = await import(pathToFileURL(join(dirname(pluginPath), 'shared', 'index.js')).href);

export const standard = plugin.Config['~standard'];

// ── Stub Cordis context ─────────────────────────────────────────────────────────
/** Records sections, contexts, listeners, effects, guards and log lines. */
export function makeCtx() {
  const record = { sections: [], contexts: [], listeners: [], effects: 0, logs: [], guards: [] };
  const ctx = {
    record,
    effect(factory) {
      record.effects += 1;
      return factory();
    },
    on(name, handler) {
      record.listeners.push({ name, handler });
      return () => {};
    },
    logger: {
      info: (...args) => record.logs.push(['info', ...args]),
      warn: (...args) => record.logs.push(['warn', ...args]),
    },
    tools: {
      guard(guard) {
        record.guards.push(guard);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section);
        return () => {};
      },
      context(context) {
        record.contexts.push(context);
        return () => {};
      },
    },
  };
  return { ctx, record };
}

export const project = mkdtempSync(join(tmpdir(), 'steward-'));

/** Drive one agent/created event and return the digest context. */
export function createdAgent(record, cwd, sessionId = 'session-test') {
  const contexts = [];
  const agent = {
    id: sessionId,
    session: { header: { cwd, id: sessionId }, surface: { replaceGeneration: 0 } },
    ctx: {
      effect: (factory) => factory(),
      on: (name, handler) => {
        const entry = { name, handler, agent };
        record.listeners.push(entry);
        agent.ctx.registered.push(entry);
        return () => {};
      },
      systemPrompt: {
        section: () => () => {},
        context: (context) => {
          contexts.push(context);
          return () => {};
        },
      },
      registered: [],
    },
  };
  for (const listener of record.listeners.filter((entry) => entry.name === 'agent/created')) {
    listener.handler({ agent });
  }
  return { agent, contexts };
}

/** Names registered on an agent's own context, which is where `session/event` arrives. */
export function agentListeners(agent) {
  return agent.ctx.registered ?? [];
}

/** Build one shell-tool execution for an agent. */
export function shell(command, agent) {
  return { name: 'pwsh', arguments: { command }, agent };
}

/** Initialise a real repository, because the digest reads `.git` directly. */
export function initRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'steward@test');
  git('config', 'user.name', 'steward');
}

export const PROJECT_MARKERS = {
  plan: 'PLAN-MARK',
  todo: 'TODO-MARK',
  done: 'DONE-MARK',
  // The negative-knowledge record: its headline reaches the derived index (the `conclusion` is
  // preferred, then `title`), while its prose must never be inlined. The fixture used to write the
  // retired `tortuous.md` — vocabulary-guard: allow (naming it says what the fixture got wrong),
  // which the plugin never reads, so the "never inlined" assertion below
  // passed without testing anything.
  tortuousHeadline: 'TORTUOUS-HEADLINE-MARK',
  tortuousProse: 'TORTUOUS-PROSE-MARK',
};

// The fixture project the digest checks read: four documents, the project rule file, one commit.
  writeFileSync(join(project, 'plan.md'), `# plan\n${PROJECT_MARKERS.plan}\n`);
  writeFileSync(join(project, 'todo.md'), `# todo\n${PROJECT_MARKERS.todo}\n`);
  writeFileSync(join(project, 'done.md'), `# done\n${PROJECT_MARKERS.done}\n`);
  writeFileSync(join(project, 'tortuous.jsonl'), `${JSON.stringify({ id: 'T1', kind: 'route', title: PROJECT_MARKERS.tortuousHeadline, observed: PROJECT_MARKERS.tortuousProse })}\n`);
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'steward.md'), '# repo rules\nSTEWARD-MARK\n');
  initRepo(project);
  writeFileSync(join(project, 'src.txt'), 'hello\n');
  execFileSync('git', ['add', '-A'], { cwd: project, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: project, stdio: 'pipe' });

