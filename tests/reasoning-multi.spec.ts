import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { reportOf } from '../src/measure.ts'
import {
  REASONING_MARKER,
  planReasoningFolds,
  reasoningCandidates,
  reasoningProjection,
  recordReasoningFolds,
} from '../src/reasoning.ts'

const BIG = (seed: string): string => seed.repeat(2000)

/** One assistant message with several reasoning blocks interleaved with a tool call. */
function sessionWithManyReasoningBlocks(): Session {
  const session = Session.create('reason-many' as never, undefined, undefined, undefined, [reasoningProjection as never])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    content: [
      { type: 'reasoning', text: BIG('a') },
      { type: 'text', text: 'note' },
      { type: 'reasoning', text: BIG('b') },
      { type: 'reasoning', text: BIG('c') },
      { type: 'tool-call', id: 'call_m' as never, name: 'read', arguments: '{}' },
    ],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

describe('multiple reasoning blocks in one message', () => {
  const config = resolveConfig()

  it('folds every eligible block in the message', () => {
    const session = sessionWithManyReasoningBlocks()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, config)
    expect(plans).toHaveLength(1)
    expect(plans[0]!.indexes).toHaveLength(3)
  })

  it('projects all of them while preserving block count and order', () => {
    const session = sessionWithManyReasoningBlocks()
    const before = session.deriveMessages()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, config))
    const after = session.deriveMessages()
    expect(after.length).toBe(before.length)
    const assistant = after.find((message) => message.role === 'assistant')!
    expect(assistant.content).toHaveLength(3 + 2)
    expect(assistant.content.map((block) => block.type)).toEqual(['reasoning', 'text', 'reasoning', 'reasoning', 'tool-call'])
    const folded = assistant.content.filter((block) => block.type === 'reasoning' && block.text.startsWith(REASONING_MARKER))
    expect(folded).toHaveLength(3)
  })

  it('is idempotent across a second decision on the same message', () => {
    const session = sessionWithManyReasoningBlocks()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, config))
    // Nothing left to fold, so a second pass must produce no plan at all.
    expect(planReasoningFolds(reasoningCandidates(session), 2, 9, config)).toHaveLength(0)
  })

  it('reports only the folded blocks, not the short one it kept', () => {
    // The report must measure exactly the blocks the decision folded. A message
    // that keeps a short block (below MIN_REASONING_CHARS) must not have that
    // block's characters attributed to the fold.
    const session = Session.create('reason-report' as never, undefined, undefined, undefined, [reasoningProjection as never])
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'a'.repeat(3000) },
          // Comfortably below the current gate (900): this one must be kept.
          { type: 'reasoning', text: 'b'.repeat(400) },
          { type: 'tool-call', id: 'call_r' as never, name: 'read', arguments: '{}' },
        ],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }), { surfaceOp: 'append' })

    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig())
    expect(plans[0]!.indexes).toEqual([0])
    recordReasoningFolds(session, plans)

    const report = reportOf(session)
    expect(report.reasoningFolds).toHaveLength(1)
    expect(report.reasoningFolds[0]!.charsBefore).toBe(3000)
    expect(report.reasoningFolds[0]!.charsAfter).toBeLessThan(400)
  })

  it('survives a duplicate decision for an already-folded message', () => {
    // A second decision naming the same seq must not double-fold or throw: the
    // projection skips blocks that already carry the marker.
    const session = sessionWithManyReasoningBlocks()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, config)
    recordReasoningFolds(session, plans)
    const seq = plans[0]!.seq
    recordReasoningFolds(session, [{ seq, indexes: [0], chars: [1], charsRemoved: 1 }])
    expect(() => session.deriveMessages()).not.toThrow()
    const assistant = session.deriveMessages().find((message) => message.role === 'assistant')!
    expect(assistant.content.filter((block) => block.type === 'reasoning')).toHaveLength(3)
    // The duplicate must not be double-counted: the report has one row per
    // (message, block), so three folded blocks give three rows, not four.
    const report = reportOf(session)
    expect(report.reasoningFolds).toHaveLength(3)
  })
})
