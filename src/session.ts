/**
 * Session adapter: read one detached snapshot of the live surface, and apply
 * planned folds through the shipped, replay-safe replace protocol
 * (design §3.1, §6.6, §6.7).
 *
 * The protocol is copied from `dsh-compaction-tool-result-pruner` in shape: a
 * `compaction/prune` shadow price immediately followed by a single-node
 * `tool/result` replacement citing that node. Only `content` differs on the
 * replacement, so tool-call pairing can never break and the host's
 * `assertToolResultRewrite` is satisfied by construction.
 *
 * @module dsh-context-fold/session
 */
import type {} from '@deepseek-ai/dsh-compaction/types'
import { freezeMessage, type ContentBlock, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { ContextFoldConfig } from './config.ts'
import { renderFoldedText, type RosterEntry } from './format.ts'
import { parseSpillNotice } from './rules.ts'
import { planFolds, type FoldBatch, type FoldDecision, type FoldPlan, type MentionRecord, type NodeSnapshot } from './plan.ts'

/** Everything a fold pass needs from the host. */
export interface FoldHost {
  /** Session whose surface is rewritten. */
  session: Session
  /** Spill backend; absent means the plugin must not fold at all (design §6.5). */
  spillStore: SpillStore
  /** Token meter, for the shadow price of each replaced node. */
  estimateMessage(message: ToolResultMessage): number
  /** Resolved configuration. */
  config: ContextFoldConfig
}

/** One landed fold, for the measurement record. */
export interface FoldedNodeRecord {
  /** Seq of the replacement node. */
  replacementSeq: number
  /** Seq of the replaced node. */
  originalSeq: number
  /** Tool call id. */
  callId: string
  /** Tool name. */
  toolName: string
  /** Characters before. */
  charsBefore: number
  /** Characters after. */
  charsAfter: number
  /** Where the full original lives. */
  locator: string
  /** Bytes written to the spill store by this fold (0 when an existing spill was reused). */
  spillBytes: number
}

/** One failed fold; earlier folds of the pass stay durable. */
export interface FoldFailure {
  /** Seq of the node that could not be folded. */
  seq: number
  /** Tool name, when known. */
  toolName: string
  /** Human-readable cause. */
  reason: string
}

/** Result of one fold pass. */
export interface FoldPassResult {
  /** The decision this pass acted on. */
  decision: FoldDecision
  /** Landed folds, in fold order. */
  folded: readonly FoldedNodeRecord[]
  /** Nodes that failed, in fold order. */
  failed: readonly FoldFailure[]
  /** Characters removed from the surface by this pass. */
  charsRemoved: number
}

/** One resolved current node. */
export interface CurrentNode {
  /** The current event, narrowed to a tool result. */
  event: SessionEvent<'tool/result'>
  /** Its derived tool-result message. */
  message: ToolResultMessage
  /** Its current text. */
  text: string
}

/**
 * Read the current model-visible state of one node.
 *
 * @param session - session owning the node.
 * @param seq - a surface seq taken from `session.surface.nodes` at evaluation time.
 * @returns the node, or undefined when the seq no longer resolves to a tool result.
 */
export function currentNode(session: Session, seq: SessionSeq): CurrentNode | undefined {
  const event = session.eventAt(seq)
  if (event === undefined) return undefined
  const message = session.deriveEventMessage(event)
  if (message === null || message.role !== 'tool') return undefined
  if (event.type !== 'tool/result') return undefined
  return { event, message, text: textOf(message.content) }
}


/**
 * Build a monotonic step ordinal for a stream of session events.
 *
 * `step` restarts at every turn, so recency cannot subtract raw steps across
 * turns. Each turn's steps are placed above every earlier turn's, offset by the
 * longest step count seen in those turns. A node from a turn that ran to step
 * 116 therefore stays genuinely old when a later turn sits at step 35
 * (measured: 9 nodes, ~19k chars, were stranded forever before this).
 *
 * @param events - the session event stream, in order.
 * @returns `globalStepOf(turn, step)` and the ordinal just past the last event.
 */
export function stepOrdinals(
  events: readonly { data: unknown }[],
): { globalStepOf: (turn: number, step: number) => number; endGlobalStep: number } {
  const maxStepOfTurn = new Map<number, number>()
  for (const event of events) {
    const data = event.data as { turn?: unknown; step?: unknown }
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    const known = maxStepOfTurn.get(data.turn)
    if (known === undefined || data.step > known) maxStepOfTurn.set(data.turn, data.step)
  }
  const baseByTurn = new Map<number, number>()
  let running = 0
  for (const turn of [...maxStepOfTurn.keys()].sort((a, b) => a - b)) {
    baseByTurn.set(turn, running)
    running += (maxStepOfTurn.get(turn) ?? 0) + 1
  }
  return { globalStepOf: (turn, step) => (baseByTurn.get(turn) ?? 0) + step, endGlobalStep: running }
}

/**
 * Build the detached evaluation input for one moment in the session.
 *
 * Surface seqs are always sourced fresh from `session.surface.nodes`, never
 * cached across evaluations (design §6.7), because a replacement splices the new
 * seq over the old one and the old seq leaves the surface.
 *
 * @param session - session to read.
 * @returns a snapshot that does not reference live session objects.
 */
export function snapshotInput(
  session: Session,
  currentTurn?: number,
  currentStep?: number,
): { nodes: NodeSnapshot[]; mentions: MentionRecord[]; currentGlobalStep: number } {
  const nodes: NodeSnapshot[] = []
  const calls = new Map<string, { name: string; args: string }>()
  const mentions: MentionRecord[] = []
  const events = session.snapshotEvents()
  const { globalStepOf, endGlobalStep } = stepOrdinals(events)

  for (const event of events) {
    switch (event.type) {
      case 'tool/call': {
        calls.set(event.data.callId, { name: event.data.name, args: event.data.arguments })
        mentions.push({ seq: event.seq, text: `${event.data.callId} ${event.data.arguments}` })
        break
      }
      case 'assistant/message': {
        let text = ''
        for (const block of event.data.message.content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'tool-call') {
            text += `${block.id} ${block.name} ${block.arguments}`
            if (!calls.has(block.id)) calls.set(block.id, { name: block.name, args: block.arguments })
          }
        }
        if (text !== '') mentions.push({ seq: event.seq, text })
        break
      }
      case 'user/message': {
        const text = textOf(event.data.content)
        if (text !== '') mentions.push({ seq: event.seq, text })
        break
      }
      default:
        break
    }
  }

  for (const seq of [...session.surface.nodes]) {
    const current = currentNode(session, seq)
    if (current === undefined) continue
    const { event, message } = current
    if (event.type !== 'tool/result') continue
    const call = calls.get(message.toolCallId)
    nodes.push({
      seq,
      turn: event.data.turn,
      step: event.data.step,
      globalStep: globalStepOf(event.data.turn, event.data.step),
      toolName: call?.name ?? 'unknown',
      callId: message.toolCallId,
      ...(call === undefined ? {} : { args: call.args }),
      content: message.content,
      isError: message.isError === true,
    })
  }
  const currentGlobalStep =
    currentTurn === undefined || currentStep === undefined ? endGlobalStep : globalStepOf(currentTurn, currentStep)
  return { nodes, mentions, currentGlobalStep }
}

