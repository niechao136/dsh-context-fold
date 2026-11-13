/**
 * Server routes backing the `conversation.view` tab.
 *
 * Two endpoints:
 *
 * - `/api/context-fold/report` — what is folded, what it cost, and the
 *   counterfactual comparison.
 * - `/api/context-fold/original` — the full text behind one fold, read back
 *   through its recovery path.
 *
 * Both are read-only. The report does no caching of its own: it re-derives from
 * the session log each time, so what the tab shows can never drift from what the
 * model actually saw.
 *
 * @module dsh-context-fold/routes
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import { counterfactualOf, usageOf, type FoldedSaving } from './counterfactual.ts'
import { reportOf } from './measure.ts'
import { reasoningDecisions } from './reasoning.ts'

/** A minimal JSON response. */
export interface RouteReply {
  ok: boolean
  value?: unknown
  error?: string
}

/** One fold row as the tab consumes it. */
export interface FoldRow {
  seq: number
  kind: 'tool-result' | 'reasoning'
  turn: number
  step: number
  toolName?: string
  charsBefore: number
  charsAfter: number
  tokensBefore: number
  tokensAfter: number
  locator?: string
  inline: string
  recoverable: boolean
}

/** The `/report` payload. */
export interface ReportValue {
  folds: FoldRow[]
  counterfactual: ReturnType<typeof counterfactualOf>
  reReads: number
}

/** What a route handler receives. */
export interface RouteDeps {
  /** Resolve a live session by id. */
  sessionOf(id: string): Session | undefined
  /** Price one message, from the token meter. */
  estimateMessage(message: never): number
  /** Spill store, for reading originals back. */
  spillStore?: SpillStore
}

/**
 * Extract the spill locator a folded node's text carries.
 *
 * Phase 1 writes `Full result: <path>`; phase 2 writes `Full text: <path> —`.
 *
 * @param text - folded node text.
 * @returns the locator, or undefined when the fold has no recovery path.
 */
export function locatorOf(text: string): string | undefined {
  // The path is followed by prose in phase 2 (`— use read …`), so match the
  // token and stop. No `^` anchor: the hint may sit at the end of a long line.
  const match = /(?:Full result|Full text): (\S+)/.exec(text)
  return match?.[1]
}

/**
 * Build the `/report` payload for one session.
 *
 * @param session - session to inspect.
 * @param deps - token meter and spill access.
 * @returns the payload the tab renders.
 */
export function buildReport(session: Session, deps: RouteDeps): ReportValue {
  const tool = reportOf(session)
  const decisions = reasoningDecisions(session)
  const folds: FoldRow[] = []

  // Tool-result folds come from the surface: their current text is the fold.
  for (const fold of tool.folds) {
    const event = session.eventAt(fold.seq as never)
    const message = event === undefined ? null : session.deriveEventMessage(event)
    const content = message !== null && message.role === 'tool' ? message.content : undefined
    const tokensAfter = content === undefined ? 0 : deps.estimateMessage(content as never)
    const inline = inlineTextOf(content) ?? ''
    const locator = locatorOf(inline)
    folds.push({
      seq: fold.seq,
      kind: 'tool-result',
      turn: fold.turn,
      step: fold.step,
      toolName: fold.toolName,
      charsBefore: fold.charsBefore,
      charsAfter: fold.charsAfter,
      tokensBefore: estimateFromChars(fold.charsBefore),
      tokensAfter,
      inline,
      recoverable: locator !== undefined,
      ...(locator === undefined ? {} : { locator }),
    })
  }

  // Reasoning folds come from the decision records, which carry the indexes and
  // locators; the current text is what the projection produced.
  for (const decision of decisions) {
    for (const target of decision.targets) {
      const event = session.eventAt(target.seq)
      const message = event === undefined ? null : session.deriveEventMessage(event)
      if (message === null || message.role !== 'assistant') continue
      const assistantEvent = session.eventAt(target.seq)
      const turn = assistantEvent?.type === 'assistant/message' ? assistantEvent.data.turn : 0
      const step = assistantEvent?.type === 'assistant/message' ? assistantEvent.data.step : 0
      for (const [position, index] of target.indexes.entries()) {
        const block = message.content[index]
        if (block === undefined || block.type !== 'reasoning') continue
        const locator = target.locators?.[position]
        folds.push({
          seq: target.seq,
          kind: 'reasoning',
          turn,
          step,
          charsBefore: target.chars?.[position] ?? 0,
          charsAfter: Array.from(block.text).length,
          tokensBefore: estimateFromChars(target.chars?.[position] ?? 0),
          tokensAfter: deps.estimateMessage([{ type: 'text', text: block.text }] as never),
          inline: block.text,
          recoverable: locator !== undefined,
          ...(locator === undefined ? {} : { locator }),
        })
      }
    }
  }

  const savings: FoldedSaving[] = folds.map((fold) => ({
    seq: fold.seq,
    kind: fold.kind,
    charsBefore: fold.charsBefore,
    charsAfter: fold.charsAfter,
    tokensBefore: fold.tokensBefore,
    tokensAfter: fold.tokensAfter,
  }))
  const steps = usageOf(session.snapshotEvents() as never)
  const foldSteps = folds.map((fold) => fold.step).filter((step) => step > 0)

  return {
    folds,
    counterfactual: counterfactualOf(savings, steps, { foldSteps }),
    reReads: tool.reReads,
  }
}

