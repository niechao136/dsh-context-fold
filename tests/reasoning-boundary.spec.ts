import { describe, expect, it } from 'vitest'
import { foldReasoningText } from '../src/reasoning.ts'
import { codePointLength } from '../src/rules.ts'

/**
 * The fold must always shrink. `foldReasoningText` keeps a 240-character head,
 * so the risk is an input just above the 1200-character gate where the marker
 * plus the omission note could outweigh the text. These probes pin the actual
 * margin rather than trusting the guard.
 */
describe('fold boundary', () => {
  it('never produces a longer result at the threshold', () => {
    for (const size of [1199, 1200, 1201, 1300, 1500, 2000, 5000]) {
      const folded = foldReasoningText('a'.repeat(size))
      // 1199 is below MIN_REASONING_CHARS and must be skipped outright.
      if (size < 1200) {
        expect(folded).toBeUndefined()
        continue
      }
      expect(folded).toBeDefined()
      expect(codePointLength(folded!)).toBeLessThan(size)
    }
  })

  it('keeps a comfortable margin: a 1200-char input folds to ~330', () => {
    const folded = foldReasoningText('a'.repeat(1200))!
    expect(codePointLength(folded)).toBeLessThan(400)
  })

  it('handles a wide-character input without splitting a code point', () => {
    const text = '汉'.repeat(1200)
    const folded = foldReasoningText(text)!
    expect(codePointLength(folded)).toBeLessThan(codePointLength(text))
    // No replacement character: the head was cut on a code-point boundary.
    expect(folded).not.toContain('\uFFFD')
  })
})