/**
 * Plan one evaluation without touching the session.
 *
 * @param session - session to read.
 * @param currentTurn - the turn being evaluated.
 * @param currentStep - the step being evaluated.
 * @param config - resolved configuration.
 * @returns the decision.
 */
export function planFor(session: Session, currentTurn: number, currentStep: number, config: ContextFoldConfig): FoldDecision {
  const { nodes, mentions, currentGlobalStep } = snapshotInput(session, currentTurn, currentStep)
  return planFolds({ nodes, mentions, currentTurn, currentStep, currentGlobalStep, config })
}

/**
 * Plan one evaluation and report the monotonic ordinal of the moment being
 * evaluated, so reasoning folding can apply the same recency rule.
 *
 * @param session - session to read.
 * @param currentTurn - the turn being evaluated.
 * @param currentStep - the step being evaluated.
 * @param config - resolved configuration.
 * @returns the decision plus `currentGlobalStep`.
 */
export function evaluateSession(
  session: Session,
  currentTurn: number,
  currentStep: number,
  config: ContextFoldConfig,
): { decision: FoldDecision; currentGlobalStep: number } {
  const { nodes, mentions, currentGlobalStep } = snapshotInput(session, currentTurn, currentStep)
  return { decision: planFolds({ nodes, mentions, currentTurn, currentStep, currentGlobalStep, config }), currentGlobalStep }
}

/**
 * Execute one planned batch.
 *
 * Per node (design §6.6): resolve the node's *current* message, spill the full
 * current text, append the shadow price, then append the replacement. A node
 * whose spill fails is left untouched — folding without a reachable original
 * would be lossy. A node whose replacement is rejected fails that node only;
 * earlier replacements stay durable and the batch is not retried.
 *
 * @param host - session, spill store, meter, and configuration.
 * @param batch - the batch to fold.
 * @returns landed folds, failures, and the characters removed.
 */
