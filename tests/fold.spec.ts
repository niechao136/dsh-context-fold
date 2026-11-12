import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { Session, deriveEventMessage, foldSurface, type SessionSeq } from '@deepseek-ai/dsh-session'
import { SpillLocator, type SaveTextSpill, type SpillRef, type SpillStore } from '@deepseek-ai/dsh-spill'
import { resolveConfig, type ContextFoldConfig } from '../src/config.ts'
import { FOLD_MARKER } from '../src/format.ts'
import { reportOf } from '../src/measure.ts'
import { foldBatch, planFor, snapshotInput, type FoldHost } from '../src/session.ts'

/** In-memory stand-in for the spill service, which counts writes and can fail on demand. */
class MemorySpillStore {
  readonly writes: SaveTextSpill[] = []
  failNext = false

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk full')
    }
    this.writes.push(input)
    return {
      locator: SpillLocator(`/spill/${this.writes.length}-${input.source.kind === 'tool' ? input.source.callId : 'x'}.txt`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

/** Treat the in-memory store as the service seam it stands in for. */
function asSpillStore(store: MemorySpillStore): SpillStore {
  return store as unknown as SpillStore
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

let seqCounter = 0

/** Append one assistant tool call plus its result. */
function toolPair(
  session: Session,
  input: { turn: number; step: number; toolName: string; args?: string; content: string; isError?: boolean },
): { callId: string; resultSeq: number } {
  const callId = `call_${++seqCounter}_${input.toolName}`
  const args = input.args ?? '{}'
  const assistant = createAssistantMessage({
    content: [{ type: 'tool-call', id: callId as never, name: input.toolName, arguments: args }],
    source: { provider: 'test', model: 'test' },
  })
  session.append(
    'assistant/message',
    { turn: input.turn, step: input.step, message: assistant, stream: [] },
    { surfaceOp: 'append' },
  )
  session.append(
    'tool/call',
    { turn: input.turn, step: input.step, callId: callId as never, name: input.toolName, arguments: args },
  )
  const message = createToolResultMessage({
    callId: callId as never,
    content: text(input.content),
    isError: input.isError === true,
  })
  const result = session.append(
    'tool/result',
    { turn: input.turn, step: input.step, message },
    { surfaceOp: 'append' },
  )
  return { callId, resultSeq: result.seq as number }
}

function freshSession(): Session {
  const session = Session.create('s1' as never)
  session.append('user/message', createUserMessage({ content: text('go'), source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

function host(session: Session, config: ContextFoldConfig, spillStore = new MemorySpillStore()): FoldHost {
  return {
    session,
    spillStore: asSpillStore(spillStore),
    config,
    estimateMessage: (message) => JSON.stringify(message.content).length,
  }
}

const config = resolveConfig({ minBatchChars: 100, keepRecentSteps: 2, staleSteps: 12, minFoldChars: 1000 })

describe('snapshotInput', () => {
  it('reads current nodes with tool names, turns and steps', () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(1500) })
    const snapshot = snapshotInput(session)
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]!.toolName).toBe('ops_bash')
    expect(snapshot.nodes[0]!.turn).toBe(1)
    expect(snapshot.nodes[0]!.step).toBe(2)
    expect(snapshot.nodes[0]!.callId).toBeTruthy()
  })

  it('records later user text as a mention source', () => {
    const session = freshSession()
    const { callId } = toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(1500) })
    session.append(
      'user/message',
      createUserMessage({ content: text(`remember ${callId}`), source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    const snapshot = snapshotInput(session)
    expect(snapshot.mentions.some((mention) => mention.text.includes(callId))).toBe(true)
  })
})

describe('foldBatch — replace protocol', () => {
  it('replaces one node with a conclusion, a locator and a roster', async () => {
    const session = freshSession()
    const small = toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: `small\n${'s'.repeat(1200)}` })
    const big = toolPair(session, { turn: 1, step: 3, toolName: 'ops_grep', args: '{"pattern":"x"}', content: `hit\n${'g'.repeat(4000)}` })
    const decision = planFor(session, 2, 30, config)
    expect(decision.batches).toHaveLength(1)
    const spill = new MemorySpillStore()
    const result = await foldBatch(host(session, config, spill), decision.batches[0]!)
    expect(result.failed).toEqual([])
    expect(result.folded).toHaveLength(2)
    expect(spill.writes).toHaveLength(2)

    const texts = [...session.surface.nodes].map((seq) => session.deriveEventMessage(session.eventAt(seq)!)!).filter((message) => message.role === 'tool')
    expect(texts).toHaveLength(2)
    const folded = texts.map((message) => (message.content[0] as { text: string }).text)
    for (const value of folded) {
      expect(value.startsWith(FOLD_MARKER)).toBe(true)
      expect(value).toContain('Conclusion:')
      expect(value).toContain('Full result: /spill/')
    }
    const head = folded.find((value) => value.includes('(batch head)'))!
    expect(head).toBeTruthy()
    expect(head).toContain('Same batch (1 more):')
    const sibling = folded.find((value) => !value.includes('(batch head)'))!
    expect(sibling).toContain('Batch head:')
    void small
    void big
  })

  it('keeps the tool call id, isError flag, turn and step byte-identical', async () => {
    const session = freshSession()
    const pair = toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const before = session.eventAt(pair.resultSeq as SessionSeq)!
    const decision = planFor(session, 2, 30, config)
    const result = await foldBatch(host(session, config), decision.batches[0]!)
    const replacement = session.eventAt(result.folded[0]!.replacementSeq as SessionSeq)!
    expect(replacement.type).toBe('tool/result')
    if (replacement.type !== 'tool/result' || before.type !== 'tool/result') throw new Error('unreachable')
    expect(replacement.data.turn).toBe(before.data.turn)
    expect(replacement.data.step).toBe(before.data.step)
    expect(replacement.data.message.toolCallId).toBe(before.data.message.toolCallId)
    expect(replacement.data.message.isError).toBe(before.data.message.isError)
    expect(replacement.data.message.id).toBe(before.data.message.id)
    expect(replacement.data.error).toEqual(before.data.error)
    expect(replacement.data.meta).toEqual(before.data.meta)
    expect(replacement.sourceEventSeqs).toEqual([pair.resultSeq])
  })

  it('appends a shadow price immediately before each replacement', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const decision = planFor(session, 2, 30, config)
    const result = await foldBatch(host(session, config), decision.batches[0]!)
    const replacementSeq = result.folded[0]!.replacementSeq
    const before = session.eventAt((replacementSeq - 1) as SessionSeq)!
    expect(before.type).toBe('compaction/prune')
    if (before.type !== 'compaction/prune') throw new Error('unreachable')
    expect(before.data.shadowedSeqs).toEqual([result.folded[0]!.originalSeq])
    expect(before.data.shadowedTokenCount).toBeGreaterThan(0)
  })

  it('shrinks the node', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: `=== deps ===\n${'line\n'.repeat(800)}` })
    const decision = planFor(session, 2, 30, config)
    const result = await foldBatch(host(session, config), decision.batches[0]!)
    expect(result.charsRemoved).toBeGreaterThan(0)
    for (const fold of result.folded) expect(fold.charsAfter).toBeLessThan(fold.charsBefore)
  })

  it('reuses an existing spill locator instead of spilling twice', async () => {
    const session = freshSession()
    const notice = '(... 900 bytes omitted. Full formatted result stored at: /spill/existing.txt. Use read with offset/limit, or grep this path to search within it.)'
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: `head\n${'y'.repeat(2000)}\n${notice}` })
    const decision = planFor(session, 2, 30, config)
    const spill = new MemorySpillStore()
    const result = await foldBatch(host(session, config, spill), decision.batches[0]!)
    expect(spill.writes).toHaveLength(0)
    expect(result.folded[0]!.locator).toBe('/spill/existing.txt')
    expect(result.folded[0]!.spillBytes).toBe(0)
  })

  it('leaves a node untouched when its spill fails', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const decision = planFor(session, 2, 30, config)
    const spill = new MemorySpillStore()
    spill.failNext = true
    const result = await foldBatch(host(session, config, spill), decision.batches[0]!)
    expect(result.folded).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    const node = snapshotInput(session).nodes[0]!
    expect(node.content[0]).toEqual({ type: 'text', text: 'x'.repeat(3000) })
  })
})

