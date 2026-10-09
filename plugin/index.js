/**
 * Project Forge mode — the mode-defining plugin.
 *
 * **What this mode is.** Not a rule list but a repository state management protocol:
 * the agent's job is to keep a project *recoverable, traceable and continuable*, and
 * the protocol defines the state that has to exist for that to be true. The state has
 * five layers:
 *
 * | layer | question it answers | carrier |
 * |---|---|---|
 * | persistence | what happened to this project? | git history |
 * | current state | what is true right now? | `done.md` |
 * | next state | what remains? | `todo.md` |
 * | strategy | why are we going this way, and how did it change? | `plan.md` |
 * | negative knowledge | which routes are already disproved? | `tortuous.md` |
 *
 * **How the mode is delivered**, weakest to strongest:
 *
 * 1. `project-forge:protocol` — the protocol itself, a system-prompt section present
 *    in every request, so it survives whatever the conversation does.
 * 2. `project-forge:recovery` — the post-compaction procedure, a second section.
 * 3. `project-forge:digest` — the maintained documents, the repository state and the
 *    project's own rule file, re-read from disk on every request and rendered into the
 *    runtime context. The rules stop being the only memory: the facts are there too.
 * 4. `injectOnCompaction` — the first step after a compression carries a recovery
 *    message with that same digest appended, so recovery does not depend on the model
 *    choosing to read anything.
 * 5. Two guards — `guardLocalGit` (publishing/history-destroying commands never run) and
 *    `guardCommitCheckpoint` (a commit is refused while the state documents are stale).
 *
 * **What is deliberately not inlined:** `tortuous.md` (long, grows monotonically, read
 * on demand) and `docs/` (that is what it is for — it answers "how do I maintain this",
 * not "what do I do next").
 *
 * Design notes that cost real debugging time (see ../tortuous.md):
 * - The digest reads files **synchronously**: the runtime context is rendered inside
 *   prompt assembly, and an async read is not finished when the first request is
 *   assembled.
 * - Compaction is detected by comparing `session.surface.replaceGeneration` across
 *   steps, with no session-log accessor in the path.
 * - A profile-installed bundle resolves no DSH packages, so this file imports only Node
 *   builtins and ./schema.js.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from './schema.js';

/** Producer kind stamped on every message this plugin injects. */
const SOURCE_KIND = 'project-forge';

/**
 * Recovery markers already folded in for one session, remembered across plugin reloads.
 *
 * In-memory state alone is not enough: a preset remount or a process restart would forget
 * that a compaction was already answered and inject the same message again.
 * @param sessionId - the session whose markers to load.
 * @returns the markers found for that session.
 */
