import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { SpillLocator, type SaveTextSpill, type SpillRef, type SpillStore } from '@deepseek-ai/dsh-spill'
import { apply, describeDecision } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { FOLD_MARKER } from '../src/format.ts'
import { reportOf } from '../src/measure.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

class MemorySpill {
  readonly writes: SaveTextSpill[] = []
  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.writes.push(input)
    return {
      locator: SpillLocator(`/spill/${this.writes.length}.txt`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

/** Minimal Cordis-shaped context that records handlers and serves the services apply() reads. */
function fakeContext(services: Record<string, unknown>): {
  ctx: Context
  emit(event: string, payload: unknown): Promise<void>
  logs: string[]
  commands: { name: string; description: string; handler: (invocation: unknown) => unknown }[]
  projections: { type: string }[]
} {
  const handlers = new Map<string, ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)[]>()
  const logs: string[] = []
  const commands: { name: string; description: string; handler: (invocation: unknown) => unknown }[] = []
  const projections: { type: string }[] = []
  const ctx = {
    on(event: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
      const list = handlers.get(event)
      if (list === undefined) handlers.set(event, [handler])
      else list.push(handler)
    },
    get(service: string) {
      return services[service]
    },
    inject(names: string[], callback: (scope: unknown) => void) {
      const scope: Record<string, unknown> = {
        commands: {
          register(definition: { name: string; description: string; handler: (invocation: unknown) => unknown }) {
            commands.push(definition)
            return () => {}
          },
        },
      }
      if (names.includes('sessions')) {
        scope.sessions = {
          registerMessageProjection(projection: { type: string }) {
            projections.push(projection)
            return async () => {}
          },
        }
      }
      callback(scope)
    },
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
  } as unknown as Context
  return {
    ctx,
    logs,
    commands,
    projections,
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, async () => undefined)
    },
  }
}

function agentOn(session: Session): Agent {
  return { session } as unknown as Agent
}

let counter = 0

function addPair(session: Session, input: { turn: number; step: number; toolName: string; content: string }): number {
  const callId = `call_${++counter}_${input.toolName}`
  const assistant = createAssistantMessage({
    content: [{ type: 'tool-call', id: callId as never, name: input.toolName, arguments: '{}' }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', { turn: input.turn, step: input.step, message: assistant, stream: [] }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: input.turn, step: input.step, callId: callId as never, name: input.toolName, arguments: '{}' })
  const result = session.append(
    'tool/result',
    {
      turn: input.turn,
      step: input.step,
      message: createToolResultMessage({ callId: callId as never, content: text(input.content), isError: false }),
    },
    { surfaceOp: 'append' },
  )
  return result.seq as number
}

/**
 * A finished turn that ran long enough for its early results to fall outside
 * `keepRecentSteps`, which is what a real reconnaissance stage looks like.
 */
function sessionWithTurnOne(): Session {
  const session = Session.create('plug-1' as never)
  session.append('user/message', createUserMessage({ content: text('go'), source: { kind: 'user' } }), { surfaceOp: 'append' })
  addPair(session, { turn: 1, step: 1, toolName: 'ops_bash', content: `=== deps ===\n${'x'.repeat(4000)}` })
  addPair(session, { turn: 1, step: 2, toolName: 'ops_grep', content: `hit\n${'y'.repeat(5000)}` })
  for (let step = 3; step <= 8; step++) {
    session.append(
      'tool/result',
      {
        turn: 1,
        step,
        message: createToolResultMessage({ callId: `filler_${step}` as never, content: text('small'), isError: false }),
      },
      { surfaceOp: 'append' },
    )
  }
  return session
}

const services = () => {
  const spill = new MemorySpill()
  return {
    spill,
    map: {
      spillStore: spill as unknown as SpillStore,
      tokenMeter: { estimateMessage: (message: { content: readonly ContentBlock[] }) => JSON.stringify(message.content).length },
    },
  }
}

const config = resolveConfig({ minBatchChars: 100, keepRecentSteps: 2, staleSteps: 4, minFoldChars: 1000 })

describe('apply', () => {
  it('folds completed-turn results at a turn boundary', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, config)
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(spill.writes).toHaveLength(2)
    const folded = reportOf(session)
    expect(folded.folds).toHaveLength(2)
    expect(folded.charsRemoved).toBeGreaterThan(0)
  })

  it('is idempotent: a second boundary folds nothing new', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, config)
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    const writes = spill.writes.length
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(spill.writes.length).toBe(writes)
  })

  it('does nothing in dryRun, but reports what it would do', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, resolveConfig({ ...config, dryRun: true }))
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(spill.writes).toHaveLength(0)
    expect(reportOf(session).folds).toHaveLength(0)
    expect(fake.logs.some((line) => line.includes('dryRun: would fold 2 node(s)'))).toBe(true)
  })

  it('does nothing when the plugin is disabled', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, resolveConfig({ ...config, enabled: false }))
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(spill.writes).toHaveLength(0)
  })

  it('no-ops with a warning when no spill store is loaded', async () => {
    const session = sessionWithTurnOne()
    const fake = fakeContext({ tokenMeter: { estimateMessage: () => 1 } })
    apply(fake.ctx, config)
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(reportOf(session).folds).toHaveLength(0)
    expect(fake.logs.some((line) => line.includes('no ctx.spillStore'))).toBe(true)
  })

  it('folds at a pre-step when the age condition fires inside one long turn', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, config)
    await fake.emit('agent/pre-step', { agent: agentOn(session), turn: 2, step: 12, messages: [], signal: new AbortController().signal, modelSelection: {} })
    expect(spill.writes).toHaveLength(2)
  })

  it('does not fold at a pre-step before the age condition fires', async () => {
    const session = sessionWithTurnOne()
    const { spill, map } = services()
    const fake = fakeContext(map)
    apply(fake.ctx, resolveConfig({ ...config, staleSteps: 100 }))
    await fake.emit('agent/pre-step', { agent: agentOn(session), turn: 2, step: 2, messages: [], signal: new AbortController().signal, modelSelection: {} })
    expect(spill.writes).toHaveLength(0)
  })

  it('passes the pre-step decision through unchanged', async () => {
    const session = sessionWithTurnOne()
    const { map } = services()
    const handlers: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
    const ctx = {
      on(_event: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        handlers.push(handler)
      },
      get(service: string) {
        return map[service as keyof typeof map]
      },
      inject() {},
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Context
    apply(ctx, config)
    const decision = { kind: 'enter' as const, messages: [] }
    const result = await handlers[0]!({ agent: agentOn(session), turn: 2, step: 3, signal: new AbortController().signal }, async () => decision)
    expect(result).toBe(decision)
  })

  it('registers the /context-fold command', () => {
    const fake = fakeContext(services().map)
    apply(fake.ctx, config)
    expect(fake.commands.map((command) => command.name)).toContain('context-fold')
  })

  it('reports through the command handler', async () => {
    const session = sessionWithTurnOne()
    const fake = fakeContext(services().map)
    apply(fake.ctx, config)
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    const command = fake.commands.find((entry) => entry.name === 'context-fold')!
    const result = (await command.handler({ agent: agentOn(session) })) as { kind: string; text: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('2 folded node(s)')
    expect(result.text).toContain('Characters removed')
  })
})

