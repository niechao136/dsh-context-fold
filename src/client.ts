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
import { enDictionary, zhDictionary } from './client-dictionaries.ts'
import { ensurePanelCss } from './panel-css.ts'
import {
  SETTINGS_NS,
  ensureSettingsCss,
  registerSettingsPage,
  settingsDictionaries,
  type SettingsPageContext,
} from './settings-page.ts'

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
  /** Tool-call argument folds (scheme B). */
  argFolds?: readonly { seq: number; blocks: number; charsBefore: number }[]
  /** Archived turns. */
  turnArchives?: readonly { turn: number; messages: number; locator?: string }[]
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
  /** Remote namespaces; `settings` backs the configuration page. */
  remote?: SettingsPageContext['remote']
  effect?(run: () => unknown, label?: string): unknown
}

/** Locale namespace owned by this plugin's client half. */
const NS = 'contextFold'



const react = require('react') as ReactFace

/**
 * Build a translator bound to this plugin's namespace.
 *
 * Resolution order is: the shell's locale service, then the Chinese dictionary,
 * then English, then the raw key. Chinese comes before English on purpose — the
 * dictionaries are written zh-first, and a shell whose locale service is missing
 * or still loading should not silently downgrade the UI to English.
 *
 * `{name}` placeholders are substituted from `params`, which keeps word order
 * translatable instead of concatenating fragments at the call site.
 *
 * @param ctx - client context supplying the locale service.
 * @returns a `t(key, params)` function.
 */
function makeTranslator(ctx: ClientContext): (key: string, params?: Record<string, string | number>) => string {
  let bound: ((key: string) => string) | undefined
  try {
    bound = ctx.locale.bind(NS)
  } catch {
    // A missing locale service must not break the page; fall through to the
    // bundled dictionaries.
    bound = undefined
  }
  return (key, params) => {
    let text: string | undefined
    if (bound !== undefined) {
      try {
        const resolved = bound(key)
        if (typeof resolved === 'string' && resolved !== '' && resolved !== key) text = resolved
      } catch {
        // Ignore a throwing lookup and use the bundled text.
      }
    }
    text ??= zhDictionary[key] ?? enDictionary[key] ?? key
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  }
}

/** Translator signature. */
type Translator = (key: string, params?: Record<string, string | number>) => string

/** Placeholder helper kept for readability at call sites. */
const translate = makeTranslator

/** Fetch the report for one session. */
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

