/**
 * Turn-level archiving and tool-call argument folding.
 *
 * Two related projections that map assistant *blocks* rather than whole nodes:
 *
 * 1. Argument folding (scheme B) — when the same path is written more than
 *    once, every write except the newest has its bulky `arguments` replaced by
 *    a compact marker. The overwritten version is dead information.
 *
 * 2. Turn archive — once a turn is older than `keepRecentTurns`, all of its
 *    tool calls, tool results and reasoning are written to one per-turn spill
 *    file. In-view assistant messages keep their `text` blocks; tool-call and
 *    reasoning blocks are projected to short markers, text-only shells become
 *    `[turn archived]`, and one recall path is appended to the last
 *    text-bearing message of the turn.
 *
 * Both use a plugin-record carrier, never a surface event type: an
 * `assistant/message` projection would drop every message of that type. See the
 * header of `reasoning.ts` for the full rationale. Deterministic throughout.
 *
 * @module dsh-context-fold/turns
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord,
  type Session,
  type SessionEvent,
  type SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection, SessionMessageProjectionContext } from '@deepseek-ai/dsh-session/surface'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { ContextFoldConfig } from './config.ts'
import { codePointLength } from './rules.ts'

/** Record type for the turn/argument projection decisions. */
export const TURN_EVENT = 'plugin:context-fold/turn' as const

/** Marker prefix for a folded tool-call argument. */
export const ARG_MARKER = '[fold:args]'

/**
 * An archived assistant message is projected to an empty content array, never
 * to a human-readable placeholder. A placeholder such as `[turn archived]`
 * sits in the assistant's own voice; the model can mistake it for a valid way
 * to answer and emit it verbatim (observed in a 44-turn session, where the
 * model replied exactly `[turn archived]` and the turn ended). Empty content
 * carries no text for the model to imitate.
 */
export const TURN_ARCHIVED = '[turn archived]'

/** Marker prefix for an archived turn's recall pointer. */
export const TURN_POINTER = '[context-fold] turn archived'

/** Minimum characters a path must have to be a safe needle. */
const MIN_PATH_CHARS = 10

/** One assistant message whose argument blocks should be folded. */
export interface ArgFoldTarget {
  seq: SessionSeq
  indexes: number[]
  chars: number[]
}

/** One archived turn: which messages to project and where the full text went. */
export interface TurnArchiveTarget {
  turn: number
  seqs: SessionSeq[]
  /** Seq of the recall-pointer message; omitted when no assistant message exists. */
  pointerSeq?: SessionSeq
  /** Spill locator; omitted when spill write failed or no store was available. */
  locator?: string
}

/** Payload written to the `TURN_EVENT` plugin record. */
export interface TurnFoldData {
  args?: ArgFoldTarget[]
  turns?: TurnArchiveTarget[]
}

/**
 * Declare the durable record via `PluginRecordMap`, not `SessionEventMap` — the
 * latter would make `append()` emit a non-ignorable unknown event and render the
 * session unreopenable (see the fuller note in `reasoning.ts`).
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:context-fold/turn': TurnFoldData
  }
}

/** A planned argument fold. */
export interface ArgPlan {
  seq: SessionSeq
  indexes: number[]
  chars: number[]
}

/** A planned turn archive, before the spill locator is known. */
export interface TurnPlan {
  turn: number
  seqs: SessionSeq[]
  pointerSeq: SessionSeq | undefined
  content: string
}

/** The complete projection plan for one evaluation. */
export interface TurnPlanResult {
  args: ArgPlan[]
  turns: TurnPlan[]
}

/**
 * Extract a target path from a file-mutating tool call.
 *
 * Both whole-file writes and incremental edits are considered.  An edit's
 * arguments are a delta that is not reconstructible from the final file on its
 * own — but once the *same path* has been mutated again, the earlier delta is
 * dead information in this conversation: the model will re-read the current
 * file, not replay an obsolete patch.  Shell commands remain excluded: their
 * arguments are not anchored to a path and can stay relevant indefinitely.
 *
 * @param name - tool name.
 * @param args - raw JSON argument string.
 * @returns the normalized path, or undefined.
 */
