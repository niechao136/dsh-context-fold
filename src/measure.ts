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
  }
}

/**
 * Count later tool calls that cite a folded node.
 *
 * Two signals, both cheap substring tests over a bounded window: the node's
 * call id, and its spill locator. Design §6.2 records the known limitation — a
 * model that re-runs the original tool with identical arguments is not
 * detected here; the argument-hash refinement is out of phase 1.
 *
 * @param events - the session's event log.
 * @param seq - the folded node's seq.
 * @param text - the folded node's text, source of the spill locator.
 * @returns the number of later citing events.
 */
function countReReads(events: readonly SessionEvent[], seq: number, text: string): number {
  const headCallId = /Batch head: (\S+) \(callId\)/.exec(text)?.[1]
  const locator = /^Full result: (.+)$/m.exec(text)?.[1]
  const needles: string[] = []
  if (headCallId !== undefined) needles.push(headCallId)
  if (locator !== undefined) needles.push(locator.trim())
  if (needles.length === 0) return 0
  let count = 0
  for (const event of events) {
    if (event.seq <= seq) continue
    const searched = searchableText(event)
    if (searched === undefined) continue
    if (needles.some((needle) => searched.includes(needle))) count++
  }
  return count
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
  if (report.folds.length === 0) {
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