function loadRecoveredMarkers(sessionId) {
  try {
    const text = readFileSync(markerPath(sessionId), 'utf8');
    return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * Record one recovery marker durably.
 * @param sessionId - the session the marker belongs to.
 * @param marker - the marker to remember.
 */
function rememberRecoveredMarker(sessionId, marker) {
  try {
    const directory = join(tmpdir(), 'dsh-project-forge');
    mkdirSync(directory, { recursive: true });
    appendFileSync(markerPath(sessionId), `${marker}\n`);
  } catch {
    /* Persistence is best-effort; the in-memory set still prevents repeats in this process. */
  }
}

/**
 * Path of one session's recovery-marker file.
 * @param sessionId - the session id.
 * @returns an absolute path in the OS temporary directory.
 */
function markerPath(sessionId) {
  return join(tmpdir(), 'dsh-project-forge', `${safeId(sessionId)}.markers`);
}

/**
 * Run one read-only git query, returning its stdout, or `undefined` when git is absent or
 * the directory is not a repository. Guards never throw.
 * @param cwd - the repository root.
 * @param args - git arguments, e.g. ['ls-files'].
 * @returns the trimmed stdout, or `undefined`.
 */
function runGitOrNothing(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether one file has uncommitted working-tree changes (modified or staged-new), reported
 * by `git status --porcelain`. `false` means clean or not a repository; `undefined` means
 * git could not be consulted.
 * @param cwd - the repository root.
 * @param absolute - the file's absolute path.
 * @returns true when the file is dirty, false when clean, undefined when unknown.
 */
function gitDirtyPath(cwd, absolute) {
  const rel = relative(cwd, absolute).replace(/\\/g, '/');
  const out = runGitOrNothing(cwd, ['status', '--porcelain', '--', rel]);
  if (out === undefined) return undefined;
  return out.trim().length > 0;
}

/**
 * A stable identity for one agent, used as the owner of a file claim.
 * @param agent - the agent writing.
 * @returns its session id when present, else a process-scoped fallback.
 */
function agentIdentity(agent) {
  const id = agent?.session?.header?.id ?? agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : `proc-${process.pid}`;
}

/**
 * Path of one file's claim record, inside a gitignored directory.
 * @param cwd - the project root.
 * @param rel - the file's repo-relative path (forward slashes).
 * @returns the claim file's absolute path.
 */
function claimPath(cwd, rel) {
  return join(cwd, '.agents', '.forge-claims', `${safeId(rel)}.json`);
}

/**
 * Read one claim; undefined when absent or unreadable.
 */
function readClaim(cwd, rel) {
  try {
    return JSON.parse(readFileSync(claimPath(cwd, rel), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write (or overwrite) one claim. Best-effort: a claim that cannot be written is not fatal.
 */
function writeClaim(cwd, rel, claim) {
  try {
    const p = claimPath(cwd, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(claim));
  } catch {
    /* best-effort */
  }
}

/**
 * Whether a claim is still owned by a live session. A claim whose lock file has not been
 * touched within the staleness window is treated as abandoned (the owner crashed or hung)
 * and may be taken over. This mirrors KimiSwarm's `filelock`-based claim: the lock itself is
 * the liveness signal, so there is no cross-platform PID check to get wrong.
 * @param claim - the claim record, which must carry `time` (last-touched epoch ms).
 * @returns true while the claim is fresh.
 */
function claimFresh(claim) {
  const t = claim?.time;
  if (typeof t !== 'number' || t <= 0) return false;
  return Date.now() - t < CLAIM_STALE_MS;
}

/** A claim older than this is assumed abandoned and may be taken over (30 minutes). */
const CLAIM_STALE_MS = 30 * 60 * 1000;

/** Extensions and names that mark a root file as a kind of artifact. */
const KIND_BY_EXTENSION = Object.freeze({
  '.py': 'source', '.js': 'source', '.mjs': 'source', '.cjs': 'source', '.ts': 'source',
  '.go': 'source', '.rs': 'source', '.java': 'source', '.rb': 'source', '.php': 'source',
  '.c': 'source', '.h': 'source', '.cc': 'source', '.cpp': 'source', '.cs': 'source',
  '.sh': 'script', '.ps1': 'script', '.bash': 'script', '.zsh': 'script', '.bat': 'script', '.cmd': 'script',
  '.service': 'deploy', '.timer': 'deploy', '.socket': 'deploy', '.target': 'deploy',
  '.yaml': 'config', '.yml': 'config', '.toml': 'config', '.ini': 'config',
});

/**
 * Facts about one repository tree, deliberately mechanical: a guard may act only on what it
 * can decide, and "is this directory well named" is not decidable here.
 * @param cwd - the session's working directory.
 * @param documents - file names that count as maintained documents, not artifacts.
 * @returns the facts, or `undefined` when the directory cannot be read.
 */
function readTreeFacts(cwd, documents) {
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const documentNames = new Set([
    ...documents.map((name) => name.toLowerCase()),
    // The protocol's own four state documents are documents whatever `digestFiles` holds;
    // `tortuous.md` in particular is normally not inlined, and counting it as an artifact
    // would inflate the root on every project that has one.
    'done.md',
    'todo.md',
    'plan.md',
    'tortuous.md',
  ]);
  const rootFiles = [];
  const kinds = new Set();
  const topLevel = [];
  const directories = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name === '.git') continue;
    topLevel.push(name);
    if (entry.isDirectory()) {
      directories.push(name);
      continue;
    }
    const lower = name.toLowerCase();
    if (documentNames.has(lower) || lower === 'readme.md' || lower === '.gitignore') continue;
    rootFiles.push(name);
    const extension = lower.slice(lower.lastIndexOf('.'));
    const kind = KIND_BY_EXTENSION[extension];
    if (kind !== undefined) kinds.add(kind);
  }
  // A root that has become a shelf for several kinds of artifact is the mechanical proxy for
  // §7.6 ("different kinds of artifact never share a shelf"). One kind may be a deliberate
  // flat layout; three kinds rarely is.
  const flagged = kinds.size >= 2 || rootFiles.length > 8;
  return { rootFiles, kinds: [...kinds], topLevel: topLevel.sort(), directories: directories.sort(), flagged };
}

/**
 * Whether the maintained documents acknowledge the tree the guard measured.
 *
 * Acknowledging means one of exactly two things is written down, both of which require
 * having looked at the tree:
 * - a **directory** name from the tree — the walk named what a place holds; or
 * - an explicit statement that the flat layout is deliberate ("保持扁平", "kept flat").
 *
 * A bare file name is deliberately **not** accepted: state documents mention file names
 * incidentally all the time, so accepting one would let the guard pass on a lucky string
 * rather than on a real walk. A root with no subdirectory at all is the case that must
 * still be acknowledged — by saying the flat layout is a decision.
 * @param documents - every maintained document's text, lowercased.
 * @param facts - the tree facts the guard just measured.
 * @returns whether the layout was acknowledged.
 */
function acknowledgesLayout(documents, facts) {
  if (documents.length === 0) return false;
  if (/保持扁平|kept? flat|deliberately flat|flat by (?:choice|design)/.test(documents)) return true;
  if (facts.directories.length === 0) return false;
  return facts.directories.some((name) => name.length >= 2 && documents.includes(name.toLowerCase()));
}


/** Cordis plugin name. */
export const name = 'project-forge';

/** The registries this row contributes to: prompts and the tool pipeline. */
export const inject = ['systemPrompt', 'tools'];

export { Config };

/**
 * The protocol. Kept byte-stable on purpose: a live agent's prompt should not drift
 * between steps of one turn.
 */
const PROTOCOL = `# Project Forge Mode — the protocol

You are the **steward** of this repository, not a generator of code into it. Stewardship means one thing: **the project must stay recoverable, traceable and continuable** — by you after your context is gone, and by the next agent that opens it. Everything below serves that.

## 0. The five layers of project state

Keep these five layers distinct. Confusing them is what turns documentation into a second codebase to maintain.

| Layer | The question it answers | Carrier |
|---|---|---|
| Persistence | What happened to this project? | git history |
| Current state | What is true right now? | \`done.md\` |
| Next state | What remains to be done? | \`todo.md\` |
| Strategy | Why this way, and how did the route change? | \`plan.md\` |
| Negative knowledge | Which routes are already disproved? | \`tortuous.md\` |

The four documents are **state**, not notes. Update a document in the same commit as the change it describes, and never let a document describe a state the repository is not in.

## 1. Local git is the safety net (highest priority)

1.1. Initialize the repository as a **local** git repository: \`git init\` at the project root (never at a parent directory).
1.2. **Never** add a remote, push, or publish — no \`git remote add\`, no \`git push\`, no hosted repository, no package publication — until the user explicitly asks for it in a later message. A guard enforces this; do not try to work around it.
1.3. Never destroy local work: no \`git reset --hard\`, no \`git clean -f\`, no \`git branch -D\` unless the user asked for exactly that.
1.4. Maintain \`.gitignore\` as the project grows: every build output, dependency directory, cache, log, editor artifact, environment file, large binary and test intermediate file, as soon as it appears.
1.5. Maintain \`README.md\` (see §3).
1.6. **Never commit a credential.** An API key, password, private key, session token, or the file whose only job is to hold one (\`.env\`, \`*.pem\`, \`*.key\`, \`credentials.*\`) must never enter the repository. \`.gitignore\` them, load them from a secret store or an untracked file, and purge any that already entered from history (\`git rm --cached\` plus a history filter or BFG) — a committed secret stays in \`git log\` forever. When you must work with a secret, read it into memory, never into the working tree. A guard (\`guardSecrets\`) refuses the commit while a tracked file is a credential file; a key embedded inside ordinary source is not decidable and is this clause's job, not the guard's.

## 2. The development loop and the checkpoint protocol

A commit is a **checkpoint**, not a save-every-command. Commit at the end of a logical loop:

\`\`\`
close one logical unit of work
   → run the relevant tests / checks
   → confirm the repository is in the state you believe it is
   → walk the layout: does every directory still say what it holds? (§5.6, §7.1)
   → update done.md (and todo.md / plan.md / tortuous.md as they changed)
   → git commit
\`\`\`

2.1. Commit messages are imperative, scoped, and say why: \`feat: …\`, \`fix: …\`, \`refactor: …\`, \`test: …\`, \`docs: …\`, \`chore: …\`.
2.2. Do **not** commit after every command. A history of "wip" commits is not a recovery mechanism.
2.3. Do **not** accumulate a large uncommitted working tree either: if a logical unit is finished and verified, commit it before starting the next one.
2.4. End a turn with a clean working tree, or an explicit statement of what is deliberately left uncommitted and why.
2.5. If an experiment is not worth keeping, revert or restore the file — do not delete the evidence by hand.

## 3. \`README.md\` and \`docs/\` answer different questions

3.1. \`README.md\` answers **"I just got this project — how do I understand and run it fastest?"** Keep it to: what the project is, how to install/build/run it, the directory layout, basic usage, and where the state documents and \`docs/\` live. It is a front door, not an encyclopedia.
3.2. When the user asks for documentation — or when a subsystem's "how do I maintain this" knowledge outgrows the README — maintain \`docs/\` with complete Markdown documents: architecture, module contracts, data flow, configuration, testing, design decisions, troubleshooting. Keep them consistent with the code; a stale document is a defect.
3.3. Never let the README grow into the docs. When it would, move the depth into \`docs/\` and link it.

## 4. The four state documents — format is part of the protocol

Each document is inlined into your runtime context under its own size budget, and **only the end of the document is inlined** — the tail, not the head — because these documents read newest-last and the current state must be at the end. The consequence matters: an overgrown document silently pushes its own current state out of your context, and the part that gets dropped is the beginning. So keeping the documents concise is part of the job, not a style preference.

| Document | Tail budget inlined | What that means for you |
|---|---|---|
| \`plan.md\` | ~20,000 chars (≈400 lines) | Strategy, not an archive. Keep it concise and current. |
| \`todo.md\` | ~10,000 chars | A short queue. Anything longer is stale items or misplaced detail. |
| \`done.md\` | ~20,000 chars | Revise sections in place; never grow it by appending. |

- **\`plan.md\` must stay concise and be updated as the project moves.** When it grows, **replace** the superseded parts instead of stacking new ones: revise phases in place, mark them done, and keep the corrections log to one line per correction. Superseded history belongs in \`git log\` and in the shortest-path section of \`done.md\`.
- **\`todo.md\` must stay short and current.** Remove an item in the commit that completes it. If the file keeps growing, the cause is stale items or detail that belongs in \`plan.md\` or in the code — fix the cause, do not grow the file.
- **\`done.md\` must stay bounded.** Its sections describe the current state, so each pass **rewrites** the affected section rather than appending a diary entry.
- If a document genuinely needs more room, put the depth in \`docs/\` and leave a link.

### 4.1 \`done.md\` — the current state and the shortest reproducible path

\`done.md\` is **not a log and not shell history**. Its test is: *can another agent reconstruct the current state by reading only this file?* Write it as:

\`\`\`markdown
# done.md

## Current state
<!-- What exists and works right now. A verifiable inventory, not a story. -->

## Shortest path to this state
<!-- Numbered phases. Commands actually run, files created/changed, and what each
     change implemented. Merge repetition; omit dead ends (they belong in tortuous.md);
     keep the reader able to reproduce the result without the chat. -->

## Verification
<!-- Commands run and the observed result, e.g. "23 passed". -->

## Repository state
<!-- Branch, HEAD commit, working-tree cleanliness. -->

## Drift (optional, when state consistency found a mismatch)
<!-- One line per mismatch: what the documents claim, what the repository shows. -->
\`\`\`

4.1.1. Do not append raw command transcripts. If three commands achieved one thing, write the one thing and the commands that matter.
4.1.2. Keep it current: after each logical unit, revise the sections rather than appending a new diary entry. An ever-growing \`done.md\` is a **defect**, not diligence.

### 4.2 \`todo.md\` — the execution queue

4.2.1. Only what still remains, in priority order, each item concrete enough to start.
4.2.2. Remove an item in the **same commit** that completes it; the record of it belongs in \`done.md\`. Add newly discovered work immediately.
4.2.3. No strategy here, no history here. If an item needs a paragraph of justification, the justification belongs in \`plan.md\` and the item links to that section.
4.2.4. Keep it short enough to read at a glance. A long \`todo.md\` means stale items were left in, or detail leaked in from \`plan.md\` — clean it up rather than adding to it.

### 4.3 \`plan.md\` — strategy and its changes

4.3.1. Record: the goal and success criteria, the phases of the approach, the decisions with their rationale and the alternatives rejected, and the risks.
4.3.2. Whenever the user corrects the direction, record the correction — what they said, what changed, why — in a dedicated **corrections** section before acting on it. A correction is only recorded when it is in this file.
4.3.3. When a discussion skill (for example \`project-forge-grilling\`) settles a direction with the user, the agreed outcome goes here.
4.3.4. \`plan.md\` must not become a task list. Strategy here, queue in \`todo.md\`. If the two ever contain the same items, delete them here.
4.3.5. Keep it concise as the project moves: update the phases in place, mark finished phases done, and delete what no longer guides a decision. Do not accumulate an append-only plan — an outdated plan at the head of the file is the part that falls out of your context first.

### 4.4 \`tortuous.md\` — negative knowledge

This is the most valuable document in the mode and the easiest to ruin. Its test is: *does this entry stop a future agent from repeating the attempt?* One entry per failed route:

\`\`\`markdown
## <date or commit>

### Tried
<!-- The attempt, in one line. -->

### Observed
<!-- What actually happened. Error text, wrong output, surprising behaviour. -->

### Commands
<!-- The exact command(s) that reproduce the failure, if any. -->

### Why it failed
<!-- The cause you established — not a guess. Write "cause not established" if it is not. -->

### Conclusion
<!-- The rule this establishes: "do not use X for Y under condition Z." -->

### Instead
<!-- What was adopted instead, or what remains open. -->
\`\`\`

4.4.1. Failed explorations only. Never write successes here.
4.4.2. Never delete an entry because it is embarrassing or because there are many.
4.4.3. This file is **not** inlined into your context (it grows long). Read it before choosing an approach that may have failed before.

## 5. Code organization: layered, modular, explicit boundaries

5.1. Unless the user explicitly directs otherwise, organize code **by layered modular hierarchy with explicit module boundaries and dependency direction**, not by file type or by feature name scattered flat across the top level. A file's location must tell the reader which layer and which module it belongs to; dependencies point one way (higher layers depend on lower ones, never the reverse, and never a cycle).
5.2. Do not use a flat file organization unless the user asks for it.
5.3. Whatever the user asks for, the code must be **high cohesion, low coupling, minimal duplication**.
5.4. Comments: **necessary comments only**, and they explain **why**, never restate **what** the code does. \`# increment x\` above \`x += 1\` is noise and a defect. A comment that records an invariant, a non-obvious reason, a constraint discovered the hard way, or a deliberate deviation is worth keeping forever.

5.5. **The layout is primarily for human developers, not for the agent.** You navigate by path and by search, so a shallow tree costs you almost nothing — and that is exactly why your convenience must never decide the structure. A human arrives without your conversation: they open the repository, see the top level, and form a model of the project in seconds. Organize for that reader.

  5.5.1. **The five-second test.** Someone who has never seen the project must be able to tell what each directory holds, and where their own change belongs, without opening a single file. If a directory's purpose cannot be guessed from its name, it is misnamed or it is hiding unrelated things.
  5.5.2. **Names state meaning, not mechanism.** A directory is named for what it holds in the project's own vocabulary (\`sync/\`, \`credentials/\`, \`deploy/\`), not for the technology inside it (\`scripts/\`, \`misc/\`, \`utils/\`, \`new/\`, \`tmp/\`, \`other/\`) and never for when it was made (\`v2/\`, \`old/\`, \`final/\`). "Where does this go?" must have one obvious answer.
  5.5.3. **Depth follows meaning.** Group what changes together and is read together; split when one directory starts answering two unrelated questions. There is no target depth: a two-file directory that names a real concept beats a flat pile, and a directory holding one unrelated file is worse than leaving that file where it belongs.
  5.5.4. **This applies at every level, not only the root.** Every directory in the tree must pass §5.5.1 — a clean root with an incoherent \`src/\` under it is not organized, it is a tidy lid on a messy box.
  5.5.5. **Placement is part of history.** Move files with \`git mv\` so the move stays reviewable, and when a path is referenced outside the repository (deployment scripts, symlinks, systemd units, installed packages, documentation, the user's own shortcuts), update the reference in the same commit or record why it must stay put.

5.6. **Every checkpoint re-examines the layout** (§2, §7.1). Ask, in this order: does the root still hold only entry points, project metadata, deployment description, the state documents and \`README\`? does each directory still answer one question? has anything accumulated that belongs elsewhere, or that merely looks placed because nobody moved it? A "no" is either work for this commit or a recorded reason to leave it — never silence.

## 6. Naming and vocabulary: one word, one meaning, every level

Layout says where things are. Naming says what they are — and naming is what actually makes a repository navigable, at every scale from one file to a monorepo. A misplaced file costs a reader one detour; a **word used for two things** costs them a wrong mental model, and that cost compounds with every session, human or agent, that reads the code afterwards.

**Why this is a first-class rule, not style advice.** Measured findings, not taste:

- Agents **fail to find architecturally critical files**, and the documented cause is not context size: navigation by lexical match is a different problem from retrieval, and agents reach for names and search strings when they should follow structure. In one study 58% of trials with a structural tool available never called it — they behaved lexically. **Names are the interface agents actually navigate by**, so a name that lies is a navigation defect, not a cosmetic one. ([CodeCompass / the Navigation Paradox](https://arxiv.org/abs/2602.20048v1))
- The dominant failure mode of agent-written code is not a crash, it is **drift**: patterns that existed for a reason get quietly replaced by whatever the model did that day, and the codebase "slowly stops making sense as a whole" while every test stays green. Local decisions, random global direction. ([The Vibes Don't Scale](https://stack72.dev/the-vibes-dont-scale/))
- Strict drafting conventions measurably **lower vocabulary growth and raise term consistency**. The analogy is exact: a statute is a large artefact read by strangers, and it achieves low entropy by using one defined term per concept. A codebase should read like a statute, not like prose. ([Scale-free characteristics of legal texts](https://arxiv.org/abs/2509.17367))

**The goal, stated so it can be checked:** *each name means exactly one thing, and each thing has exactly one name* — at directory level, file level, and identifier level. That is what low entropy means here, and it is what makes a project readable by a stranger and navigable by an agent.

### 6.1 The controlled vocabulary

6.1.1. **Keep the vocabulary in \`.agents/steward.md\`.** List the project's own concept words (the domain, not the technology) and the one name each concept carries. The file is inlined into your context every turn, so this is how you keep writing the same words the project already uses instead of inventing a new synonym.
6.1.2. **One concept, one word, everywhere** — in directories, file names, type names, function names, comments, commit messages, document titles. If the domain concept is \`credential\`, do not let \`token\`, \`key\` and \`secret\` appear as if they were the same thing. If they genuinely are different things, define all three; if they are the same thing, pick one and remove the others.
6.1.3. **A synonym for an existing concept is a defect, not a style choice.** Before introducing a new word, search for the concept — it probably already has a name, and using a second one splits the reader's model in two.
6.1.4. **The high-entropy words are the ones to fix.** A name that appears spread evenly across unrelated directories — \`data\`, \`handler\`, \`process\`, \`state\`, \`util\`, \`info\`, \`manager\` — is the signature of one word doing several jobs. Replace it **per context** with the specific term for that context (\`data\` in billing becomes \`invoice_payload\`; in auth, \`credential\`); never rename it globally to another generic word. A name concentrated in one module is healthy even if it is frequent — frequency is not the signal, **spread** is.
6.1.5. When you notice that a name has drifted into two meanings, treat it as work: fix the names in the commit that fixes the concept, and record the vocabulary decision in \`.agents/steward.md\`.

### 6.2 Directories

6.2.1. Lowercase, no spaces, no dates, no versions, no personal names. A directory is a **noun for what it holds**, not a verb and not a task.
6.2.2. Never a dumping word: \`misc\`, \`utils\`, \`helpers\`, \`common\`, \`shared\`, \`temp\`, \`new\`, \`old\`, \`backup\`, \`extra\`, \`stuff\`. These are not names, they are deferrals — every one of them means "a decision was postponed", and the reader pays for it. If a file has no home, that is information: either the concept is missing from the vocabulary, or the file belongs in an existing module.
6.2.3. A directory name must be **specific enough that a second one like it cannot be created by accident**. If you are tempted to add \`utils2/\`, the first one is misnamed.
6.2.4. Plural for collections (\`credentials/\`, \`sources/\`), singular for single concepts (\`auth/\`, \`deploy/\`). Pick one convention per repository and keep it.
6.2.5. Test directories are named \`test/\` or the language's own convention (\`tests/\`, \`spec/\`) and are never scattered; deployment description lives under its own name (\`deploy/\`, \`systemd/\`), never mixed with source.

### 6.3 Files

6.3.1. A file name states **what the file is**, not who wrote it, when, or its position in a sequence. No \`new\`, \`final\`, \`v2\`, \`copy\`, \`tmp\`, \`untitled\`, \`test2\`, \`misc\`.
6.3.2. Follow the language's own convention for the language's own files (\`snake_case.py\`, \`kebab-case.ts\`, whatever the toolchain already expects) and the repository's convention for everything else. Never mix conventions inside one directory.
6.3.3. One primary concept per file, and the name says which. A file named \`utils.py\` is the file-level version of §6.2.2 — a defect.
6.3.4. Entry points and executables are recognisable as such (\`main\`, \`cli\`, \`deploy.sh\`), and a file without an extension that is executable must be named for what it does (\`git-baidu\`), never for where it sits.
6.3.5. Test files mirror the thing they test (\`test_<subject>.py\`), so the pairing is visible without opening either.
6.3.6. Generated artifacts, fixtures and data say so in the name or live in a directory that does (\`fixtures/\`, \`golden/\`, \`generated/\`), and generated output is never committed under a name that looks hand-written.

### 6.4 Code contents

6.4.1. **Names are phrases about the domain, not about the code.** \`retry_after_quota_reset\` beats \`handle_error2\`; \`Invoice\` beats \`DataManager\`. If a name needs a comment to explain what it means, the name is wrong.
6.4.2. **The length rule**: a name grows with the size of the scope it is visible in. A loop index may be \`i\`; a module-level concept may not. Never abbreviate a public name (\`usr\`, \`cfg\`, \`mgr\`), never spell out a local one to twenty characters.
6.4.3. **One name per concept across the codebase** (§6.1.2): if the domain says \`credential\`, then a type, a variable, a function and a file about it all say \`credential\`. Mixed \`credential\`/\`token\`/\`secret\` in the same layer is a defect even when each compiles.
6.4.4. **Boolean names read as assertions** (\`is_expired\`, \`has_quota\`, \`should_retry\`) — never \`flag\`, \`check\`, \`status\`.
6.4.5. **Function names say what they do to what** (\`refresh_credential\`, \`parse_manifest\`), and a function that needs "and" in its name is two functions.
6.4.6. **No encoding of noise**: no \`\__v2\`, no \`_old\`, no \`temp_\`, no commented-out block kept "just in case". Git is the archive; a name that encodes history in the working tree is entropy.
6.4.7. When you must keep a name that violates these rules — a published API, a wire format, a path referenced outside the repository — record the deviation and its reason in \`.agents/steward.md\`. **A recorded deviation is knowledge; an unrecorded one is rot.**

### 6.5 Checking it (works at every scale)

6.5.1. The check is cheap and does not need tooling: **read the directory listing, then the file names, then the top-level symbols of a file.** At each level ask *"does this word mean exactly one thing here, and is it the same word the rest of the project uses?"* A stranger should be able to answer from the names alone.
6.5.2. Scale does not change the rule, only the amount of it: a three-file script has one vocabulary and three names to keep honest; a monorepo has the same obligation per package, and the vocabulary file is what keeps packages from inventing separate words for one concept.
6.5.3. **The trend matters more than any single name.** If the same generic word keeps appearing in new places, or if two words for one concept keep alternating, that is drift (§5A. head) and it belongs in \`done.md\` as a finding — with the rename as its fix.
6.5.4. Naming work is checkpoint work: rename with the move or refactor that causes it, \`git mv\` for files (§5.5.5), and update the vocabulary file in the same commit.

## 7. Keep the file architecture in order

7.1. Re-examine the **whole tree — every directory, not only the root** — when work adds files, and at each checkpoint: sources, tests, fixtures, generated artifacts, test intermediates, scripts, deployment description and documentation each belong in their own place, and each directory must still pass the five-second test in §5.5.1.

7.2. Test code and everything tests need (fixtures, golden files, generated inputs, intermediate output) is organized, never loose in the project root.

7.3. **When the tests become an independent development and verification system — or when test file count, fixtures, data or generated output start to shape the project structure — organize them as a standalone \`test/\` project at the project root**, with its own \`README.md\`, its own four state documents (\`done.md\`, \`todo.md\`, \`tortuous.md\`, \`plan.md\`), and code that follows §5 exactly like the main project. The project root is the required location: collaborators look for tests there, and one top-level directory is what keeps the test project from being mixed into the source tree. Inside it, separate test code, fixtures and generated output into subdirectories.

7.4. **More than three test files is a trigger to make that judgement, not the judgement itself.** Three files that form a fixture-heavy verification system already need the structure; four small unit-test files for one module may not. Say which you concluded and why, in \`done.md\`.

7.5. **A single test file is not an exemption from §7.1 or §5.5.** Kept at the top level it still has to be findable as a test and not read as part of the implementation; when the layout already separates by role, it belongs with the tests like any other.

7.6. **Different kinds of artifact never share a shelf.** Executable source, deployment description (units, timers, service files), build and release scripts, data and fixtures, and documentation each live under a place that names them — a root holding all of them at once is the failure case, not a shortcut.

7.7. Record every restructuring in \`done.md\` — what moved, from where to where, and what referenced the old paths — and every abandoned restructuring attempt in \`tortuous.md\`.

## 8. The repository may carry its own rules

8.1. If \`.agents/steward.md\` exists, it is this repository's own steward rules — read them (they are inlined into your context) and follow them. They may add project-specific conventions and may override this protocol for this project specifically.
8.2. If the user overrides a clause of this protocol, record the override in \`plan.md\` so the next compaction does not silently restore the default.
8.3. If you establish a rule that will matter to the next session, write it into \`.agents/steward.md\` rather than only into the conversation.

## 9. State consistency is part of the job

The documents and the repository will drift. Finding the drift is your work, not the user's.

9.1. Run a consistency check at these moments: **taking over an unfamiliar project**, **immediately after a context compaction**, **before every commit**, and every few commits during a long run.
9.2. Compare, using the repository state that is inlined in your context plus \`git status\` / \`git log\` when you need detail:

| Check | Documents | Repository |
|---|---|---|
| README | install/build/run instructions, layout | actual layout and commands |
| todo | items still open | work actually unfinished |
| done | claimed completed work | commits and files that exist |
| plan | stated direction and phases | what is being built now |
| docs | described interfaces | implemented interfaces |

9.3. On a mismatch: record it in the **Drift** section of \`done.md\` (what the documents claim, what the repository shows), then either fix the document or fix the code — in the same commit. Never leave a known mismatch unrecorded.
9.4. A commit is a checkpoint of a *consistent* state. The checkpoint guard refuses \`git commit\` while the state documents have not been touched since the last compaction or since commits the documents do not mention.
9.5. The comparison table has a **layout** row too: what \`README\` and the documents say the tree looks like, against what the tree actually is. A \`README\` describing directories that no longer exist, or a tree that no longer matches its own description, is the same class of defect as a stale \`done.md\`.

## 10. When a task is complete

A task is complete when **all** of these hold — otherwise it is not complete, whatever the code does:

1. The stated acceptance criteria are met and verified by a command whose result you observed.
2. \`todo.md\` no longer lists it.
3. \`done.md\` reflects it, including how to verify it.
4. \`plan.md\` reflects any direction change it caused.
5. Failures encountered on the way are in \`tortuous.md\`.
6. The working tree is clean, or what is left uncommitted is stated explicitly.
7. No known drift between documents and repository is left unrecorded.
8. **The layout still passes §5.5 and §7.1**: every directory names what it holds, different kinds of artifact do not share a shelf, and any file left in a place that merely looks convenient has a recorded reason in \`done.md\`.

## 11. Taking over a project

11.1. Before changing anything in an unfamiliar project, reconstruct its state: read the inlined documents, read \`tortuous.md\` if the project has one, run \`git log --oneline\` and \`git status\`, and **walk the whole directory tree** — at every level, ask what each directory holds and whether its name answers that (§5.5).
11.2. Run a consistency check (§9) and record the result, including the layout row.
11.3. If README, \`docs/\` or the state documents do not exist yet, create what the work needs — do not silently work without them.
11.4. If the tree fails §5.5 — a flat pile, mixed artifact kinds, directories named \`misc\`/\`utils\`/\`old\` — say so in your opening report and propose the regrouping **before** building on top of it. Reorganizing is part of taking over, not a later cleanup.
11.5. Then state, in one short message, what you found and what you intend to do first.

## 12. Parallel sessions on one project

More than one main agent may run on the same project root at the same time — each in its own session, working on a different part. The state documents are shared, and they cannot be merged, so without rules a second writer silently overwrites the first. These rules keep parallel work safe. (On 2026-10-07 three main agents really did write the same four documents of one project in a single day; every rule below answers a failure that actually happened.)

12.1. **One document owner.** Only one session — the one that took the project over first, unless the user says otherwise — writes \`done.md\`, \`plan.md\`, \`todo.md\` and \`tortuous.md\`. Other parallel sessions **do not** edit those four. They write code and, when they must record something, put it in their own module's notes or in the single owner's inbox; the owner folds it into the shared documents.

12.2. **The owner commits a document change immediately.** A shared document must never sit with uncommitted edits: another session may pick it up mid-edit and build on a half-written state. §2 already requires a document change to be committed with its code; in parallel work this is not optional. The guard \`guardConcurrentWrite\` enforces this with a per-file claim in \`.agents/.forge-claims/\`: created when you write a protected file, **released the moment any commit succeeds**, and deleted automatically when stale (owner quiet for 30 minutes — a crash cannot block the project). A refusal names the claiming session by its id. Keep \`.agents/.forge-claims/\` in \`.gitignore\`; never commit a claim file.

12.3. **Claim before you touch a module.** Before changing a module, a route, or a shared concept, add one line to the top of \`plan.md\`'s **正在做** list: \`<session> → <what>\`. Remove the line when the work lands. Another session must read this list before starting and must not step onto a claimed area; if the whole project is claimed, wait or ask the user, do not race.

12.4. **One vocabulary, everywhere.** Every parallel session uses the same \`.agents/steward.md\` controlled vocabulary (§6). A session that needs a new word adds it there in its own commit — and \`.agents/steward.md\` is a shared document, so §12.2's commit-immediately rule applies to it too. Never introduce a synonym for a concept that already has a name (§6.1.3); that fragments the vocabulary across agents.

12.5. **A spawned subagent inherits nothing — check before you adopt.** A \`spawn\` subagent starts without this protocol, without the digest, and without the vocabulary, so treat its report as untrusted input: before acting on any name, route, or structure it proposes, check it against §6 and the layout rules. (\`fork\` subagents do inherit the preset; see §12.9.) Do not let a subagent's convenience naming enter the project unreviewed.

12.6. **Leave the tree clean, or say so.** When you stop — at the end of a goal, a session, or a hand-off — the working tree must be either clean (everything committed) or its dirty state recorded in the owner's \`done.md\` Drift: what is uncommitted, why, and which session should pick it up next. A pile of uncommitted changes from a finished session is how the next session — human or agent — loses an hour reconstructing what was real.

12.7. **When in doubt, stop and report.** If you find a shared document dirty, a claim that is not yours, or a change you do not understand: stop, do not overwrite, and tell the user. A pause costs minutes; a silent overwrite costs the other agent's work.

12.8. **Two subagent modes — pick the tool by the task.** Two tools open two deliberately different children:
  - \`subagent_fork\` (**fork**) joins the child to your preset revision and copies your context: the child carries this protocol, the digest and the controlled vocabulary, plus your conversation. Use it when the child must **collaborate on project work** — know the conventions, continue a thread, write with the right vocabulary.
  - \`subagent\` (**spawn**) opens a **clean room**: no inherited context, no preset, just the task you give it. Use it when the parent's context is a burden rather than a help — a **simple self-contained task**, a **code review** that must read the code without your biases, or **read-only recon** you will summarise yourself.
  Choose per task, not by habit. Whatever the mode, give a narrow, read-mostly task: name the exact files it may touch, say whether it may write, and forbid it from editing the shared state documents — its findings come back to you, and you (or the document owner) fold them in. A \`spawn\` child's output is untrusted until checked (§12.5).

12.9. **If you are the subagent.** A forked subagent inherits this protocol; act on it even though you did not take the project over. (A spawned one does not — you have only the task text, so stay strictly within it.) Default to read-only exploration: inspect, measure, and report — do not edit the shared state documents (\`done\`/\`plan\`/\`todo\`/\`tortuous\`/\`.agents/steward.md\`), which belong to the parent's session. If the task genuinely requires writing, touch only the files the task names, name new things with the project's controlled vocabulary (§6), keep §5.5's layout, and leave the working tree clean or tell the parent exactly what you changed. Report findings as input for the parent to review, not as decisions already made — the parent is accountable for merging your output into the project.`;

/**
 * The post-compaction recovery procedure. Kept separate from the protocol because it is
 * triggered by a mechanism, not merely read.
 */
const RECOVERY = `# Project Forge Mode — resuming after context compaction

Your context was compressed; the project state was not. Recover it in this order before making any change:

1. **Read the state that is already in front of you.** \`plan.md\`, \`todo.md\` and \`done.md\` are inlined in your runtime context, and so is the repository state (branch, HEAD, recent commits). Start there; do not ask the user what the documents already record.
2. **Read \`tortuous.md\`** from the project root before choosing any approach — it lists the routes already disproved.
3. **Re-state the protocol** in your reply: the five state layers, local-only git with checkpoint commits, the four documents and what each one holds, \`README.md\` versus \`docs/\`, layered modular organization with explicit boundaries, necessary comments that explain why, the standalone \`test/\` project rule, and the state-consistency requirement.
4. **Run a state consistency check** (§9): compare the documents with \`git status\` and \`git log\`. Record every mismatch in the **Drift** section of \`done.md\` before continuing.
5. **Then continue** the work from \`todo.md\`. If a task's state is unclear, ask the user — but only about what the documents cannot answer.

This procedure exists because the conversation is not the project's memory. The repository is.`;

/** Heading of the inlined project-memory block. */
const DIGEST_HEADING = '## Project memory (maintained documents)';

/** Heading of the inlined repository-state block. */
const REPO_HEADING = '## Repository state (read from .git)';

/** Trailing note the digest carries about the one document it omits. */
const DIGEST_NOTE = '`tortuous.md` is deliberately not inlined; read it before choosing an approach that may have failed before.';

/**
 * Read one file synchronously; undefined when it is absent or unreadable.
 * @param absolute - resolved path.
 * @returns the file text, or undefined.
 */
function readIfPresent(absolute) {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Make a value safe to appear inside a message id.
 * @param value - the raw marker.
 * @returns a token-safe string.
 */
function safeId(value) {
  return String(value).replace(/[^\w.-]/g, '_');
}

/**
 * Remove quoted segments and comments from a shell command, so a literal \`git push\`
 * inside a string or a message cannot trigger the guard.
 * @param text - the raw command line.
 * @returns the command with quoted spans replaced by spaces.
 */
function stripQuoted(text) {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/(?:^|\s)#[^\n]*/g, ' ');
}

/**
 * Decide whether one shell command escapes the local-only git contract.
 * @param command - the command line handed to a shell tool.
 * @returns the offending label and fragment, or undefined when acceptable.
 */
function localGitEscape(command) {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const bare = stripQuoted(command);
  const escapes = [
    [/\bgit\s+push\b/, 'git push'],
    [/\bgit\s+remote\s+(?:add|set-url)\b/, 'git remote add/set-url'],
    [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
    [/\bgit\s+clean\s+-[a-z]*f/, 'git clean -f'],
    [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  ];
  for (const [pattern, label] of escapes) {
    const match = pattern.exec(bare);
    if (match !== null) return { label, fragment: match[0] };
  }
  return undefined;
}

/**
 * Decide whether one shell command is a commit that the checkpoint protocol governs.
 * @param command - the command line handed to a shell tool.
 * @returns true when the command commits.
 */
function isCommitCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return /\bgit\s+commit\b/.test(stripQuoted(command));
}

/**
 * Resolve a git directory from a working directory, following a \`.git\` file
 * (a worktree or submodule pointer) when present.
 * @param cwd - the session's working directory.
 * @returns the git directory path, or undefined when there is none.
 */
function gitDirOf(cwd) {
  const dotGit = join(cwd, '.git');
  const asFile = readIfPresent(dotGit);
  if (asFile !== undefined) {
    const match = /^gitdir:\s*(.+)$/m.exec(asFile);
    if (match === null) return undefined;
    const target = match[1].trim();
    return isAbsolute(target) ? target : join(cwd, target);
  }
  // A directory: probe a file that only a repository has.
  return readIfPresent(join(dotGit, 'HEAD')) === undefined ? undefined : dotGit;
}

/**
 * Read the repository state that the digest renders: current branch, HEAD commit and
 * the most recent commit subjects. Read straight from \`.git\` so it is synchronous and
 * needs no subprocess.
 * @param cwd - the session's working directory.
 * @param limit - how many recent commits to report.
 * @returns rendered lines, or undefined when the directory is not a repository.
 */
function readRepoState(cwd, limit = 8) {
  const gitDir = gitDirOf(cwd);
  if (gitDir === undefined) return undefined;
  const lines = [];

  const head = readIfPresent(join(gitDir, 'HEAD'));
  let branch;
  let headHash;
  if (head !== undefined) {
    const trimmed = head.trim();
    const ref = /^ref:\s*(.+)$/.exec(trimmed);
    if (ref !== null) {
      branch = ref[1].replace(/^refs\/heads\//, '');
      const refValue = readIfPresent(join(gitDir, ref[1].trim()));
      if (refValue !== undefined) headHash = refValue.trim().slice(0, 12);
    } else {
      branch = '(detached)';
      headHash = trimmed.slice(0, 12);
    }
  }
  if (branch !== undefined) lines.push(`branch: ${branch}`);
  if (headHash !== undefined) lines.push(`HEAD: ${headHash}`);

  const log = readIfPresent(join(gitDir, 'logs', 'HEAD'));
  if (log !== undefined) {
    const entries = log.split('\n').filter((line) => line.length > 0).slice(-limit);
    if (entries.length > 0) {
      lines.push('recent commits (newest last):');
      for (const entry of entries) {
        // <old> <new> <name> <email> <ts> <tz>\t<message>
        const tab = entry.indexOf('\t');
        const meta = tab === -1 ? entry : entry.slice(0, tab);
        // Git prefixes the first amend/rebase entries: drop that bookkeeping so the
        // subject stays readable in the digest.
        const message = (tab === -1 ? '' : entry.slice(tab + 1).split('\n')[0])
          .replace(/^commit(\s+\([^)]*\))?:\s*/, '');
        const hash = meta.split(' ')[1] ?? '?';
        lines.push(`- ${hash.slice(0, 8)} ${message.slice(0, 100)}`);
      }
    }
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

/**
 * Register the protocol, the project-memory digest, the compaction recovery and the two
 * guards on the preset scope.
 *
 * @param ctx - the preset scope context.
 * @param config - the validated row config.
 */
export function apply(ctx, config) {
  if (config.protocol !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'project-forge:protocol',
          // 400 sits after the shared deployment persona (0) and before the plan
          // policy (500); the mode's rules belong directly after the agent's identity
          // and before tool-specific guidance (1000+).
          order: 400,
          text: () => PROTOCOL,
        }),
      'project-forge.protocol()',
    );
  }

  if (config.recoveryProcedure !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'project-forge:recovery',
          order: 410,
          text: () => RECOVERY,
        }),
      'project-forge.recovery()',
    );
  }

  const wantsDigest = config.digest !== false;
  const wantsRecovery = config.injectOnCompaction !== false;

  /** Per-agent state: the rendered digest plus the detection bookkeeping. */
  const states = new Map();

  /**
   * Read the configured documents, the repository state and the project's rule file,
   * and render the digest.
   *
   * Synchronous on purpose: the runtime context is rendered inside prompt assembly, and
   * an async read is not finished when the first request is assembled.
   * @param state - the agent's state.
   */
  const refresh = (state, force) => {
    if (!force && state.text !== undefined && Date.now() - state.at < config.digestRefreshMs) return;
    const cwd = state.agent.session.header.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return;
    const parts = [];
    let used = 0;

    /**
     * Render one document under its own tail budget.
     *
     * The tail, not the head, is what a resuming agent needs: these documents are
     * maintained newest-last, so the end holds the current state while the beginning is
     * history that `git log` and the shortest-path section already cover. The omission
     * note is counted inside the budget, so the rendered size stays predictable.
     * @param label - the document's display name.
     * @param absolute - its resolved path.
     * @returns whether the document existed and was inlined.
     */
    const appendFile = (label, absolute) => {
      const text = readIfPresent(absolute);
      if (text === undefined) return false;
      const perDocument = typeof config.digestTailLimits?.[label] === 'number'
        ? config.digestTailLimits[label]
        : config.digestDefaultTailLimit;
      // Two ceilings: the document's own budget, and whatever is left of the global one.
      const limit = Math.max(0, Math.min(perDocument, config.digestMaxBytes - used));
      let body;
      if (text.length <= limit) {
        body = text.trimEnd();
      } else {
        const note = `(…omitted ${text.length - limit} characters from the start of ${label}; read the file, or \`git log\` for its history)`;
        const keep = Math.max(0, limit - note.length - 1);
        body = `${note}\n${text.slice(text.length - keep)}`;
      }
      used += body.length;
      parts.push(`### ${label}\n${body}`);
      return true;
    };

    for (const relative of config.digestFiles) {
      const absolute = isAbsolute(relative) ? relative : join(cwd, relative);
      appendFile(relative, absolute);
    }

    if (config.stewardFile !== false) {
      const relative = config.stewardFilePath;
      const absolute = isAbsolute(relative) ? relative : join(cwd, relative);
      if (appendFile(`${relative} (this repository's own steward rules)`, absolute)) {
        state.stewardPresent = true;
      } else {
        state.stewardPresent = false;
      }
    }

    if (parts.length === 0) {
      state.status = state.text === undefined ? 'missing' : 'stale';
      return;
    }

    const blocks = [DIGEST_HEADING, '', parts.join('\n\n')];
    const documentText = parts.join('\n').toLowerCase();
    if (config.repoStateInDigest !== false) {
      const repo = readRepoState(cwd);
      if (repo !== undefined) {
        blocks.push('', REPO_HEADING, '', repo);
        state.repoLog = repo;
        state.repoHead = /HEAD: (\S+)/.exec(repo)?.[1];
        // Drift signal, computed from what is in front of the model: newer commits that
        // none of the documents mention. A commit older than one the documents do cite
        // counts as covered, so the signal stays strict and does not nag forever.
        const hashes = [...repo.matchAll(/^- ([0-9a-f]{7,12}) /gm)].map((match) => match[1]);
        const newestCited = hashes.findIndex((hash) => documentText.includes(hash));
        state.unrecordedCommits = newestCited === -1
          ? hashes.length > 0 && state.docSinceCompaction !== true
          : hashes.slice(0, newestCited).length > 0;
      } else {
        state.repoHead = undefined;
        state.unrecordedCommits = false;
      }
    }
    if (config.digestFiles.includes('tortuous.md') === false) blocks.push('', DIGEST_NOTE);
    state.text = blocks.join('\n');
    state.at = Date.now();
    state.status = 'ready';
  };

  /**
   * The recovery message folded into the first step after a compaction.
   * @param marker - identifies the compaction this message answers.
   * @param snapshot - the current digest, so the message is self-contained.
   * @returns a UserMessage-shaped object.
   */
  const recoveryMessage = (marker, snapshot) => {
    const text = [
      'Context compaction just settled. Project Forge recovery:',
      '1. The documents and the repository state are inlined below — read them there; read `tortuous.md` before repeating a failed approach.',
      '2. Re-state the steward protocol in your reply before making changes.',
      '3. Run a state consistency check against `git status` / `git log`, and record every mismatch in the Drift section of `done.md`.',
      '',
      snapshot ?? '(the state documents could not be read; open them from the project root)',
    ].join('\n');
    return {
      // Hand-built message: a profile-installed bundle cannot import
      // `@deepseek-ai/dsh-llm`, so the UserMessage shape is produced locally.
      id: `project-forge:recovery:${safeId(marker)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      // `form: 'snapshot'` is the harness's own shape for injected context (see
      // `packages/core/agent-loop/src/runtime-context.ts` and `time-context`). A bare
      // `{ kind: 'user' }` would render as if the user had typed this text.
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: 'project-forge:recovery', text }] },
    };
  };

  ctx.on('agent/created', ({ agent }) => {
    const state = {
      agent,
      text: undefined,
      at: 0,
      status: 'pending',
      /** Turn number observed at the last step, so recovery fires once per turn. */
      turnSeen: undefined,
      /** Recovery markers already folded in, loaded from disk so a reload cannot repeat one. */
      recoveredMarkers: loadRecoveredMarkers(agent.id),
      /** Recovery marker waiting for the next eligible step, set by `compaction/end`. */
      pendingRecovery: undefined,
      /** Absolute paths this session has written, for the checkpoint guard. */
      touchedDocs: new Set(),
      /** Whether any maintained document was written since the last compaction. */
      docSinceCompaction: false,
      /** Whether a `compaction/end` has happened with no document written since. */
      compacted: false,
      /** Whether the repository is known to hold commits the documents do not mention. */
      unrecordedCommits: false,
      /** The repository-state block as the digest last read it. */
      repoLog: undefined,
      /** The project's own rule file was found. */
      stewardPresent: false,
      /** HEAD as the digest last read it. */
      repoHead: undefined,
    };
    states.set(agent.id, state);

    // The compaction signal, read where it is actually delivered. `session/event` is a
    // Scoped event: a listener registered on the plugin's own context does not receive it,
    // while one registered on the agent's context does — the same registration the
    // framework's runtime-context uses. Keying on the real `compaction/end` event removes
    // the old guess "the surface generation changed", which also fires for every other
    // surface replacement (tool-result pruning, spill).
    ctx.effect(() => {
      const dispose = agent.ctx.effect(
        () =>
          agent.ctx.on('session/event', (_session, event) => {
            if (event?.type !== 'compaction/end') return;
            // A failed compaction still closes with `compaction/end`, but the surface did not
            // shrink and there is nothing to recover from — only a successful one counts.
            if (event.data?.error !== undefined) return;
            // A compaction invalidates "the documents were updated recently": the digest in
            // front of the model may no longer match the repository, so the next eligible
            // step carries one recovery message and the checkpoint guard arms.
            state.docSinceCompaction = false;
            state.compacted = true;
            state.pendingRecovery = `compaction-${String(event.seq)}`;
          }),
        'project-forge.compactionEvents()',
      );
      return dispose;
    }, 'project-forge.compactionListener()');

    // Warm before the first assembly: the context entry renders during prompt assembly,
    // so a lazily filled cache would miss the first request.
    refresh(state, true);
    if (wantsDigest && state.status !== 'ready') {
      ctx.logger?.warn?.(
        'project-forge: no project memory for session %s (cwd %s) — are the state documents written yet?',
        agent.id,
        String(agent.session.header.cwd),
      );
    }

    ctx.effect(() => {
      const dispose = agent.ctx.effect(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'project-forge:digest',
            // After the framework's own policy context (110-120), well before the
            // instruction and tool sections that follow.
            order: 130,
            // Document prose is data, not a template: never interpolate it.
            interpolate: false,
            text: () => {
              if (!wantsDigest) return '';
              refresh(state, false);
              return state.text ?? '';
            },
          }),
        'project-forge.digest()',
      );
      return () => {
        dispose();
        states.delete(agent.id);
      };
    }, 'project-forge.agentState()');
  });

  if (wantsRecovery) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      const state = states.get(payload.agent.id);
      if (state === undefined) return decision;
      if (payload.turn !== state.turnSeen) {
        state.turnSeen = payload.turn;
      }
      // An empty first entry owns a no-step turn; folding here would turn it into a
      // standalone request instead of context waiting for the next input.
      if (decision.kind === 'reject' || decision.messages.length === 0) return decision;
      const pending = state.pendingRecovery;
      if (pending === undefined) return decision;
      // Bound it to one message per turn, and only the earliest eligible step of that
      // turn, so several surface replacements inside one turn cannot stack messages.
      if (typeof payload.step === 'number' && payload.step > config.recoveryMinTurnStep) return decision;
      state.pendingRecovery = undefined;
      if (state.recoveredMarkers.has(pending)) return decision;
      state.recoveredMarkers.add(pending);
      rememberRecoveredMarker(payload.agent.id, pending);
      refresh(state, true);
      ctx.logger?.info?.('project-forge: folding post-compaction recovery (%s)', pending);
      return { ...decision, messages: [...decision.messages, recoveryMessage(pending, state.text)] };
    });
  }

  // ── Guard A: the local-only git contract ──────────────────────────────────────
  // A guard is monotonic — no listener ordering can turn a denial back into permission —
  // and it runs before the shell body, which is the only point at which a refused
  // command is guaranteed not to have executed.
  if (config.guardLocalGit !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'pwsh' && execution.name !== 'bash') return undefined;
          const escape = localGitEscape(execution.arguments?.command);
          if (escape === undefined) return undefined;
          return [
            `Project Forge Mode refuses \`${escape.label}\`: this repository is local-only.`,
            'The user has not authorized publishing or history rewriting.',
            'Continue with local checkpoint commits instead; if the user explicitly asks to publish in a',
            'later message, they must clear this guard themselves.',
          ].join(' ');
        }),
      'project-forge.localGitGuard()',
    );
  }

  // ── Guard C: the layout checkpoint (§5.5 / §7.1) ─────────────────────────────
  // The layout rules are prose, and prose cannot fail — so the one part of them that is
  // mechanically decidable is enforced at the only moment that matters: the commit. The
  // probe reports facts about the tree (a root that has become a shelf for several kinds of
  // artifact, the shape of the top level); the guard refuses the commit while those facts
  // are unacknowledged by the state documents. Whether a directory is *well named* is a
  // judgement no guard can make, and this guard does not pretend to.
  if (config.guardLayoutCheckpoint !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'pwsh' && execution.name !== 'bash') return undefined;
          if (!isCommitCommand(execution.arguments?.command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const state = states.get(agent.id);
          if (state === undefined) return undefined;
          const cwd = agent.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const facts = readTreeFacts(cwd, config.digestFiles);
          if (facts === undefined || facts.flagged !== true) return undefined;
          // The acknowledgement may live in any maintained document: the digest is what the
          // model sees, so requiring it in the commit itself is what makes the walk real.
          const documents = config.digestFiles
            .map((document) => readIfPresent(join(cwd, document)) ?? '')
            .join('\n')
            .toLowerCase();
          if (acknowledgesLayout(documents, facts)) return undefined;
          return [
            'Project Forge Mode refuses `git commit`: the layout of this repository has not been checked.',
            `The project root holds ${facts.rootFiles.length} non-document files across ${facts.kinds.length} kinds`
              + ` (${facts.kinds.join(', ')}) and ${facts.directories.length} directories`
              + ` (top level: ${facts.topLevel.slice(0, 8).join(', ')}${facts.topLevel.length > 8 ? ', …' : ''}).`,
            'Walk the tree (§5.5) and record the result in `done.md`: what each directory holds, where a new',
            'file belongs, and what you concluded. A bare file name does not count — name a directory, or',
            'state explicitly that the flat layout is a decision (「保持扁平」/ "kept flat: <why>") — then commit.',
          ].join(' ');
        }),
      'project-forge.layoutCheckpointGuard()',
    );
  }

  // ── Guard B: the checkpoint protocol ─────────────────────────────────────────
  // A checkpoint is a commit of a consistent state, so two situations refuse it: the
  // session was compacted and no state document has been touched since, or the digest
  // can see commits the documents do not mention.
  if (config.guardCommitCheckpoint !== false && ctx.tools !== undefined) {
    ctx.on('tools/result', (execution, result) => {
      if (result.isError) return;
      if (execution.name !== 'write' && execution.name !== 'edit') return;
      const path = execution.arguments?.file_path;
      const agent = execution.agent;
      if (typeof path !== 'string' || path.length === 0 || agent === undefined) return;
      const normalized = path.replace(/\\/g, '/').toLowerCase();
      const state = states.get(agent.id);
      if (state === undefined) return;
      state.touchedDocs.add(normalized);
      if (config.digestFiles.some(
        (document) => normalized === document.toLowerCase() || normalized.endsWith(`/${document.toLowerCase()}`),
      )) {
        state.docSinceCompaction = true;
        // Any document write closes the post-compaction window for the checkpoint guard.
        state.compacted = false;
        // The drift was written down; the next refresh will re-read the documents.
        state.unrecordedCommits = false;
      }
    });

    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'pwsh' && execution.name !== 'bash') return undefined;
          if (!isCommitCommand(execution.arguments?.command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const state = states.get(agent.id);
          if (state === undefined) return undefined;
          if (state.docSinceCompaction) return undefined;
          // `compacted` is set by the real `compaction/end` event; it is not inferred from
          // the surface generation, which also changes for pruning and spill.
          const stale = state.compacted === true || state.unrecordedCommits;
          if (!stale) return undefined;
          return [
            'Project Forge Mode refuses `git commit`: this is not a checkpoint of a consistent state.',
            state.compacted === true
              ? 'This session was compacted and no state document has been updated since.'
              : 'The repository holds commits the state documents do not mention.',
            `Update \`done.md\` (and \`todo.md\` / \`plan.md\` as they changed): record the current state,`,
            'reconcile it with `git status` and `git log`, and put any mismatch in the Drift section —',
            'then commit.',
          ].join(' ');
        }),
      'project-forge.commitCheckpointGuard()',
    );
  }

  // ── Guard D: no secrets into the repository ────────────────────────────────────
  // A commit that lands a secret is the one mistake `git log` cannot undo: the value is
  // in history forever, even after a later "remove" commit. The guard therefore refuses
  // the *stage-and-commit* itself when the tracked-file set includes a path that exists
  // only to hold credentials. This is the one secret class that is decidable from the
  // file name alone; a key *inside* an ordinary source file is not decidable and is
  // covered by the protocol, not this guard.
  if (config.guardSecrets !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'pwsh' && execution.name !== 'bash') return undefined;
          if (!isCommitCommand(execution.arguments?.command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const cwd = agent.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          // A tracked file that exists only to hold credentials. `.env` is matched with a
          // boundary so legitimate names like `dev.env.sample` are not flagged.
          const tracked = runGitOrNothing(cwd, ['ls-files']);
          if (tracked === undefined) return undefined;
          const trackedFiles = tracked.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
          const envPattern = /(^|\/)\.env(\.|$)/;
          const offending = trackedFiles.filter(
            (path) =>
              envPattern.test(path) ||
              /\.(pem|key|p12|pfx)$/i.test(path) ||
              /(^|\/)(credentials|secrets?)(\/|\.|$)/i.test(path),
          );
          if (offending.length === 0) return undefined;
          return [
            'Project Forge Mode refuses `git commit`: the repository is staged to record a credential.',
            `Tracked file(s) that exist only to hold secrets: ${offending.slice(0, 5).join(', ')}${offending.length > 5 ? ` and ${offending.length - 5} more` : ''}.`,
            'A committed secret stays in `git log` forever — removing it later does not erase history.',
            'Purge the file from history (e.g. `git rm --cached` + filter or BFG), move the value into a',
            'secret store or an untracked, gitignored file, and only then commit. See §1.6 of the protocol.',
          ].join(' ');
        }),
      'project-forge.secretsGuard()',
    );
  }

  // ── Guard E: concurrent-write interception (per-file claims) ───────────────────
  // On 2026-10-07 three main agents really did work one project in parallel, and the
  // shared state documents (done/plan/todo/tortuous) were each written by two of them;
  // narrative documents cannot be merged, so the second writer silently overwrote the
  // first. This guard closes that window with a per-file claim stored on disk, so it is
  // shared across every session on the same project root.
  //
  // Semantics: writing a shared file requires claiming it. The first session to claim a
  // file may write it; the claim is released when the file is committed or the owning
  // process dies. A second session is refused while a live claim by another agent holds,
  // and takes over a stale (dead-owner) claim. §12.1's single-document-owner rule keeps
  // most parallel agents off these files entirely; this guard is the hard backstop.
  if (config.guardConcurrentWrite !== false && ctx.tools !== undefined) {
    // A successful commit releases every claim in this project: the work has landed, so no
    // file is mid-edit any more. Without this, claims from a crashed or finished session
    // sat on disk until the 30-minute staleness window — a real incident on 2026-10-08 left
    // 82 stale claims behind and blocked a parallel session five times.
    ctx.on('tools/result', (execution, result) => {
      if (result?.isError) return;
      if (execution.name !== 'pwsh' && execution.name !== 'bash') return;
      if (!isCommitCommand(execution.arguments?.command)) return;
      const cwd = execution.agent?.session?.header?.cwd;
      if (typeof cwd !== 'string' || cwd.length === 0) return;
      clearClaims(cwd);
    });

    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'write' && execution.name !== 'edit') return undefined;
          const rawPath = execution.arguments?.file_path ?? execution.arguments?.path;
          if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
          const base = rawPath.split(/[\\/]/).pop().toLowerCase();
          const SHARED = ['done.md', 'plan.md', 'todo.md', 'tortuous.md', 'steward.md'];
          const isDoc = SHARED.includes(base);
          const mode = config.concurrentWriteMode ?? 'both';
          const protectSource = mode === 'sourceFiles' || mode === 'both';
          if (!isDoc && !protectSource) return undefined;
          if (!isDoc && !/\.(dart|py|js|mjs|ts|go|rs|java|kt|rb|php|c|cc|cpp|h|cs|sh|ps1)$/i.test(base)) return undefined;
          const agent = execution.agent;
          const cwd = agent?.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const absolute = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
          const rel = relative(cwd, absolute).replace(/\\/g, '/');
          // Never claim a file outside the project: a session may write scratch files in
          // Temp or elsewhere, and their claims do not belong to this project's claim set.
          if (rel.startsWith('..')) return undefined;
          const self = agentIdentity(agent);

          // A working-tree change we do not own is always a blocker, even with no claim.
          const dirty = gitDirtyPath(cwd, absolute);
          let claim = readClaim(cwd, rel);
          if (claim !== undefined && !claimFresh(claim)) {
            // Stale claim: its owner is gone (crash, hang, or finished without commit).
            // Delete it and treat the file as unclaimed instead of leaving residue forever.
            deleteClaim(cwd, rel);
            claim = undefined;
          }
          // Housekeeping: drop every other stale claim in this project while we are here.
          clearStaleClaims(cwd);
          if (claim !== undefined && claim.owner !== self) {
            return [
              `Project Forge Mode refuses to write \`${rel}\`: it is claimed by session ${shortId(claim.owner)}.`,
              'That session is editing it right now; a second writer would silently overwrite its work.',
              'Coordinate (or ask it to commit — a commit releases every claim), then try again. See §12.',
            ].join(' ');
          }
          if (dirty === true && claim?.owner !== self) {
            return [
              `Project Forge Mode refuses to write \`${rel}\`: it has uncommitted changes.`,
              'Another session likely edited it and has not committed; re-read it and reconcile before writing.',
              'See §12 of the protocol.',
            ].join(' ');
          }
          // Take or keep the claim, then allow the write.
          writeClaim(cwd, rel, { owner: self, time: Date.now() });
          return undefined;
        }),
      'project-forge.concurrentWriteGuard()',
    );
  }
}