export async function foldBatch(host: FoldHost, batch: FoldBatch): Promise<{ folded: FoldedNodeRecord[]; failed: FoldFailure[]; charsRemoved: number }> {
  const folded: FoldedNodeRecord[] = []
  const failed: FoldFailure[] = []
  const spilled = new Map<number, { locator: string; bytes: number }>()
  const roster: RosterEntry[] = []

  for (const plan of batch.members) {
    try {
      const ref = await spillFor(host, plan)
      spilled.set(plan.seq, ref)
      roster.push({ toolName: plan.facts.toolName, callId: plan.facts.callId, locator: ref.locator })
    } catch (error) {
      failed.push({ seq: plan.seq, toolName: plan.facts.toolName, reason: describe(error) })
    }
  }

  const landed = batch.members.filter((plan) => spilled.has(plan.seq))
  for (const plan of landed) {
    const ref = spilled.get(plan.seq)!
    const siblings = roster.filter((entry) => entry.callId !== plan.facts.callId)
    try {
      const text = renderFoldedText(plan, ref.locator, siblings, landed.length)
      // The promise is "smaller than the input": a rendered node that is not
      // smaller stays as it is, even though its original is already spilled.
      if (Array.from(text).length >= plan.facts.chars) {
        failed.push({ seq: plan.seq, toolName: plan.facts.toolName, reason: 'the folded node would not be smaller than the result' })
        continue
      }
      folded.push(applyFold(host, plan, text, ref.locator, ref.bytes))
    } catch (error) {
      failed.push({ seq: plan.seq, toolName: plan.facts.toolName, reason: describe(error) })
    }
  }
  const charsRemoved = folded.reduce((total, fold) => total + (fold.charsBefore - fold.charsAfter), 0)
  return { folded, failed, charsRemoved }
}

/**
 * Spill one node's full current text and return its locator.
 *
 * A result that already carries a spill notice is not spilled twice: its
 * existing locator is reused (design §6.5).
 *
 * @param host - host services.
 * @param plan - the node to spill.
 * @returns the locator to cite and the bytes this fold wrote.
 */
async function spillFor(host: FoldHost, plan: FoldPlan): Promise<{ locator: string; bytes: number }> {
  const current = currentNode(host.session, plan.seq)
  if (current === undefined) throw new Error('the node left the surface before its fold landed')
  const existing = parseSpillNotice(current.text)
  if (existing !== undefined) return { locator: existing.locator, bytes: 0 }
  const ref = await host.spillStore.saveText({
    owner: { sessionId: host.session.header.id },
    source: { kind: 'tool', toolName: plan.facts.toolName, callId: current.message.toolCallId, label: 'result' },
    suggestedName: `${plan.facts.toolName}.txt`,
    content: current.text,
  })
  return { locator: ref.locator, bytes: ref.bytes }
}

/**
 * Apply one fold through the replace protocol.
 *
 * @param host - host services.
 * @param plan - the node to rewrite.
 * @param text - replacement content text.
 * @param locator - the spill locator cited in the text.
 * @param spillBytes - bytes written to reach that locator.
 * @returns the landed fold record.
 * @throws when the host rejects the replacement.
 */
function applyFold(host: FoldHost, plan: FoldPlan, text: string, locator: string, spillBytes: number): FoldedNodeRecord {
  const current = currentNode(host.session, plan.seq)
  if (current === undefined) throw new Error('the node left the surface before its fold landed')
  const content: ContentBlock[] = [{ type: 'text', text }]
  const message = freezeMessage({ ...current.message, content } as ToolResultMessage)
  host.session.append('compaction/prune', {
    shadowedRange: { start: plan.seq, end: plan.seq },
    shadowedSeqs: [plan.seq],
    shadowedTokenCount: host.estimateMessage(current.message),
  })
  const replacement = host.session.append(
    'tool/result',
    { ...current.event.data, message },
    { surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq }, sourceEventSeqs: [plan.seq] },
  )
  return {
    replacementSeq: replacement.seq,
    originalSeq: plan.seq,
    callId: plan.facts.callId,
    toolName: plan.facts.toolName,
    charsBefore: plan.facts.chars,
    charsAfter: Array.from(text).length,
    locator,
    spillBytes,
  }
}

/** Concatenate text blocks. */
function textOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}

/** Human-readable error text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
