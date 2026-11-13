import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
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
  const session = Session.create('reason-many' as never, undefined, undefined, undefined, [reasoningProjection])
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

  it('survives a duplicate decision for an already-folded message', () => {
    // A second decision naming the same seq must not double-fold or throw: the
    // projection skips blocks that already carry the marker.
    const session = sessionWithManyReasoningBlocks()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, config)
    recordReasoningFolds(session, plans)
    const seq = plans[0]!.seq
    session.append('context-fold/reasoning', { targets: [{ seq, chars: [1] }] })
    expect(() => session.deriveMessages()).not.toThrow()
    const assistant = session.deriveMessages().find((message) => message.role === 'assistant')!
    expect(assistant.content.filter((block) => block.type === 'reasoning')).toHaveLength(3)
  })
})
