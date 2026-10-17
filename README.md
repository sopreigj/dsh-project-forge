# dsh-project-forge

English | [中文](README.zh.md)

**Project Forge (项目锻造模式)** — a DeepSeek Harness agent preset that turns an agent into the steward of a project: it keeps the project recoverable (local git), traceable (four contracts plus append-only records), well-organized (layout & naming discipline), and safe to continue after context loss (compaction recovery), with write guards that hold even when the model does not cooperate.

It ships two presets:

| Preset | For |
|---|---|
| `project-forge` | Full stewardship: protocol, live document digest, compaction recovery, the write guards |
| `project-forge-review` (in `review/`) | Read-mostly review mode: code review, simple tasks, clean-room subagents |

## Install

```sh
# Local development checkout
dsh plugin --profile web add link:/path/to/dsh-project-forge
dsh plugin --profile web add link:/path/to/dsh-project-forge/review

# Or straight from git
dsh plugin --profile web add github:sopreigj/dsh-project-forge#main
```

Bundle plugins take effect after restarting `dsh web`. Then pick 项目锻造模式 / 项目锻造 · 干净审查 in the mode picker.

> **Requires DeepSeek Harness >= 0.2.1-rc.** The digest leaves `{{...}}` alone and hands interpolation off to `systemPrompt.context`'s `interpolate: false`; older hosts honour that switch on sections only, so on an older host a document quoting braces fails during prompt assembly (see `CHANGELOG.md` 3.4.0 and `V11` in the negative-knowledge record).

## What the mode enforces

- **A state boundary.** Everything the project keeps for itself — the four contracts, the records,
  repository's own rules, the concurrent-write claims — lives in one directory (`private/` by
  default). Everything outside it is the **public surface**, written as if the project were
  already open source: portable, no private fact outside a configuration file (which ships an
  example twin), no reference into the boundary. Publishing is then mechanical: delete the
  boundary, copy the tree, `git init`.
- **Local-only git**: never push, add a remote, or rewrite history until the user explicitly asks.
- **State in three classes**, all inside the boundary. *Contracts* —
  `private/steward.md` (the repository's own rules), `plan.md` (strategy), `done.md` (current
  state), `todo.md` (queue) — are inlined **in full** every turn: each has a soft budget, and a
  budget is a warning threshold, never a truncation. *Records* — `private/journal.jsonl` (work
  log) and `private/tortuous.jsonl` (negative knowledge: failed routes and recorded deviations) —
  are append-only JSONL, one record per line, never inlined; only a one-line-per-record index and
  the last few journal entries ride the digest and the recovery message. *On-demand* material
  lives in `private/rationale/`. A project whose documents still sit at the project root is read
  there (and its rules at `.agents/steward.md`), so nothing forged before the boundary existed
  breaks.
- **Checkpoint protocol**: close a logical unit → run checks → update documents → one commit. Never commit per command.
- **Layout & naming**: directory/file/identifier names follow one-word-one-meaning at every level; checked at every checkpoint; the layout guard refuses unacknowledged mixed-artifact roots.
- **Parallel sessions**: single document owner, per-file claims under `private/.forge-claims/`, released on commit, stale claims expire by themselves (10 minutes of silence).
- **No secrets in git**: refuses to commit credential files outside the boundary (inside it, a local-only repository may hold them).
- **Compaction recovery**: a real `compaction/end` event folds a recovery message (protocol restatement + fresh digest) into the next step.

## Configuration

Every switch defaults on. The complete reference — all 33 fields, their defaults and what they
do — is **[docs/configuration.md](docs/configuration.md)**. `release/check-consistency.mjs` compares
that table against the plugin schema, so the two cannot drift apart.

What changed in a given version, and what you have to do about it, is in
**[CHANGELOG.md](CHANGELOG.md)** — one entry per version, newest first.

The two you are most likely to touch:

```yaml
- id: project-forge
  name: 'dsh-project-forge'
  config:
    sizeLimitMode: ratchet    # also refuse a commit that grows an already-over-cap document
    stateDir: '.'             # fall back to the pre-boundary layout (documents at the root)
```

## Layout of this repo

