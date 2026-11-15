/**
 * Fold-boundary probes.
 *
 * The marker line, the retained head and the omission note all cost characters,
 * so the risk is an input just above the gate where the marker plus the note
 * could outweigh the text. These probes pin the actual margin rather than
 * trusting the guard.
 *
 * The gate moved from 1200 to 900. Measured sessions have a ~510-character
 * median reasoning block, so 1200 skipped the bulk of the available saving while
 * 900 still folds roughly two thirds of the block away (see `MIN_REASONING_CHARS`
 * for the measured curve). These probes pin the current value, and fail loudly if
 * someone changes the constant without re-checking profitability.
 */
import { describe, expect, it } from 'vitest'
import { foldReasoningText } from '../src/reasoning.ts'
import { codePointLength } from '../src/rules.ts'

const GATE = 900

describe('fold boundary', () => {
  it('never produces a longer result at the threshold', () => {
    for (const size of [GATE - 1, GATE, GATE + 1, 700, 1200, 2000, 5000]) {
      const folded = foldReasoningText('a'.repeat(size))
      // One below the gate is skipped outright.
      if (size < GATE) {
        expect(folded).toBeUndefined()
        continue
      }
      expect(folded).toBeDefined()
      expect(codePointLength(folded!)).toBeLessThan(size)
    }
  })

  it('keeps a comfortable margin: an input at the gate folds to about a third', () => {
    const folded = foldReasoningText('a'.repeat(GATE))!
    // The folded form is a fixed ~328 chars (240-char head + marker), so the
    // saving ratio at the gate is roughly two thirds.
    expect(codePointLength(folded)).toBeLessThan(GATE / 2)
    expect(codePointLength('a'.repeat(GATE)) - codePointLength(folded)).toBeGreaterThan(GATE / 2)
  })

  it('handles a wide-character input without splitting a code point', () => {
    const text = '汉'.repeat(GATE)
    const folded = foldReasoningText(text)!
    expect(codePointLength(folded)).toBeLessThan(codePointLength(text))
    // No replacement character: the head was cut on a code-point boundary.
    expect(folded).not.toContain('\uFFFD')
  })
})