describe('idempotency', () => {
  it('folds nothing on a second evaluation of the same log', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const first = planFor(session, 2, 30, config)
    await foldBatch(host(session, config), first.batches[0]!)
    const second = planFor(session, 2, 30, config)
    expect(second.batches).toHaveLength(0)
    expect(second.skipped.some((entry) => entry.reason === 'folded')).toBe(true)
  })

  it('never revisits the pre-fold seq, which left the surface', async () => {
    const session = freshSession()
    const pair = toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const first = planFor(session, 2, 30, config)
    await foldBatch(host(session, config), first.batches[0]!)
    expect([...session.surface.nodes]).not.toContain(pair.resultSeq)
  })
})

describe('replay', () => {
  it('recovers the exact original from sourceEventSeqs, not just the shortened text', async () => {
    const session = freshSession()
    const pair = toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: `original\n${'z'.repeat(3000)}` })
    const decision = planFor(session, 2, 30, config)
    const result = await foldBatch(host(session, config), decision.batches[0]!)
    const replacement = session.eventAt(result.folded[0]!.replacementSeq as SessionSeq)!
    const sources = replacement.sourceEventSeqs ?? []
    expect(sources).toContain(pair.resultSeq)
    const original = session.eventAt(pair.resultSeq as SessionSeq)!
    if (original.type !== 'tool/result') throw new Error('unreachable')
    expect((original.data.message.content[0] as { text: string }).text).toContain('z'.repeat(3000))
    // A full-log replay reproduces the current surface exactly.
    const replayed = foldSurface(session.snapshotEvents())
    expect(replayed.nodes).toEqual([...session.surface.nodes])
  })

  it('replays to the same derived messages the live session serves', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const decision = planFor(session, 2, 30, config)
    await foldBatch(host(session, config), decision.batches[0]!)
    const replayed = foldSurface(session.snapshotEvents())
    expect(replayed.nodes).toEqual([...session.surface.nodes])
    // Replaying the fold reproduces the same model-visible history the live session serves.
    const replayedMessages = replayed.nodes.map((seq) => {
      const event = session.snapshotEvents()[seq]
      return event === undefined ? null : (replayed.projectedMessages.get(seq) ?? deriveEventMessage(event))
    })
    expect(replayedMessages.filter((message) => message !== null)).toEqual(session.deriveMessages())
  })
})

