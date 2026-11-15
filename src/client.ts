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
 * ## How this file is shipped
 *
 * `tsdown` wraps the output in the shell's module-factory form
 * (`window.__ModuleLoader__.load({id, factory(require){…}})`), which is the only
 * shape the client module system executes. Imports are therefore converted into
 * `require` calls resolved against the shared platform module table, and the
 * plugin's exports (`name`/`inject`/`apply`) are what the factory returns.
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

/**
 * The shell hands this bundle its `require` through the module factory, and
 * resolves bare ids such as `react` against the shared platform module table.
 */
declare function require(id: string): unknown

/** The slice of the React runtime a tab needs. */
interface ReactFace {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (next: T) => void]
  useRef<T>(value: T): { current: T }
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** Minimal cordis client shape this plugin touches. */
interface ClientContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(descriptor: Record<string, unknown>, render: (props: unknown) => unknown): unknown
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string) => string
  }
  effect?(run: () => unknown, label?: string): unknown
}

/** Locale namespace owned by this plugin's client half. */
const NS = 'contextFold'

/** Dictionary: keep keys aligned with `locale/*.json`. */
const zh: Record<string, string> = {
  'tab.contextFold': '上下文折叠',
}

/** Dictionary: keep keys aligned with `locale/*.json`. */
const en: Record<string, string> = {
  'tab.contextFold': 'Context fold',
}

const react = require('react') as ReactFace

/**
 * Fetch the report for one session.
 *
 * Failures are reported rather than swallowed: before the routes existed the
 * tab rendered "no report available", which reads like "this session folded
 * nothing" instead of "the request never landed".
 *
 * @param sessionId - session to report on.
 * @returns the payload, or a message describing why there is none.
 */
