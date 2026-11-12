/**
 * Folded-node text format (design §6.4).
 *
 * All fold bookkeeping lives inside the text: the host asserts that a
 * `tool/result` surface replacement may change only `content`, so there is no
 * field for "folded at step N" and no out-of-band state. The marker prefix is
 * the idempotency test and must never appear at the start of an unfolded
 * result.
 *
 * The roster lives once per batch — on the batch head — and every sibling
 * carries a one-line back-reference, so per-node overhead stays O(1) and total
 * batch overhead stays O(n) rather than O(n²).
 *
 * @module dsh-context-fold/format
 */
import type { FoldPlan } from './plan.ts'

/** Fixed prefix identifying a folded node. A `startsWith` test is the idempotency check. */
export const FOLD_MARKER = '[context-fold]'

/**
 * Whether already-folded content is being inspected.
 *
 * @param text - current model-visible text of a node.
 * @returns true when the node is a fold this plugin produced.
 */
export function isFoldedText(text: string): boolean {
  return text.startsWith(FOLD_MARKER)
}

/** One roster entry: a sibling's tool, call id, and locator. */
export interface RosterEntry {
  /** Tool name. */
  toolName: string
  /** The sibling's own call id. */
  callId: string
  /** Spill locator holding the sibling's full original. */
  locator: string
}

/**
 * Render one folded node.
 *
 * @param plan - the fold being rendered.
 * @param locator - where this node's full original now lives.
 * @param roster - the batch's other members with their locators (used on the head only).
 * @param total - total member count of the batch, including the head.
 * @returns the replacement content text.
 */
export function renderFoldedText(plan: FoldPlan, locator: string, roster: readonly RosterEntry[], total: number): string {
  const header = `${FOLD_MARKER} [tool: ${plan.facts.toolName}] ${formatNumber(plan.facts.chars)} chars folded at turn ${plan.turn}, step ${plan.step}.${plan.head ? ' (batch head)' : ''}`
  const lines = [header, `Conclusion: ${plan.conclusion}`, `Full result: ${locator}`]
  if (plan.head && roster.length > 0) {
    lines.push(`Same batch (${roster.length} more):`)
    for (const entry of roster) lines.push(`  - ${entry.toolName} (callId ${entry.callId}): ${entry.locator}`)
  }
  if (!plan.head && plan.headCallId !== undefined) {
    const others = Math.max(0, total - 1)
    lines.push(`Batch head: ${plan.headCallId} (callId) — lists ${others} more result${others === 1 ? '' : 's'} from this batch.`)
  }
  return lines.join('\n')
}

/** Group digits for readability. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}