describe('reportOf', () => {
  it('reports folded nodes, savings and call ids', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    toolPair(session, { turn: 1, step: 3, toolName: 'ops_grep', content: 'y'.repeat(4000) })
    const decision = planFor(session, 2, 30, config)
    await foldBatch(host(session, config), decision.batches[0]!)
    const report = reportOf(session)
    expect(report.folds).toHaveLength(2)
    expect(report.charsRemoved).toBeGreaterThan(0)
    expect(report.folds.filter((fold) => fold.head)).toHaveLength(1)
    expect(report.folds.every((fold) => fold.charsBefore > fold.charsAfter)).toBe(true)
  })

  it('counts a later citation of a folded locator as a re-read', async () => {
    const session = freshSession()
    toolPair(session, { turn: 1, step: 2, toolName: 'ops_bash', content: 'x'.repeat(3000) })
    const decision = planFor(session, 2, 30, config)
    const result = await foldBatch(host(session, config), decision.batches[0]!)
    const locator = result.folded[0]!.locator
    const before = reportOf(session)
    expect(before.reReads).toBe(0)
    toolPair(session, { turn: 3, step: 40, toolName: 'read', args: JSON.stringify({ path: locator }), content: 'x'.repeat(3000) })
    const after = reportOf(session)
    expect(after.reReads).toBeGreaterThan(before.reReads)
    expect(after.rereadNodes).toBe(1)
  })

  it('reports nothing for an unfurled session', () => {
    const session = freshSession()
    const report = reportOf(session)
    expect(report.folds).toHaveLength(0)
    expect(report.charsRemoved).toBe(0)
  })
})
