import { describe, expect, it } from 'vitest'
import { resolveConfig, DEFAULT_CONFIG } from '../src/config.ts'

describe('resolveConfig', () => {
  it('returns the documented defaults', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({}).minFoldChars).toBe(1000)
    expect(resolveConfig({}).minBatchChars).toBe(8000)
    expect(resolveConfig({}).keepRecentSteps).toBe(6)
    expect(resolveConfig({}).staleSteps).toBe(12)
    expect(resolveConfig({}).batchSpanSteps).toBe(20)
    expect(resolveConfig({}).dryRun).toBe(false)
  })

  it('accepts partial overrides and keeps the rest', () => {
    const config = resolveConfig({ minFoldChars: 500 })
    expect(config.minFoldChars).toBe(500)
    expect(config.minBatchChars).toBe(8000)
  })

  it('freezes the result', () => {
    const config = resolveConfig()
    expect(Object.isFrozen(config)).toBe(true)
    expect(() => {
      ;(config as { minFoldChars: number }).minFoldChars = 1
    }).toThrow()
  })

  it('rejects minFoldChars below the negative-return floor', () => {
    expect(() => resolveConfig({ minFoldChars: 299 })).toThrow(/minFoldChars/)
  })

  it('rejects non-integer and negative budgets', () => {
    expect(() => resolveConfig({ minBatchChars: 1.5 })).toThrow(/minBatchChars/)
    expect(() => resolveConfig({ keepRecentSteps: -1 })).toThrow(/keepRecentSteps/)
    expect(() => resolveConfig({ staleSteps: 0 })).toThrow(/staleSteps/)
    expect(() => resolveConfig({ batchSpanSteps: 0 })).toThrow(/batchSpanSteps/)
  })

  it('rejects NaN', () => {
    expect(() => resolveConfig({ minFoldChars: Number.NaN })).toThrow(/minFoldChars/)
  })
})
