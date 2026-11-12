/**
 * dsh-context-fold — stage-boundary folding of completed tool results.
 *
 * Completed-stage tool output leaves the re-sent surface and stays one hop
 * away: the inline conclusion remains, the full original goes to the spill
 * store, and a batch roster chains siblings together. Every decision is a pure
 * function of the session log plus configuration — no model call, ever.
 *
 * Evaluation points (design §6.1):
 * - `agent/pre-step` — fires once per step and carries `turn` and `step`, so the
 *   age branch can fire inside one long turn.
 * - `agent/turn-stopping` — fires once per turn, after the last step.
 *
 * Both handlers run the same idempotent evaluation. A fold already applied is
 * not re-applied: the replacement leaves the surface it was read from, and the
 * fold marker makes "already folded" visible in the text itself.
 *
 * @module dsh-context-fold
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { Config, resolveConfig, type ContextFoldConfig } from './config.ts'
import { renderReport, reportOf } from './measure.ts'
import type { FoldBatch } from './plan.ts'
import { foldBatch, planFor, type FoldPassResult } from './session.ts'

export { Config, resolveConfig, DEFAULT_CONFIG } from './config.ts'
export type { ContextFoldConfig } from './config.ts'
export { FOLD_MARKER, isFoldedText } from './format.ts'
export { conclude, codePointLength, isFoldableContent, parseSpillNotice, textOf } from './rules.ts'
export { planFolds } from './plan.ts'
export type { FoldBatch, FoldDecision, FoldPlan, NodeSnapshot, SkippedNode } from './plan.ts'
export type { FoldFacts } from './rules.ts'
export { planFor, snapshotInput } from './session.ts'
export type { FoldPassResult, FoldedNodeRecord, FoldFailure } from './session.ts'
export { reportOf, renderReport } from './measure.ts'
export type { FoldRecord, FoldReport } from './measure.ts'

/** Cordis plugin identity. */
export const name = 'context-fold'

/** The plugin needs a token meter; without a spill store it no-ops with a warning (design §6.5). */
export const inject = ['tokenMeter']

/** Per-session pass guard: one fold pass at a time, and the boundary it last evaluated. */
interface SessionState {
  /** `${turn}:${step}:${contentGeneration}` of the last evaluation. */
  boundary: string
  /** Whether a pass is currently running. */
  running: boolean
}

/**
 * Mount the fold policy.
 *
 * @param ctx - plugin context.
 * @param rawConfig - configuration from the settings row.
 */
