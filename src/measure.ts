/**
 * Measurement derived entirely from the session log (design §6.10).
 *
 * The plugin persists nothing: characters before/after come from
 * `compaction/prune` shadow prices and the replacement nodes; the node count
 * comes from the fold marker; and the re-read rate comes from scanning events
 * after each fold for the folded result's call id or its spill locator. That
 * keeps the metric reproducible from any log, including one produced by
 * `dryRun`.
 *
 * @module dsh-context-fold/measure
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { FOLD_MARKER, isFoldedText } from './format.ts'
import { REASONING_EVENT } from './reasoning.ts'
import { codePointLength } from './rules.ts'
import { currentNode } from './session.ts'

/** One fold found in the log. */
export interface FoldRecord {
  /** Seq of the replacement node. */
  seq: number
  /** Turn the folded result belonged to. */
  turn: number
  /** Step the folded result belonged to. */
  step: number
  /** Tool name parsed from the marker line. */
  toolName: string
  /** Original character count parsed from the marker line. */
  charsBefore: number
  /** Current character count of the folded node. */
  charsAfter: number
  /** Sequential calls later found that cite this fold's call id. */
  reReads: number
  /** Whether this node is a batch head. */
  head: boolean
}

/** Aggregate facts about one session's folds. */
export interface FoldReport {
  /** Every fold currently on the surface, in surface order. */
  folds: readonly FoldRecord[]
  /** Characters removed across the surface. */
  charsRemoved: number
  /** Total sequential references to folded content. */
  reReads: number
  /** How many of the folds were cited at least once. */
  rereadNodes: number
  /** Reasoning folds recorded by decision events (phase 2). */
  reasoningFolds: readonly ReasoningFoldRecord[]
}

/** One reasoning fold found in the log. */
export interface ReasoningFoldRecord {
  /** Message surface seq the decision named. */
  seq: number
  /** Reasoning blocks the decision covered. */
  blocks: number
  /** Original characters in those blocks. */
  charsBefore: number
  /** Characters the projected text currently occupies. */
  charsAfter: number
}

const MARKER_HEADER = /^\[context-fold\] \[tool: ([^\]]+)\] ([\d,]+) chars folded at turn (\d+), step (\d+)\.( \(batch head\))?/

/**
 * Derive a report from one session's current log.
 *
 * @param session - session to inspect.
 * @returns the fold report.
 */
export function reportOf(session: Session): FoldReport {
  const events = session.snapshotEvents()
  const folds: FoldRecord[] = []
  for (const seq of [...session.surface.nodes]) {
    const current = currentNode(session, seq)
    if (current === undefined) continue
    if (!isFoldedText(current.text)) continue
    const header = MARKER_HEADER.exec(current.text)
    const charsAfter = codePointLength(current.text)
    folds.push({
      seq,
      turn: header === null ? 0 : Number(header[3]),
      step: header === null ? 0 : Number(header[4]),
      toolName: header?.[1] ?? 'unknown',
      charsBefore: header === null ? charsAfter : Number(header[2]!.replaceAll(',', '')),
      charsAfter,
      reReads: countReReads(events, seq, current.text),
      head: header?.[5] !== undefined,
    })
  }
  return {
    folds,
    charsRemoved: folds.reduce((total, fold) => total + Math.max(0, fold.charsBefore - fold.charsAfter), 0),
    reReads: folds.reduce((total, fold) => total + fold.reReads, 0),
    rereadNodes: folds.filter((fold) => fold.reReads > 0).length,
    reasoningFolds: reasoningFoldsOf(session, events),
  }
}

/**
 * Derive reasoning folds from their durable decision records.
 *
 * Only the folded blocks are measured, so a message that intentionally keeps a
 * short reasoning block does not have that block's characters attributed to the
 * fold. Rows are keyed by `seq` + block index: two decisions may legitimately
 * cover different blocks of one message, but a repeated decision for the same
 * block must not be counted twice.
 *
 * @param session - session to inspect.
 * @param events - the session's event log.
 * @returns one record per folded block, in decision order.
 */
function reasoningFoldsOf(session: Session, events: readonly SessionEvent[]): ReasoningFoldRecord[] {
  const records: ReasoningFoldRecord[] = []
  const seen = new Set<string>()
  for (const event of events) {
    // Plugin-record types are outside `SessionEventType`, so there is no union
    // member to narrow to; compare as a plain string.
    if ((event.type as string) !== REASONING_EVENT) continue
    const data = event.data as { targets?: readonly { seq: number; indexes?: readonly number[]; chars?: readonly number[] }[] }
    for (const target of data.targets ?? []) {
      const indexes = target.indexes ?? []
      const message = session.eventAt(target.seq as never)
      const derived = message === undefined ? null : session.deriveEventMessage(message)
      if (derived === null || derived.role !== 'assistant') continue
      for (const [position, index] of indexes.entries()) {
        const key = `${target.seq}:${index}`
        if (seen.has(key)) continue
        const block = derived.content[index]
        if (block === undefined || block.type !== 'reasoning') continue
        seen.add(key)
        records.push({
          seq: target.seq,
          blocks: 1,
          charsBefore: target.chars?.[position] ?? codePointLength(block.text),
          charsAfter: codePointLength(block.text),
        })
      }
    }
  }
  return records
}

