/**
 * `conversation.view` tab: what this plugin folded, what it saved, and the full
 * text behind each fold.
 *
 * ## Why the page reads from the server route, not the session log
 *
 * The browser client cannot walk a session log: the fold decisions are durable
 * plugin records, and the full original reasoning lives in the log's assistant
 * events. Both are server-side. The tab therefore renders exactly what
 * `/api/context-fold/report` returns and does no derivation of its own.
 *
 * ## What it shows, and how honestly
 *
 * The token comparison is a **counterfactual estimate**, not a measured A/B.
 * The "before" case never ran. The panel says so in the UI, lists the
 * assumptions the number depends on, and marks whether the session reported real
 * provider usage at all — because a number built on heuristics must not look
 * like a bill.
 *
 * The original text of every fold is shown on demand, fetched by its recovery
 * path, so the tab doubles as the answer to "what exactly did it remove".
 *
 * @module dsh-context-fold/client
 */

/** One fold row as the server reports it. */
export interface FoldRow {
  /** Surface seq. */
  seq: number
  /** `tool-result` or `reasoning`. */
  kind: 'tool-result' | 'reasoning'
  /** Turn it belonged to. */
  turn: number
  /** Step it belonged to. */
  step: number
  /** Tool name, for tool folds. */
  toolName?: string
  /** Characters before folding. */
  charsBefore: number
  /** Characters after folding. */
  charsAfter: number
  /** Estimated tokens before. */
  tokensBefore: number
  /** Estimated tokens after. */
  tokensAfter: number
  /** Spill path holding the full original, when one was written. */
  locator?: string
  /** The conclusion currently inline. */
  inline: string
  /** Whether the full original is still retrievable. */
  recoverable: boolean
}

/** The server's report payload. */
export interface FoldReportPayload {
  /** Every fold on the current surface. */
  folds: FoldRow[]
  /** The counterfactual comparison. */
  counterfactual: {
    tokensNow: number
    tokensIfUnfolded: number
    tokensSavedPerStep: number
    remainingSteps: number
    grossSaving: number
    invalidationCost: number
    netSaving: number
    actualPromptCost: number
    counterfactualPromptCost: number
    hasRealUsage: boolean
    cacheReadShare?: number
    assumptions: string[]
  }
  /** Re-read signals observed after each fold. */
  reReads: number
}

/** Minimal cordis client shape this plugin touches. */
interface ClientContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(descriptor: Record<string, unknown>, render: (props: unknown) => unknown): unknown
  }
  locale: {
    get(key: string): string
  }
}

/** Fetch the report for one session. */
async function fetchReport(sessionId: string): Promise<FoldReportPayload | undefined> {
  const response = await fetch('/api/context-fold/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as { ok?: boolean; value?: FoldReportPayload }
  return body.ok === true ? body.value : undefined
}

/** Fetch the full text behind one fold. */
async function fetchOriginal(sessionId: string, locator: string): Promise<string | undefined> {
  const response = await fetch('/api/context-fold/original', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, locator }),
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as { ok?: boolean; value?: { text: string } }
  return body.ok === true ? body.value?.text : undefined
}