export function writeTargetPath(name: string, args: string): string | undefined {
  if (!/^(write|ops_write_file|rw_write_file|wsl-write|edit|ops_edit_file|wsl-edit)$/.test(name)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const raw = record.file_path ?? record.path ?? record.filePath
  if (typeof raw !== 'string' || raw.length < MIN_PATH_CHARS) return undefined
  return raw.replace(/\\/g, '/').toLowerCase()
}

/**
 * Plan argument folds (scheme B) across all assistant messages.
 *
 * For each path the most recent write keeps its full arguments; earlier writes
 * fold every argument block at or above `minFoldArgsChars`. Ordering is by seq.
 *
 * @param session - session to inspect.
 * @param config - resolved configuration.
 * @returns argument fold plans.
 */
export function planArgFolds(session: Session, config: ContextFoldConfig): ArgPlan[] {
  const newestByPath = new Map<string, SessionSeq>()
  const events = session.snapshotEvents()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type !== 'tool-call') continue
      const path = writeTargetPath(block.name, block.arguments)
      if (path !== undefined) newestByPath.set(path, event.seq)
    }
  }

  const plans: ArgPlan[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const indexes: number[] = []
    const chars: number[] = []
    event.data.message.content.forEach((block, index) => {
      if (block.type !== 'tool-call') return
      const path = writeTargetPath(block.name, block.arguments)
      if (path === undefined || newestByPath.get(path) === event.seq) return
      const size = codePointLength(block.arguments)
      if (size < config.minFoldArgsChars) return
      indexes.push(index)
      chars.push(size)
    })
    if (indexes.length > 0) plans.push({ seq: event.seq, indexes, chars })
  }
  return plans
}

/**
 * Whether a turn is old enough to archive.
 *
 * @param turn - turn number to test.
 * @param currentTurn - open turn.
 * @param config - resolved configuration.
 * @returns true when the turn should be archived.
 */
export function isArchivedTurn(turn: number, currentTurn: number, config: ContextFoldConfig): boolean {
  return config.foldTurnArchive && turn < currentTurn - config.keepRecentTurns + 1
}

/**
 * Turn numbers already covered by an archive record.
 *
 * @param events - the session event log.
 * @returns the set of archived turn numbers.
 */
function archivedTurnsOf(events: readonly SessionEvent[]): Set<number> {
  const turns = new Set<number>()
  for (const event of events) {
    if ((event.type as string) !== TURN_EVENT) continue
    const data = event.data as { turns?: readonly { turn?: unknown }[] }
    for (const target of data.turns ?? []) {
      if (typeof target?.turn === 'number') turns.add(target.turn)
    }
  }
  return turns
}

/**
 * Plan turn archives.
 *
 * A turn is archived when `turn < currentTurn - keepRecentTurns + 1` — with the
 * default 5, turns at most 5 behind the open turn stay intact. Each archive
 * captures every tool call, tool result and reasoning block of the turn in one
 * deterministic text, recoverable with a single read.
 *
 * @param session - session to inspect.
 * @param currentTurn - open turn.
 * @param config - resolved configuration.
 * @returns turn archive plans, one per archived turn.
 */
