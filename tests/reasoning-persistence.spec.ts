import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import {
  REASONING_EVENT,
  planReasoningFolds,
  reasoningCandidates,
  reasoningProjection,
  recordReasoningFolds,
} from '../src/reasoning.ts'

/**
 * The decision record must be *persistable*, not merely replayable in memory.
 *
 * `dsh-session-persistence`'s `assertEventsSupported` refuses a log containing an
 * event type outside `KNOWN_SESSION_EVENT_TYPES` unless the event carries
 * `ignorable === true`:
 *
 *   "contains event type … unknown to this harness and not marked ignorable;
 *    refusing to interpret the log"
 *
 * A plain `session.append()` of a plugin-invented type produces an envelope of
 * exactly `{type, seq, time, data}` — no marker — so it makes the session
 * unreopenable. These tests pin both the danger and the fix, because the failure
 * mode is silent until a user reopens the session and finds it gone.
 */
function sessionWithFold(): Session {
  const session = Session.create('persist-1' as never, undefined, undefined, undefined, [reasoningProjection as never])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'reasoning', text: 'z'.repeat(4000) }, { type: 'tool-call', id: 'c1' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
  return session
}

describe('decision record persistence', () => {
  it('passes the persistence vocabulary gate', () => {
    const decision = sessionWithFold().snapshotEvents().find((event) => (event.type as string) === REASONING_EVENT)!
    // This is the exact predicate `assertEventsSupported` applies on reopen.
    const passesGate = KNOWN_SESSION_EVENT_TYPES.has(decision.type) || decision.ignorable === true
    expect(passesGate).toBe(true)
  })

  it('is not a harness-known type, so the marker is what saves it', () => {
    // Documents *why* `appendPluginRecord` is required: the type cannot be added
    // to the harness vocabulary from a downstream plugin.
    expect(KNOWN_SESSION_EVENT_TYPES.has(REASONING_EVENT as never)).toBe(false)
  })

  it('a plain append of an invented type would NOT pass the gate', () => {
    // A plain append of an invented type (the bug this design avoids) carries no
    // ignorable marker, which is exactly what the persistence gate refuses.
    // `append` is typed against SessionEventMap, so an invented type needs a cast.
    const session = Session.create('persist-2' as never) as unknown as {
      append(type: string, data: unknown): { ignorable?: boolean; type: string }
    }
    session.append('plugin:context-fold/fake', { targets: [] })
    const plain = session.append('plugin:context-fold/fake', { targets: [] })
    expect(plain.ignorable).toBeUndefined()
    expect(KNOWN_SESSION_EVENT_TYPES.has(plain.type)).toBe(false)
  })

  it('still folds the request after a replay of the persisted log', () => {
    const session = sessionWithFold()
    const restored = Session.create('persist-1' as never, session.snapshotEvents() as never, undefined, undefined, [reasoningProjection as never])
    const assistant = restored.deriveMessages().find((message) => message.role === 'assistant')!
    const reasoning = assistant.content.filter((block) => block.type === 'reasoning')[0] as { text: string }
    expect(reasoning.text).toContain('[context-fold] [reasoning]')
    expect(reasoning.text.length).toBeLessThan(1000)
  })
})