/**
 * A short, recognisable form of a session id for error messages. `owner.slice(0, 8)` was a
 * real bug: every session id starts with `session-`, so the slice showed `session-` and the
 * owner was invisible in the refusal (an anonymous "ghost" blocker).
 * @param owner - the claim owner's session id.
 * @returns the UUID portion, truncated to 8 characters.
 */
function shortId(owner) {
  return String(owner).replace(/^session-/, '').slice(0, 8);
}

/**
 * Delete one claim file, if present. Absent files are not an error.
 */
function deleteClaim(cwd, rel) {
  try {
    unlinkSync(claimPath(cwd, rel));
  } catch {
    /* absent or locked — fine */
  }
}

/**
 * Remove every stale claim in one project (owner quiet past the staleness window). Called
 * lazily on each guarded write, so residue cannot accumulate across sessions.
 */
function clearStaleClaims(cwd) {
  let names;
  try {
    names = readdirSync(join(cwd, '.agents', '.forge-claims'));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const claim = JSON.parse(readFileSync(join(cwd, '.agents', '.forge-claims', name), 'utf8'));
      if (!claimFresh(claim)) unlinkSync(join(cwd, '.agents', '.forge-claims', name));
    } catch {
      /* unreadable entries are left alone */
    }
  }
}

/**
 * Remove every claim in one project. Called after a successful commit: the work has landed,
 * so no claim is mid-edit any more.
 */
function clearClaims(cwd) {
  let names;
  try {
    names = readdirSync(join(cwd, '.agents', '.forge-claims'));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.json')) {
      try {
        unlinkSync(join(cwd, '.agents', '.forge-claims', name));
      } catch {
        /* best-effort */
      }
    }
  }
}
