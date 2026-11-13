/**
 * Counterfactual savings estimate (approach A, chosen by the user).
 *
 * ## What this can and cannot be
 *
 * A true before/after comparison is impossible: the "before" session did not
 * run with folding disabled, and we will not re-run it. So this module does not
 * measure a difference — it **replays the token arithmetic** that the provider
 * would have charged.
 *
 * The estimate rests on one real observation and one explicit assumption:
 *
 * - **Observed**: how many tokens each surface node costs (`tokenMeter.measure`
 *   prices every message), and how many tokens the provider actually charged
 *   per step (from `usage`).
 * - **Assumed**: the folded text would have cost the difference, at the same
 *   cache treatment the session actually experienced.
 *
 * ## Why cache treatment is the whole ballgame
 *
 * Naively, saving `N` tokens per step for `S` remaining steps is `N × S`. That
 * is wrong in both directions:
 *
 * 1. **A fold invalidates the prefix from the first shadowed token.** Every
 *    token after it is re-billed at the full rate once, instead of the cached
 *    rate. So the fold has a one-time cost, and whether it pays depends on how
 *    many steps remain — the break-even the design's §3.5 predicted.
 * 2. **Saved tokens would have been re-sent at the *cached* rate**, not the full
 *    rate. On a warm session that is ~10% of list price, so the saving is far
 *    smaller than a naive count suggests.
 *
 * Both are modelled here. Every number states its assumption so the user can
 * judge it rather than trust it.
 *
 * @module dsh-context-fold/counterfactual
 */

/** Relative price of a token by how it was billed. Values are multipliers over the uncached input rate. */
export interface PriceModel {
  /** Fresh, uncached input. */
  uncachedInput: number
  /** Prefix cache hit. */
  cacheRead: number
  /** Prefix cache write. */
  cacheWrite: number
}

/**
 * DeepSeek's published relative pricing, normalised to uncached input = 1.
 *
 * Cache read is ~0.1×, cache write ~1× (a write and a plain read are priced
 * alike), output 4× but output is not affected by folding so it is not modelled.
 * These are *ratios*, so the result can be read as "token-equivalents" without
 * needing a currency.
 */
export const DEFAULT_PRICE_MODEL: Readonly<PriceModel> = Object.freeze({
  uncachedInput: 1,
  cacheRead: 0.1,
  cacheWrite: 1,
})

/** Per-step provider billing observed in the session, if any. */
export interface StepUsage {
  /** Turn the step belongs to. */
  turn: number
  /** Step number. */
  step: number
  /** Uncached input tokens. */
  input: number
  /** Tokens served from the prefix cache. */
  cacheRead: number
  /** Tokens written to the prefix cache. */
  cacheWrite: number
  /** Sequence number of the reporting event, for ordering. */
  seq: number
}

/** One folded node, as it exists on the current surface. */
export interface FoldedSaving {
  /** Surface seq. */
  seq: number
  /** Kind of fold. */
  kind: 'tool-result' | 'reasoning'
  /** Character count before folding. */
  charsBefore: number
  /** Character count after folding. */
  charsAfter: number
  /** Estimated tokens before (heuristic). */
  tokensBefore: number
  /** Estimated tokens after (heuristic). */
  tokensAfter: number
}

/** The counterfactual comparison for one session. */
export interface Counterfactual {
  /** Estimated tokens the folded content still occupies. */
  tokensNow: number
  /** Estimated tokens it would have occupied unfolded. */
  tokensIfUnfolded: number
  /** `tokensIfUnfolded - tokensNow` — the per-step prompt reduction. */
  tokensSavedPerStep: number
  /** Steps that still re-send the folded nodes (the ones whose saving is banked). */
  remainingSteps: number
  /** GROSS saving in price units if every remaining step benefited and nothing was invalidated. */
  grossSaving: number
  /** One-time cost of invalidating the prefix at each fold, in the same units. */
  invalidationCost: number
  /** `grossSaving - invalidationCost`. Negative means folding has cost more than it saved so far. */
  netSaving: number
  /** Prompt price units actually paid across the session, from real usage. */
  actualPromptCost: number
  /** The same step count with the folded content charged instead, from real usage. */
  counterfactualPromptCost: number
  /** Whether the session reported provider usage at all; `false` means every figure above is heuristic. */
  hasRealUsage: boolean
  /** Per-step observed cache-read share, 0..1; undefined when no usage was reported. */
  cacheReadShare?: number
  /** The price model used. */
  priceModel: PriceModel
  /** Assumptions, in the order they matter. */
  assumptions: readonly string[]
}

/**
 * Extract per-step provider usage from a log.
 *
 * @param events - session events in seq order.
 * @returns one record per step that reported usage, in seq order.
 */