async function fetchReport(sessionId: string): Promise<{ report: FoldReportPayload } | { error: string }> {
  // Absolute: these are the exact paths the server registers on the connection
  // route registry, and the shell serves the GUI from the origin root.
  let response: Response
  try {
    response = await fetch('/api/context-fold/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch (error) {
    return { error: `request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const body = (await response.json().catch(() => undefined)) as
    | { ok?: boolean; value?: FoldReportPayload; error?: string }
    | undefined
  if (!response.ok) {
    return { error: body?.error ?? `HTTP ${String(response.status)}` }
  }
  if (body?.ok !== true || body.value === undefined) {
    return { error: body?.error ?? 'the server returned no value' }
  }
  return { report: body.value }
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

/** Cached per-session report, so re-renders do not refetch on every paint. */
interface ReportState {
  /** `loading` until the first response lands. */
  status: 'loading' | 'ready' | 'empty' | 'error'
  /** The payload when `status === 'ready'`. */
  report?: FoldReportPayload
  /** The server's or the transport's complaint when `status === 'error'`. */
  error?: string
}

/** Read the active session id out of the slot props. */
function sessionIdOf(props: unknown): string | undefined {
  const value = (props as { sessionId?: unknown } | undefined)?.sessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Inline styles, kept as plain objects because no CSS module ships here. */
const styles = {
  root: { padding: '12px', font: '13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace', overflow: 'auto', height: '100%' },
  title: { fontWeight: 600, marginBottom: '8px' },
  muted: { color: '#888' },
  box: { marginBottom: '12px', padding: '8px', border: '1px solid #333', borderRadius: '6px' },
  heading: { fontWeight: 600, marginBottom: '6px' },
  table: { borderCollapse: 'collapse' as const },
  labelCell: { padding: '1px 12px 1px 0', color: '#aaa' },
  warning: { marginTop: '6px', color: '#facc15' },
  error: { marginTop: '6px', color: '#f87171' },
  reread: { marginTop: '6px', color: '#f87171' },
  fold: { marginBottom: '6px', padding: '6px', border: '1px solid #2a2a2a', borderRadius: '6px' },
  foldSummary: { cursor: 'pointer' },
  inlinePre: { whiteSpace: 'pre-wrap' as const, margin: '6px 0', color: '#bbb', maxHeight: '12em', overflow: 'auto' },
  originalPre: {
    whiteSpace: 'pre-wrap' as const,
    margin: '6px 0',
    color: '#ddd',
    maxHeight: '24em',
    overflow: 'auto',
    borderTop: '1px dashed #333',
    paddingTop: '6px',
  },
  locator: { color: '#666', fontSize: '11px', wordBreak: 'break-all' as const },
  notRecoverable: { color: '#f87171', fontSize: '11px' },
  detailsToggle: { cursor: 'pointer', color: '#888', marginTop: '6px' },
  assumptionList: { margin: '4px 0 0 16px', padding: 0, color: '#999' },
}

/** The counterfactual summary block. */
function Summary(props: { report: FoldReportPayload }): unknown {
  const cf = props.report.counterfactual
  const rows: [string, string][] = [
    ['Folded content, now', `${num(cf.tokensNow)} tokens`],
    ['If it had stayed unfolded', `${num(cf.tokensIfUnfolded)} tokens`],
    ['Prompt reduction per step', `${num(cf.tokensSavedPerStep)} tokens`],
    ['Steps still paying the folded prompt', num(cf.remainingSteps)],
    ['Gross saving', signed(cf.grossSaving)],
    ['Prefix invalidation cost', signed(-cf.invalidationCost)],
    ['Net', signed(cf.netSaving)],
  ]
  return react.createElement(
    'section',
    { style: styles.box },
    react.createElement('div', { style: styles.heading, key: 'h' }, 'Token comparison (estimate)'),
    react.createElement(
      'table',
      { style: styles.table, key: 't' },
      ...rows.map(([label, value]) =>
        react.createElement(
          'tr',
          { key: label },
          react.createElement('td', { style: styles.labelCell }, label),
          react.createElement(
            'td',
            // A negative net must read as a loss at a glance.
            label === 'Net'
              ? { style: { fontWeight: 600, color: cf.netSaving >= 0 ? '#4ade80' : '#f87171' } }
              : null,
            value,
          ),
        ),
      ),
    ),
    react.createElement(
      'div',
      { style: styles.warning, key: 'f' },
      cf.hasRealUsage
        ? `Priced against this session's real usage${cf.cacheReadShare === undefined ? '' : ` (cache-read share ${(cf.cacheReadShare * 100).toFixed(1)}%)`}.`
        : 'This session reported NO provider usage — every figure here is heuristic token counts, not a bill.',
    ),
    react.createElement(
      'details',
      { key: 'a' },
      react.createElement('summary', { style: styles.detailsToggle }, 'Assumptions'),
      react.createElement(
        'ul',
        { style: styles.assumptionList },
        ...cf.assumptions.map((assumption, index) => react.createElement('li', { key: String(index) }, assumption)),
      ),
    ),
    props.report.reReads > 0
      ? react.createElement(
          'div',
          { style: styles.reread, key: 'r' },
          `Re-read signals: ${String(props.report.reReads)} — folded content was fetched again after being folded.`,
        )
      : null,
  )
}

/** One fold row; the original text loads when the row is opened. */
function FoldItem(props: { sessionId: string; fold: FoldRow }): unknown {
  const { fold, sessionId } = props
  const [original, setOriginal] = react.useState<string | null>(null)

  const onToggle = (event: { currentTarget?: { open?: boolean } }): void => {
    // The point of folding is that this text is expensive: fetch it once, and
    // only when the reader actually opens the row.
    if (event.currentTarget?.open !== true || original !== null) return
    const locator = fold.locator
    if (locator === undefined) return
    setOriginal('')
    void fetchOriginal(sessionId, locator).then((text) => {
      setOriginal(text ?? '(could not read the stored original)')
    })
  }

  const label = fold.kind === 'reasoning' ? 'reasoning' : (fold.toolName ?? 'tool')
  const summary = `${label} · turn ${String(fold.turn)}.${String(fold.step)} · ${num(fold.charsBefore)} → ${num(fold.charsAfter)} chars · ${fold.recoverable ? 'recoverable' : 'NOT recoverable'}`

  const children: unknown[] = [
    react.createElement('summary', { style: styles.foldSummary, key: 's' }, summary),
    react.createElement('pre', { style: styles.inlinePre, key: 'i' }, fold.inline),
  ]
  if (fold.locator !== undefined) {
    children.push(react.createElement('div', { style: styles.locator, key: 'l' }, fold.locator))
    if (original !== null) {
      children.push(react.createElement('pre', { style: styles.originalPre, key: 'o' }, original))
    }
  } else if (!fold.recoverable) {
    children.push(
      react.createElement(
        'div',
        { style: styles.notRecoverable, key: 'w' },
        'No recovery path: the original is in the session log but no tool exposes it.',
      ),
    )
  }

  return react.createElement('details', { style: styles.fold, onToggle }, ...children)
}

/** The per-fold list. */
function FoldList(props: { sessionId: string; report: FoldReportPayload }): unknown {
  const { report, sessionId } = props
  const heading = react.createElement(
    'div',
    { style: styles.heading, key: 'h' },
    `Folded content (${String(report.folds.length)})`,
  )
  if (report.folds.length === 0) {
    return react.createElement(
      'section',
      null,
      heading,
      react.createElement('div', { style: styles.muted, key: 'e' }, 'Nothing has been folded in this session yet.'),
    )
  }
  return react.createElement(
    'section',
    null,
    heading,
    ...report.folds.map((fold) => react.createElement(FoldItem, { key: String(fold.seq), sessionId, fold })),
  )
}

/**
 * The tab body.
 *
 * The active session id arrives through the standard slot props, and the report
 * is refetched whenever that id changes because the tab outlives navigation.
 */
function ContextFoldTab(props: unknown): unknown {
  const sessionId = sessionIdOf(props)
  const [state, setState] = react.useState<ReportState>({ status: 'loading' })

  react.useEffect(() => {
    if (sessionId === undefined) {
      setState({ status: 'empty' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void fetchReport(sessionId).then((result) => {
      if (cancelled) return
      setState('report' in result ? { status: 'ready', report: result.report } : { status: 'error', error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const children: unknown[] = [react.createElement('div', { style: styles.title, key: 'title' }, 'Context fold')]
  if (sessionId === undefined) {
    children.push(react.createElement('div', { style: styles.muted, key: 'm' }, 'No active session.'))
  } else if (state.status === 'loading') {
    children.push(react.createElement('div', { style: styles.muted, key: 'm' }, 'Loading…'))
  } else if (state.status === 'error') {
    children.push(
      react.createElement('div', { style: styles.error, key: 'e' }, `Could not load the report: ${state.error ?? 'unknown'}`),
    )
  } else if (state.status !== 'ready' || state.report === undefined) {
    children.push(
      react.createElement('div', { style: styles.muted, key: 'm' }, 'This session has no folds to report.'),
    )
  } else {
    children.push(react.createElement(Summary, { key: 'summary', report: state.report }))
    children.push(react.createElement(FoldList, { key: 'folds', sessionId, report: state.report }))
  }
  return react.createElement('div', { className: 'context-fold-tab', style: styles.root }, ...children)
}

/** Client plugin name. */
export const name = 'context-fold-client'

/** The tab needs the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Mount the conversation tab.
 *
 * Dictionaries are registered from inside this bundle: the locale service reads
 * them from the plugin registry, not from `locale/*.json` on disk.
 *
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  const registerDictionaries = (): void => {
    ctx.locale.register(NS, { zh, en })
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(registerDictionaries, 'context-fold: dictionaries')
  } else {
    registerDictionaries()
  }

  const t = (key: string): string => {
    // Fall back to the English dictionary so a missing service never renders a
    // raw key in the tab strip.
    try {
      return ctx.locale.bind(NS)(key) || (en[key] ?? key)
    } catch {
      return en[key] ?? key
    }
  }

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'context-fold',
        // After dsh-context's fleet tab (30) so the two read in a stable order.
        order: 40,
        locale: NS,
        label: () => t('tab.contextFold'),
      },
      ContextFoldTab,
    ),
  )
}
