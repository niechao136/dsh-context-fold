/**
 * Reasoning folding for historical assistant messages (design phase 2).
 *
 * Phase 1 rewrote `tool/result` nodes through the surface replacement protocol.
 * That protocol is unavailable here: `assistant/message` may not carry
 * `sourceEventSeqs`, while a surface replacement must cite every shadowed node.
 * So an assistant rewrite is structurally impossible via `surfaceOp`.
 *
 * The host's supported seam for changing message content is a **message
 * projection**: a durable decision event plus a pure interpreter registered with
 * `ctx.sessions.registerMessageProjection`. The projection changes what each
 * request sees without changing the log, node membership, or message identity.
 * `dsh-compaction-image-offload` ships exactly this pattern for images.
 *
 * Two verified facts shape the policy:
 *
 * 1. Reasoning costs the most tokens on tool-call turns. The DeepSeek adapter
 *    emits `reasoning_content` only when the assistant message also carries tool
 *    calls ("reasoning_content must return on tool-call turns; it is ignored on
 *    plain turns, so we drop it there"), so on that route plain-turn reasoning is
 *    already free. Other routes replay it (pi-ai's `foreignAssistant` maps every
 *    reasoning block to `{type:'thinking'}`), but the measured plain-turn share
 *    is tiny — 0.03–2.7% of the surface versus 12–19% on tool-call turns in three
 *    real sessions — so folding only tool-call turns captures essentially all of
 *    the available win and does not depend on knowing the route.
 * 2. No replay signatures exist to preserve on the measured routes: every
 *    sampled `assistant/message` had `source.replayState === undefined`, so the
 *    provider branch of `toPiAssistant` (which validates block types and counts)
 *    is not on the path. The block count and order are preserved regardless, so
 *    a stowed signature would still be honoured if one ever appears.
 *
 * @module dsh-context-fold/reasoning
 */
import type { AssistantMessage, ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection, SessionMessageProjectionContext } from '@deepseek-ai/dsh-session/surface'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { ContextFoldConfig } from './config.ts'
import { FOLD_MARKER } from './format.ts'
import { codePointLength } from './rules.ts'

/** Marker opening a folded reasoning block. Must be distinctive: `startsWith` is the idempotency test. */
export const REASONING_MARKER = `${FOLD_MARKER} [reasoning]`

/** Durable record type carrying one reasoning-fold decision. */
export const REASONING_EVENT = 'plugin:context-fold/reasoning'

/** One reasoning fold recorded by a decision record. */
export interface ReasoningTarget {
  /** Surface seq of the assistant node whose reasoning is folded. */
  seq: SessionSeq
  /** Content indexes of the folded reasoning blocks, in content order. */
  indexes: readonly number[]
  /** Original code-point length of each folded block, for the report. */
  chars: readonly number[]
  /** Spill locator per folded block, parallel to `indexes`. Absent when spilling failed. */
  locators?: readonly (string | undefined)[]
}

/** Data of one `plugin:context-fold/reasoning` decision record. */
export interface ReasoningFoldData {
  /** Targets, in surface order. */
  targets: readonly ReasoningTarget[]
}

/**
 * Declare the durable decision record.
 *
 * This uses {@link PluginRecordMap}, **not** `SessionEventMap`. That distinction
 * is load-bearing and was initially got wrong here:
 *
 * A `SessionEventMap` augmentation only adds a *TypeScript* type. The record
 * written by `session.append()` carries an envelope of exactly
 * `{type, seq, time, data}` with **no `ignorable` marker**, and the persistence
 * read path refuses any type outside `KNOWN_SESSION_EVENT_TYPES` unless
 * `ignorable === true`:
 *
 * > "contains event type … unknown to this harness and not marked ignorable;
 * > refusing to interpret the log"
 * > — `dsh-session-persistence` `assertEventsSupported`
 *
 * So a plain `append` of a plugin-invented type makes the session **unreopenable**,
 * which would lose the whole conversation. `appendPluginRecord` is the host's
 * sanctioned alternative: it stamps `ignorable: true`, and a reader that does not
 * know the type retains and skips it.
 *
 * `dsh-compaction-image-offload` is *not* a precedent for the other approach,
 * because `image/offload` is a harness-core member of
 * `KNOWN_SESSION_EVENT_TYPES`; a downstream plugin cannot join that set.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * Fold historical reasoning blocks on tool-call turns.
     *
     * Targets name current `assistant/message` surface nodes and the content
     * indexes of the reasoning blocks the decision covers. Message identity,
     * block count, and block types are preserved; the durable assistant event
     * keeps the full original text.
     */
    'plugin:context-fold/reasoning': ReasoningFoldData
  }
}

