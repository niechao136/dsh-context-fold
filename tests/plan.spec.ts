import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'
import { FOLD_MARKER } from '../src/format.ts'
import { planFolds, type MentionRecord, type NodeSnapshot } from '../src/plan.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** Branded seq for a plain integer, as a session would supply it. */
const seqOf = (value: number): NodeSnapshot['seq'] => value as NodeSnapshot['seq']

function node(overrides: Omit<Partial<NodeSnapshot>, 'seq'> & { seq: number }): NodeSnapshot {
  const body = overrides.content === undefined ? text(`${'x'.repeat(4000)}\nline2\nline3`) : overrides.content
  return {
    turn: 1,
    step: 1,
    toolName: 'ops_bash',
    callId: `call-${overrides.seq}`,
    content: body,
    isError: false,
    ...overrides,
    seq: seqOf(overrides.seq),
  }
}

const config = resolveConfig({ minBatchChars: 100, keepRecentSteps: 2, staleSteps: 12 })

function decide(nodes: NodeSnapshot[], mentions: MentionRecord[] = [], turn = 2, step = 30) {
  return planFolds({ nodes, mentions, currentTurn: turn, currentStep: step, config })
}

describe('planFolds — candidate rules', () => {
  it('folds an aged, unreferenced, large result', () => {
    const decision = decide([node({ seq: 3 })])
    expect(decision.batches).toHaveLength(1)
    expect(decision.batches[0]!.members).toHaveLength(1)
    expect(decision.batches[0]!.members[0]!.seq).toBe(3)
  })

  it('never folds an error result', () => {
    const decision = decide([node({ seq: 3, isError: true })])
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('error')
  })

  it('never folds a recent result', () => {
    const decision = decide([node({ seq: 3, step: 29 })], [], 2, 30)
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('recent')
  })

  it('never folds a result from the open turn that is not yet stale', () => {
    const decision = decide([node({ seq: 3, turn: 2, step: 29 })], [], 2, 30)
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('alive')
  })

  it('folds a result in the open turn once it is stale', () => {
    const decision = decide([node({ seq: 3, turn: 2, step: 10 })], [], 2, 30)
    expect(decision.batches).toHaveLength(1)
  })

  it('skips a result smaller than minFoldChars', () => {
    const decision = decide([node({ seq: 3, content: text('tiny') })])
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('small')
  })

  it('skips an already-folded node, which is the idempotency test', () => {
    const decision = decide([node({ seq: 3, content: text(`${FOLD_MARKER} [tool: ops_bash] 100 chars folded at turn 1, step 1.`) })])
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('folded')
  })

  it('skips image content', () => {
    const image = { type: 'image', attachment: { attachmentId: 'i', mediaType: 'image/png', width: 1, height: 1 } } as unknown as ContentBlock
    const decision = decide([node({ seq: 3, content: [image] })])
    expect(decision.skipped[0]!.reason).toBe('unfoldable')
  })

  it('skips a node a later tool call cites by call id', () => {
    const mentions: MentionRecord[] = [{ seq: 99, text: 'read call-3 again' }]
    const decision = decide([node({ seq: 3 })], mentions)
    expect(decision.batches).toHaveLength(0)
    expect(decision.skipped[0]!.reason).toBe('referenced')
  })

  it('ignores a mention that is older than the node', () => {
    const mentions: MentionRecord[] = [{ seq: 1, text: 'call-3' }]
    const decision = decide([node({ seq: 3 })], mentions)
    expect(decision.batches).toHaveLength(1)
  })

  it('does not fold when a batch is below minBatchChars', () => {
    const strict = resolveConfig({ minBatchChars: 1_000_000 })
    const decision = planFolds({
      nodes: [node({ seq: 3 })],
      mentions: [],
      currentTurn: 2,
      currentStep: 30,
      config: strict,
    })
    expect(decision.batches).toHaveLength(0)
    expect(decision.candidateChars).toBeGreaterThan(0)
  })
})

describe('planFolds — batching', () => {
  it('groups one turn into one batch, largest first', () => {
    const small = node({ seq: 3, content: text('y'.repeat(1200)) })
    const big = node({ seq: 4, content: text('z'.repeat(4000)) })
    const decision = decide([small, big])
    expect(decision.batches).toHaveLength(1)
    expect(decision.batches[0]!.members[0]!.seq).toBe(4)
    expect(decision.batches[0]!.members[1]!.seq).toBe(3)
    expect(decision.batches[0]!.members[0]!.head).toBe(true)
    expect(decision.batches[0]!.members[1]!.head).toBe(false)
  })

  it('splits a very long turn into contiguous step ranges', () => {
    const nodes = [
      node({ seq: 3, step: 1 }),
      node({ seq: 4, step: 5 }),
      node({ seq: 5, step: 25 }),
      node({ seq: 6, step: 30 }),
    ]
    const decision = decide(nodes)
    expect(decision.batches).toHaveLength(2)
    expect(decision.batches[0]!.members.every((member) => member.step < 25)).toBe(true)
    expect(decision.batches[1]!.members.every((member) => member.step >= 25)).toBe(true)
  })

  it('separates different turns into different batches', () => {
    const decision = decide([node({ seq: 3, turn: 1 }), node({ seq: 4, turn: 2, step: 1 })])
    expect(decision.batches).toHaveLength(2)
    expect(decision.batches[0]!.members[0]!.turn).toBe(1)
    expect(decision.batches[1]!.members[0]!.turn).toBe(2)
  })

  it('is deterministic for the same snapshot', () => {
    const nodes = [node({ seq: 3 }), node({ seq: 4, content: text('q'.repeat(5000)) })]
    expect(JSON.stringify(decide(nodes))).toBe(JSON.stringify(decide(nodes)))
  })

  it('records an existing conclusion for every member', () => {
    const decision = decide([node({ seq: 3 }), node({ seq: 4, toolName: 'mystery', content: text('opaque\nrest') })])
    for (const member of decision.batches[0]!.members) expect(member.conclusion.length).toBeGreaterThan(0)
  })

  it('keeps the default config compatible with a single aged result', () => {
    const decision = planFolds({
      nodes: [node({ seq: 3, content: text('x'.repeat(DEFAULT_CONFIG.minBatchChars + 10)) })],
      mentions: [],
      currentTurn: 2,
      currentStep: 30,
      config: resolveConfig(),
    })
    expect(decision.batches).toHaveLength(1)
  })
})