describe('describeDecision', () => {
  it('summarizes batches, candidates, and skip reasons', () => {
    const line = describeDecision('would fold', {
      batches: [{ members: [{}, {}] }, { members: [{}] }],
      candidateChars: 12345,
      skipped: [{ reason: 'recent' }, { reason: 'recent' }, { reason: 'error' }],
    }, config)
    expect(line).toContain('would fold 3 node(s) in 2 batch(es)')
    expect(line).toContain('candidate chars 12345')
    expect(line).toContain('recent=2')
    expect(line).toContain('error=1')
  })
})

describe('folded node invariants under the plugin', () => {
  it('marks every folded node and keeps it smaller than its original', async () => {
    const session = sessionWithTurnOne()
    const fake = fakeContext(services().map)
    apply(fake.ctx, config)
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    const texts = [...session.surface.nodes]
      .map((seq) => session.deriveEventMessage(session.eventAt(seq as SessionSeq)!))
      .filter((message) => message !== null && message.role === 'tool')
      .map((message) => (message!.content[0] as { text: string }).text)
    // The two large results fold; the small filler results stay untouched.
    const foldedTexts = texts.filter((value) => value.startsWith(FOLD_MARKER))
    expect(foldedTexts).toHaveLength(2)
    expect(texts.length).toBe(8)
    const report = reportOf(session)
    expect(report.folds).toHaveLength(2)
    for (const fold of report.folds) expect(fold.charsAfter).toBeLessThan(fold.charsBefore)
  })
})

describe('reasoning folding is wired through the plugin', () => {
  it('registers its message projection', () => {
    const fake = fakeContext(services().map)
    apply(fake.ctx, config)
    expect(fake.projections.map((projection) => projection.type)).toContain('context-fold/reasoning')
  })

  it('registers the projection even when reasoning folding is disabled, so old logs stay readable', () => {
    const fake = fakeContext(services().map)
    apply(fake.ctx, resolveConfig({ ...config, foldReasoning: false }))
    expect(fake.projections.map((projection) => projection.type)).toContain('context-fold/reasoning')
  })

  it('records no reasoning decision while disabled', async () => {
    const session = sessionWithTurnOne()
    const fake = fakeContext(services().map)
    apply(fake.ctx, resolveConfig({ ...config, foldReasoning: false }))
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 1, signal: new AbortController().signal })
    expect(session.snapshotEvents().some((event) => event.type === 'context-fold/reasoning')).toBe(false)
  })

  it('records a reasoning decision for an aged tool-call turn', async () => {
    const session = Session.create('plug-reason' as never)
    session.append('user/message', createUserMessage({ content: text('go'), source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'r'.repeat(5000) }, { type: 'tool-call', id: 'call_r' as never, name: 'read', arguments: '{}' }],
      source: { provider: 'test', model: 'test' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    const fake = fakeContext(services().map)
    // `keepRecentSteps: 0` isolates the age rule: this minimal session has no
    // later steps, so any recency window would classify turn 1 as in-use.
    apply(fake.ctx, resolveConfig({ ...config, keepRecentSteps: 0, foldReasoning: true }))
    await fake.emit('agent/turn-stopping', { agent: agentOn(session), turn: 2, signal: new AbortController().signal })
    const decision = session.snapshotEvents().find((event) => event.type === 'context-fold/reasoning')
    expect(decision).toBeDefined()
    expect(fake.logs.some((line) => line.includes('folded reasoning'))).toBe(true)
  })
})