/** Format a number with thousands separators and at most one decimal. */
function num(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

/** A signed figure with an explicit sign, so a loss never reads as a gain. */
function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${num(rounded)}`
}

/** Compact token count: 1.2M rather than 1200000. */
function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return num(value)
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

const el = react.createElement

/** One labelled metric tile. */
function Metric(props: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' }): unknown {
  const toneClass = props.tone === undefined ? '' : ` cf-${props.tone}`
  const children: unknown[] = [
    el('div', { className: 'cf-metric-label', key: 'l' }, props.label),
    el('div', { className: `cf-metric-value${toneClass}`, key: 'v' }, props.value),
  ]
  if (props.sub !== undefined) children.push(el('div', { className: 'cf-metric-sub', key: 's' }, props.sub))
  return el('div', { className: 'cf-metric' }, ...children)
}

/** A notice strip, optionally warning-toned. */
function Notice(props: { children: unknown; warn?: boolean }): unknown {
  return el('div', { className: props.warn === true ? 'cf-notice cf-notice-warn' : 'cf-notice' }, props.children)
}

/** The counterfactual summary card. */
function Summary(props: { report: FoldReportPayload; t: Translator }): unknown {
  const t = props.t
  const cf = props.report.counterfactual
  const savedChars = props.report.folds.reduce((total, fold) => total + (fold.charsBefore - fold.charsAfter), 0)
  const netTone = cf.netSaving >= 0 ? 'good' : 'bad'

  return el(
    'section',
    { className: 'cf-card' },
    el('div', { className: 'cf-card-title', key: 'h' }, t('summary.title')),
    el(
      'div',
      { className: 'cf-grid', key: 'g' },
      el(Metric, {
        key: 'now',
        label: t('summary.now.label'),
        value: `${compact(cf.tokensNow)} tok`,
        sub: t('summary.now.sub'),
      }),
      el(Metric, {
        key: 'before',
        label: t('summary.before.label'),
        value: `${compact(cf.tokensIfUnfolded)} tok`,
        sub: t('summary.before.sub'),
      }),
      el(Metric, {
        key: 'per',
        label: t('summary.perStep.label'),
        value: `${num(cf.tokensSavedPerStep)} tok`,
        sub: t('summary.perStep.sub', { n: num(cf.remainingSteps) }),
      }),
      el(Metric, {
        key: 'gross',
        label: t('summary.gross.label'),
        value: signed(cf.grossSaving),
        sub: t('summary.gross.sub'),
        tone: cf.grossSaving >= 0 ? 'good' : 'bad',
      }),
      el(Metric, {
        key: 'cost',
        label: t('summary.cost.label'),
        value: signed(-cf.invalidationCost),
        sub: t('summary.cost.sub'),
        tone: 'warn',
      }),
      el(Metric, {
        key: 'net',
        label: t('summary.net.label'),
        value: signed(cf.netSaving),
        sub: cf.netSaving >= 0 ? t('summary.net.win') : t('summary.net.loss'),
        tone: netTone,
      }),
    ),
    el(
      'div',
      { style: { marginTop: '12px' }, key: 'n' },
      el(
        Notice,
        {
          warn: !cf.hasRealUsage,
        },
        el(
          'span',
          null,
          cf.hasRealUsage
            ? el(
                'span',
                null,
                el('span', { className: 'cf-notice-strong' }, t('summary.realUsage')),
                ' ',
                t('summary.cacheShare', {
                  pct: cf.cacheReadShare === undefined ? 'n/a' : (cf.cacheReadShare * 100).toFixed(1),
                }),
              )
            : el(
                'span',
                null,
                el('span', { className: 'cf-notice-strong' }, t('summary.heuristic')),
                ' ',
                t('summary.heuristicDetail'),
              ),
        ),
      ),
    ),
    el(
      'div',
      { className: 'cf-aside', style: { marginTop: '10px' }, key: 'a' },
      t('summary.charsRemoved', {
        chars: num(savedChars),
        n: String(props.report.folds.length),
      }),
    ),
    (props.report.argFolds?.length ?? 0) > 0
      ? el(
          'div',
          { className: 'cf-aside', style: { marginTop: '4px' }, key: 'args' },
          t('summary.argFolds', {
            n: String(props.report.argFolds?.length ?? 0),
            blocks: num((props.report.argFolds ?? []).reduce((total, fold) => total + fold.blocks, 0)),
            chars: num((props.report.argFolds ?? []).reduce((total, fold) => total + fold.charsBefore, 0)),
          }),
        )
      : null,
    (props.report.turnArchives?.length ?? 0) > 0
      ? el(
          'div',
          { className: 'cf-aside', style: { marginTop: '4px' }, key: 'turns' },
          t('summary.turnArchives', {
            n: String(props.report.turnArchives?.length ?? 0),
            turns: (props.report.turnArchives ?? []).map((archive) => `T${String(archive.turn)}`).join(', '),
            messages: num((props.report.turnArchives ?? []).reduce((total, archive) => total + archive.messages, 0)),
          }),
        )
      : null,
    props.report.reReads > 0
      ? el(
          'div',
          { className: 'cf-notice cf-notice-warn', style: { marginTop: '10px' }, key: 'r' },
          el(
            'span',
            null,
            el('span', { className: 'cf-notice-strong' }, t('summary.reReads', { n: String(props.report.reReads) })),
            ' ',
            t('summary.reReadsDetail'),
          ),
        )
      : null,
    el('details', { key: 'asm', style: { marginTop: '10px' } }, el('summary', { className: 'cf-aside' }, t('summary.assumptions')), el('ul', { style: { margin: '6px 0 0 18px', padding: 0 }, }, ...cf.assumptions.map((assumption, index) => el('li', { className: 'cf-aside', key: String(index) }, assumption)))),
  )
}

/** One fold row; the original text loads when the row is opened. */
function FoldItem(props: { sessionId: string; fold: FoldRow; t: Translator }): unknown {
  const { fold, sessionId } = props
  const t = props.t
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

  const isReasoning = fold.kind === 'reasoning'
  const tagClass = isReasoning ? 'cf-tag cf-tag-reasoning' : 'cf-tag'
  const saved = fold.tokensBefore - fold.tokensAfter

  const body: unknown[] = [
    el('div', { className: 'cf-fold-body', key: 'b' },
      el('div', { className: 'cf-label' }, t('fold.stays')),
      el('pre', { className: 'cf-pre' }, fold.inline),
      fold.locator !== undefined
        ? el('div', null,
            el('div', { className: 'cf-label' }, t('fold.original')),
            original === null
              ? el('div', { className: 'cf-aside' }, t('fold.expandHint'))
              : el('pre', { className: 'cf-pre cf-pre-original' }, original),
            el('div', { className: 'cf-locator' }, fold.locator),
          )
        : el('div', { className: 'cf-aside cf-bad', style: { marginTop: '8px' } },
            t('fold.noRecovery')),
    ),
  ]

  const children: unknown[] = [
    el('summary', { className: 'cf-fold-head', key: 'h' },
      el('span', { className: 'cf-caret' }, '▶'),
      el('span', { className: tagClass }, isReasoning ? t('fold.reasoning') : (fold.toolName ?? 'tool')),
      el('span', { className: 'cf-fold-pos' }, t('fold.pos', { t: String(fold.turn), s: String(fold.step) })),
      el('span', { className: 'cf-fold-pos' }, t('fold.chars', { before: compact(fold.charsBefore), after: compact(fold.charsAfter) })),
      el('span', { className: 'cf-fold-saving' }, t('fold.saved', { n: compact(Math.max(0, saved)) })),
    ),
  ]
  children.push(...body)

  return el('details', { className: 'cf-fold', onToggle }, ...children)
}

/** The per-fold list card. */
/**
 * The per-fold list: searchable, filterable, and paged by turn.
 *
 * Ordering is newest-first. A fold log is read from the live end — "what just
 * got folded?" is the common question — so the highest turn/step sorts to the
 * top rather than making the reader scroll to the bottom of a long session.
 *
 * Paging is by *turn*, not by row count: folds cluster per turn, and jumping to
 * "turn 4" is how someone reasons about a conversation. A turn filter narrows
 * the same list rather than a separate view, so search and filter compose.
 */
function FoldList(props: { sessionId: string; report: FoldReportPayload; t: Translator }): unknown {
  const { report, sessionId } = props
  const t = props.t
  const [query, setQuery] = react.useState('')
  const [kind, setKind] = react.useState<'all' | FoldRow['kind']>('all')
  const [turn, setTurn] = react.useState<number | 'all'>('all')

  const folds = report.folds
  const title = el('div', { className: 'cf-card-title', key: 'h' }, `${t('list.title')} · ${String(folds.length)}`)

  if (folds.length === 0) {
    return el(
      'section',
      { className: 'cf-card' },
      title,
      el(
        'div',
        { className: 'cf-empty', key: 'e' },
        el('div', { className: 'cf-empty-title' }, t('list.empty.title')),
        el('div', null, t('list.empty.hint')),
      ),
    )
  }

  // Newest first, then a stable tiebreak on seq so a re-render never reorders
  // rows the reader is looking at.
  const ordered = [...folds].sort((a, b) => b.turn - a.turn || b.step - a.step || b.seq - a.seq)

  const turns = [...new Set(ordered.map((fold) => fold.turn))].sort((a, b) => b - a)
  const needle = query.trim().toLowerCase()
  const visible = ordered.filter((fold) => {
    if (kind !== 'all' && fold.kind !== kind) return false
    if (turn !== 'all' && fold.turn !== turn) return false
    if (needle === '') return true
    // Match on the inline conclusion, the tool name, and the locator: those are
    // the three things a reader actually searches for after the fact.
    const haystack = `${fold.toolName ?? ''}\n${fold.inline}\n${fold.locator ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })

  const reasoningCount = ordered.filter((fold) => fold.kind === 'reasoning').length
  const toolCount = ordered.length - reasoningCount

  const controls = el(
    'div',
    { className: 'cf-controls', key: 'c' },
    el('input', {
      className: 'cf-search',
      type: 'search',
      placeholder: t('list.search'),
      value: query,
      onInput: (event: { currentTarget?: { value?: string } }) => setQuery(event.currentTarget?.value ?? ''),
    }),
    el(
      'div',
      { className: 'cf-seg' },
      ...[
        ['all', t('list.filter.all', { n: String(ordered.length) })],
        ['tool-result', t('list.filter.tool', { n: String(toolCount) })],
        ['reasoning', t('list.filter.reasoning', { n: String(reasoningCount) })],
      ].map(([value, label]) =>
        el(
          'button',
          {
            key: String(value),
            type: 'button',
            className: kind === value ? 'cf-seg-btn cf-seg-on' : 'cf-seg-btn',
            onClick: () => setKind(value as 'all' | FoldRow['kind']),
          },
          String(label),
        ),
      ),
    ),
  )

  const turnBar =
    turns.length <= 1
      ? null
      : el(
          'div',
          { className: 'cf-turns', key: 't' },
          el(
            'button',
            {
              type: 'button',
              className: turn === 'all' ? 'cf-turn cf-turn-on' : 'cf-turn',
              onClick: () => setTurn('all'),
            },
            t('list.allTurns'),
          ),
          ...turns.map((value) =>
            el(
              'button',
              {
                key: String(value),
                type: 'button',
                className: turn === value ? 'cf-turn cf-turn-on' : 'cf-turn',
                onClick: () => setTurn(value),
              },
              t('list.turn', { n: String(value) }),
            ),
          ),
        )

  const summary = el(
    'div',
    { className: 'cf-list-note', key: 'n' },
    visible.length === ordered.length
      ? t('list.countAll', { n: String(ordered.length) })
      : t('list.countFiltered', { m: String(visible.length), n: String(ordered.length) }),
  )

  const rows =
    visible.length === 0
      ? el('div', { className: 'cf-empty', key: 'x' }, t('list.noMatch'))
      : el(
          'div',
          { className: 'cf-folds', key: 'f' },
          ...visible.map((fold) => el(FoldItem, { key: String(fold.seq), sessionId, fold, t })),
        )

  return el('section', { className: 'cf-card' }, title, controls, turnBar, summary, rows)
}

