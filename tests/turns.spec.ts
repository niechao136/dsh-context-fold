import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createUserMessage,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig, type ContextFoldConfig } from '../src/config.ts'
import {
  ARG_MARKER,
  TURN_ARCHIVED,
  writeTargetPath,
  planArgFolds,
  isArchivedTurn,
  planTurnArchives,
  projectTurnMessage,
  recordTurnFolds,
  turnProjection,
} from '../src/turns.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

function writeSession(): { session: Session; seqs: number[] } {
  const session = Session.create('turns-test' as never)
  const seqs: number[] = []
  const writeTo = (turn: number, step: number, path: string, body: string) => {
    const args = JSON.stringify({ file_path: path, content: body })
    const msg = createAssistantMessage({
      content: [
        { type: 'text', text: `writing ${path}` },
        { type: 'tool-call', id: `c${turn}${step}` as never, name: 'write', arguments: args },
      ],
      source: { provider: 'test', model: 'test' },
    })
    const r = session.append('assistant/message', { turn, step, message: msg, stream: [] }, { surfaceOp: 'append' })
    seqs.push(r.seq as number)
  }
  writeTo(1, 2, 'C:\\repo\\a.ts', 'x'.repeat(800))
  writeTo(3, 4, 'C:\\repo\\a.ts', 'y'.repeat(900))
  writeTo(3, 5, 'C:\\repo\\b.ts', 'z'.repeat(500))
  return { session, seqs }
}

describe('writeTargetPath', () => {
  it('extracts and normalizes a write path', () => {
    expect(writeTargetPath('write', JSON.stringify({ file_path: 'C:\\Repo\\A.ts' }))).toBe('c:/repo/a.ts')
    expect(writeTargetPath('ops_write_file', JSON.stringify({ path: '/repo/b.ts' }))).toBe('/repo/b.ts')
  })
  it('recognizes edit paths too', () => {
    expect(writeTargetPath('edit', JSON.stringify({ file_path: 'C:\\Repo\\A.ts' }))).toBe('c:/repo/a.ts')
    expect(writeTargetPath('ops_edit_file', JSON.stringify({ path: '/repo/b.ts' }))).toBe('/repo/b.ts')
  })
  it('ignores non-mutating tools and invalid args', () => {
    expect(writeTargetPath('read', JSON.stringify({ file_path: 'C:\\repo\\a.ts' }))).toBeUndefined()
    expect(writeTargetPath('write', 'not json')).toBeUndefined()
    expect(writeTargetPath('write', JSON.stringify({ file_path: 'x' }))).toBeUndefined()
  })
})

describe('planArgFolds (scheme B)', () => {
  it('folds only superseded writes, keeping the newest intact', () => {
    const { session, seqs } = writeSession()
    const plans = planArgFolds(session, resolveConfig({ minFoldArgsChars: 400 }))
    // First write to a.ts (seqs[0]) is superseded; the others are newest for
    // their path and stay whole.
    expect(plans).toHaveLength(1)
    expect(plans[0]!.seq).toBe(seqs[0])
    expect(plans[0]!.indexes).toEqual([1])
  })

  it('respects the configured minimum size', () => {
    const { session } = writeSession()
    const plans = planArgFolds(session, resolveConfig({ minFoldArgsChars: 5000 }))
    expect(plans).toHaveLength(0)
  })

  it('folds superseded edits, including a write followed by an edit', () => {
    const session = Session.create('turns-edit' as never)
    const append = (seqKey: string, name: string, args: string) => {
      const msg = createAssistantMessage({
        content: [{ type: 'tool-call', id: seqKey as never, name, arguments: args }],
        source: { provider: 'test', model: 'test' },
      })
      return session.append('assistant/message', { turn: 1, step: 1, message: msg, stream: [] }, { surfaceOp: 'append' }).seq as number
    }
    // a.ts: write, then two edits — only the last edit keeps full args.
    const s1 = append('w', 'write', JSON.stringify({ file_path: 'C:\\repo\\a.ts', content: 'x'.repeat(800) }))
    append('e1', 'edit', JSON.stringify({ file_path: 'C:\\repo\\a.ts', old: 'x', new: 'y', body: 'y'.repeat(600) }))
    append('e2', 'edit', JSON.stringify({ file_path: 'C:\\repo\\a.ts', old: 'y', new: 'z', body: 'z'.repeat(600) }))
    // b.ts: a single edit, never superseded -> stays whole.
    append('e3', 'edit', JSON.stringify({ file_path: 'C:\\repo\\b.ts', body: 'q'.repeat(700) }))

    const plans = planArgFolds(session, resolveConfig({ minFoldArgsChars: 400 }))
    // s1 (old write) and e1 (old edit) fold; e2 and b.ts's edit stay.
    expect(plans.map((p) => p.seq).sort((a, b) => a - b)).toEqual([s1, s1 + 1].sort((a, b) => a - b))
  })
})

