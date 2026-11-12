/**
 * Pure decision layer: which results fold, in which batches, in what order
 * (design §6.1, §6.2, §6.4).
 *
 * Everything here is a function of one detached snapshot, so a plan can be
 * asserted in tests without a Session, a store, or a clock, and the same
 * snapshot always yields the same plan.
 *
 * @module dsh-context-fold/plan
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContextFoldConfig } from './config.ts'
import { isFoldedText } from './format.ts'
import { codePointLength, conclude, isFoldableContent, type FoldFacts } from './rules.ts'

/** One model-visible `tool/result` node at evaluation time. */
export interface NodeSnapshot {
  /** Current surface sequence number. */
  seq: SessionSeq
  /** Turn the result belongs to. */
  turn: number
  /** Step the result belongs to. */
  step: number
  /** Tool name, resolved from the paired `tool/call` when that event is still reachable. */
  toolName: string
  /** Model-issued call id. */
  callId: string
  /** Raw `arguments` JSON of the paired `tool/call`, when available. */
  args?: string
  /** Current model-visible content. */
  content: readonly ContentBlock[]
  /** Whether the tool invocation failed. */
  isError: boolean
}

/** One searchable later event used by reference detection (design §6.2). */
export interface MentionRecord {
  /** Event sequence number. */
  seq: number
  /** Text searched for a candidate's call id. */
  text: string
}

/** The complete input to one evaluation. */
export interface PlanInput {
  /** Current surface `tool/result` nodes, in surface order. */
  nodes: readonly NodeSnapshot[]
  /** Later events whose text can cite a call id: tool-call arguments and message text. */
  mentions: readonly MentionRecord[]
  /** Turn being evaluated (the open turn). */
  currentTurn: number
  /** Step being evaluated: the step about to run, or the closing step. */
  currentStep: number
  /** Resolved configuration. */
  config: ContextFoldConfig
}

/** One planned fold, independent of any spill locator. */
export interface FoldPlan {
  /** Surface seq of the node to rewrite. */
  seq: SessionSeq
  /** Detached facts of the node. */
  facts: FoldFacts
  /** The node's turn. */
  turn: number
  /** The node's step. */
  step: number
  /** Conclusion body that will be rendered inline. */
  conclusion: string
  /** Full current text to persist before the rewrite. */
  original: string
  /** Whether this node carries the batch roster. */
  head: boolean
  /** The head's call id, present on non-head members. */
  headCallId?: string
}

/** One batch of folds sharing a turn and a contiguous step range. */
export interface FoldBatch {
  /** Stable batch key (`turn:stepFrom-stepTo`), used only for reporting. */
  key: string
  /** The batch head's call id. */
  callId: string
  /** Members in fold order (largest first). */
  members: readonly FoldPlan[]
  /** Original character count of the batch. */
  chars: number
}

/** Why one node did not fold, for the dry-run report. */
export interface SkippedNode {
  /** Surface seq. */
  seq: SessionSeq
  /** Tool name. */
  toolName: string
  /** Character count. */
  chars: number
  /** Machine-readable reason. */
  reason: 'recent' | 'alive' | 'referenced' | 'error' | 'folded' | 'small' | 'unfoldable' | 'no-conclusion'
}

/** The complete result of one evaluation. */
export interface FoldDecision {
  /** Batches to fold, in fold order. */
  batches: readonly FoldBatch[]
  /** Nodes considered and rejected, for diagnostics and the dry-run report. */
  skipped: readonly SkippedNode[]
  /** Total character count of every candidate that qualified, before batching. */
  candidateChars: number
}

/**
 * Decide what to fold for one snapshot.
 *
 * Candidate rules, in the order they are checked (design §6.1): error results
 * never fold, recently-used results never fold, already-folded nodes never
 * fold, nodes still cited by a later event never fold, and a node folds only
 * when it is at least `minFoldChars` and a conclusion exists that is smaller
 * than the result.
 *
 * @param input - one detached snapshot plus configuration.
 * @returns the decision; an empty `batches` array means "do nothing".
 */