```
dsh-project-forge/
├── package.json          # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      # the preset composition (project-forge)
├── plugin/               # the mode plugin: protocol + digest + recovery + guards, one slice each
├── test/                 # the check project: one file per plugin slice, one shared fixture
├── skills/project-forge-grilling/   # bundled discussion skill
├── review/               # review-mode bundle (own package.json + its own copy of the skill)
├── release/              # release tooling: eight checks and the publish script
├── locale/               # the preset cards, English and Chinese
├── docs/                 # documentation for users and contributors
└── README.md / README.zh.md / CHANGELOG.md / LICENSE
```

`docs/` follows Diátaxis — one reader need per file: [getting-started.md](docs/getting-started.md) is
the tutorial (install, verify which copy is live, first takeover),
[how-to-change-the-mode.md](docs/how-to-change-the-mode.md) shows how to change the mode itself
(protocol text, a guard, a config field), [configuration.md](docs/configuration.md) is the reference, [state-boundary.md](docs/state-boundary.md) explains the boundary (design, export
flow, guard coverage), and [init-a-project.md](docs/init-a-project.md) is the how-to for bringing a project under the mode.

In this development repository the state boundary `private/` is tracked by git (so state is
recoverable) and **excluded wholesale by `release/publish.ps1`**, which is why it does not appear
in the published bundle.

## Development

```sh
node test/run.mjs plugin/index.js   # self-test: config, digest, guards, patch↔schema drift
node release/check-consistency.mjs           # docs/configuration.md ↔ schema; the two skill copies
node release/check-preset-sync.mjs --source <dsh-checkout>   # preset rows vs the shipped `standard`
node release/check-public-surface.mjs        # the mode's privacy guard, applied to this repo
node release/check-runtime.mjs               # skill frontmatter + the customSkillDirs target
node release/check-changelog.mjs             # package.json's version has a CHANGELOG entry
node release/check-prompt-variables.mjs      # every {{variable}} in the patch is one the host registers
node release/check-installed.mjs             # profile entries point at a copy that exists
```

The plugin imports only Node builtins — profile-installed bundles resolve no third-party packages. The hand-written Standard Schema in `plugin/config/schema.js` implements the exact `~standard.validate` interface Cordis requires (the official docs use `@deepseek-ai/schemastery`; a hand-written schema is used here to keep the bundle dependency-free).

`release/` holds the release tooling. Eight checks — seven scripts, `check-runtime` runs twice (this
repo, then `review/`) — each able to fail:

| check | refuses when |
|---|---|
| `check-consistency.mjs` | the configuration table, the docs' path references, the retired vocabulary or the two copies of the bundled skill disagree with their single source |
| `check-preset-sync.mjs` | a row upstream's `standard` preset carries is missing here (it needs a DSH checkout — `--source <dir>` or `$DSH_SOURCE` — and skips cleanly without one) |
| `check-public-surface.mjs` | this repo's own public files trip the mode's privacy guard |
| `check-runtime.mjs` | the skill frontmatter or the `customSkillDirs` target does not resolve (run twice: the repo, then `review/`) |
| `check-changelog.mjs` | `package.json`'s version has no `CHANGELOG.md` entry |
| `check-prompt-variables.mjs` | the preset text names a `{{…}}` variable the host does not register (the source of truth is read from a git tag, not a working tree) |
| `check-installed.mjs` | a profile's install entry points at a copy that no longer exists |

`publish.ps1` runs **all eight** plus two source-derived sub-checks before mirroring this tree into the
public repository, so a stale or broken public surface is refused rather than published. Every
machine-specific value — the publish directory, the DSH checkout, the tag the source-of-truth checks
read, extra excludes — comes from `release/publish.config.json`: gitignored, excluded from the
mirror, and shipped to you only as `publish.config.example.json`. A machine path in a public script
is exactly what §1.7 forbids, and the script refuses to run if the config file itself is tracked.

## Boundaries (read before trusting it)

- Guards refuse at the shell-tool boundary; they are anti-slip, not a security boundary (alternate phrasing/scripts/provider APIs can bypass).
- Guard E (`guardPrivacyBoundary`) checks three decidable things — a home directory of this machine, a source file reaching into the boundary, a high-confidence secret literal outside a configuration file — and nothing about whether prose "reads public". A file may opt out with the marker `privacy-guard: allow`; the mode's own plugin and fixtures carry it.
- Guard F protects high-contention files only (the four contract documents + the steward rules + source files); merge conflicts in ordinary files are git's job.
- The protocol is prompt text: it is always *present*; whether the model *obeys* is not machine-verified except where a guard enforces it.

## License

MIT — see [LICENSE](./LICENSE).