/**
 * Prefix kept from the head of a folded reasoning block.
 *
 * Reasoning carries its conclusion at the end (the model reasons towards a
 * decision), but the opening line names the intent. Keeping a head and a tail
 * would double the per-block overhead for little added value, so the policy
 * keeps a head only and leaves the full text reachable through the spill path
 * recorded in the block itself. Zero is not allowed: a bare pointer with no
 * conclusion is the failure mode the design forbids.
 */
const HEAD_CHARS = 240

/**
 * Smallest reasoning block worth folding.
 *
 * The folded form is a fixed cost: a 240-character head plus the marker and the
 * omission note, which measures ~328 characters regardless of input size. That
 * fixes the profitability curve, measured against the real fold function:
 *
 * | input | output | saved |
 * |-------|--------|-------|
 * |  600  |  328   |  45%  |
 * |  700  |  328   |  53%  |
 * |  900  |  328   |  64%  |
 * | 1200  |  330   |  73%  |
 *
 * The original gate was 1200, which is profitable but excludes most of the
 * surface: measured sessions have a ~510-character median reasoning block, so
 * 1200 skipped the bulk of the available saving. 600 was the first proposal and
 * only breaks even politely at 45%. 900 is the point where the fold saves
 * roughly two thirds of the block while still reaching well below the median
 * session's larger blocks — the best trade between reach and margin.
 */
const MIN_REASONING_CHARS = 900

/**
 * Whether a reasoning block is already folded.
 *
 * @param text - reasoning text.
 * @returns true for a block this plugin produced.
 */
export function isFoldedReasoning(text: string): boolean {
  return text.startsWith(REASONING_MARKER)
}

/**
 * Whether a message is a tool-call turn, i.e. a turn that requested tool work.
 *
 * This is a **policy** filter, not a token-accounting claim. Reasoning is re-sent
 * differently per route:
 *
 * - `dsh-llm-deepseek`'s `serializeAssistant` emits `reasoning_content` only when
 *   `toolCalls.length > 0` ("it is ignored on plain turns, so we drop it there"),
 *   so a plain turn's reasoning is free on that route.
 * - `dsh-router-core`'s `wireMessages` — the route this profile actually runs —
 *   does **not** gate it: `...reasoning.length > 0 ? { reasoning_content } : {}`
 *   is unconditional, so plain-turn reasoning IS re-sent and does cost tokens.
 *
 * Restricting to tool-call turns therefore leaves real bytes on the table on the
 * router route. It stays the default only because the conservative shape matches
 * phase 1's "completed stage" intent and the measured tool-call share dominates;
 * `foldPlainTurnReasoning` widens it for routes that replay plain-turn reasoning.
 *
 * @param content - assistant content blocks.
 * @returns true when the message carries at least one tool call.
 */
export function isToolCallTurn(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === 'tool-call')
}

/**
 * Build the replacement text for one reasoning block.
 *
 * The head is preserved verbatim, so no information is invented and the
 * conclusion-like opening of the thought stays visible. The character count and
 * the full-length note make the omission visible, which is the difference
 * between a cautious model and a fluent one.
 *
 * When a `locator` is supplied the folded text inlines it, so the omission is
 * **recoverable**: `read`/`grep` on that path returns the original reasoning.
 * Without it the note is a pointer to nothing — it tells the model detail is
 * missing while offering no way to fetch it — which is why the fold path always
 * tries to spill first (design §12.7).
 *
 * @param text - original reasoning text.
 * @param locator - spill path holding the full original, when one was written.
 * @returns folded text, or undefined when folding would not shorten it.
 */
export function foldReasoningText(text: string, locator?: string): string | undefined {
  if (isFoldedReasoning(text)) return undefined
  const chars = codePointLength(text)
  if (chars < MIN_REASONING_CHARS) return undefined
  const head = Array.from(text).slice(0, HEAD_CHARS).join('').trimEnd()
  const omitted = `[… ${formatNumber(chars - codePointLength(head))} chars of earlier reasoning omitted]`
  const folded = [
    `${REASONING_MARKER} ${formatNumber(chars)} chars folded.`,
    head,
    // The recovery hint must name the path and the tool, or the model has to
    // guess both.
    locator === undefined ? omitted : `${omitted} Full text: ${locator} — use read (offset/limit) or grep on that path.`,
  ].join('\n')
  return codePointLength(folded) < chars ? folded : undefined
}