/** Format a number for display. */
function num(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

/** A signed figure with an explicit sign, so a loss never looks like a gain. */
function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${num(rounded)}`
}

/**
 * Render the tab body.
 *
 * Deliberately plain DOM (no framework import): the plugin's render prop may be
 * called from any client runtime, and depending on a specific React bundle would
 * couple this package to one shell version.
 *
 * @param props - slot props carrying the active session id.
 * @returns an element or a node tree.
 */
function renderTab(props: unknown): unknown {
  const sessionId = (props as { sessionId?: string } | undefined)?.sessionId
  const root = document.createElement('div')
  root.className = 'context-fold-tab'
  root.style.cssText = 'padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;height:100%'

  const title = document.createElement('div')
  title.textContent = 'Context fold'
  title.style.cssText = 'font-weight:600;margin-bottom:8px'
  root.append(title)

  const status = document.createElement('div')
  status.style.cssText = 'color:#888'
  status.textContent = sessionId === undefined ? 'No active session.' : 'Loading…'
  root.append(status)

  if (sessionId !== undefined) {
    void fetchReport(sessionId).then((report) => {
      root.replaceChildren(title)
      if (report === undefined) {
        status.textContent = 'No report available for this session.'
        root.append(status)
        return
      }
      root.append(renderSummary(report), renderFolds(sessionId, report))
    })
  }
  return root
}

/** The counterfactual summary block. */
function renderSummary(report: FoldReportPayload): HTMLElement {
  const cf = report.counterfactual
  const box = document.createElement('section')
  box.style.cssText = 'margin-bottom:12px;padding:8px;border:1px solid #333;border-radius:6px'

  const heading = document.createElement('div')
  heading.textContent = 'Token comparison (estimate)'
  heading.style.cssText = 'font-weight:600;margin-bottom:6px'

  const rows: [string, string][] = [
    ['Folded content, now', `${num(cf.tokensNow)} tokens`],
    ['If it had stayed unfolded', `${num(cf.tokensIfUnfolded)} tokens`],
    ['Prompt reduction per step', `${num(cf.tokensSavedPerStep)} tokens`],
    ['Steps still paying the folded prompt', num(cf.remainingSteps)],
    ['Gross saving', signed(cf.grossSaving)],
    ['Prefix invalidation cost', signed(-cf.invalidationCost)],
    ['Net', signed(cf.netSaving)],
  ]
  const table = document.createElement('table')
  table.style.cssText = 'border-collapse:collapse'
  for (const [label, value] of rows) {
    const tr = document.createElement('tr')
    const th = document.createElement('td')
    th.textContent = label
    th.style.cssText = 'padding:1px 12px 1px 0;color:#aaa'
    const td = document.createElement('td')
    td.textContent = value
    if (label === 'Net') {
      // A negative net must read as a loss at a glance.
      td.style.cssText = `font-weight:600;color:${cf.netSaving >= 0 ? '#4ade80' : '#f87171'}`
    }
    tr.append(th, td)
    table.append(tr)
  }

  const freshness = document.createElement('div')
  freshness.style.cssText = 'margin-top:6px;color:#facc15'
  freshness.textContent = cf.hasRealUsage
    ? `Priced against this session's real usage${cf.cacheReadShare === undefined ? '' : ` (cache-read share ${(cf.cacheReadShare * 100).toFixed(1)}%)`}.`
    : 'This session reported NO provider usage — every figure here is heuristic token counts, not a bill.'

  const assumptions = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = 'Assumptions'
  summary.style.cssText = 'cursor:pointer;color:#888;margin-top:6px'
  assumptions.append(summary)
  const list = document.createElement('ul')
  list.style.cssText = 'margin:4px 0 0 16px;padding:0;color:#999'
  for (const assumption of cf.assumptions) {
    const item = document.createElement('li')
    item.textContent = assumption
    list.append(item)
  }
  assumptions.append(list)

  box.append(heading, table, freshness, assumptions)
  if (report.reReads > 0) {
    const reread = document.createElement('div')
    reread.style.cssText = 'margin-top:6px;color:#f87171'
    reread.textContent = `Re-read signals: ${String(report.reReads)} — folded content was fetched again after being folded.`
    box.append(reread)
  }
  return box
}

/** The per-fold list, with the original text expandable. */
function renderFolds(sessionId: string, report: FoldReportPayload): HTMLElement {
  const section = document.createElement('section')
  const heading = document.createElement('div')
  heading.textContent = `Folded content (${String(report.folds.length)})`
  heading.style.cssText = 'font-weight:600;margin-bottom:6px'
  section.append(heading)

  if (report.folds.length === 0) {
    const empty = document.createElement('div')
    empty.style.cssText = 'color:#888'
    empty.textContent = 'Nothing has been folded in this session yet.'
    section.append(empty)
    return section
  }

  for (const fold of report.folds) {
    const item = document.createElement('details')
    item.style.cssText = 'margin-bottom:6px;padding:6px;border:1px solid #2a2a2a;border-radius:6px'
    const summary = document.createElement('summary')
    summary.style.cssText = 'cursor:pointer'
    summary.textContent = `${fold.kind === 'reasoning' ? 'reasoning' : (fold.toolName ?? 'tool')} · turn ${String(fold.turn)}.${String(fold.step)} · ${num(fold.charsBefore)} → ${num(fold.charsAfter)} chars · ${fold.recoverable ? 'recoverable' : 'NOT recoverable'}`
    item.append(summary)

    const inline = document.createElement('pre')
    inline.textContent = fold.inline
    inline.style.cssText = 'white-space:pre-wrap;margin:6px 0;color:#bbb;max-height:12em;overflow:auto'
    item.append(inline)

    if (fold.locator !== undefined) {
      const path = document.createElement('div')
      path.textContent = fold.locator
      path.style.cssText = 'color:#666;font-size:11px;word-break:break-all'
      item.append(path)

      // Load lazily: the point of folding is that this text is expensive.
      item.addEventListener('toggle', () => {
        if (!item.open || item.dataset['loaded'] === '1') return
        item.dataset['loaded'] = '1'
        void fetchOriginal(sessionId, fold.locator!).then((text) => {
          const pre = document.createElement('pre')
          pre.textContent = text ?? '(could not read the stored original)'
          pre.style.cssText = 'white-space:pre-wrap;margin:6px 0;color:#ddd;max-height:24em;overflow:auto;border-top:1px dashed #333;padding-top:6px'
          item.append(pre)
        })
      })
    } else if (!fold.recoverable) {
      const warning = document.createElement('div')
      warning.textContent = 'No recovery path: the original is in the session log but no tool exposes it.'
      warning.style.cssText = 'color:#f87171;font-size:11px'
      item.append(warning)
    }
    section.append(item)
  }
  return section
}

/** Client plugin name. */
export const name = 'context-fold-client'

/** The tab needs the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Mount the conversation tab.
 *
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'context-fold',
        // After dsh-context's fleet tab (30) so the two read in a stable order.
        order: 40,
        label: () => ctx.locale.get('tab.contextFold'),
      },
      renderTab,
    ),
  )
}
