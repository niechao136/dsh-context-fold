# dsh-context-fold — Design

**Date:** 2026-11-12
**Status:** awaiting approval
**Scope of this document:** phase 1 (tool-result folding) and phase 2 (reasoning folding, §12). Phases 3–4 are sketched only.

---

## 1. Intent and why

Long DSH sessions get dominated by content that was useful once and is re-sent forever. In this project's own measurement of two real sessions (38 and 44 steps), **tool results were 63–64% of the final context surface** and assistant messages 22–25%.

The sharper number is about *timing*, not size. In one session, the opening environment-reconnaissance block (a run of `cordis_inspect_*` / `ops_*` calls in turn 1) settled by **step 11**, then never changed again — and was re-sent **28 times**. That block alone was **70.7% of the final surface** and consumed roughly **43% of all input tokens billed across the session**.

The user's stated pain: they would have kept discussing in one session if context were not the constraint. Splitting into a new session is the real information loss; default compaction is a secondary worry (and on this route, with a 1,000,000-token window at 10% occupancy, it rarely triggers at all).

So the target is not "compress history". It is: **content that a completed stage produced, and that later stages only occasionally need, should leave the window and remain reachable in one hop.**

### Why "Inline & Spill" and not "lossless compression"

The reference material's Inline & Spill is **reversible eviction**, not lossless compression. Three senses of "lossless" must be kept apart:

- **Storage-lossless** — the full text is preserved on disk. Achieved.
- **Context-lossless** — all information still in the window. Impossible by definition.
- **Access-lossless** — retrievable when needed. Depends on the model *knowing* to retrieve.

Default compaction fails even storage-lossless (an LLM summary replaces the span permanently). Folding at least preserves the first. But the dangerous failure mode is in the third sense: **a compaction summary is visibly incomplete, so the model is cautious; a spill pointer looks complete, so the model may answer fluently without reading it.** This design must therefore put conclusions inline and only pointers to detail — never a bare pointer where a conclusion belongs.

---

## 2. Goals, non-goals, anti-goals

### Goals

1. Keep a single session viable for hundreds of steps by removing completed-stage tool output from the re-sent surface.
2. Preserve exact originals and make them reachable in one hop, without a new recall tool.
3. Make folding **deterministic** — same input, same output. No model calls, ever.
4. Never break protocol: no orphaned tool calls, no invalid replay state.
5. Be measurable: report tokens saved so the value is verifiable, not assumed.

### Non-goals

- Replacing `compaction-basic`. Folding is additive; compaction still handles true overflow.
- Cross-session recall. That is `dsh-recall`'s job and is explicitly out of scope here (see §4, rejected approach D).
- Folding user messages or assistant text.
- Folding reasoning blocks — **now in scope as phase 2 (§12)**, via a message projection rather than a surface rewrite.

### Anti-goals — what would make this a failure even if it "works"

- **The model re-reads what we folded.** If folding causes re-fetching, we pay twice and lose. Measured by re-read rate per folded node.
- **A session gets slower or errors.** A protocol error on any step is a total failure.
- **The user cannot tell what was folded.** Silent context mutation without a visible record is unacceptable.
- **It folds content still in use.** Folding an actively-referenced result is worse than not folding.

---

## 3. Constraints and verified facts

All of the following were verified against the running installation, not assumed.

### 3.1 The replace protocol already exists and is replay-safe

`@deepseek-ai/dsh-compaction-tool-result-pruner` (194 lines, read in full) performs exactly the mutation this design needs:

```js
session.append("compaction/prune", {
  shadowedRange: { start: seq, end: seq },
  shadowedSeqs: [seq],
  shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
});
session.append("tool/result", { ...event.data, message }, {
  surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],
});
```

Properties this gives us for free:

- The original event stays in the append-only log; `sourceEventSeqs` makes replay recover the exact input.
- `compaction/prune` prices the shadowed node so pure consumers can subtract it.
- Only `content` changes; call id, step, error, and metadata are preserved — so **tool-call pairing is never broken**.

This is the template. We are not writing a mutation engine; we are writing a *policy* for when and how to fold.

### 3.2 Session access from a plugin is possible

