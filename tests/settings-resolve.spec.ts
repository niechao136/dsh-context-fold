import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

/**
 * Regression: the host hands `apply()` the *parsed* schema output, and because
 * every field is `.volatile()` that output is a reference per field
 * (`{ get(): T }`) rather than a plain value. `resolveConfig` must unwrap those.
 *
 * The failure this pins was real and visible in the plugin inventory as
 * `context-fold: minFoldChars ([object Object]) must be an integer of at least
 * 300` — the plugin was listed as broken and never started.
 */
describe('resolveConfig against real schema output', () => {
  it('unwraps the volatile references the host passes in', () => {
    // Exactly what the Loader hands `apply()`: the schema's parsed output.
    const fromSchema = Config({}) as unknown as Partial<Record<string, unknown>>
    const resolved = resolveConfig(fromSchema as never)
    expect(resolved.minFoldChars).toBe(1000)
    expect(resolved.minBatchChars).toBe(16000)
    expect(resolved.keepRecentSteps).toBe(6)
    expect(resolved.staleSteps).toBe(12)
    expect(resolved.batchSpanSteps).toBe(20)
    expect(resolved.foldReasoning).toBe(true)
    expect(resolved.foldPlainTurnReasoning).toBe(false)
    expect(resolved.enabled).toBe(true)
    expect(resolved.dryRun).toBe(false)
  })

  it('honours an override supplied through the schema', () => {
    const fromSchema = Config({ minFoldChars: 500, dryRun: true } as never) as unknown as Partial<Record<string, unknown>>
    const resolved = resolveConfig(fromSchema as never)
    expect(resolved.minFoldChars).toBe(500)
    expect(resolved.dryRun).toBe(true)
  })

  it('still accepts plain values, as tests and profile patches supply them', () => {
    const resolved = resolveConfig({ minFoldChars: 700, foldReasoning: false })
    expect(resolved.minFoldChars).toBe(700)
    expect(resolved.foldReasoning).toBe(false)
  })

  it('fills defaults when a field is absent from the input', () => {
    const resolved = resolveConfig({})
    expect(resolved.minFoldChars).toBe(1000)
    expect(resolved.staleSteps).toBe(12)
  })
})