/** Group digits for readability. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/** One candidate assistant node for reasoning folding. */
export interface ReasoningCandidate {
  /** Current surface seq. */
  seq: SessionSeq
  /** Turn the message belongs to. */
  turn: number
  /** Step the message belongs to. */
  step: number
  /** Current model-visible content. */
  content: readonly ContentBlock[]
}

/** One planned reasoning fold. */
export interface ReasoningPlan {
  /** Surface seq to project. */
  seq: SessionSeq
  /** Folded block indexes, in content order. */
  indexes: readonly number[]
  /** Original character count per folded block. */
  chars: readonly number[]
  /** Total characters removed. */
  charsRemoved: number
  /**
   * Spill locators parallel to `indexes`: where each block's full original lives.
   *
   * The record carries these so the projection can inline the same recovery path
   * on replay; without them a restored session would show an omission note with
   * no way to recover the text.
   */
  locators?: readonly (string | undefined)[]
}

/**
 * Plan reasoning folds for one snapshot.
 *
 * A node qualifies when it is a tool-call turn (where reasoning is re-sent most,
 * and where the measurable win is), when it is old enough by the same age rules
 * phase 1 uses, and when at least one reasoning block is large enough to shrink.
 *
 * The plan itself does not spill: writing to the store is side-effectful, so it
 * happens in `recordReasoningFolds`, which fills in the locators and re-derives
 * the conclusion text with them.
 *
 * @param candidates - current assistant nodes, in surface order.
 * @param currentTurn - turn being evaluated.
 * @param currentStep - step being evaluated.
 * @param config - resolved configuration.
 * @returns plans in surface order.
 */
export function planReasoningFolds(
  candidates: readonly ReasoningCandidate[],
  currentTurn: number,
  currentStep: number,
  config: ContextFoldConfig,
): ReasoningPlan[] {
  const plans: ReasoningPlan[] = []
  for (const node of candidates) {
    // Plain turns fold only when the route re-sends their reasoning (see
    // `isToolCallTurn`): on dsh-llm-deepseek that reasoning never leaves the
    // process, so folding it would shrink the log view without saving a token.
    if (!isToolCallTurn(node.content) && !config.foldPlainTurnReasoning) continue
    const aged = node.turn < currentTurn || currentStep - node.step >= config.staleSteps
    if (!aged) continue
    if (node.step > currentStep - config.keepRecentSteps) continue
    const indexes: number[] = []
    const chars: number[] = []
    let removed = 0
    for (const [index, block] of node.content.entries()) {
      if (block.type !== 'reasoning') continue
      const folded = foldReasoningText(block.text)
      if (folded === undefined) continue
      indexes.push(index)
      chars.push(codePointLength(block.text))
      removed += codePointLength(block.text) - codePointLength(folded)
    }
    if (indexes.length === 0) continue
    plans.push({ seq: node.seq, indexes, chars, charsRemoved: removed })
  }
  return plans
}

/**
 * Project one assistant message with selected reasoning blocks folded.
 *
 * Message identity and every other block are preserved verbatim, which is what
 * `replayedAssistant` and `foreignAssistant` both require: the block count and
 * block types are unchanged, so even a signed route would still validate.
 *
 * @param message - message to project.
 * @param indexes - reasoning block indexes to fold, strictly increasing.
 * @returns an immutable projected copy.
 * @throws when an index is out of range or does not name a reasoning block.
 */
export function projectReasoning(message: AssistantMessage, indexes: readonly number[], locators?: readonly (string | undefined)[]): AssistantMessage {
  const content = message.content.map((block, index) => {
    if (!indexes.includes(index)) return block
    if (block.type !== 'reasoning') throw new Error(`context-fold: block ${index} is not reasoning`)
    const locator = locators?.[indexes.indexOf(index)]
    const folded = foldReasoningText(block.text, locator)
    if (folded === undefined) throw new Error(`context-fold: block ${index} cannot be folded again`)
    return { ...block, text: folded }
  })
  return freezeCopy({ ...message, content })
}

