# Configuration reference

Every switch of the `project-forge` row (and the `project-forge-review` row, which shares the
plugin). All of them default **on**; set `false` to disable.

Override a field in a profile's `cordis.patch.yml`:

```yaml
- id: project-forge
  name: 'dsh-project-forge'
  config:
    sizeLimitMode: ratchet      # only the fields you change
```

The **default column holds a JSON literal** on purpose: `release/check-consistency.mjs` parses it
and compares it field by field against `plugin/config/schema.js`, so this table cannot drift from the
code that implements it.

| Field | Default | Meaning |
|---|---|---|
| `protocol` | `true` | Register the steward protocol section in every request. |
| `recoveryProcedure` | `true` | Register the post-compaction recovery section. |
| `digest` | `true` | Inline the contract documents every turn. |
| `stateDir` | `"private"` | The state boundary: the one directory holding the documents, the rules and the claims. `"."` restores the pre-boundary layout (documents at the project root); a project whose documents still sit at the root keeps working either way. |
| `digestFiles` | `["plan.md","done.md","todo.md"]` | Which contract documents are inlined, and in what order. Least-volatile first, because a change invalidates everything after it in the cached prefix. |
| `documentBudgets` | `{"steward.md":6000,"plan.md":15000,"done.md":2000,"todo.md":5000}` | Per-document **soft budget** in characters. A budget is a warning threshold, never a truncation: an over-budget document is still inlined whole and the digest reports by how much. |
| `documentBudgetDefault` | `20000` | Budget for a contract document the map does not name. |
| `journalFile` | `"journal.jsonl"` | The append-only work record. Never inlined; only the compaction-recovery message carries its last entries. |
| `journalRecoveryEntries` | `5` | How many of those entries ride the recovery message. |
| `tortuousFile` | `"tortuous.jsonl"` | The append-only negative-knowledge file. Never inlined; only a one-line-per-record index is. |
| `tortuousIndexBytes` | `2500` | Character ceiling for that index. |
| `repoCommitWindow` | `8` | How many recent commits the repository block lists. The checkpoint guard reads the same list, so this is also its look-back window. |
| `repoStateInDigest` | `true` | Append branch, HEAD and recent commit subjects, so document/repository drift is visible without spending a tool call. |
| `stewardFile` | `true` | Inline the repository's own rules, making the repository self-describing. |
| `stewardFilePath` | `"private/steward.md"` | Where those rules live. A repository that still keeps them at `.agents/steward.md` is read there too. |
| `digestMaxBytes` | `28000` | Ceiling for the whole inlined block. A pure fuse: crossing it adds one warning line and never truncates. |
| `digestRefreshMs` | `5000` | How often the digest re-reads the files (a cached block otherwise). |
| `injectOnCompaction` | `true` | Fold one recovery message carrying the digest into the first step after a real compaction. |
| `recoveryMinTurnStep` | `1` | Earliest step of a turn that may carry the recovery message, which bounds it to one per turn. |
| `guardLocalGit` | `true` | Refuse shell commands that publish the repository or destroy local history. |
| `guardCommitCheckpoint` | `true` | Refuse `git commit` until one of the four contract documents has been written since the last commit (the exemption dies the moment HEAD moves — it is not a standing permit), and when git shows commits the documents do not mention. The refusal names the files the session did touch, and the contract documents that would have counted. |
| `guardLayoutCheckpoint` | `true` | Refuse a commit whose layout check was not acknowledged. The refusal reports what it measured, including a labelled list of the non-document files sitting at the root. |
| `guardSecrets` | `true` | Refuse a commit that would record a credential file outside the state boundary. |
| `guardPrivacyBoundary` | `true` | Refuse a commit whose public files leak this machine's home path, reach into the boundary from source, or carry a high-confidence secret literal. |
| `guardConcurrentWrite` | `true` | Refuse to write a shared file another live session has claimed; take over a claim whose owner went quiet. |
| `guardAppendOnly` | `true` | The record files may only grow: a write that does not keep the text already on disk as its prefix is refused, and the refusal localizes the divergence — the offset and line where the draft stopped matching, plus both sides' text at that point. |
| `guardMalformedToolCall` | `true` | Rewrite an empty tool-call id from the model stream into a synthetic one (an empty id freezes the session file mid-turn). The repair is logged, and the digest then reports it — the repaired call reaches the model as an unknown tool, so without that line the cause would look like a missing tool. |
| `sizeLimitMode` | `"warn"` | `"warn"` only prints the digest warning line. `"ratchet"` additionally refuses a commit that makes an **already-over-cap** document bigger; shrinking and splitting always pass. The refusal reports that document's budget, the hard cap, the current size and how far over the cap it is. |
| `sizeHardRatio` | `1.5` | Hard cap = the document's budget × this factor, used by `"ratchet"`. |
| `clockFooter` | `false` | Append one line carrying the current time to a successful tool result. Off by default: the preset adopts upstream's `time-context`, and two time sources are one too many. Turn it on for a preset that has no `time-context`. |
| `clockFooterThrottleMs` | `600000` | Minimum interval between two such lines, per session. |
| `concurrentWriteMode` | `"both"` | Which shared files the claim guard protects. With `"both"` or `"sourceFiles"` it covers the four contracts, source files, and **any other file this project tracks**; with any other value, the contracts only. Untracked files (build artifacts, drafts) are never claimed. |
| `claimStaleMs` | `600000` | How long a claim survives without its owner touching it. Expiry is the only cleanup this design relies on. |

## Notes

- **Budgets are fences, not quotas.** No field here truncates a document. An over-budget contract
  is reported in the digest, and the fix is to move the oldest detail into `journal.jsonl` or
  `private/rationale/` — never to compress the wording.
- **The boundary is a convention, not a gate.** A repository that predates it keeps working:
  readers fall back to the project root for the documents and to `.agents/steward.md` for the
  rules.
- **`stateDir` is resolved relative to the project root**, as is `stewardFilePath`; both are
  inside the boundary by default, which is what `release/publish.ps1` excludes wholesale.