export function apply(ctx: Context, rawConfig: Partial<ContextFoldConfig> = {}): void {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info('context-fold: disabled by configuration')
    return
  }
  const states = new Map<string, SessionState>()
  let warnedMissingSpill = false
  let warnedMissingMeter = false

  /** Run one idempotent evaluation for an agent at a boundary. */
  async function evaluate(agent: Agent, currentTurn: number, currentStep: number): Promise<FoldPassResult | undefined> {
    const session = agent.session
    const sessionId = session.header.id
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { boundary: '', running: false }
      states.set(sessionId, state)
    }
    const boundary = `${currentTurn}:${currentStep}:${session.surface.contentGeneration}`
    if (state.running || state.boundary === boundary) return undefined
    state.running = true
    state.boundary = boundary
    try {
      const spillStore = ctx.get('spillStore') as SpillStore | undefined
      if (spillStore === undefined) {
        if (!warnedMissingSpill) {
          warnedMissingSpill = true
          ctx.logger.warn('context-fold: no ctx.spillStore backend is loaded; folding is a no-op')
        }
        return undefined
      }
      const tokenMeter = ctx.get('tokenMeter') as TokenMeter | undefined
      if (tokenMeter === undefined) {
        if (!warnedMissingMeter) {
          warnedMissingMeter = true
          ctx.logger.warn('context-fold: no ctx.tokenMeter service; folding is a no-op')
        }
        return undefined
      }
      const decision = planFor(session, currentTurn, currentStep, config)
      if (config.dryRun) {
        ctx.logger.info(describeDecision('dryRun: would fold', decision, config))
        return { decision, folded: [], failed: [], charsRemoved: 0 }
      }
      if (decision.batches.length === 0) return { decision, folded: [], failed: [], charsRemoved: 0 }
      const folded = []
      const failed = []
      const host = {
        session,
        spillStore,
        config,
        estimateMessage: (message: Parameters<TokenMeter['estimateMessage']>[0]) => tokenMeter.estimateMessage(message),
      }
      for (const batch of decision.batches as readonly FoldBatch[]) {
        const result = await foldBatch(host, batch)
        folded.push(...result.folded)
        failed.push(...result.failed)
      }
      const charsRemoved = folded.reduce((total, fold) => total + (fold.charsBefore - fold.charsAfter), 0)
      if (folded.length > 0 || failed.length > 0) {
        ctx.logger.info(`context-fold: folded ${folded.length} node(s), removed ${charsRemoved} chars, ${failed.length} failure(s)`)
      }
      return { decision, folded, failed, charsRemoved }
    } catch (error) {
      // Nothing was mitigated this boundary; clear it so the next step may retry.
      state.boundary = ''
      ctx.logger.warn(`context-fold: evaluation failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      state.running = false
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    await evaluate(payload.agent, payload.turn, payload.step)
    return decision
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    await evaluate(payload.agent, payload.turn, latestStep(payload.agent.session))
  })

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'context-fold',
      description: 'Report what dsh-context-fold has folded in this session, and how often the folded content was read again.',
      handler: (invocation) => ({ kind: 'success', text: renderReport(reportOf(invocation.agent.session), config.dryRun) }),
    })
  })

  ctx.on('session/disposed', (session) => {
    states.delete(session.header.id)
  })

  if (ctx.get('spillStore') === undefined) {
    ctx.logger.warn('context-fold: no ctx.spillStore backend at mount; folding stays inert until one is loaded')
  }
  ctx.logger.info(
    `context-fold: enabled (minFoldChars ${config.minFoldChars}, minBatchChars ${config.minBatchChars}, keepRecentSteps ${config.keepRecentSteps}, staleSteps ${config.staleSteps}, batchSpanSteps ${config.batchSpanSteps}, dryRun ${config.dryRun})`,
  )
}

/**
 * Highest step number recorded in a session log, used at the turn boundary.
 *
 * @param session - session to scan.
 * @returns the highest step, or 0 for a session without steps.
 */
function latestStep(session: Session): number {
  let step = 0
  for (const event of session.snapshotEvents()) {
    const value = stepOf(event)
    if (value !== undefined && value > step) step = value
  }
  return step
}

/** The step of any step-carrying event. */
function stepOf(event: { type: string; data: unknown }): number | undefined {
  if (event.type !== 'tool/result' && event.type !== 'tool/call' && event.type !== 'assistant/message') return undefined
  const data = event.data as { step?: unknown }
  return typeof data.step === 'number' ? data.step : undefined
}

/**
 * One-line summary of a decision for the log during `dryRun`.
 *
 * @param prefix - leading phrase.
 * @param decision - the decision to describe.
 * @param config - resolved configuration.
 * @returns a single log line.
 */
export function describeDecision(
  prefix: string,
  decision: { batches: readonly { members: readonly unknown[] }[]; candidateChars: number; skipped: readonly { reason: string }[] },
  config: ContextFoldConfig,
): string {
  const nodes = decision.batches.reduce((total, batch) => total + batch.members.length, 0)
  const reasons = new Map<string, number>()
  for (const skip of decision.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1)
  const detail = [...reasons].map(([reason, count]) => `${reason}=${count}`).join(' ')
  return `context-fold: ${prefix} ${nodes} node(s) in ${decision.batches.length} batch(es); candidate chars ${decision.candidateChars}; skipped ${detail === '' ? 'none' : detail}; thresholds minFoldChars=${config.minFoldChars} minBatchChars=${config.minBatchChars}`
}

export default { name, inject, Config, apply }