export function planTurnArchives(session: Session, currentTurn: number, config: ContextFoldConfig): TurnPlan[] {
  const events = session.snapshotEvents()
  // A turn already archived by an earlier evaluation must never be archived
  // again: re-planning it would rewrite the same spill file on every later
  // step, which is both wasted IO and an ever-growing file pile.
  const alreadyArchived = archivedTurnsOf(events)
  const byTurn = new Map<number, SessionEvent[]>()
  for (const event of events) {
    const data = event.data as { turn?: unknown }
    if (typeof data.turn !== 'number') continue
    if (alreadyArchived.has(data.turn)) continue
    if (!isArchivedTurn(data.turn, currentTurn, config)) continue
    const list = byTurn.get(data.turn) ?? []
    list.push(event)
    byTurn.set(data.turn, list)
  }

  const plans: TurnPlan[] = []
  for (const [turn, events] of [...byTurn].sort((a, b) => a[0] - b[0])) {
    const seqs: SessionSeq[] = []
    let lastAssistant: SessionSeq | undefined
    let pointerSeq: SessionSeq | undefined
    const lines: string[] = [`${TURN_POINTER} turn ${String(turn)} — full tool calls, results and reasoning`]
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const content = event.data.message.content
        const hasText = content.some((block) => block.type === 'text' && block.text.trim() !== '')
        if (hasText) pointerSeq = event.seq
        lastAssistant = event.seq
        seqs.push(event.seq)
        lines.push(`\n## [seq ${String(event.seq)}] assistant`)
        for (const block of content) {
          if (block.type === 'text') lines.push(`text: ${block.text}`)
          else if (block.type === 'tool-call') {
            lines.push(`tool-call ${block.name} (${String(codePointLength(block.arguments))} chars): ${block.arguments}`)
          } else if (block.type === 'reasoning') {
            lines.push(`reasoning (${String(codePointLength(block.text))} chars): ${block.text}`)
          }
        }
      } else if (event.type === 'tool/result') {
        lines.push(`\n## [seq ${String(event.seq)}] tool/result`)
        for (const block of event.data.message.content) {
          if (block.type === 'text') lines.push(`text: ${block.text}`)
        }
      }
    }
    // Pointer lands on the last text-bearing assistant message; if the whole
    // turn had no text, it lands on the last assistant message (a shell).
    if (pointerSeq === undefined) pointerSeq = lastAssistant
    plans.push({ turn, seqs, pointerSeq, content: lines.join('\n') })
  }
  return plans
}

/**
 * Persist planned folds to spill and append one projection record.
 *
 * @param session - session to record against.
 * @param plans - argument and turn plans.
 * @param spill - spill store, when available.
 * @param config - resolved configuration.
 * @returns the record seq, or undefined when there was nothing to record.
 */
export async function recordTurnFolds(
  session: Session,
  plans: TurnPlanResult,
  spill: SpillStore | undefined,
  config: ContextFoldConfig,
): Promise<SessionSeq | undefined> {
  const args: ArgFoldTarget[] = plans.args.map((plan) => ({
    seq: plan.seq,
    indexes: [...plan.indexes],
    chars: [...plan.chars],
  }))
  const turns: TurnArchiveTarget[] = []
  for (const plan of plans.turns) {
    let locator: string | undefined
    if (spill !== undefined) {
      try {
        const saved = await spill.saveText({
          owner: { sessionId: session.header.id },
          source: {
            kind: 'tool',
            toolName: 'turn-archive',
            callId: `turn-${String(plan.turn)}` as never,
            label: `turn ${String(plan.turn)}`,
          },
          // The spill store derives its own file name and URL-encodes any path
          // separator, so a nested name would materialise as one flat file with
          // `~002F` in it. Ask for a flat name instead.
          suggestedName: `turn-${String(plan.turn).padStart(2, '0')}.md`,
          content: plan.content,
        })
        locator = saved.locator
      } catch {
        locator = undefined
      }
    }
    turns.push({
      turn: plan.turn,
      seqs: [...plan.seqs],
      ...(plan.pointerSeq === undefined ? {} : { pointerSeq: plan.pointerSeq }),
      ...(locator === undefined ? {} : { locator }),
    })
  }
  if (args.length === 0 && turns.length === 0) return undefined
  return appendPluginRecord(session, TURN_EVENT, {
    ...(args.length > 0 ? { args } : {}),
    ...(turns.length > 0 ? { turns } : {}),
  })
}

/**
 * Build the folded form of a tool-call argument block.
 *
 * @param block - the original tool-call block.
 * @param chars - original argument size.
 * @returns a folded tool-call block preserving id and name.
 */
function foldArgBlock(block: Extract<ContentBlock, { type: 'tool-call' }>, chars: number): ContentBlock {
  return {
    type: 'tool-call',
    id: block.id,
    name: block.name,
    arguments: `${ARG_MARKER} ${String(chars)} chars of tool arguments folded.`,
  }
}