/**
 * Translator for the tab body.
 *
 * The tab is a module-scoped component (the host wants a stable reference), so it
 * cannot close over the per-apply context. `apply()` installs the bound translator
 * here before registering, and the fallback keeps the component renderable if it
 * is ever mounted out of order.
 */
let tabTranslator: Translator = (key, params) => {
  const text = zhDictionary[key] ?? enDictionary[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
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

  const t = tabTranslator
  const head = el('div', { className: 'cf-head', key: 'head' },
    el('span', { className: 'cf-head-title' }, t('head.title')),
    sessionId === undefined
      ? null
      : el('span', { className: 'cf-head-note' }, state.status === 'ready'
          ? t('tab.subtitle.summary', { n: String(state.report?.folds.length ?? 0) })
          : t('tab.subtitle.default')),
  )

  const children: unknown[] = [head]
  if (sessionId === undefined) {
    children.push(
      el('div', { className: 'cf-card' },
        el('div', { className: 'cf-empty' },
          el('div', { className: 'cf-empty-title' }, t('state.noSession.title')),
          el('div', null, t('state.noSession.hint')),
        ),
      ),
    )
  } else if (state.status === 'loading') {
    children.push(el('div', { className: 'cf-card' }, el('div', { className: 'cf-empty' }, t('state.loading'))))
  } else if (state.status === 'error') {
    children.push(
      el('div', { className: 'cf-card' },
        el('div', { className: 'cf-empty' },
          el('div', { className: 'cf-empty-title cf-bad' }, t('state.error.title')),
          el('div', null, state.error ?? 'unknown error'),
        ),
      ),
    )
  } else if (state.status !== 'ready' || state.report === undefined) {
    children.push(el('div', { className: 'cf-card' }, el('div', { className: 'cf-empty' }, t('state.empty'))))
  } else {
    children.push(el(Summary, { key: 'summary', report: state.report, t }))
    children.push(el(FoldList, { key: 'folds', sessionId, report: state.report, t }))
  }

  return el('div', { className: 'cf-root' }, ...children)
}

/** Client plugin name. */
export const name = 'context-fold-client'

/**
 * Client services this plugin needs.
 *
 * `remote` and `remote.settings` are **both** required, and that is not
 * redundant: each dotted name gates a separate readiness latch, but property
 * access starts at `ctx.remote`. Declaring only `remote.settings` leaves
 * `ctx.remote` itself unresolvable, so `ctx.remote.settings` throws
 * `cannot get property "remote" without inject` — which is what failed the whole
 * client plugin with "dsh-context-fold: loading" at web boot.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

/**
 * Mount the conversation tab.
 *
 * Dictionaries are registered from inside this bundle: the locale service reads
 * them from the plugin registry, not from `locale/*.json` on disk.
 *
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ensurePanelCss()

  // Two locales: the conversation tab's, and the settings page's. They are
  // separate namespaces because both surfaces label themselves and a missing
  // one shows the raw key ("settings.nav") in the sidebar — which is exactly
  // what happened while only the tab's dictionary was registered.
  const registerDictionaries = (): void => {
    ctx.locale.register(NS, { zh: zhDictionary, en: enDictionary })
    ctx.locale.register(SETTINGS_NS, settingsDictionaries)
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(registerDictionaries, 'context-fold: dictionaries')
  } else {
    registerDictionaries()
  }

  const t = makeTranslator(ctx)
  tabTranslator = t

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

  // A settings section of our own. The host can generate a form from the schema
  // (`configure({ auto: true })`, done on the server half), but no shipped client
  // renders that yet, so without this the knobs stay unreachable in the GUI.
  ensureSettingsCss()
  const page = registerSettingsPage(ctx as unknown as SettingsPageContext)
  if (typeof page === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => page as () => void, 'context-fold: settings section')
  }
}
