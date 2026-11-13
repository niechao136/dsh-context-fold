import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { renderReport, reportOf } from '../src/measure.ts'
import {
  REASONING_MARKER,
  foldReasoningText,
  isFoldedReasoning,
  isToolCallTurn,
  planReasoningFolds,
  projectReasoning,
  reasoningCandidates,
  reasoningProjection,
  recordReasoningFolds,
} from '../src/reasoning.ts'

const LONG = 'x'.repeat(4000)

/** Reasoning is only re-sent by the DeepSeek adapter on tool-call turns. */
describe('isToolCallTurn', () => {
  it('detects a tool call', () => {
    expect(isToolCallTurn([{ type: 'reasoning', text: 'a' }, { type: 'tool-call', id: 'c' as never, name: 'read', arguments: '{}' }])).toBe(true)
  })

  it('rejects a plain turn', () => {
    expect(isToolCallTurn([{ type: 'reasoning', text: 'a' }, { type: 'text', text: 'answer' }])).toBe(false)
  })
})

describe('foldReasoningText', () => {
  it('keeps the head verbatim and reports the omission', () => {
    const text = `${'h'.repeat(300)}${'z'.repeat(3000)}`
    const folded = foldReasoningText(text)!
    expect(folded.startsWith(REASONING_MARKER)).toBe(true)
    expect(folded).toContain('h'.repeat(240))
    expect(folded).toContain('omitted')
    expect(folded.length).toBeLessThan(text.length)
  })

  it('skips a block that is too short to shrink', () => {
    expect(foldReasoningText('short reasoning')).toBeUndefined()
  })

  it('is idempotent', () => {
    const folded = foldReasoningText(LONG)!
    expect(isFoldedReasoning(folded)).toBe(true)
    expect(foldReasoningText(folded)).toBeUndefined()
  })

  it('never invents content: the folded head is a prefix of the original', () => {
    const text = `${'a'.repeat(2000)}tail`
    const folded = foldReasoningText(text)!
    const head = folded.split('\n')[1]!
    expect(text.startsWith(head)).toBe(true)
  })
})

function sessionWithOldToolTurn(): Session {
  const session = Session.create('reason-1' as never, undefined, undefined, undefined, [reasoningProjection])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    content: [{ type: 'reasoning', text: LONG }, { type: 'tool-call', id: 'call_1' as never, name: 'read', arguments: '{}' }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

describe('planReasoningFolds', () => {
  const config = resolveConfig()

  it('folds an aged tool-call turn', () => {
    const session = sessionWithOldToolTurn()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, config)
    expect(plans.length).toBe(1)
    expect(plans[0]!.charsRemoved).toBeGreaterThan(0)
  })

  it('never folds a recent message', () => {
    const session = sessionWithOldToolTurn()
    expect(planReasoningFolds(reasoningCandidates(session), 2, 3, config).length).toBe(0)
  })

  it('skips a plain turn, whose reasoning is not re-sent', () => {
    const session = Session.create('reason-plain' as never)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: LONG }, { type: 'text', text: 'answer' }],
      source: { provider: 'test', model: 'test' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    expect(planReasoningFolds(reasoningCandidates(session), 2, 9, config).length).toBe(0)
  })

  it('does not plan a message it already folded', () => {
    const session = sessionWithOldToolTurn()
    const first = planReasoningFolds(reasoningCandidates(session), 2, 9, config)
    recordReasoningFolds(session, first)
    expect(planReasoningFolds(reasoningCandidates(session), 2, 9, config).length).toBe(0)
  })
})

describe('projectReasoning', () => {
  it('preserves identity, block count, and block types', () => {
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: LONG }, { type: 'text', text: 'answer' }],
      source: { provider: 'test', model: 'test' },
    })
    const projected = projectReasoning(message, [0])
    expect(projected.id).toBe(message.id)
    expect(projected.content.length).toBe(message.content.length)
    expect(projected.content.map((block) => block.type)).toEqual(message.content.map((block) => block.type))
    expect((projected.content[0] as { text: string }).text).toContain(REASONING_MARKER)
    // The input message is untouched.
    expect((message.content[0] as { text: string }).text).toBe(LONG)
  })

  it('is frozen', () => {
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: LONG }],
      source: { provider: 'test', model: 'test' },
    })
    expect(Object.isFrozen(projectReasoning(message, [0]))).toBe(true)
  })
})

describe('reasoningProjection', () => {
  it('shrinks what the request sees while the log keeps the original', () => {
    const session = sessionWithOldToolTurn()
    const plans = planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig())
    recordReasoningFolds(session, plans)

    const derived = JSON.stringify(session.deriveMessages())
    expect(derived).not.toContain(LONG)
    expect(derived).toContain(REASONING_MARKER)
    expect(JSON.stringify(session.snapshotEvents())).toContain(LONG)
  })

  it('keeps the message count identical', () => {
    const session = sessionWithOldToolTurn()
    const before = session.deriveMessages().length
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    expect(session.deriveMessages().length).toBe(before)
  })

  it('survives a restore through a replay of the same log', () => {
    const session = sessionWithOldToolTurn()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const restored = Session.create('reason-1' as never, session.snapshotEvents() as never, undefined, undefined, [reasoningProjection])
    expect(JSON.stringify(restored.deriveMessages())).toContain(REASONING_MARKER)
  })

  it('tolerates a stale target instead of throwing', () => {
    // A target whose seq is not a current node must be skipped: a compaction may
    // have shadowed the node, and throwing would brick every later request.
    const session = sessionWithOldToolTurn()
    session.append('context-fold/reasoning', { targets: [{ seq: 999 as never, chars: [1] }] })
    expect(() => session.deriveMessages()).not.toThrow()
  })

  it('rejects a malformed decision so a corrupt log fails loudly', () => {
    const session = sessionWithOldToolTurn()
    expect(() => session.append('context-fold/reasoning', { targets: [] })).toThrow()
  })
})

describe('reportOf covers reasoning folds', () => {
  it('counts the folded decisions and their savings', () => {
    const session = sessionWithOldToolTurn()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const report = reportOf(session)
    expect(report.reasoningFolds).toHaveLength(1)
    const fold = report.reasoningFolds[0]!
    expect(fold.blocks).toBe(1)
    expect(fold.charsBefore).toBe(LONG.length)
    expect(fold.charsAfter).toBeLessThan(fold.charsBefore)
  })

  it('renders the reasoning line in the command output', () => {
    const session = sessionWithOldToolTurn()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    expect(renderReport(reportOf(session), false)).toContain('Reasoning folded in 1 message(s)')
  })

  it('does not also claim nothing was folded when only reasoning folded', () => {
    const session = sessionWithOldToolTurn()
    recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const text = renderReport(reportOf(session), false)
    expect(text).not.toContain('Nothing has been folded')
  })
})