/**
 * Project one assistant message with argument / turn folds applied.
 *
 * @param message - the message (assistant role).
 * @param argIndexes - argument block indexes to fold.
 * @param argChars - original sizes, parallel to `argIndexes`.
 * @param archive - whether the whole turn is archived.
 * @param pointer - recall pointer to append to the last text block, if any.
 * @returns the projected message.
 */
export function projectTurnMessage(
  message: Message,
  argIndexes: readonly number[],
  argChars: readonly number[],
  archive: boolean,
  pointer: string | undefined,
): Message {
  if (message.role !== 'assistant') return message
  const argMap = new Map(argIndexes.map((index, position) => [index, argChars[position] ?? 0]))
  const blocks: ContentBlock[] = []
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'tool-call') {
      const size = argMap.get(index) ?? (archive ? codePointLength(block.arguments) : undefined)
      blocks.push(size !== undefined ? foldArgBlock(block, size) : block)
    } else if (archive && block.type === 'reasoning') {
      continue
    } else {
      blocks.push(block)
    }
  }

  // A message with no text left after archiving is an empty shell. Project it
  // to empty content: a text placeholder would be in the assistant's voice and
  // the model can imitate it as a reply. Empty content leaves nothing to copy.
  const remainingText = blocks.some((block) => block.type === 'text' && block.text.trim() !== '')
  if (archive && !remainingText) {
    return { ...message, content: [] }
  }

  // Append the recall pointer once, to the last text block of the turn.
  if (pointer !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.type === 'text') {
        const block = blocks[i] as Extract<ContentBlock, { type: 'text' }>
        blocks[i] = { type: 'text', text: `${block.text}\n${pointer}` }
        break
      }
    }
  }
  return { ...message, content: blocks }
}

/** Validates that a locator is a real path, not a truncated fragment. */
function usableLocator(locator: string | undefined): locator is string {
  return typeof locator === 'string' && locator.length >= MIN_PATH_CHARS && /[\\/]/.test(locator)
}

/**
 * The projection definition registered with `ctx.sessions`.
 *
 * Tolerant of stale targets: a compaction may shadow a node the record named;
 * skipping it (rather than throwing) keeps every later `deriveMessages()` alive.
 */
export const turnProjection = {
  type: TURN_EVENT,
  project(event: SessionEvent, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message> {
    const data = event.data as TurnFoldData
    if (typeof data !== 'object' || data === null) return new Map()
    const nodes = new Set(context.nodes)
    const updates = new Map<SessionSeq, Message>()

    for (const target of data.args ?? []) {
      if (typeof target !== 'object' || target === null) continue
      if (!Array.isArray(target.indexes) || target.indexes.length === 0) continue
      if (!nodes.has(target.seq) || updates.has(target.seq)) continue
      const source = context.events[target.seq - context.baseSeq]
      if (source?.type !== 'assistant/message') continue
      const message = context.messages.get(target.seq) ?? source.data.message
      if (message.role !== 'assistant') continue
      const indexes = target.indexes.filter((index) => {
        const block = message.content[index]
        return block?.type === 'tool-call' && !block.arguments.startsWith(ARG_MARKER)
      })
      if (indexes.length === 0) continue
      updates.set(target.seq, projectTurnMessage(message, indexes, target.chars, false, undefined))
    }

    for (const target of data.turns ?? []) {
      if (typeof target !== 'object' || target === null || !Array.isArray(target.seqs)) continue
      for (const seq of target.seqs) {
        if (!nodes.has(seq) || updates.has(seq)) continue
        const source = context.events[seq - context.baseSeq]
        if (source?.type !== 'assistant/message') continue
        const message = context.messages.get(seq) ?? source.data.message
        if (message.role !== 'assistant') continue
        const pointer = seq === target.pointerSeq && usableLocator(target.locator)
          ? `${TURN_POINTER}: ${target.locator} — use read (offset/limit) or grep on that path.`
          : undefined
        updates.set(seq, projectTurnMessage(message, [], [], true, pointer))
      }
    }
    return updates
  },
} as const

