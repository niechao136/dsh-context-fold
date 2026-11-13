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
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection, SessionMessageProjectionContext } from '@deepseek-ai/dsh-session/surface'
import type { ContextFoldConfig } from './config.ts'
import { FOLD_MARKER } from './format.ts'
import { codePointLength } from './rules.ts'

/** Marker opening a folded reasoning block. Must be distinctive: `startsWith` is the idempotency test. */
export const REASONING_MARKER = `${FOLD_MARKER} [reasoning]`

/** Durable event type carrying one reasoning-fold decision. */
export const REASONING_EVENT = 'context-fold/reasoning'

/** One reasoning fold recorded by a decision event. */
export interface ReasoningTarget {
  /** Surface seq of the assistant node whose reasoning is folded. */
  seq: SessionSeq
  /** Original code-point length of each folded reasoning block, in content order. */
  chars: readonly number[]
}

/** Data of one `context-fold/reasoning` decision event. */
export interface ReasoningFoldData {
  /** Targets, in surface order. */
  targets: readonly ReasoningTarget[]
}

/**
 * Declare the durable decision event, exactly as `dsh-compaction-image-offload`
 * declares `image/offload`: a plugin-owned event that a registered message
 * projection interprets. The `@messageProjection` tag marks it as one.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Fold historical reasoning blocks on tool-call turns.
     *
     * Targets name current `assistant/message` surface nodes and how many of
     * their reasoning blocks the decision covers, in content order. Message
     * identity, block count, and block types are preserved; the durable event
     * keeps the full original text.
     * @messageProjection
     */
    'context-fold/reasoning': ReasoningFoldData
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

/** Smallest reasoning block worth folding. Below this the pointer costs as much as the text. */
const MIN_REASONING_CHARS = 1200

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
 * Whether a message is a tool-call turn.
 *
 * That is where reasoning is re-sent most, and where folding pays: the DeepSeek
 * adapter emits `reasoning_content` only on tool-call turns, and the measured
 * plain-turn share is negligible (see the module header). Restricting to this
 * shape keeps the policy route-independent.
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
 * @param text - original reasoning text.
 * @returns folded text, or undefined when folding would not shorten it.
 */
export function foldReasoningText(text: string): string | undefined {
  if (isFoldedReasoning(text)) return undefined
  const chars = codePointLength(text)
  if (chars < MIN_REASONING_CHARS) return undefined
  const head = Array.from(text).slice(0, HEAD_CHARS).join('').trimEnd()
  const folded = [
    `${REASONING_MARKER} ${formatNumber(chars)} chars folded.`,
    head,
    `[… ${formatNumber(chars - codePointLength(head))} chars of earlier reasoning omitted]`,
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
}

/**
 * Plan reasoning folds for one snapshot.
 *
 * A node qualifies when it is a tool-call turn (where reasoning is re-sent most,
 * and where the measurable win is), when it is old enough by the same age rules
 * phase 1 uses, and when at least one reasoning block is large enough to shrink.
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
    if (!isToolCallTurn(node.content)) continue
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
export function projectReasoning(message: AssistantMessage, indexes: readonly number[]): AssistantMessage {
  const content = message.content.map((block, index) => {
    if (!indexes.includes(index)) return block
    if (block.type !== 'reasoning') throw new Error(`context-fold: block ${index} is not reasoning`)
    const folded = foldReasoningText(block.text)
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
 * Append one decision event recording the planned folds.
 *
 * The decision is durable and pure: replaying the log through the registered
 * projection reproduces exactly the same request content, which is what makes
 * this replay-safe without touching the append-only log.
 *
 * @param session - session to extend.
 * @param plans - folds to record.
 */
export function recordReasoningFolds(session: Session, plans: readonly ReasoningPlan[]): void {
  const targets: ReasoningTarget[] = plans.map((plan) => ({ seq: plan.seq, chars: [...plan.chars] }))
  session.append(REASONING_EVENT, { targets })
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
export const reasoningProjection: SessionMessageProjection<typeof REASONING_EVENT> = {
  type: REASONING_EVENT,
  project(event: SessionEvent, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message> {
    const data = event.data as ReasoningFoldData
    if (typeof data !== 'object' || data === null || !Array.isArray(data.targets) || data.targets.length === 0) {
      throw new Error('context-fold: reasoning decision must carry a non-empty targets array')
    }
    const nodes = new Set(context.nodes)
    const updates = new Map<SessionSeq, Message>()
    for (const target of data.targets) {
      if (typeof target !== 'object' || target === null) continue
      if (!Number.isSafeInteger(target.seq) || !Array.isArray(target.chars) || target.chars.length === 0) continue
      // A stale target is not an error: see the tolerance note above.
      if (!nodes.has(target.seq) || updates.has(target.seq)) continue
      // `context.messages` holds only *previously projected* messages, so an
      // untouched assistant node falls back to its own durable event, exactly as
      // `image/offload` does.
      const source = context.events[target.seq - context.baseSeq]
      if (source?.type !== 'assistant/message') continue
      const message = context.messages.get(target.seq) ?? source.data.message
      if (message.role !== 'assistant') continue
      const chosen: number[] = []
      for (const [index, block] of message.content.entries()) {
        if (chosen.length === target.chars.length) break
        if (block.type !== 'reasoning') continue
        if (isFoldedReasoning(block.text)) continue
        if (foldReasoningText(block.text) === undefined) continue
        chosen.push(index)
      }
      if (chosen.length === 0) continue
      const projected = projectReasoning(message, chosen)
      // The decision may not apply to a message from a different provider route,
      // but block count and types are preserved either way, so a partial fold is
      // still a valid projection.
      updates.set(target.seq, projected)
    }
    return updates
  },
} as const