export function planFolds(input: PlanInput): FoldDecision {
  const { config } = input
  const skipped: SkippedNode[] = []
  const candidates: NodeSnapshot[] = []

  for (const node of input.nodes) {
    const text = textOfContent(node.content)
    const chars = codePointLength(text)
    const skip = (reason: SkippedNode['reason']): void => {
      skipped.push({ seq: node.seq, toolName: node.toolName, chars, reason })
    }
    if (node.isError) {
      skip('error')
      continue
    }
    if (isFoldedText(text)) {
      skip('folded')
      continue
    }
    if (!isFoldableContent(node.content)) {
      skip('unfoldable')
      continue
    }
    const aged = node.turn < input.currentTurn || input.currentStep - node.step >= config.staleSteps
    if (!aged) {
      skip('alive')
      continue
    }
    if (node.step > input.currentStep - config.keepRecentSteps) {
      skip('recent')
      continue
    }
    if (isReferencedAfter(node.callId, node.seq, input.mentions)) {
      skip('referenced')
      continue
    }
    if (chars < config.minFoldChars) {
      skip('small')
      continue
    }
    if (conclude(factsOf(node)) === undefined) {
      skip('no-conclusion')
      continue
    }
    candidates.push(node)
  }

  const candidateChars = candidates.reduce((total, node) => total + codePointLength(textOfContent(node.content)), 0)
  const batches: FoldBatch[] = []
  for (const group of groupByBatch(candidates, config.batchSpanSteps)) {
    const chars = group.reduce((total, node) => total + codePointLength(textOfContent(node.content)), 0)
    if (chars < config.minBatchChars) continue
    const ordered = [...group].sort((a, b) => {
      const size = codePointLength(textOfContent(b.content)) - codePointLength(textOfContent(a.content))
      return size !== 0 ? size : a.seq - b.seq
    })
    const head = ordered[0]
    if (head === undefined) continue
    batches.push({
      key: `${group[0]!.turn}:${group[0]!.step}-${group[group.length - 1]!.step}`,
      callId: head.callId,
      members: ordered.map((node) => ({
        seq: node.seq,
        facts: factsOf(node),
        turn: node.turn,
        step: node.step,
        conclusion: conclude(factsOf(node)) ?? '',
        original: textOfContent(node.content),
        head: node.seq === head.seq,
        ...(node.seq === head.seq ? {} : { headCallId: head.callId }),
      })),
      chars,
    })
  }
  return { batches, skipped, candidateChars }
}

/** Detect a node that a later event still cites (design §6.2). */
function isReferencedAfter(callId: string, seq: SessionSeq, mentions: readonly MentionRecord[]): boolean {
  for (const mention of mentions) if (mention.seq > seq && mention.text.includes(callId)) return true
  return false
}

/** Group candidates into batches by turn, splitting long turns by step range. */
function groupByBatch(nodes: readonly NodeSnapshot[], batchSpanSteps: number): NodeSnapshot[][] {
  const byTurn = new Map<number, NodeSnapshot[]>()
  for (const node of nodes) {
    const list = byTurn.get(node.turn)
    if (list === undefined) byTurn.set(node.turn, [node])
    else list.push(node)
  }
  const groups: NodeSnapshot[][] = []
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const sorted = [...byTurn.get(turn)!].sort((a, b) => a.step - b.step || a.seq - b.seq)
    const first = sorted[0]
    if (first === undefined) continue
    let bucket: NodeSnapshot[] = []
    let bucketStart = first.step
    for (const node of sorted) {
      if (node.step - bucketStart >= batchSpanSteps && bucket.length > 0) {
        groups.push(bucket)
        bucket = []
        bucketStart = node.step
      }
      bucket.push(node)
    }
    if (bucket.length > 0) groups.push(bucket)
  }
  return groups
}

/** Build facts from a snapshot. */
function factsOf(node: NodeSnapshot): FoldFacts {
  return {
    toolName: node.toolName,
    callId: node.callId,
    content: node.content,
    chars: codePointLength(textOfContent(node.content)),
    ...(node.args === undefined ? {} : { args: node.args }),
  }
}

/** Concatenate text blocks of one result. */
function textOfContent(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}
