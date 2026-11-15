import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { locatorOf, buildReport, registerRoutes, readOriginal, type RouteDeps } from '../src/routes.ts'
import { FOLD_MARKER } from '../src/format.ts'
import { planReasoningFolds, reasoningCandidates, reasoningProjection, recordReasoningFolds } from '../src/reasoning.ts'

describe('locatorOf', () => {
  it('reads the phase-1 tool locator', () => {
    const text = `${FOLD_MARKER} [tool: ops_grep] 1,000 chars folded.\nConclusion: x\nFull result: /spill/a.txt\n`
    expect(locatorOf(text)).toBe('/spill/a.txt')
  })

  it('reads the phase-2 reasoning locator', () => {
    const text = `${FOLD_MARKER} [reasoning] 9,000 chars folded.\nhead\n[… 8,000 chars of earlier reasoning omitted] Full text: /spill/r.txt — use read`
    expect(locatorOf(text)).toBe('/spill/r.txt')
  })

  it('returns undefined when a fold has no recovery path', () => {
    expect(locatorOf(`${FOLD_MARKER} [reasoning] 9,000 chars folded.\nhead\n[… omitted]`)).toBeUndefined()
  })
})

function sessionWithFolds(): Session {
  const session = Session.create('route-1' as never, undefined, undefined, undefined, [reasoningProjection as never])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const callId = 'call_a'
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'reasoning', text: 'r'.repeat(5000) }, { type: 'tool-call', id: callId as never, name: 'ops_bash', arguments: '{}' }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: callId as never, name: 'ops_bash', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: 'x'.repeat(6000) }], isError: false }),
  }, { surfaceOp: 'append' })
  return session
}

const deps = (): RouteDeps => ({
  sessionOf: () => undefined,
  estimateMessage: (message: { content?: readonly { text?: string }[] }) => {
    const text = (message.content ?? []).map((block) => block.text ?? '').join('')
    return Math.round(Array.from(text).length / 3.5)
  },
})

describe('buildReport', () => {
  it('reports reasoning folds with their recovery path', async () => {
    const session = sessionWithFolds()
    await recordReasoningFolds(
      session,
      planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()),
      { saveText: async () => ({ locator: '/spill/reason.txt' }) },
    )
    const report = buildReport(session, deps())
    expect(report.folds).toHaveLength(1)
    const fold = report.folds[0]!
    expect(fold.kind).toBe('reasoning')
    expect(fold.recoverable).toBe(true)
    expect(fold.locator).toBe('/spill/reason.txt')
    expect(fold.charsAfter).toBeLessThan(fold.charsBefore)
    expect(report.counterfactual.tokensIfUnfolded).toBeGreaterThan(report.counterfactual.tokensNow)
  })

  it('marks a fold without a recovery path as not recoverable', async () => {
    const session = sessionWithFolds()
    await recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const fold = buildReport(session, deps()).folds[0]!
    expect(fold.recoverable).toBe(false)
    expect(fold.locator).toBeUndefined()
  })

  it('states that usage was unavailable rather than inventing a bill', async () => {
    const session = sessionWithFolds()
    await recordReasoningFolds(session, planReasoningFolds(reasoningCandidates(session), 2, 9, resolveConfig()))
    const report = buildReport(session, deps())
    expect(report.counterfactual.hasRealUsage).toBe(false)
    expect(report.counterfactual.assumptions[0]).toContain('no provider usage')
  })
})

describe('registerRoutes', () => {
  it('serves the report and rejects a bad request', async () => {
    const session = sessionWithFolds()
    const registrations: { path: string; fetch: (request: Request) => Promise<Response> }[] = []
    // The host surface is `connection.fetch.register(...)`, not a callable
    // connection object; the fixture mirrors that so this test fails if the
    // production code ever drifts back to the wrong shape.
    const connection = {
      fetch: {
        register(definition: { path: string; fetch: (request: Request) => Promise<Response> }) {
          registrations.push(definition)
          return () => {}
        },
      },
    }
    registerRoutes(connection, { ...deps(), sessionOf: (id) => (id === 'route-1' ? session : undefined) })

    expect(registrations.map((entry) => entry.path)).toEqual(['/api/context-fold/report', '/api/context-fold/original'])

    const reportRoute = registrations[0]!
    const good = await reportRoute.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ sessionId: 'route-1' }) }))
    expect(good.status).toBe(200)
    const payload = (await good.json()) as { ok: boolean; value: { folds: unknown[] } }
    expect(payload.ok).toBe(true)
    expect(Array.isArray(payload.value.folds)).toBe(true)

    const missing = await reportRoute.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({}) }))
    expect(missing.status).toBe(400)

    const unknown = await reportRoute.fetch(new Request('http://x', { method: 'POST', body: JSON.stringify({ sessionId: 'nope' }) }))
    expect(unknown.status).toBe(404)
  })
})

describe('readOriginal', () => {
  it('reads through the spill store when it can', async () => {
    const text = await readOriginal({ ...deps(), spillStore: { readText: async () => 'full text' } as never }, '/spill/a.txt')
    expect(text).toBe('full text')
  })

  it('returns undefined when the store cannot read', async () => {
    expect(await readOriginal(deps(), '/spill/a.txt')).toBeUndefined()
  })
})
