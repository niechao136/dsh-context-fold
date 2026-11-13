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
  type ReasoningSpill,
} from '../src/reasoning.ts'

const LONG = 'q'.repeat(4000)

class MemorySpill implements ReasoningSpill {
  readonly writes: { content: string; locator: string }[] = []
  fail = false
  async saveText(input: { content: string }): Promise<{ locator: string }> {
    if (this.fail) throw new Error('spill unavailable')
    const locator = `/spill/reasoning-${this.writes.length}.txt`
    this.writes.push({ content: input.content, locator })
    return { locator }
  }
}

function sessionWithReasoning(): Session {
  const session = Session.create('recall-1' as never, undefined, undefined, undefined, [reasoningProjection as never])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'reasoning', text: LONG }, { type: 'tool-call', id: 'c1' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

describe('reasoning fold recovery path', () => {
  it('spills the original and inlines the locator into the folded marker', async () => {
    const session = sessionWithReasoning()
    const spill = new MemorySpill()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig())
    await recordReasoningFolds(session, plans, spill)

    // The full original text was written, not the folded summary.
    expect(spill.writes).toHaveLength(1)
    expect(spill.writes[0]!.content).toBe(LONG)

    const assistant = session.deriveMessages().find((message) => message.role === 'assistant')!
    const folded = (assistant.content[0] as { text: string }).text
    expect(folded.startsWith(REASONING_MARKER)).toBe(true)
    // The recovery path is inline, so the omission is one hop from recoverable.
    expect(folded).toContain(spill.writes[0]!.locator)
    expect(folded).toContain('read')
  })

  it('keeps the recovery path across a replay of the persisted log', async () => {
    const session = sessionWithReasoning()
    const spill = new MemorySpill()
    await recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()), spill)

    const restored = Session.create('recall-1' as never, session.snapshotEvents() as never, undefined, undefined, [reasoningProjection as never])
    const assistant = restored.deriveMessages().find((message) => message.role === 'assistant')!
    expect((assistant.content[0] as { text: string }).text).toContain(spill.writes[0]!.locator)
  })

  it('still folds, without a recovery path, when spilling fails', async () => {
    // A failed spill must not block the fold: the omission note stays accurate,
    // only the hint is missing. This is phase 1's rule for tool results too.
    const session = sessionWithReasoning()
    const spill = new MemorySpill()
    spill.fail = true
    await recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()), spill)

    const assistant = session.deriveMessages().find((message) => message.role === 'assistant')!
    const folded = (assistant.content[0] as { text: string }).text
    expect(folded.startsWith(REASONING_MARKER)).toBe(true)
    expect(folded).not.toContain('/spill/')
  })

  it('folds without any spill store at all', async () => {
    const session = sessionWithReasoning()
    await recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const assistant = session.deriveMessages().find((message) => message.role === 'assistant')!
    expect((assistant.content[0] as { text: string }).text.startsWith(REASONING_MARKER)).toBe(true)
  })
})
