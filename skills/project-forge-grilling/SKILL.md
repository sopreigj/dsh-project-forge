---
name: project-forge-grilling
description: Use when a Project Forge Mode session must clarify a complex task, feature, refactor or design with the user before building it, and the outcome has to land in the project's four state documents. Runs one focused question at a time, records confirmed decisions straight into plan.md, and hands the agreed execution steps to todo.md.
---

# Project Forge grilling

A structured grilling session for **Project Forge Mode**. It is adapted from the
`grill-me` skill so that its output survives this mode's own protocol: the four state
documents, the requirement to keep them current, and context compaction.

This skill does not own `plan.md`. `plan.md` already holds the project's strategy, the
decision log, and the record of how user corrections changed the plan.

## When to use

Use it when the user needs to think through a complex task, feature, refactor or
design before it is built. Do not use it for a one-line change, a typo fix, or a
task whose shape is already settled by `plan.md` and `todo.md`.

## Before the first question

Do not ask the user anything yet. Read what the project already knows:

1. **Your runtime context** — `plan.md`, `todo.md`, `done.md`, `.agents/steward.md` and
   the repository state are inlined there every turn: the strategy, the open work, how
   the project got here, this repository's own rules, and the recent commits.
2. `tortuous.md` from the project root — the approaches that already failed. A
   grilling question whose answer is "we tried that, it failed for reason X" is a
   question you should not have asked.
3. Run the state-consistency check the protocol requires before a new direction is
   agreed: do the documents and the repository still agree? Record any mismatch in the
   **Drift** section of `done.md` before grilling changes the plan further.

Then classify every question you are considering, exactly as this skill requires:

- **Factual question** — the answer is in the codebase, the configuration, or the
  environment, and read-only inspection can settle it. **Do not ask.** Investigate
  first (read, search, inspect configuration). If you resolve it, record the finding
  in `plan.md` under the current topic and move on, or sharpen it into a follow-up
  built on what you found. Ask only if you genuinely cannot resolve it, and say what
  you already checked so the user does not repeat your work.
- **Taste question** — the answer depends on the user's preference, priorities, or
  risk appetite and cannot be derived from the project. Always ask; never guess.

## Session flow

### Phase 1 — Grilling, one question at a time

1. Ask **one focused question per turn**. Never bundle several questions.
2. With each question, offer a recommended answer or 2–3 concrete options, so the
   user can answer with one word.
3. Decide whether the current branch is clear. If it is, move to the next branch; if
   not, ask one sharper follow-up.
4. Cover, when relevant: goal and success criteria; scope (in and out); users and
   stakeholders; trigger, timing and frequency; success and failure handling; edge
   cases and constraints; dependencies and impacted files or modules; risks and
   trade-offs.
5. **Never ask the user to decide something the protocol already fixes.** Unless the
   user explicitly overrides it, these hold and are not grilling topics: local-only git
   (no remote, no push, no history rewriting); the four state documents and their
   distinct roles; layered modular organization with explicit boundaries and dependency
   direction; high cohesion, low coupling, minimal duplication; necessary comments that
   explain why; the standalone `test/` project rule. If the user *does* want to override
   one, record the override in `plan.md` — the next compaction must not silently restore
   the default.
6. **Never ask a question whose answer is a document-keeping chore.** "Should I update
   `done.md`?" is not a grilling question; the protocol requires it.

#### Writing into `plan.md` while grilling

`plan.md` is the plan of record, so grilling does **not** create a second plan file
and does not overwrite `plan.md`.

- If `plan.md` does not exist yet, create it with the scaffold below.
- If it exists, **append a new topic section**; never reformat or drop what a previous
  session recorded. Existing content is history, and history is what makes the plan
  and its corrections auditable.
- After every user answer, write down only what that answer actually settled or
  raised: confirmed decisions, constraints, rejected alternatives and open questions.
  Do not fill in speculative content.

Topic scaffold to append (or use for a fresh `plan.md`):

```markdown
# plan.md — <one-line project goal>

## Corrections (用户指正记录)

<!-- One row per correction: what the user said, what changed, and why. -->

## Plan: <topic>

### Goal and acceptance criteria

### Background (verified project facts)

### Decisions

<!-- Decision · rationale · alternative rejected -->

### Phases

### Risks and mitigations

### Open questions
```

When the user corrects your direction, add a row to **Corrections** before acting on
it, and revise the affected topic section. `plan.md` is the only place a correction is
considered recorded.

Keep the boundary the protocol draws: `plan.md` holds **strategy** (why, how, which
route, how the route changed). The moment an item becomes "do this next", it belongs in
`todo.md`. If the same items appear in both files, delete them from `plan.md`.

### Phase 2 — The user stays in control

After every question, print this block verbatim:

> You can say:
> - "继续" / "continue" — answer and keep going
> - "跳过" / "skip" — skip this question
> - "够了" / "stop" / "enough" — stop grilling and finalize the plan
> - "直接执行" / "execute" — stop grilling and start building

Any stop phrase ends the grilling immediately: ask nothing further and go to Phase 3.

### Phase 3 — Finalize the plan and hand over the work

1. Stop asking questions.
2. Read the current `plan.md` and summarize the structured plan for the topic in your
   reply: goal, decisions, rejected alternatives, phases, risks, acceptance criteria.
3. Ask the user for additions or corrections, and write them into `plan.md` — including
   any protocol clause the user decided to override, recorded as an explicit override.
4. **Move the agreed execution steps into `todo.md`** as concrete, ordered items — the
   protocol requires work to be tracked there, and `plan.md` holds strategy rather than
   a task queue. Keep both files consistent in the same change.
5. If the discussion produced a rule that will matter to the next session (a project
   convention, a constraint, an override), write it into `.agents/steward.md` as well.
6. If the topic implies new directories or moves, settle the **layout** here rather than
   during implementation: what each new directory holds, what it is named for, and which
   references outside the repository (deployment scripts, symlinks, systemd units,
   documentation) must move with it. Record the conclusion in `plan.md`; the standard it
   has to meet is §5.5 of the protocol — a reader new to the project guesses what each
   directory holds without opening a file.
7. Tell the user what you wrote: which `plan.md` topic section was added or revised,
   which `todo.md` items were created, and whether `.agents/steward.md` changed.

### Phase 4 — Execution, only when asked

Only after the user explicitly says "execute" / "直接执行":

1. Work from `todo.md`, taking one item at a time.
2. Remove each completed item from `todo.md` in the same change that completes it, and
   record the work in `done.md` — the commands that matter, the files changed, what each
   change implemented, and how it was verified.
3. Follow the checkpoint protocol from the protocol section: close a logical unit, run
   the checks, update the state documents, then one local commit with a scoped message.
   Never add a remote and never push.
4. Record every failed approach in `tortuous.md` using the protocol's entry template,
   including this one, so the next grilling session does not re-open it.
5. Run the state-consistency check before each commit, and record any mismatch in the
   **Drift** section of `done.md`.

## Constraints

- Never execute the plan during grilling: no code changes, no test runs, no commits.
  Reading, searching and inspecting are expected and encouraged; mutation is not.
- You may create or update `plan.md`, `todo.md` and `.agents/steward.md` during grilling —
  they are the grilling's own output medium. Do not finalize anything the user has not
  confirmed.
- Never ignore an explicit stop signal.
- Never invent an answer for a taste question; ask.
- Do not restate the whole protocol in every reply. Restate it when a compaction has
  happened or when the user asks; otherwise keep the session moving.
- This skill clarifies and records. It does not replace the protocol: the checkpoint
  guard, the local-only git guard and the four-document requirements still apply while
  you are executing.