/** Text of a tool message's single result block. */
function inlineTextOf(content: readonly { type: string; text?: string }[] | undefined): string | undefined {
  if (content === undefined) return undefined
  let text = ''
  for (const block of content) if (block.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

/**
 * Approximate tokens from a character count.
 *
 * Only used for the *before* side, where the text is gone. The ratio matches the
 * token meter's own CJK-aware heuristic closely enough for an estimate that is
 * already labelled as one.
 */
function estimateFromChars(chars: number): number {
  return Math.round(chars / 3.5)
}

/**
 * Read the full original behind one fold.
 *
 * @param deps - spill access.
 * @param locator - recovery path recorded on the fold.
 * @returns the text, or undefined when it cannot be read.
 */
export async function readOriginal(deps: RouteDeps, locator: string): Promise<string | undefined> {
  if (deps.spillStore === undefined) return undefined
  const reader = deps.spillStore as unknown as { readText?(locator: string): Promise<string> }
  if (typeof reader.readText !== 'function') return undefined
  try {
    return await reader.readText(locator)
  } catch {
    return undefined
  }
}

/** Box a successful value. */
export function ok(value: unknown): RouteReply {
  return { ok: true, value }
}

/** Box a failure. */
export function fail(error: string): RouteReply {
  return { ok: false, error }
}

/** Minimal shape of the host's `connection` route registry. */
export interface ConnectionRoutes {
  (definition: { path: string; methods: string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }): () => void
}

/** JSON response matching the host's own convention. */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Register the two read-only routes the tab uses.
 *
 * @param register - the host route registrar.
 * @param deps - session and spill access.
 * @returns a disposer for both routes.
 */
export function registerRoutes(register: ConnectionRoutes, deps: RouteDeps): () => void {
  const report = register({
    path: '/api/context-fold/report',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      let body: { sessionId?: unknown }
      try {
        body = (await request.json()) as { sessionId?: unknown }
      } catch {
        return json(fail('body is not JSON'), 400)
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return json(fail('missing sessionId'), 400)
      const session = deps.sessionOf(sessionId)
      if (session === undefined) return json(fail(`unknown session ${sessionId}`), 404)
      try {
        return json(ok(buildReport(session, deps)))
      } catch (error) {
        return json(fail(error instanceof Error ? error.message : String(error)), 500)
      }
    },
  })

  const original = register({
    path: '/api/context-fold/original',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      let body: { locator?: unknown }
      try {
        body = (await request.json()) as { locator?: unknown }
      } catch {
        return json(fail('body is not JSON'), 400)
      }
      const locator = typeof body.locator === 'string' ? body.locator : ''
      if (locator === '') return json(fail('missing locator'), 400)
      try {
        const text = await readOriginal(deps, locator)
        return text === undefined ? json(fail('original not readable'), 404) : json(ok({ text }))
      } catch (error) {
        return json(fail(error instanceof Error ? error.message : String(error)), 500)
      }
    },
  })

  return () => {
    report()
    original()
  }
}
