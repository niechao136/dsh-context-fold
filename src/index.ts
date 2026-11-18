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
import { settingsOpsOf } from './settings-page.ts'
import type { FoldBatch } from './plan.ts'
import { gateFoldPool, type FoldGate } from './plan.ts'
import { planReasoningFolds, reasoningCandidates, reasoningProjection, recordReasoningFolds } from './reasoning.ts'
import { registerRoutes, type ConnectionRoutes } from './routes.ts'
import { evaluateSession, foldBatch, type FoldPassResult } from './session.ts'
import {
  planArgFolds,
  planTurnArchives,
  recordTurnFolds,
  turnProjection,
} from './turns.ts'

export { Config, resolveConfig, DEFAULT_CONFIG } from './config.ts'
export type { ContextFoldConfig } from './config.ts'
export { FOLD_MARKER, isFoldedText } from './format.ts'
export {
  REASONING_EVENT,
  REASONING_MARKER,
  foldReasoningText,
  isFoldedReasoning,
  isToolCallTurn,
  planReasoningFolds,
  projectReasoning,
  reasoningCandidates,
  reasoningProjection,
  recordReasoningFolds,
} from './reasoning.ts'
export type { ReasoningCandidate, ReasoningFoldData, ReasoningPlan, ReasoningTarget } from './reasoning.ts'
export { conclude, codePointLength, isFoldableContent, parseSpillNotice, textOf } from './rules.ts'
export { planFolds } from './plan.ts'
export type { FoldBatch, FoldDecision, FoldPlan, NodeSnapshot, SkippedNode } from './plan.ts'
export type { FoldFacts } from './rules.ts'
export { evaluateSession, planFor, snapshotInput } from './session.ts'
export type { FoldPassResult, FoldedNodeRecord, FoldFailure } from './session.ts'
export { reportOf, renderReport } from './measure.ts'
export type { FoldRecord, FoldReport } from './measure.ts'
export {
  ARG_MARKER,
  TURN_ARCHIVED,
  TURN_EVENT,
  TURN_POINTER,
  isArchivedTurn,
  planArgFolds,
  planTurnArchives,
  projectTurnMessage,
  recordTurnFolds,
  turnProjection,
  writeTargetPath,
} from './turns.ts'
export type { ArgFoldTarget, TurnArchiveTarget, TurnFoldData, TurnPlan, TurnPlanResult } from './turns.ts'

/** Cordis plugin identity. */
export const name = 'context-fold'

/** The plugin needs a token meter; without a spill store it no-ops with a warning (design §6.5). */
export const inject = ['tokenMeter']

/**
 * How often `evaluate` may re-read live settings, in ms.
 *
 * The settings page writes through the host's remote settings service, which
 * does not reload this plugin's fiber, so a saved change only takes effect if
 * the plugin re-reads it. One host round-trip per minute is enough: fold
 * thresholds are not latency-sensitive, and the throttle keeps a busy session
 * from calling `describe()` on every step.
 */
const CONFIG_REFRESH_MS = 60_000

/**
 * Pick this plugin's namespace row out of a settings document.
 *
 * The auto-rendered server namespace name is host-defined, so match by content:
 * the row carrying `keepRecentTurns`. No other plugin's namespace would hold it.
 *
 * @param namespaces - rows from `describe()`.
 * @returns the live value map, or undefined when absent.
 */
export function liveConfigOf(
  namespaces: readonly { value?: Record<string, unknown> }[] | undefined,
): Record<string, unknown> | undefined {
  if (namespaces === undefined) return undefined
  for (const row of namespaces) {
    const value = row.value
    if (value !== undefined && 'keepRecentTurns' in value) return value
  }
  return undefined
}

/** Per-session pass guard: one fold pass at a time, and the boundary it last evaluated. */
interface SessionState {
  /** `${turn}:${step}:${contentGeneration}` of the last evaluation. */
  boundary: string
  /** Whether a pass is currently running. */
  running: boolean
}

