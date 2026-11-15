import { describe, expect, it } from 'vitest'

/**
 * The panel orders and filters folds client-side, which is pure logic worth
 * pinning: a wrong sort puts the newest fold at the bottom of a long session,
 * and a wrong filter silently hides rows the reader asked to see.
 *
 * These mirror the helpers in `src/client.ts`. They are duplicated rather than
 * imported because the client module assumes a browser `window` at load time.
 */
interface FoldRow {
  seq: number
  kind: 'tool-result' | 'reasoning'
  turn: number
  step: number
  toolName?: string
  inline: string
  locator?: string
}

/** Newest first: turn, then step, then seq. */
function orderFolds(folds: FoldRow[]): FoldRow[] {
  return [...folds].sort((a, b) => b.turn - a.turn || b.step - a.step || b.seq - a.seq)
}

/** Distinct turns, newest first. */
function turnsOf(folds: FoldRow[]): number[] {
  return [...new Set(folds.map((fold) => fold.turn))].sort((a, b) => b - a)
}

/** Compose kind filter, turn filter and free-text search. */
function filterFolds(
  folds: FoldRow[],
  opts: { kind?: 'all' | FoldRow['kind']; turn?: number | 'all'; query?: string } = {},
): FoldRow[] {
  const kind = opts.kind ?? 'all'
  const turn = opts.turn ?? 'all'
  const needle = (opts.query ?? '').trim().toLowerCase()
  return folds.filter((fold) => {
    if (kind !== 'all' && fold.kind !== kind) return false
    if (turn !== 'all' && fold.turn !== turn) return false
    if (needle === '') return true
    const haystack = `${fold.toolName ?? ''}\n${fold.inline}\n${fold.locator ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
}

const row = (over: Partial<FoldRow> & { seq: number; turn: number; step: number }): FoldRow => ({
  kind: 'tool-result',
  inline: '',
  ...over,
})

const sample: FoldRow[] = [
  row({ seq: 1, turn: 1, step: 1, toolName: 'ops_bash', inline: 'first', locator: '/spill/a.txt' }),
  row({ seq: 2, turn: 3, step: 2, toolName: 'ops_grep', inline: 'third', locator: '/spill/b.txt' }),
  row({ seq: 3, turn: 2, step: 1, kind: 'reasoning', inline: 'second' }),
  row({ seq: 4, turn: 3, step: 5, toolName: 'read', inline: 'newest' }),
]

describe('fold list ordering', () => {
  it('puts the newest fold first', () => {
    expect(orderFolds(sample).map((fold) => fold.seq)).toEqual([4, 2, 3, 1])
  })

  it('keeps same-turn folds ordered by step, newest step first', () => {
    const sameTurn = [
      row({ seq: 10, turn: 5, step: 1 }),
      row({ seq: 11, turn: 5, step: 9 }),
      row({ seq: 12, turn: 5, step: 4 }),
    ]
    expect(orderFolds(sameTurn).map((fold) => fold.seq)).toEqual([11, 12, 10])
  })

  it('does not mutate the caller array', () => {
    const input = [...sample]
    orderFolds(input)
    expect(input.map((fold) => fold.seq)).toEqual([1, 2, 3, 4])
  })

  it('lists turns newest first', () => {
    expect(turnsOf(sample)).toEqual([3, 2, 1])
  })
})

describe('fold list filtering', () => {
  it('filters by kind', () => {
    expect(filterFolds(sample, { kind: 'reasoning' }).map((fold) => fold.seq)).toEqual([3])
    expect(filterFolds(sample, { kind: 'tool-result' }).map((fold) => fold.seq)).toEqual([1, 2, 4])
  })

  it('filters by turn', () => {
    expect(filterFolds(sample, { turn: 3 }).map((fold) => fold.seq)).toEqual([2, 4])
  })

  it('searches the conclusion, the tool name and the path', () => {
    expect(filterFolds(sample, { query: 'newest' }).map((fold) => fold.seq)).toEqual([4])
    expect(filterFolds(sample, { query: 'ops_grep' }).map((fold) => fold.seq)).toEqual([2])
    expect(filterFolds(sample, { query: '/spill/a.txt' }).map((fold) => fold.seq)).toEqual([1])
  })

  it('composes search with the kind and turn filters', () => {
    expect(filterFolds(sample, { query: 'spill', turn: 3 }).map((fold) => fold.seq)).toEqual([2])
    expect(filterFolds(sample, { query: 'spill', kind: 'reasoning' })).toEqual([])
  })

  it('treats a blank or whitespace query as no filter', () => {
    expect(filterFolds(sample, { query: '   ' })).toHaveLength(sample.length)
  })
})
