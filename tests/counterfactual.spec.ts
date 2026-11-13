import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRICE_MODEL,
  counterfactualOf,
  promptCostOf,
  usageOf,
  type FoldedSaving,
  type StepUsage,
} from '../src/counterfactual.ts'

const fold = (overrides: Partial<FoldedSaving> = {}): FoldedSaving => ({
  seq: 1,
  kind: 'tool-result',
  charsBefore: 40000,
  charsAfter: 200,
  tokensBefore: 10000,
  tokensAfter: 50,
  ...overrides,
})

const step = (overrides: Partial<StepUsage> = {}): StepUsage => ({
  turn: 1,
  step: 1,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  seq: 1,
  ...overrides,
})

describe('usageOf', () => {
  it('reads usage off assistant messages and skips steps without it', () => {
    const steps = usageOf([
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 90 } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, step: 2 } },
      { type: 'tool/result', seq: 3, data: {} },
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ input: 10, cacheRead: 90 })
  })

  it('returns nothing for a session with no usage, which is the common case here', () => {
    expect(usageOf([{ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1 } }])).toHaveLength(0)
  })
})

describe('promptCostOf', () => {
  it('prices a cached token far below an uncached one', () => {
    const cached = promptCostOf(step({ cacheRead: 1000 }), DEFAULT_PRICE_MODEL)
    const fresh = promptCostOf(step({ input: 1000 }), DEFAULT_PRICE_MODEL)
    expect(cached).toBeLessThan(fresh)
    expect(cached).toBeCloseTo(fresh * 0.1, 5)
  })
})

describe('counterfactualOf', () => {
  it('reports no real usage when the session logged none', () => {
    const result = counterfactualOf([fold()], [])
    expect(result.hasRealUsage).toBe(false)
    expect(result.tokensSavedPerStep).toBe(9950)
    expect(result.assumptions[0]).toContain('no provider usage')
  })

  it('prices savings at the observed cache-read share, not the uncached rate', () => {
    // A warm session: 100k prompt tokens, 95k of them cache reads.
    const warm = Array.from({ length: 10 }, (_, index) =>
      step({ step: index + 1, input: 5000, cacheRead: 95000 }))
    const result = counterfactualOf([fold()], warm)
    expect(result.cacheReadShare).toBeCloseTo(0.95, 5)
    // Saved tokens would have been ~95% cached, so the saving is far below the
    // naive 9950 x 10 uncached-token count.
    const naive = result.tokensSavedPerStep * result.remainingSteps
    expect(result.grossSaving).toBeLessThan(naive * 0.5)
    expect(result.grossSaving).toBeGreaterThan(naive * 0.1)
  })

  it('charges one prefix invalidation per fold', () => {
    const steps = Array.from({ length: 10 }, (_, index) => step({ step: index + 1, input: 1000, cacheRead: 1000 }))
    const withFolds = counterfactualOf([fold()], steps, { foldSteps: [1, 2] })
    expect(withFolds.invalidationCost).toBeGreaterThan(0)
    const without = counterfactualOf([fold()], steps)
    expect(without.invalidationCost).toBe(0)
  })

  it('can show a net loss when the fold lands too late to repay its invalidation', () => {
    // One fold, one step left, a huge prompt: the invalidation dwarfs the saving.
    const steps = [step({ step: 1, input: 0, cacheRead: 200000 }), step({ step: 2, input: 0, cacheRead: 200000 })]
    const late = counterfactualOf([fold()], steps, { foldSteps: [2] })
    expect(late.remainingSteps).toBe(0)
    expect(late.grossSaving).toBe(0)
    expect(late.netSaving).toBeLessThan(0)
  })

  it('can show a net win when the fold lands early in a long session', () => {
    const steps = Array.from({ length: 60 }, (_, index) => step({ step: index + 1, input: 2000, cacheRead: 20000 }))
    const early = counterfactualOf([fold()], steps, { foldSteps: [1] })
    expect(early.netSaving).toBeGreaterThan(0)
  })

  it('states every assumption it relies on', () => {
    const result = counterfactualOf([fold()], [step({ input: 100, cacheRead: 900 })], { foldSteps: [1] })
    expect(result.assumptions.length).toBeGreaterThanOrEqual(3)
    expect(result.assumptions.join(' ')).toContain('invalidation')
  })

  it('sums differently-kinded folds together', () => {
    const result = counterfactualOf(
      [fold({ kind: 'tool-result', tokensBefore: 1000, tokensAfter: 10 }), fold({ seq: 2, kind: 'reasoning', tokensBefore: 500, tokensAfter: 50 })],
      [],
    )
    expect(result.tokensNow).toBe(60)
    expect(result.tokensIfUnfolded).toBe(1500)
    expect(result.tokensSavedPerStep).toBe(1440)
  })
})