/** Deep-freeze a detached copy, matching the host's immutability contract for projected messages. */
function freezeCopy<T>(value: T): T {
  const freeze = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    for (const child of Object.values(node)) freeze(child)
    Object.freeze(node)
  }
  const copy = structuredClone(value)
  freeze(copy)
  return copy
}

/**
 * Collect the assistant nodes a decision event may target.
 *
 * @param session - session to read.
 * @returns candidates in surface order.
 */
export function reasoningCandidates(session: Session): ReasoningCandidate[] {
  const candidates: ReasoningCandidate[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const message = session.deriveEventMessage(event)
    if (message === null || message.role !== 'assistant') continue
    candidates.push({ seq, turn: event.data.turn, step: event.data.step, content: message.content })
  }
  return candidates
}

/**
 * Append one decision record covering the planned folds.
 *
 * The record is self-describing: it stores the exact content indexes it covers,
 * so replay never has to re-derive *which* blocks were chosen from a count. The
 * record is durable and pure — replaying the log through the registered
 * projection reproduces exactly the same request content.
 *
 * @param session - session to extend.
 * @param plans - folds to record.
 * @param spill - optional spill store; when supplied, every folded block's full
 *   text is written first and its locator is recorded so the projection can
 *   inline a real recovery path.
 * @returns the record's sequence number.
 */
export async function recordReasoningFolds(
  session: Session,
  plans: readonly ReasoningPlan[],
  spill?: ReasoningSpill,
): Promise<SessionSeq> {
  const targets: ReasoningTarget[] = []
  for (const plan of plans) {
    const locators: (string | undefined)[] = []
    const event = session.eventAt(plan.seq)
    const message = event === undefined ? null : session.deriveEventMessage(event)
    for (const [position, index] of plan.indexes.entries()) {
      const block = message !== null && message.role === 'assistant' ? message.content[index] : undefined
      // Spill the *original* text, not the folded text, or the recovery path
      // would hand back the very summary it is supposed to expand.
      const original = block !== undefined && block.type === 'reasoning' ? block.text : undefined
      if (spill === undefined || original === undefined) {
        locators.push(undefined)
        continue
      }
      try {
        const saved = await spill.saveText({
          owner: { sessionId: session.header.id },
          source: {
            kind: 'tool',
            toolName: 'reasoning',
            // Reasoning has no model-issued call id; a stable synthetic one keeps
            // the spill source shape valid and makes the file name traceable back
            // to the node and block it came from.
            callId: `reasoning-${String(plan.seq)}-${String(index)}` as never,
            label: 'reasoning',
          },
          suggestedName: `reasoning-${String(plan.seq)}-${String(index)}.txt`,
          content: original,
        })
        locators.push(saved.locator)
      } catch {
        // A failed spill must not block the fold: the omission note stays
        // accurate, only the recovery hint is missing. Phase 1 makes the same
        // choice for tool results.
        locators.push(undefined)
      }
    }
    targets.push({
      seq: plan.seq,
      indexes: [...plan.indexes],
      chars: [...plan.chars],
      ...(locators.some((locator) => locator !== undefined) ? { locators } : {}),
    })
  }
  return appendPluginRecord(session, REASONING_EVENT, { targets })
}

/**
 * The slice of the spill store this module needs.
 *
 * Typed against the host's own `SpillStore` rather than a hand-written shape:
 * its ids are branded (`SessionId`, `ToolCallId`), so a local structural type
 * would either fail to accept the real store or force a cast.
 */
export type ReasoningSpill = {
  saveText(input: SpillStore['saveText'] extends (input: infer I) => Promise<unknown> ? I : never): Promise<{ locator: string }>
}

/**
 * Read every decision record in a log.
 *
 * Records are read back through {@link pluginRecordOf}, which validates that the
 * type carries the `plugin:` prefix; the owner still validates `data` before use,
 * because a restored record carries whatever an earlier build wrote.
 *
 * @param session - session to inspect.
 * @returns decisions in log order, with unreadable payloads dropped.
 */