export function usageOf(events: readonly { type: string; seq: number; data: unknown }[]): StepUsage[] {
  const steps: StepUsage[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { turn?: number; step?: number; usage?: Record<string, unknown> } | null
    const usage = data?.usage
    if (usage === undefined || usage === null) continue
    const read = (key: string): number => {
      const value = usage[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    steps.push({
      turn: typeof data?.turn === 'number' ? data.turn : 0,
      step: typeof data?.step === 'number' ? data.step : 0,
      input: read('inputTokens'),
      cacheRead: read('cacheReadTokens'),
      cacheWrite: read('cacheWriteTokens'),
      seq: event.seq,
    })
  }
  return steps
}

/**
 * Price one step's prompt under the model.
 *
 * @param usage - the step's observed billing.
 * @param price - price model.
 * @returns prompt cost in price units (uncached-input-equivalents).
 */
export function promptCostOf(usage: StepUsage, price: PriceModel): number {
  return usage.input * price.uncachedInput + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite
}

/** Total tokens one step sent. */
function promptTokensOf(usage: StepUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

/**
 * Build the counterfactual comparison.
 *
 * @param folds - folded nodes present on the current surface.
 * @param steps - observed per-step usage, in seq order.
 * @param options - fold step numbers per fold, for the invalidation window, plus the price model.
 * @returns the comparison, with every assumption stated.
 */
export function counterfactualOf(
  folds: readonly FoldedSaving[],
  steps: readonly StepUsage[],
  options: { price?: PriceModel; foldSteps?: readonly number[] } = {},
): Counterfactual {
  const price = options.price ?? DEFAULT_PRICE_MODEL
  const tokensNow = folds.reduce((total, fold) => total + fold.tokensAfter, 0)
  const tokensIfUnfolded = folds.reduce((total, fold) => total + fold.tokensBefore, 0)
  const tokensSavedPerStep = Math.max(0, tokensIfUnfolded - tokensNow)

  const hasRealUsage = steps.length > 0
  const totalPromptTokens = steps.reduce((total, step) => total + promptTokensOf(step), 0)
  const totalCacheRead = steps.reduce((total, step) => total + step.cacheRead, 0)
  const actualPromptCost = steps.reduce((total, step) => total + promptCostOf(step, price), 0)

  // A fold is only "paid for" on the steps after it landed. Without per-fold
  // step numbers we conservatively credit every observed step with the saving,
  // and say so.
  const foldSteps = options.foldSteps
  const remainingSteps = foldSteps === undefined || foldSteps.length === 0
    ? steps.length
    : steps.filter((step) => foldSteps.some((foldStep) => step.step > foldStep)).length

  // Saved tokens would have been billed at whatever rate the session actually
  // paid: mostly cache reads on a warm prefix. Using the observed share keeps
  // the estimate anchored to this session instead of an idealised 0.1.
  const cacheReadShare = totalPromptTokens === 0 ? undefined : totalCacheRead / totalPromptTokens
  const savedTokenRate = cacheReadShare === undefined
    ? price.uncachedInput
    : cacheReadShare * price.cacheRead + (1 - cacheReadShare) * price.uncachedInput

  const grossSaving = tokensSavedPerStep * remainingSteps * savedTokenRate

  // One invalidation per fold: every token of the prompt after the fold point is
  // re-billed from cache-read to uncached once. Modelled per fold over the
  // prompt size observed at that step.
  let invalidationCost = 0
  if (foldSteps !== undefined) {
    for (const foldStep of foldSteps) {
      const at = steps.find((step) => step.step >= foldStep)
      if (at === undefined) continue
      const prompt = promptTokensOf(at)
      invalidationCost += prompt * (price.uncachedInput - price.cacheRead)
    }
  }

  // The counterfactual keeps every observed token but charges the folded tokens
  // as if still present, at the same cache treatment.
  const counterfactualPromptCost = actualPromptCost + tokensSavedPerStep * remainingSteps * savedTokenRate

  const assumptions: string[] = []
  assumptions.push(
    hasRealUsage
      ? `Prices are DeepSeek ratios (cache read ${price.cacheRead}×, write ${price.cacheWrite}×, uncached ${price.uncachedInput}×), applied to this session's observed usage.`
      : 'This session reported no provider usage, so even the "actual" figures are heuristic token counts, not billed amounts.',
  )
  if (cacheReadShare !== undefined) {
    assumptions.push(`Saved tokens are priced at this session's observed cache-read share (${(cacheReadShare * 100).toFixed(1)}%), not at the uncached rate.`)
  }
  if (foldSteps === undefined || foldSteps.length === 0) {
    assumptions.push('Fold step numbers were unavailable, so every observed step is credited with the saving. Treat the figure as an upper bound.')
  } else {
    assumptions.push(`Each fold is charged one prefix invalidation: the whole prompt after it re-billed from cache-read to uncached once.`)
  }
  assumptions.push('The counterfactual assumes the same number of steps and the same cache behaviour as the real session — a folded prompt might have hit cache differently.')

  return {
    tokensNow,
    tokensIfUnfolded,
    tokensSavedPerStep,
    remainingSteps,
    grossSaving,
    invalidationCost,
    netSaving: grossSaving - invalidationCost,
    actualPromptCost,
    counterfactualPromptCost,
    hasRealUsage,
    ...(cacheReadShare === undefined ? {} : { cacheReadShare }),
    priceModel: price,
    assumptions,
  }
}