- `agent/turn-stopping` is a `serial` event carrying `{ agent, turn, signal }` — the stage-boundary hook.
- `ctx.sessions.get(agent.id)` returns the live `Session`.
- `Session.append` accepts `SurfaceIntent` on surface event types.
- `ctx.spillStore.saveText({ owner: { sessionId }, source: {...}, suggestedName, content })` returns `{ locator, bytes, retrievalHint }`.

**Conclusion: this is a standalone plugin. No core changes required.**

### 3.3 Retrieval needs no new tool

`spillStore.saveText` already returns `retrievalHint`: *"Use read with offset/limit, or grep this path to search within it."* The existing `read` and `grep` tools are the recall primitives. `dsh-spill-policy` already ships this pattern, so the model is trained on it by exposure.

### 3.4 Sizing — measured on real data

Per-fold fixed overhead (path 118 chars + notice + one-line conclusion) ≈ **278 chars**.

| Threshold | Saving per fold | % of original |
|---|---|---|
| 300 chars | 22 | 7% |
| 500 chars | 222 | 44% |
| **1000 chars** | **722** | **72%** |
| 2000 chars | 1722 | 86% |

Result-size distribution in a real 55-result session:

| Threshold | Results below | % of tool bytes |
|---|---|---|
| ≤200 chars | 13 (24%) | **0.9%** |
| ≤500 chars | 24 (44%) | 2.5% |
| ≤1000 chars | 33 (60%) | 5.7% |
| ≤2000 chars | 37 (67%) | 8.9% |

**Top 12 results = 82.4% of tool bytes.** Skipping short results costs almost nothing and avoids pointless churn.

### 3.5 Cache invalidation is the main financial risk — and it is timeable

The agent-loop documentation states that a surface replacement invalidates prefix reuse from the first shadowed token. Folding therefore has a one-time cost and a per-step saving.

Observed cache behaviour is **inconsistent across sessions on this machine**: one session showed `cacheReadTokens` rising 58k → 118k; another showed **zero cache fields on all 38 steps**. Therefore:

- The break-even model is real but its constant is unknown.
- Folding once at a **stage boundary** amortises the invalidation over all remaining steps, which is the best available mitigation.
- **Open item:** confirm actual cache behaviour on the target route before tuning aggressiveness.

### 3.6 Prior art (checked on npm)

| Package | Mechanism | Overlap |
|---|---|---|
| `dsh-fold` (taken) | Disables `compaction-basic`, subclasses it, overrides `summarize()`. Folds the oldest *span* into a brief. Explicitly "No fold tool yet." | Same motivation, different seam |
| `dsh-recall` (taken) | Cross-session history search, three-tier retrieval, compaction anchors | Different scope |
| `dsh-context` | Read-only context dashboards | Our UI reference |

Neither folds individual tool results at a stage boundary with inline chained pointers. **This plugin's position is the gap between them.** The name `dsh-context-fold` was verified available.

---

## 4. Approaches considered

### A. Configuration only — tune spill, enable the pruner

Adjust `spill-policy.maxInlineTokens`; enable `compaction-tool-result-pruner`.

- **For:** zero code.
- **Against:** the pruner only runs **under compaction pressure**, which on a 1M-token window at 10% occupancy never happens. Spill's arrival-time truncation is the only live part. Recovers a fraction of the available win and none of the stage-awareness.
- **Rejected as insufficient** — though its threshold is still worth tuning independently.

### B. Arrival-time shrinking (`tools/post-execute`)

Replace each oversized result with summary + pointer the moment it lands.

- **For:** zero cache cost — it never enters the prefix.
- **Against:** the decision is made too early. At step 3 you cannot know whether step 20 needs it, so you must be conservative: cut too little (no win) or too much (causes re-reads, which is an anti-goal).
- **Rejected.**

### C. Stage-boundary retroactive folding — **CHOSEN**

At a stage boundary, fold completed-stage tool results into `conclusion + spill path + batch roster`, via the §3.1 replace protocol.

- **For:** the decision is made with full information — we already know whether the result was re-referenced. Matches the measured pain exactly: 127k chars, resent 28 times, re-read zero times.
- **Against:** one-time cache invalidation at the boundary.
- **Chosen** because only retroactive folding knows "finished with". A and B can only guess.

### D. Cross-session recall

- **Rejected for this project.** `dsh-recall` already does it well. It is the user's stated second priority, not this plugin's job.