/**
 * Give the plugin a page in the settings UI.
 *
 * The Settings service builds a page for every active plugin whose config schema
 * exposes at least one `.volatile()` field (see `Config`), so this only has to
 * declare the page policy. The policy names the plugin's own fiber as the owner,
 * which is what stops a reload from stacking a second page.
 *
 * `configure` throws when called twice for the same fiber, so a duplicate is
 * caught and reported rather than taking `apply()` down with it. Failing to get a
 * page is not a reason to stop folding.
 *
 * @param ctx - plugin context.
 */
function declareSettingsPage(ctx: Context): void {
  ctx.inject(['settings'], (scope) => {
    const settings = (scope as unknown as { settings?: { configure(presentation: { auto?: boolean }): () => void } }).settings
    if (settings === undefined || typeof settings.configure !== 'function') {
      ctx.logger.warn('context-fold: no ctx.settings service; the configuration page is unavailable')
      return
    }
    try {
      // `auto: true` asks the host to render a page from the config schema.
      const dispose = settings.configure({ auto: true })
      if (typeof dispose === 'function') ctx.effect(() => dispose, 'context-fold: settings page')
      ctx.logger.info('context-fold: configuration page registered')
    } catch (error) {
      ctx.logger.warn(
        `context-fold: configuration page not registered: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/**
 * Mount the fold policy.
 *
 * @param ctx - plugin context.
 * @param rawConfig - configuration from the settings row.
 */
export function apply(ctx: Context, rawConfig: Partial<ContextFoldConfig> = {}): void {
  // Live config: the settings page writes through the host's remote settings
  // service, which does not reload this plugin's fiber. Re-reading it at each
  // evaluation is what makes a saved change take effect without a restart.
  let config = resolveConfig(rawConfig)
  let configReadAt = 0

  // The settings page must exist even when folding is switched off — otherwise
  // turning `enabled` back on would require editing the profile file by hand,
  // which is precisely the situation the page exists to avoid. It is also the
  // only way the other knobs are discoverable at all.
  declareSettingsPage(ctx)

  if (!config.enabled) {
    ctx.logger.info('context-fold: disabled by configuration')
    return
  }
  const states = new Map<string, SessionState>()
  let warnedMissingSpill = false
  let warnedMissingMeter = false

  /**
   * Re-read the live settings and rebase `config` on them.
   *
   * Throttled: `describe()` is a host round-trip, and a fold decision does not
   * need it on every step. Failures are swallowed — a stale config is far better
   * than a fold pass that throws mid-session.
   *
   * @param force - bypass the throttle (used once at first evaluation).
   */
  async function refreshConfig(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - configReadAt < CONFIG_REFRESH_MS) return
    configReadAt = now
    const ops = settingsOpsOf(ctx as never)
    if (ops === undefined) return
    try {
      const described = await ops.describe()
      if (!described.ok) return
      const live = liveConfigOf(described.value?.namespaces)
      if (live !== undefined) config = resolveConfig({ ...rawConfig, ...live })
    } catch {
      // Keep the last known-good config.
    }
  }

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
      // Pick up a settings change made since the last evaluation, so the user
      // does not have to restart the app for a new threshold to apply.
      await refreshConfig()
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
      const { decision, currentGlobalStep } = evaluateSession(session, currentTurn, currentStep, config)
      const reasoningPlans = config.foldReasoning
        ? planReasoningFolds(reasoningCandidates(session), currentTurn, currentStep, config, currentGlobalStep)
        : []
      const argPlans = planArgFolds(session, config)
      // Only the *count* matters for the gate; the archive itself is written at
      // the very end, after tool results and reasoning have folded, so its
      // snapshot records the compact markers (each carrying its own spill path)
      // instead of duplicating the full originals.
      const turnPlans = planTurnArchives(session, currentTurn, config)

      // A turn crossing the archive boundary invalidates the cache regardless:
      // fold everything pending now (arg folds, reasoning, tool results) and
      // skip the char gate. One invalidation, maximal work.
      const archiving = turnPlans.length > 0
      const argChars = argPlans.reduce((total, plan) => total + plan.chars.reduce((a, b) => a + b, 0), 0)
      const reasoningChars = reasoningPlans.reduce((total, plan) => total + plan.charsRemoved, 0)
      const gate = gateFoldPool(decision.toolChars, reasoningChars + argChars, config)
      const shouldFold = archiving || gate.fold
      if (config.dryRun) {
        ctx.logger.info(describeDecision('dryRun: would fold', decision, gate, config))
        if (archiving) ctx.logger.info(`context-fold: dryRun: would archive ${turnPlans.length} turn(s), fold ${argPlans.length} arg group(s)`)
        return { decision, folded: [], failed: [], charsRemoved: 0 }
      }
      if (!shouldFold) {
        // Below the shared threshold nothing folds — reasoning and args included.
        // Doing half the work still invalidates the whole prefix.
        return { decision, folded: [], failed: [], charsRemoved: 0 }
      }
      // Reasoning folding is recorded even when no tool batch qualifies: it is a
      // pure projection with no spill write and no surface rewrite, so it has no
      // dependency on the tool-fold decision.
      if (reasoningPlans.length > 0) {
        try {
          // Spill the originals so the folded marker carries a real recovery
          // path; without it the model is told detail is missing and given no
          // way to fetch it (design §12.7).
          await recordReasoningFolds(session, reasoningPlans, spillStore)
          const chars = reasoningPlans.reduce((total, plan) => total + plan.charsRemoved, 0)
          ctx.logger.info(`context-fold: folded reasoning in ${reasoningPlans.length} message(s), removed ${chars} chars`)
        } catch (error) {
          ctx.logger.warn(`context-fold: reasoning fold failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const host = {
        session,
        spillStore,
        config,
        estimateMessage: (message: Parameters<TokenMeter['estimateMessage']>[0]) => tokenMeter.estimateMessage(message),
      }
      const folded = []
      const failed = []
      for (const batch of decision.batches as readonly FoldBatch[]) {
        const result = await foldBatch(host, batch)
        folded.push(...result.folded)
        failed.push(...result.failed)
      }
      const charsRemoved = folded.reduce((total, fold) => total + (fold.charsBefore - fold.charsAfter), 0)
      if (folded.length > 0 || failed.length > 0) {
        ctx.logger.info(`context-fold: folded ${folded.length} node(s), removed ${charsRemoved} chars, ${failed.length} failure(s)`)
      }

      // Turn archive and argument folding run LAST, after tool results and
      // reasoning have folded. Two reasons:
      //   1. The per-turn snapshot then records the compact markers (each with a
      //      spill path to the original) rather than duplicating full text, so
      //      an archived turn's detail is one hop away, not two.
      //   2. The panel counts tool-result folds from this pass separately, so
      //      archived turn traffic is never double-counted.
      if (turnPlans.length > 0 || argPlans.length > 0) {
        try {
          const recordSeq = await recordTurnFolds(session, { args: argPlans, turns: turnPlans }, spillStore, config)
          if (recordSeq !== undefined) {
            ctx.logger.info(`context-fold: archived ${turnPlans.length} turn(s), folded ${argPlans.length} arg group(s)`)
          }
        } catch (error) {
          ctx.logger.warn(`context-fold: turn archive failed: ${error instanceof Error ? error.message : String(error)}`)
        }
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

  // Register the reasoning projection unconditionally, including when
  // `foldReasoning: false`.
  //
  // Verified behaviour, not assumed: an unregistered decision event is inert
  // rather than fatal — `deriveMessages()` falls back to the original, unfolded
  // reasoning (measured: 4000 chars instead of 332). So the log always stays
  // readable. Registering unconditionally is still right because the flag should
  // govern only *new* decisions: a session whose log already carries them keeps
  // the benefit it was already charged for.
  ctx.inject(['sessions'], (scope) => {
    const sessions = (scope as unknown as { sessions?: { registerMessageProjection(projection: unknown): () => Promise<void> } }).sessions
    if (sessions === undefined || typeof sessions.registerMessageProjection !== 'function') {
      ctx.logger.warn('context-fold: no ctx.sessions.registerMessageProjection; reasoning/turn folds stay inactive')
      return
    }
    try {
      // The host types constrain a projection to `keyof SessionEventMap`, which
      // cannot express a plugin-record carrier; the runtime accepts any event
      // type (see the reasoning module header).
      sessions.registerMessageProjection(reasoningProjection)
      sessions.registerMessageProjection(turnProjection)
      // Say so out loud. A missing projection is invisible from the outside:
      // `deriveEventMessage` ignores a plugin event it has no projection for, so
      // records are written, the tab counts them, and nothing is folded. Without
      // this line the only symptom is "folding looks like it does nothing" —
      // exactly the failure that took a full log dig to find once.
      ctx.logger.info('context-fold: reasoning + turn projections registered')
    } catch (error) {
      // The host allows exactly one definition per event type, and `apply()` can
      // run twice (a reload, or two rows naming the same package). A duplicate is
      // not a mount failure: the first registration is already live and correct,
      // so warn instead of throwing out of `apply()`.
      ctx.logger.warn(`context-fold: reasoning projection not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // The conversation tab reads its data from these read-only routes: fold
  // decisions are durable plugin records and originals live in the log, neither
  // reachable from the browser. Registration is an effect so the routes go away
  // with the plugin.
  ctx.inject(['connection'], (scope) => {
    const connection = (scope as unknown as { connection?: ConnectionRoutes }).connection
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      ctx.logger.warn('context-fold: no ctx.connection.fetch.register; the conversation tab has no data source')
      return
    }
    const tokenMeter = ctx.get('tokenMeter') as TokenMeter | undefined
    // `register` returns its own disposer, but the host expects registration to
    // happen inside an effect so an unload cannot leave the routes behind.
    ctx.effect(
      () =>
        registerRoutes(connection, {
          sessionOf: (id) => {
            const sessions = ctx.get('sessions') as { get(id: string): Session | undefined } | undefined
            return sessions?.get(id)
          },
          estimateMessage: (message) => (tokenMeter === undefined ? 0 : tokenMeter.estimateMessage(message)),
          ...(ctx.get('spillStore') === undefined ? {} : { spillStore: ctx.get('spillStore') as SpillStore }),
        }),
      'context-fold: conversation tab routes',
    )
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
 * @param gate - the shared pool gate that accepted or rejected this step.
 * @param config - resolved configuration.
 * @returns a single log line.
 */
export function describeDecision(
  prefix: string,
  decision: { batches: readonly { members: readonly unknown[] }[]; candidateChars: number; skipped: readonly { reason: string }[] },
  gate: FoldGate,
  config: ContextFoldConfig,
): string {
  const nodes = decision.batches.reduce((total, batch) => total + batch.members.length, 0)
  const reasons = new Map<string, number>()
  for (const skip of decision.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1)
  const detail = [...reasons].map(([reason, count]) => `${reason}=${count}`).join(' ')
  const verdict = gate.fold ? 'pass' : 'below threshold'
  return `context-fold: ${prefix} ${nodes} node(s) in ${decision.batches.length} batch(es); tool chars ${gate.toolChars} + reasoning chars ${gate.reasoningChars} = pool ${gate.poolChars} / ${gate.threshold} (${verdict}); skipped ${detail === '' ? 'none' : detail}; thresholds minFoldChars=${config.minFoldChars} minBatchChars=${config.minBatchChars}`
}

export default { name, inject, Config, apply }