/**
 * Count later events that re-read a folded node's content.
 *
 * Two cheap substring signals over the later event stream:
 *   1. the batch-head call id (the model citing the fold explicitly), and
 *   2. a *valid* spill locator (the model reading the spilled original).
 *
 * Locator validation matters: a truncated marker can leave `Full result: '`
 * with a one-character locator, and searching for `'` matches nearly every
 * later event — producing hundreds of phantom re-reads from a single node.
 * A real spill locator is both long and path-shaped.
 *
 * Deliberately NOT detected: re-running the original tool with the same
 * arguments (design §6.2's known limitation). The only reliable needle for
 * that would be a full file path lifted from the conclusion, but conclusions
 * often quote directories, which match every later operation under them and
 * create worse false positives than the ones this fix removes.
 *
 * @param events - the session's event log.
 * @param seq - the folded node's seq.
 * @param text - the folded node's text, source of call id and locator.
 * @returns the number of later citing events.
 */
function countReReads(events: readonly SessionEvent[], seq: number, text: string): number {
  const needles: string[] = []
  const headCallId = /Batch head: (\S+) \(callId\)/.exec(text)?.[1]
  if (headCallId !== undefined && headCallId.length >= 6) needles.push(headCallId)

  const locator = /^Full result: (.+)$/m.exec(text)?.[1]?.trim()
  if (locator !== undefined && isValidLocator(locator)) needles.push(locator)

  const unique = [...new Set(needles)]
  if (unique.length === 0) return 0
  let count = 0
  for (const event of events) {
    if (event.seq <= seq) continue
    const searched = searchableText(event)
    if (searched === undefined) continue
    if (unique.some((needle) => searched.includes(needle))) count++
  }
  return count
}

/**
 * A spill locator is a real file path, not a truncated fragment.
 *
 * @param locator - trimmed locator text from the fold marker.
 * @returns true when safe to use as a search needle.
 */
export function isValidLocator(locator: string): boolean {
  return locator.length >= 10 && /[\\/]/.test(locator)
}

/** Text one later event contributes to the re-read search. */
function searchableText(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'tool/call':
      return `${event.data.callId} ${event.data.name} ${event.data.arguments}`
    case 'user/message': {
      let text = ''
      for (const block of event.data.content) if (block.type === 'text') text += block.text
      return text
    }
    case 'assistant/message': {
      let text = ''
      for (const block of event.data.message.content) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'tool-call') text += `${block.id} ${block.name} ${block.arguments}`
      }
      return text
    }
    default:
      return undefined
  }
}

/**
 * Render the `/context-fold` report.
 *
 * @param report - derived report.
 * @param dryRun - whether the plugin is configured to mutate nothing.
 * @returns markdown text for the command result.
 */
export function renderReport(report: FoldReport, dryRun: boolean): string {
  const lines = [`${FOLD_MARKER} ${report.folds.length} folded node(s) on the surface.`]
  if (report.reasoningFolds.length > 0) {
    const removed = report.reasoningFolds.reduce((total, fold) => total + Math.max(0, fold.charsBefore - fold.charsAfter), 0)
    lines.push(`Reasoning folded in ${report.reasoningFolds.length} message(s): ${removed.toLocaleString('en-US')} chars removed.`)
  }
  if (report.folds.length === 0) {
    if (report.reasoningFolds.length > 0) {
      if (dryRun) lines.push('dryRun is on: nothing is mutated; candidates are reported by the log line.')
      return lines.join('\n')
    }
    lines.push(dryRun ? 'dryRun is on: nothing is mutated; candidates are reported by the log line.' : 'Nothing has been folded in this session yet.')
    return lines.join('\n')
  }
  lines.push(`Characters removed: ${report.charsRemoved.toLocaleString('en-US')}`)
  lines.push(`Re-read signals: ${report.reReads} across ${report.rereadNodes} folded node(s)`)
  lines.push('')
  lines.push('| seq | turn.step | tool | before | after | re-reads |')
  lines.push('| --- | --- | --- | ---: | ---: | ---: |')
  for (const fold of report.folds) {
    lines.push(`| ${fold.seq} | ${fold.turn}.${fold.step} | ${fold.toolName} | ${fold.charsBefore} | ${fold.charsAfter} | ${fold.reReads} |`)
  }
  if (dryRun) lines.push('', 'dryRun is on: the numbers above describe folds landed earlier, not new mutations.')
  return lines.join('\n')
}
