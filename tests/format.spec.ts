import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { FOLD_MARKER, isFoldedText, renderFoldedText } from '../src/format.ts'
import type { FoldPlan } from '../src/plan.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

function plan(overrides: Partial<FoldPlan> = {}): FoldPlan {
  return {
    seq: 3 as FoldPlan['seq'],
    facts: { toolName: 'ops_grep', callId: 'a0f9', content: text('x'.repeat(1000)), chars: 1000 },
    turn: 1,
    step: 12,
    conclusion: 'pattern "surfaceOp" — 47 matches across 12 files',
    original: 'x'.repeat(1000),
    head: true,
    ...overrides,
  }
}

describe('flash marker', () => {
  it('identifies its own folded text', () => {
    expect(isFoldedText(renderFoldedText(plan(), '/spill/a.txt', [], 1))).toBe(true)
    expect(isFoldedText('ordinary result')).toBe(false)
    expect(FOLD_MARKER).toBe('[context-fold]')
  })

  it('does not treat a result containing the marker later in its text as folded', () => {
    expect(isFoldedText(`data: ${FOLD_MARKER}`)).toBe(false)
  })
})

describe('renderFoldedText — head', () => {
  it('puts the conclusion inline before any pointer', () => {
    const output = renderFoldedText(plan(), '/spill/a.txt', [], 1)
    const conclusionAt = output.indexOf('Conclusion:')
    const pathAt = output.indexOf('Full result:')
    expect(conclusionAt).toBeGreaterThan(-1)
    expect(pathAt).toBeGreaterThan(conclusionAt)
    expect(output).toContain('(batch head)')
    expect(output).toContain('1,000 chars folded at turn 1, step 12')
  })

  it('lists the batch roster once, on the head, with call ids', () => {
    const roster = [
      { toolName: 'ops_bash', callId: 'a1b2', locator: '/spill/b.txt' },
      { toolName: 'skill', callId: 'e5f6', locator: '/spill/c.txt' },
    ]
    const output = renderFoldedText(plan(), '/spill/a.txt', roster, 3)
    expect(output).toContain('Same batch (2 more):')
    expect(output).toContain('ops_bash (callId a1b2): /spill/b.txt')
    expect(output).toContain('skill (callId e5f6): /spill/c.txt')
  })

  it('omits the roster section for a single-member batch', () => {
    const output = renderFoldedText(plan(), '/spill/a.txt', [], 1)
    expect(output).not.toContain('Same batch')
  })
})

describe('renderFoldedText — non-head', () => {
  it('carries a one-line back-reference instead of a roster', () => {
    const output = renderFoldedText(
      plan({ seq: 4 as FoldPlan['seq'], head: false, headCallId: 'a0f9', facts: { toolName: 'ops_bash', callId: 'c3d4', content: text('y'), chars: 6266 } }),
      '/spill/d.txt',
      [],
      3,
    )
    expect(output).not.toContain('(batch head)')
    expect(output).not.toContain('Same batch')
    expect(output).toContain('Batch head: a0f9 (callId)')
    expect(output).toContain('2 more results from this batch')
  })

  it('uses the singular for one sibling', () => {
    const output = renderFoldedText(plan({ head: false, headCallId: 'a0f9' }), '/spill/d.txt', [], 2)
    expect(output).toContain('1 more result from this batch')
  })
})

describe('renderFoldedText — budget', () => {
  it('keeps per-node overhead near the measured 278-character budget', () => {
    const output = renderFoldedText(
      plan({
        facts: { toolName: 'ops_grep', callId: 'a0f9', content: text('x'.repeat(73447)), chars: 73447 },
        conclusion: 'pattern "surfaceOp" — 47 matches across 12 files; top: agent-loop, session.',
      }),
      '/users/me/.dsh/spill/session-abc/9f8e7d6c5b4a-ops_grep.txt',
      [],
      1,
    )
    expect(Array.from(output).length).toBeLessThan(400)
  })

  it('is exactly stable for identical inputs', () => {
    expect(renderFoldedText(plan(), '/spill/a.txt', [], 1)).toBe(renderFoldedText(plan(), '/spill/a.txt', [], 1))
  })
})