export function reasoningDecisions(session: Session): ReasoningFoldData[] {
  const decisions: ReasoningFoldData[] = []
  for (const event of session.snapshotEvents()) {
    // Plugin-record types are outside `SessionEventType`, so the union has no
    // member to narrow to; the runtime check is the only discriminator.
    if ((event.type as string) !== REASONING_EVENT) continue
    const record = pluginRecordOf(event as never)
    if (record === undefined) continue
    const data = record.data as ReasoningFoldData
    if (typeof data !== 'object' || data === null || !Array.isArray(data.targets)) continue
    decisions.push(data)
  }
  return decisions
}

/**
 * The projection definition registered with `ctx.sessions`.
 *
 * It is deliberately **tolerant of stale targets** rather than strict: a
 * decision is durable, but the surface it referred to is not frozen — a
 * `compaction` replacement can remove a node the decision named. Throwing there
 * would make every later `deriveMessages()` fail and brick the session, which
 * violates the design's "a session never errors" anti-goal. A target whose node
 * is no longer current, or whose reasoning blocks are already folded, is
 * therefore skipped: the fold it described is simply no longer applicable.
 *
 * Each target's `chars` array is only a length hint — how many reasoning blocks
 * that decision intended to fold. The projection folds that many still-unfolded
 * reasoning blocks, which keeps replay correct even after a later decision has
 * already folded a sibling block.
 */
/**
 * The projection definition registered with `ctx.sessions`.
 *
 * **Why a cast is needed, and why it is correct:** `SessionMessageProjection<T>`
 * constrains `T extends keyof SessionEventMap`, so the host's *types* do not
 * admit a `plugin:` record type. The *runtime* does: `SurfaceManager` resolves a
 * projection with `projections.find(item => item.type === event.type)` **before**
 * it looks at `surfaceOp`, so any committed event type can drive one. The cast is
 * therefore only widening a compile-time parameter that the implementation
 * already accepts.
 *
 * A projection must **not** be registered for a surface event type
 * (`assistant/message`, `user/message`, `tool/result`): `planSurfaceEvent`
 * returns a `project` plan *instead of* an append/replace plan, and
 * `applySurfacePlan` only pushes nodes for `append`, so such a registration would
 * silently drop every message of that type off the surface. A non-surface
 * plugin-owned record is the only correct carrier.
 *
 * It is deliberately **tolerant of stale targets** rather than strict: a
 * decision is durable, but the surface it referred to is not frozen — a
 * `compaction` replacement can remove a node the decision named. Throwing there
 * would make every later derivation fail and brick the session, which violates
 * the design's "a session never errors" anti-goal.
 */
export const reasoningProjection = {
  type: REASONING_EVENT,
  project(event: SessionEvent, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message> {
    const data = event.data as ReasoningFoldData
    if (typeof data !== 'object' || data === null || !Array.isArray(data.targets) || data.targets.length === 0) {
      // A record with no targets describes no fold. It cannot be applied, but it
      // also cannot change any message, so refusing it here would only break
      // derivation for no benefit — the record is skipped by returning nothing.
      return new Map()
    }
    const nodes = new Set(context.nodes)
    const updates = new Map<SessionSeq, Message>()
    for (const target of data.targets) {
      if (typeof target !== 'object' || target === null) continue
      if (!Number.isSafeInteger(target.seq) || !Array.isArray(target.indexes) || target.indexes.length === 0) continue
      // A stale target is not an error: a compaction may have shadowed the node,
      // and throwing would fail every later derivation.
      if (!nodes.has(target.seq) || updates.has(target.seq)) continue
      // `context.messages` holds only *previously projected* messages, so an
      // untouched assistant node falls back to its own durable event, exactly as
      // `image/offload` does.
      const source = context.events[target.seq - context.baseSeq]
      if (source?.type !== 'assistant/message') continue
      const message = context.messages.get(target.seq) ?? source.data.message
      if (message.role !== 'assistant') continue
      // Fold exactly the recorded indexes that still name an unfoldable reasoning
      // block. The record is authoritative about *which* blocks, so this never
      // depends on positional re-derivation.
      const indexes: number[] = []
      const locators: (string | undefined)[] = []
      for (const [position, index] of target.indexes.entries()) {
        const block = message.content[index]
        if (block === undefined || block.type !== 'reasoning') continue
        if (isFoldedReasoning(block.text)) continue
        if (foldReasoningText(block.text) === undefined) continue
        indexes.push(index)
        locators.push(target.locators?.[position])
      }
      if (indexes.length === 0) continue
      updates.set(target.seq, projectReasoning(message, indexes, locators))
    }
    return updates
  },
} as const
