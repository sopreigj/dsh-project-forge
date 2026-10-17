/**
 * Shell-command parsing shared by the git guards (escape detection, live-checkpoint detection).
 *
 * privacy-guard: allow — naming the state boundary and the machine-specific patterns is this file's job;
 * the unit tests are the reason it may.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  stripQuoted,
} from '../shared/index.js';
/**
 * The shell command a tool call carries, if any.
 *
 * Every guard used to open with a check on the tool NAME (pwsh/bash), so a shell command wrapped
 * in another tool — an MCP tool whose arguments carry a "command" field, say — was never
 * inspected. Any tool's command/cmd argument is inspected now; stripQuoted still removes quoted
 * spans, so prose that merely mentions a command does not deny the call.
 * @param execution - the read-only tool execution handed to a guard.
 * @returns the command string, or undefined when this call carries none.
 */
export function shellCommandOf(execution) {
  const args = execution.arguments;
  if (args === null || typeof args !== "object") return undefined;
  const candidate = args.command ?? args.cmd;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Git global options that consume a value, so the token after them is not the subcommand.
 * `git -c x=y push` and `git --no-pager push` both publish; matching `git\s+push` alone missed them.
 */
const GIT_VALUE_OPTION = /^(?:-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)(?:=(.*))?$/;
/** Where one shell command ends, so the args of `git status` do not bleed into the next command. */
const COMMAND_SEPARATOR = /[;&|#\n]/;
/** Wrappers whose quoted argument is itself a command line. */
const SHELL_WRAPPER = /^\s*(?:bash|sh|zsh|dash|pwsh|powershell|cmd|wsl|node|deno|bun|python3?|perl|ruby)\b/;
/** Publishing verbs, including the plumbing that performs the same transfer as `git push`. */
const PUBLISH_VERB = 'push|send-pack';

/**
 * Whether the push arguments ask for a history rewrite.
 * Read from the parsed arguments rather than the raw line, so `git -c x=y push -f` is seen too.
 * @param args - the text following the subcommand.
 * @returns true when a force flag is present.
 */
function isForced(args) {
  return /(?:^|\s)(?:-f|--force|--force-with-lease|--force-if-includes)\b/.test(args);
}

/**
 * Split one bare command line into the git invocations it contains, skipping global options.
 * @param bare - the command with quoted spans already removed.
 * @returns each `{ verb, args }`, where verb is the subcommand and args the text that follows it.
 */
function gitInvocations(bare) {
  const found = [];
  const token = /\bgit\b/g;
  while (token.exec(bare) !== null) {
    const words = bare.slice(token.lastIndex).split(/\s+/).filter((word) => word.length > 0);
    let index = 0;
    while (index < words.length && words[index].startsWith('-')) {
      const option = GIT_VALUE_OPTION.exec(words[index]);
      index += option !== null && option[1] === undefined ? 2 : 1;
    }
    if (index >= words.length) continue;
    const verb = words[index];
    const rest = words.slice(index + 1).join(' ');
    found.push({ verb, args: rest.split(COMMAND_SEPARATOR)[0] });
  }
  return found;
}

/**
 * Decide whether one shell command escapes the local-only git contract.
 *
 * Only shapes a command line can show are decidable here — a push performed inside an opaque script
 * (`node -e`, a build tool) is beyond a text guard, and saying so is part of the contract.
 * @param command - the command line handed to a shell tool.
 * @returns the offending label and fragment, or undefined when acceptable.
 */
export function localGitEscape(command) {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const bare = stripQuoted(command);
  // A wrapper hides its payload in quotes, which stripQuoted removes; scan the raw text as well so
  // `bash -c "git push"` is seen. Conservative by design: this only runs for wrapper-shaped calls.
  const candidates = SHELL_WRAPPER.test(command) ? [bare, command] : [bare];
  for (const text of candidates) {
    for (const { verb, args } of gitInvocations(text)) {
      const fragment = `git ${verb}${args.length > 0 ? ` ${args}` : ''}`.trim();
      // The label is a stable key: the guard branches on 'git push' for grants and force detection,
      // so it stays exactly that for a push and names the plumbing separately.
      if (verb === 'push') return { label: 'git push', fragment, forced: isForced(args) };
      if (verb === 'send-pack') return { label: 'git send-pack', fragment, forced: isForced(args) };
      if (verb === 'remote' && /^(?:add|set-url)\b/.test(args)) return { label: 'git remote add/set-url', fragment };
      if (verb === 'reset' && /--hard\b/.test(args)) return { label: 'git reset --hard', fragment };
      if (verb === 'clean' && /-[a-z]*f/.test(args)) return { label: 'git clean -f', fragment };
      if (verb === 'branch' && /-D\b/.test(args)) return { label: 'git branch -D', fragment };
      if (verb === 'config' && new RegExp(`alias\\.[\\w-]+\\s+(?:${PUBLISH_VERB})\\b`).test(args)) {
        return { label: 'git config alias.* push', fragment };
      }
    }
  }
  // `gh` publishes without git: an API mutation can create the very ref a push would have.
  // Only the group name is captured; the rest is read as one tail, because a flag like `-X` would
  // otherwise be half-swallowed by the sub-command group (`[a-z-]+` stops at the uppercase X).
  const gh = /\bgh\s+([a-z][a-z-]*)([^;&|#\n]*)/.exec(bare);
  if (gh !== null) {
    const [, group, tail] = gh;
    if (group === 'api' && /(?:^|\s)(?:-X\s*|--method[= ])(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-f|--field|--raw-field|--input)\b/i.test(tail)) {
      return { label: 'gh api (mutating)', fragment: `gh api ${tail.trim()}`.trim() };
    }
    if (group === 'release' && /^\s+(?:create|delete|edit)\b/.test(tail)) {
      return { label: 'gh release create/delete/edit', fragment: `gh release${tail.trimEnd()}` };
    }
  }
  return undefined;
}

/**
 * The subcommands one shell command actually runs, with every git global option skipped.
 *
 * This is the single parser every commit- and push-gated guard reads: a guard that matched the raw
 * text instead would treat `git -C . commit` or `git -c user.name=x commit` as "not a commit" and
 * skip silently — the shape a legal command takes, not an exotic one.
 * @param command - the command line handed to a shell tool.
 * @returns the subcommands in order (may be empty).
 */
export function gitSubcommands(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const bare = stripQuoted(command);
  const candidates = SHELL_WRAPPER.test(command) ? [bare, command] : [bare];
  const verbs = [];
  for (const text of candidates) {
    for (const { verb } of gitInvocations(text)) verbs.push(verb);
  }
  return verbs;
}

/**
 * Decide whether one shell command is a commit that the checkpoint protocol governs.
 * @param command - the command line handed to a shell tool.
 * @returns true when the command commits.
 */
export function isCommitCommand(command) {
  return gitSubcommands(command).includes('commit');
}