---

## 5. Design decisions

### Decided by the user

| Decision | Choice |
|---|---|
| Fold summaries generated by | **Rules only.** No model call. |
| Recall mechanism | **Approach A: inline spill paths, reuse `read`/`grep`.** No new tool. |
| Short results | **Skip them** — otherwise the pointer is longer than the payload. |
| Batch roster in folded node | **Keep it** — that is what makes recall chained rather than single-point. |
| Reasoning folding | **Phase 2**, not phase 1. |
| UI | Follow `dsh-context`'s form. |

### My calls (flag for review)

| Call | Rationale |
|---|---|
| `minFoldChars` default **1000** | 72% saving per fold; skips 60% of results for only 5.7% of bytes. Never below 300 — negative return. |
| Fold **largest first within a batch** | 82.4% of bytes sit in the top 12 results; largest-first maximises win under any budget. |
| Batch is the **atomic unit** of triggering | Prevents per-step dribbling, which would turn one big cache invalidation into N small ones. |
| Never fold the **most recent K steps** | In-use content must not move, regardless of size. |
| One turn = one stage boundary | Measured: turn 1 was 38 steps of recon, turn 2 began the discussion. Turns are where intent actually changes. |
| Add an **age condition** alongside turn boundaries | A single turn can run 200 steps; boundaries alone would never fire. |
| **Errors are never folded** | Error text is the highest-value content in the window; folding it causes retries. |
| Name: `dsh-context-fold` | `dsh-fold` / `dsh-recall` taken; `context-` prefix forms a family with `dsh-context`. |
| No new recall tool | `spillStore` already returns retrieval guidance; a new tool definition perturbs the header and tool declarations. |

---

## 6. Detailed design

### 6.1 Trigger

**Evaluation points (verified, not assumed):**

- `agent/pre-step` — a `waterfall` event fired **once per step**, payload `{ agent, messages, turn, step, signal, modelSelection }`. This is the per-step hook; it supplies the current `turn` and `step` numbers directly, so no step-number derivation is needed.
- `agent/turn-stopping` — a `serial` event, payload `{ agent, turn, signal }`. Fires once per turn, after the last step. This is the stage boundary.

Both handlers must run the same idempotent `evaluate()`; a fold already applied is not re-applied because folded nodes are skipped by rule (d).

**Candidate selection** (a candidate is a *surface node*, not a log event — see 6.7):

```
candidates = surface nodes of type tool/result where
  (a) node.turn < currentTurn  OR  (currentStep - node.step) >= staleSteps
  (b) node.step > currentStep - keepRecentSteps          // not recent
  (c) node.isError is not true
  (d) not already folded                                // see 6.7
  (e) not referenced by a later event                   // see 6.2
  (f) foldedChars < node.chars  AND node.chars >= minFoldChars

trigger when:
  sum(node.chars for node in candidates) >= minBatchChars
```

**Batching:**

- Primary grouping key: `node.turn`.
- If a single turn exceeds `batchSpanSteps` steps, split it into contiguous step ranges of `batchSpanSteps`, so one very long turn yields several batches rather than one unbounded one.

Rationale for batching: folding one aged node per step would invalidate the prefix cache repeatedly for tiny gains. A batch makes the invalidation cost paid once.

**Why both conditions:** turn boundaries alone never fire inside a single 200-step turn; age alone folds a trickle every step. Requiring both — a batch-worthy pile, reached at either a turn boundary or an age threshold — avoids both failure modes.

### 6.2 Reference detection (the "is it still in use" test)

This must run **before** spilling, so it cannot match on a spill locator that does not exist yet.

Pre-spill identifiers available on a candidate:

- `callId` — from `event.data.message.toolCallId` (the tool result's own call id).
- `toolName` — resolved by looking up the matching `tool/call` event for that `callId`.
- Nothing else. There is no locator yet.

Therefore reference detection matches on **`callId` and `toolName`**, over events *later than the candidate*:

1. Any later `tool/call` whose `arguments` string contains the candidate's `callId` → referenced.
2. Any later `user/message` or `assistant/message` text block containing the candidate's `callId` → referenced.

Both are cheap substring tests over a bounded window.

**Known limitation, accepted:** a model that re-reads a result by re-running the original tool with the same arguments (rather than by citing a call id) will not be detected. This is the one case where the re-read anti-goal can be violated without warning; the re-read metric (6.9) exists to surface it. A future refinement can hash `(toolName, arguments)` and compare against later calls; phase 1 does not.

**No state store is required.** "Age" is derived, never persisted: `age = currentStep - node.step`, both read from the events themselves. A node is "reset" simply by not qualifying on a later evaluation — because its reference check now fails, or because it is recent again only if it moved, which it cannot. Explicitly: **there is no `reset` mutation; the candidate set is recomputed from scratch each evaluation.**

### 6.3 Fold rule (deterministic, per tool type)

Rule-based dispatch, not uniform head/tail truncation:

| Tool family | Retained in the conclusion |
|---|---|
| `ops_bash`, `pwsh` | exit code, stderr tail, first N lines of stdout, byte count |
| `ops_read_files`, `read` | path, line range, first line |
| `ops_grep`, `grep`, `ops_glob`, `glob` | pattern, match count, first few matching paths |
| `cordis_inspect_*` | service/event names only; drop type declarations |
| `web_fetch`, `web_search` | URL/title, first paragraph |
| `spill`-noticed results | pass through (already bounded) |
| **any error result** | **never folded** |

Fallback for unknown tools: first line + total char count.

Every rule must produce output that is **smaller than the input and contains no information that was not in the input**. No invention, no paraphrase.

### 6.4 Folded node format

The batch roster is the one place where a naive format contradicts the size budget: listing the whole batch in *every* folded node makes total overhead O(batch²), which breaks both §3.4's fixed ~278-char assumption and §6.3's "smaller than the input".

**Resolution: the roster lives once per batch, not once per node.**

A batch produces one **index node** plus N **folded nodes**:

- The **first** node folded in a batch (largest-first, so the biggest win) carries the full roster and is marked as the batch head.
- Every **other** node in the batch carries a one-line back-reference: `Batch head: <callId of head> — full roster there.`

This keeps per-node overhead at ~278 chars and total batch overhead O(n) instead of O(n²), while preserving the chain: any folded node points at the head, and the head lists every sibling path.

Head node format:

```
[tool: ops_grep] 73,447 chars folded at turn 1, step 12. (batch head)
Conclusion: pattern "surfaceOp" — 47 matches across 12 files; top: agent-loop, session.
Full result: <spill locator path>
Same batch (3 more):
  - ops_bash (callId a1b2): <path>
  - ops_bash (callId c3d4): <path>
  - skill    (callId e5f6): <path>
```

Non-head node format:

```
[tool: ops_bash] 6,266 chars folded at turn 1, step 12.
Conclusion: exit 0; stdout first line "=== deps ==="; 41 lines.
Full result: <spill locator path>
Batch head: a0f9 (callId) — lists 3 more results from this batch.
```

Requirements:

- The conclusion is inline; the path is secondary. (Anti-goal: never a bare pointer.)
- The roster is **batch-scoped only** — that is what makes the chain finite and walkable.
- Every path is a real path that `read`/`grep` accept.
- Formatting is stable so tests can assert on it exactly.
- Roster entries include the `callId` so the chain can be walked without guessing which path is which.
- **All fold bookkeeping lives in the text.** Per 6.6, the message may change only `content`; there is no field for "folded at step N". The marker prefix, the fold step, and the batch id must all be encoded in the text itself.
- The marker prefix must be distinctive enough that a single `startsWith` test identifies a folded node, because that test is the idempotency check.

### 6.5 Spill integration

- If the result already carries a spill notice, reuse its locator — do not spill twice.
- Otherwise call `ctx.spillStore.saveText` with `source: { kind: 'tool', toolName, callId, label }` before appending the replacement.
- **If spill fails, do not fold that node.** Keep the original inline. Folding without a reachable original would be lossy, which violates the design's core promise. Best-effort with a logged warning, matching `spill-policy`'s behaviour.
- If `spillStore` is absent, the plugin must **no-op entirely** (config-time check, clear diagnostic).

### 6.6 Mutation protocol

For each node, in largest-first order:

1. Resolve the node's **current** event (see 6.7) — never `session.eventAt(seq)` alone, which returns the *original* pre-fold event.
2. `session.deriveEventMessage(currentEvent)` to obtain the current content.
3. Compute the folded content.
4. `saveText` the original (full current content).
5. Append `compaction/prune` with the shadow price.
6. Append the replacement `tool/result` with `surfaceOp: { op:'replace', startSeq: seq, endSeq: seq }` and `sourceEventSeqs: [seq]`.

A rejected replacement fails that node; earlier replacements stay durable (matching the pruner's documented semantics). The plugin must not retry the whole batch on one failure.

### 6.7 Resolving a surface node to its current event

This is load-bearing and was underspecified in the first draft.

`session.surface.nodes` is a `readonly SessionSeq[]` of the **live** surface. **Verified in `dsh-session`'s `applySurfacePlan`:** a replacement performs `state.nodes.splice(startIdx, endIdx - startIdx + 1, plan.seq)` and bumps both `replaceGeneration` and `contentGeneration`. So the folded node's seq becomes the **new** event's seq and the old seq **leaves** `surface.nodes`.

Consequences:

- **Idempotency is structural, not stateful.** A folded node cannot be re-folded by iterating the old seq, because that seq left the surface. Walking `session.surface.nodes` each evaluation therefore never revisits a folded node. No `folded` flag is needed — and per 6.6, no such flag *could* be stored on the message anyway.
- To detect "already folded" (rule (d) in 6.1), the test is the fold marker prefix inside the node's text content.
- Because a replacement only ever rewrites exactly one node and produces one new node, batch folding is N independent single-node replacements, not one range replacement.
- `eventAt(seq)` for a seq taken from `surface.nodes` returns that node's current event, so `deriveEventMessage(eventAt(seq))` is correct — provided seqs are always sourced from `surface.nodes` at evaluation time and never cached across evaluations.
- `replaceGeneration` is observable and usable as a cheap "did anything change since my last pass" guard before doing any work.

**Event data shape and the rewrite constraint** (verified against `dsh-session`'s `assertToolResultRewrite`, not inferred):

- `tool/result` data is `{ turn, step, message, error?, meta? }`.
- The tool result message is `event.data.message`, carrying `toolCallId`, `content`, and `isError`. A result's `callId` is therefore `event.data.message.toolCallId` (not `event.data.callId`).
- The replacement template is `{ ...event.data, message }`: keep `turn`, `step`, `error`, `meta`; swap only `message`.
- **Hard constraint:** the host asserts that a `tool/result` surface replacement changes **only `content`**. Every other field of the replacement message — and of `event.data` — must be deep-equal to the original, compared with `content` nulled out. Violating this throws `tool/result surface replacement may change only content`.
- **Consequence for folding:** a folded node must keep the original `toolCallId`, `isError`, `turn`, `step`, `error`, and `meta` byte-identical. Only `content` may differ. This is exactly what makes the fold safe for tool-call pairing — but it also means **the fold cannot record bookkeeping in the message** (no added field for "folded at step N"). The fold marker must live **inside the text content**, and any out-of-band state must be derived from the log.
- A replacement must rewrite **exactly one** current node (`shadowedSeqs.length !== 1` throws), which is what a per-node fold does.

### 6.8 What is deliberately not touched

- Assistant message **text** and tool-call arguments. (Reasoning blocks are folded in phase 2 through a message projection — see §12 — which never rewrites the log.)
- User messages.
- System prompt nodes.
- Any node in the last `keepRecentSteps` steps.

### 6.9 Configuration

```yaml
- id: context-fold
  name: 'dsh-context-fold'
  config:
    minFoldChars: 1000        # skip results smaller than this
    minBatchChars: 8000       # only fold when a batch is worth it
    keepRecentSteps: 6        # never fold the newest N steps
    staleSteps: 12            # age condition for long single turns
    batchSpanSteps: 20        # split very long turns into sub-batches
    enabled: true
    dryRun: false             # compute and report, mutate nothing
```

`dryRun` exists so the value can be verified before trusting it.

### 6.10 Measurement (must ship with phase 1)

Per fold and per session, record: chars before/after, nodes folded, spill bytes written, and — the key one — **re-read rate** (how often a folded result's `callId` or path is later passed to `read`/`grep`, or its original tool re-invoked with identical arguments).

**Where this state lives:** nothing is persisted by the plugin. All of it is derivable from the session log:

- chars before/after → `compaction/prune` shadow prices and the replacement nodes' measured content.
- nodes folded → count of fold-created replacements (identifiable by the fold marker).
- re-read rate → scan events after each fold for the candidate's `callId` in tool arguments or message text, plus a `(toolName, arguments)` hash comparison for the re-invoked-tool case.

This keeps the plugin stateless and makes the metric reproducible from any log, including one produced by `dryRun`.

Report via `/context-fold` command. This is what makes "worth doing" answerable with evidence rather than belief.

---

## 7. UI (phase 3, after core)

Form follows `dsh-context`: a `sidebar.panellist` entry plus a `main` keyed page, and optionally a `conversation.view` tab. Content: what was folded, when, how much was saved, and re-read rate per node.

Deliberately **not** in phase 1. The numbers can be computed from the session log first; drawing them before they are correct is premature.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Cache invalidation outweighs savings | High | Fold only at batch boundaries; `dryRun`; measure before trusting |
| Model re-reads folded content | High | Reference detection (6.2); conclusions inline; re-read metric |
| Replay/protocol breakage | High | Reuse the shipped, tested replace protocol verbatim; the host enforces content-only rewrites (`assertToolResultRewrite`), so any attempt to add fields fails loudly rather than silently |
| Fold marker collides with real content | Medium | Marker is a fixed, unlikely prefix; idempotency test is `startsWith`, and a false positive only means "skip", never "corrupt" |
| `spillStore` absent | Medium | No-op with a clear diagnostic |
| Over-folding early turns that are still needed | Medium | `keepRecentSteps`, reference detection, per-tool rules |
| Silent context mutation confuses the user | Medium | Visible record in UI; `/context-fold` report; `dryRun` |
| Diverging from host compaction semantics | Low | Do not reimplement compaction; only append replacements |

---

## 9. Phase plan

**Phase 1 (this design):** tool-result folding, deterministic rules, spill + chain roster, `dryRun`, measurement. No UI, no reasoning.

**Phase 2:** reasoning folding. **Mechanism resolved and implemented** — see §12. The original blocker (replay-state rewriting) was based on a wrong assumption about the seam: `assistant/message` cannot be surface-replaced at all, but a registered **message projection** folds its content without touching the log.

**Phase 3:** UI in `dsh-context`'s form.

**Phase 4 (user's second priority):** cross-session recall. Only after 1–3, and only if it is not better served by `dsh-recall`.

---

## 12. Phase 2 — reasoning folding (implemented)

This section supersedes the "blocked on replay-state rewriting" note in §9. Everything below was verified against the installed `0.2.2-rc.1` packages, and the behaviour is covered by `tests/reasoning.spec.ts`.

### 12.1 The original blocker was the wrong constraint

The first draft assumed reasoning folding required rewriting `SessionEventMap` replay state because `toPiAssistant` enforces `state.blocks[index].type === block.type`. Two corrections:

1. **`assistant/message` cannot be surface-replaced at all.** In `0.2.2`, `assertSourceEventReferences` throws *"assistant/message embeds its source stream and cannot carry sourceEventSeqs"*, while a replacement must cite every shadowed node. So the phase-1 replace protocol is structurally unavailable for assistant messages — no amount of replay handling would make it work.
2. **Replay signatures were not actually present.** Probing three real session logs (13,701 / 7,077 / 5,084 events) found `source.replayState === undefined` on *every* assistant message, across `deepseek-flash` and `codebuddy`. The provider branch of `toPiAssistant` is not on this path, so there was never a signature to preserve.

### 12.2 The seam: a registered message projection, carried by a plugin *record*

`ctx.sessions.registerMessageProjection(def)` is the host's supported way for a plugin to change what a request sees **without changing the log**. Verified chain: `dsh-agent-loop` builds requests with `this.session.deriveMessages()`; `deriveMessages()` walks `surface.nodes` and calls `deriveEventMessage`; that applies any registered projection and bumps `contentGeneration` so the cache is invalidated.

**A correction that matters more than the mechanism:** the durable decision is carried by `appendPluginRecord`, *not* `session.append`.

`dsh-compaction-image-offload` is *not* a precedent for inventing an event type. `image/offload` is a **harness-core** member of `KNOWN_SESSION_EVENT_TYPES`; a downstream plugin cannot join that set by declaring a `SessionEventMap` augmentation, which is TypeScript-only.

A plain `session.append()` of a plugin-invented type produces an envelope of exactly `{type, seq, time, data}` with no `ignorable` marker, and `dsh-session-persistence`'s `assertEventsSupported` refuses such a log on reopen:

> "contains event type … unknown to this harness and not marked ignorable; refusing to interpret the log"

That would make any session containing a single reasoning fold **unreopenable** — the user's whole conversation lost, triggered by normal use. The first implementation of this phase had exactly that defect. `appendPluginRecord` is the sanctioned carrier: it stamps `ignorable: true`, so an older reader retains and skips the record, and `reasoningProjection` still drives `deriveMessages()` from it (verified end-to-end).

The "in-memory restore proves it" test was not sufficient, because `Session.create(seed)` does not run the persistence vocabulary gate. `tests/reasoning-persistence.spec.ts` now pins the real gate predicate explicitly.

Verified consequences:

- The message count, identity, block count, and block types are all preserved, so this is compatible with replay validation even on a signed route.
- **Design consequence:** the fold is a *pure function of the log plus the registered definition*, so replay is exact by construction. The full original reasoning stays in the append-only event.
- A projection must **not** be registered for a surface event type: `planSurfaceEvent` returns a `project` plan instead of an append/replace plan, so registering one would silently drop every message of that type off the surface.

### 12.3 What reasoning actually costs — measured

The DeepSeek adapter only re-sends reasoning on tool-call turns (`serializeAssistant`: `reasoning_content` is emitted only when `toolCalls.length > 0`, because it "is ignored on plain turns, so we drop it there"). **But that is not the route this profile runs.** The active route is `router`, whose `dsh-router-core` serializer `wireMessages` emits `...reasoning.length > 0 ? { reasoning_content } : {}` **unconditionally** — so on the real route plain-turn reasoning IS re-sent and does cost tokens.

Measuring three real sessions:

| Session | Reasoning on tool-call turns | Reasoning on plain turns (already free) |
|---|---|---|
| foreman (2,118 assistant msgs) | 1,151 msgs, **981,533 chars** | 11 msgs, 42,563 chars |
| super-agent A | 185 msgs, **195,145 chars** | 1 msg, 5,955 chars |
| super-agent B | 345 msgs, **178,742 chars** | 6 msgs, 398 chars |

So the dominant target is tool-call-turn reasoning — ~12–19% of the surface. Plain-turn reasoning is a smaller share, but on the router route it is real money. Because the serializer differs per route, the policy is **route-aware by configuration**:

- `foldReasoning` (default **true**) folds tool-call turns. Safe and valuable on every route.
- `foldPlainTurnReasoning` (default **false**) additionally folds plain turns. Enable it on a router route, where plain-turn reasoning is re-sent; leave it off on `dsh-llm-deepseek`, where it is dropped and folding would save nothing.

### 12.4 Rules

Deterministic, no model call, matching phase 1's contract:

- **Tool-call turns fold by default; plain turns only on request.** Which turns cost tokens depends on the route's serializer (see 12.3), so the plain-turn share is a configuration decision rather than a hard-coded assumption.
- **Head preserved verbatim.** 240 code points of the thought's opening stay inline, followed by an explicit `[… N chars of earlier reasoning omitted]` note. The head is a literal prefix of the original, so nothing is invented.
- **`MIN_REASONING_CHARS = 1200`.** Below this the marker plus the note cost as much as the text.
- **Age and recency reuse phase 1's rules** (`turn < currentTurn || age >= staleSteps`, and never within `keepRecentSteps`), so a single long turn has an exit and in-use content never moves.
- **Idempotent by marker.** A block already starting with `[context-fold] [reasoning]` never folds again.

### 12.5 Failure policy

The projection is deliberately **tolerant of stale targets**: a `compaction` replacement can shadow a node a durable decision named. Throwing there would make every later `deriveMessages()` fail and brick the session — a direct violation of the "a session never errors" anti-goal. A target whose node is no longer current, or whose blocks are already folded, is skipped.

The decision's own shape *is* validated strictly (non-empty `targets`), so a corrupt log still fails loudly rather than silently under-folding.

### 12.6 Wiring is unconditional, and a missing projection is inert

The projection is registered **even when `foldReasoning: false`**, because the flag should govern only *new* decisions: a session whose log already carries them keeps the benefit it was already charged for.

**Verified, correcting an assumption in the first draft:** an unregistered decision event is **inert, not fatal**. `deriveMessages()` does not refuse derivation — it falls back to the original unfolded reasoning (measured: 4000 chars returned instead of 332). So a log can never be bricked by a missing projection; the fold simply stops applying. Registration is therefore about *keeping a benefit*, not about *avoiding breakage*.

The host permits exactly one definition per event type, and `apply()` can run twice (a reload, or two config rows naming the same package). A duplicate registration is caught and warned about rather than thrown out of `apply()`: the first registration is already live and correct.

### 12.7 Open gap: folded reasoning has no retrieval path

Phase 2 writes no spill file. That is worse than it first looks, and the earlier wording here ("a gap, not a bug: no conclusion is lost") understated it.

The head is kept, so a conclusion survives — but the message trail says `[… N chars of earlier reasoning omitted]` and offers **no recovery path**. That is a pointer to nothing. Phase 1's promise is "conclusions inline, details one hop away": the model can call `read`/`grep` on the locator. Phase 2 delivers "conclusions inline, details unreachable" — the only copy is the raw `assistant/message` event, which no tool exposes.

Why this is worse than phase 1's tradeoff: it *invites* the model to believe the detail is recoverable. A model that was reasoning its way through a subtle problem cannot go back and re-read how far it got, and cannot know it cannot.

The fix is to spill the original reasoning text at fold time and inline the locator in the same marker, exactly as phase 1 does, so both kinds of fold share one recall chain. That is the next piece of work; it is recorded here rather than quietly dropped.

**Also still open:** the interaction with `compaction-basic`. A compaction span covering an assistant node changes its surface seq, so a reasoning target pointing at the old seq goes stale and is skipped. Intended (see 12.6), but untested against a real `/compact`.

---

## 10. What is left to the builder

- Exact plugin skeleton, package metadata, locale resources, icon.
- The precise reference-detection implementation and its measured cost per evaluation.
- Per-tool fold-rule details for tools not listed in 6.3.
- Test strategy: unit tests for fold rules; integration tests asserting the replacement protocol; a replay test proving `sourceEventSeqs` recovery; an idempotency test proving a second evaluation folds nothing.
- Whether `compaction/prune` needs a distinct marker type for fold-created shadow prices (open question 3).
- Where `dryRun` reports go: log line, command output, or both.

## 11. Open questions

1. **Cache behaviour on the target route** — the two measured sessions disagree (one had cache reads rising 58k→118k, the other had zero cache fields on all 38 steps). Tuning aggressiveness depends on this. `dryRun` plus the measurement report exists precisely to answer it empirically before it matters.
2. **Interaction with `compaction-basic`** — if compaction fires on a session that already has folded nodes, do fold-created `compaction/prune` events double-count? `compaction-basic` prices its own shadowed span from `session.surface.nodes`, so a folded node is *already small* when compaction prices it — which suggests no double count, but this must be verified against a real `/compact` run, not assumed.
3. **Distinct marker for fold-created shadow prices** — `compaction/prune` is shared with the pruner. If a consumer needs to tell them apart, fold may need its own marker type or a discriminating field. Confirm whether anything downstream branches on it.

### Resolved during review (kept for the record)

- ~~Surface-node enumeration / current-content read~~ — resolved in 6.7: always source seqs from `session.surface.nodes` at evaluation time; `deriveEventMessage(eventAt(seq))` is then correct; folding is structurally idempotent because `applySurfacePlan` splices the new seq over the old, so a folded node leaves the surface it was read from.
- ~~"current step" undefined; age trigger dead~~ — resolved in 6.1: `agent/pre-step` is a verified per-step waterfall carrying `turn` and `step`; the age branch fires there, the turn branch at `agent/turn-stopping`.
- ~~Reference detection cannot run pre-spill; no state store for reset~~ — resolved in 6.2: match on `callId`/`toolName` (both available pre-spill), derive age rather than store it, recompute candidates from scratch each evaluation.
- ~~Batch roster is O(n²)~~ — resolved in 6.4: one roster per batch at the head node, back-references from siblings.