describe('isArchivedTurn', () => {
  it('keeps the newest N turns and archives older ones', () => {
    const config = resolveConfig({ foldTurnArchive: true, keepRecentTurns: 5 })
    expect(isArchivedTurn(6, 10, config)).toBe(false) // 4 behind
    expect(isArchivedTurn(5, 10, config)).toBe(true) // exactly boundary
    expect(isArchivedTurn(1, 10, config)).toBe(true)
    expect(isArchivedTurn(1, 10, resolveConfig({ foldTurnArchive: false }))).toBe(false)
  })
})

describe('planTurnArchives', () => {
  it('builds one ordered archive per old turn with a pointer target', () => {
    const { session, seqs } = writeSession()
    const plans = planTurnArchives(session, 10, resolveConfig({ keepRecentTurns: 5 }))
    // Only turn 1 is old (turns 3 are 7 behind with keep=5 -> also old).
    expect(plans.length).toBeGreaterThanOrEqual(1)
    const t1 = plans.find((p) => p.turn === 1)!
    expect(t1.seqs).toContain(seqs[0])
    expect(t1.pointerSeq).toBe(seqs[0])
    expect(t1.content).toContain('tool-call write')
    expect(t1.content).toContain('text: writing')
  })
})

describe('projectTurnMessage', () => {
  const callBlock = (id: string, args: string): ContentBlock => ({ type: 'tool-call', id: id as never, name: 'write', arguments: args })

  it('folds a superseded argument block but keeps text', () => {
    const msg = createAssistantMessage({
      content: [text('kept')[0]!, callBlock('a', 'x'.repeat(500))],
      source: { provider: 'test', model: 'test' },
    })
    const out = projectTurnMessage(msg, [1], [500], false, undefined)
    expect(out.content[0]).toEqual(text('kept')[0])
    expect((out.content[1] as { arguments: string }).arguments).toContain(ARG_MARKER)
  })

  it('archives a full turn: drops reasoning, folds calls, collapses shells', () => {
    const msg = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'think' }, callBlock('a', 'x'.repeat(500))],
      source: { provider: 'test', model: 'test' },
    })
    const out = projectTurnMessage(msg, [], [], true, undefined)
    expect(out.content).toHaveLength(1)
    expect((out.content[0] as { text: string }).text).toBe(TURN_ARCHIVED)
  })

  it('appends the recall pointer once, to a text-bearing message', () => {
    const msg = createAssistantMessage({
      content: [text('body')[0]!, callBlock('a', 'x'.repeat(500))],
      source: { provider: 'test', model: 'test' },
    })
    const out = projectTurnMessage(msg, [], [], true, '[context-fold] turn archived: /spill/turn-01.md')
    const textBlocks = out.content.filter((b) => b.type === 'text') as { text: string }[]
    expect(textBlocks.some((b) => b.text.includes('/spill/turn-01.md'))).toBe(true)
  })
})

describe('turnProjection', () => {
  it('ignores a malformed record without throwing', () => {
    const updates = turnProjection.project(
      { seq: 1, type: 'plugin:context-fold/turn', time: 0, data: {} } as never,
      { nodes: [], events: [], messages: new Map(), baseSeq: 0 } as never,
    )
    expect(updates.size).toBe(0)
  })

  it('archives an old turn end-to-end: keeps text, folds calls/reasoning, one pointer', async () => {
    const session = Session.create('turn-e2e' as never, undefined, undefined, undefined, [turnProjection as never])
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'deploy now' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'starting deploy' },
        { type: 'reasoning', text: 'r'.repeat(1000) },
        { type: 'tool-call', id: 'c1' as never, name: 'ops_bash', arguments: JSON.stringify({ command: 'echo deploy' }) },
        { type: 'text', text: 'deploy done' },
      ],
      source: { provider: 'test', model: 'test' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })

    const config = resolveConfig({ keepRecentTurns: 5 })
    const plans = planTurnArchives(session, 10, config)
    expect(plans).toHaveLength(1)
    // No spill store in this unit test: locator is undefined, so no pointer is shown.
    await recordTurnFolds(session, { args: [], turns: plans }, undefined, config)

    const projected = session.deriveMessages().find((m) => m.role === 'assistant')!
    const texts = projected.content.filter((b) => b.type === 'text') as { text: string }[]
    expect(texts.map((b) => b.text)).toEqual(['starting deploy', 'deploy done'])
    const calls = projected.content.filter((b) => b.type === 'tool-call') as { arguments: string }[]
    expect(calls).toHaveLength(1)
    expect(calls[0]!.arguments).toContain(ARG_MARKER)
    expect(projected.content.some((b) => b.type === 'reasoning')).toBe(false)
  })

  it('collapses a tool-call-only assistant message to [turn archived]', async () => {
    const session = Session.create('turn-shell' as never, undefined, undefined, undefined, [turnProjection as never])
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: 'c1' as never, name: 'write', arguments: 'x'.repeat(500) }],
      source: { provider: 'test', model: 'test' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    const config = resolveConfig({ keepRecentTurns: 5 })
    await recordTurnFolds(session, { args: [], turns: planTurnArchives(session, 10, config) }, undefined, config)
    const projected = session.deriveMessages().find((m) => m.role === 'assistant')!
    expect(projected.content).toHaveLength(1)
    expect((projected.content[0] as { text: string }).text).toBe(TURN_ARCHIVED)
  })
})
