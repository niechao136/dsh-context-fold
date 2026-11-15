/**
 * The plugin's settings page.
 *
 * ## Why this is hand-written
 *
 * The Settings service exposes an `auto` page policy and the schema carries
 * `.volatile()` fields precisely so a client could generate the form. No shipped
 * client does — the official README says so directly ("no shipped client does so
 * yet"), and searching the installed client bundles for `autoGenerate` finds
 * nothing. `configure({ auto: true })` alone therefore produces no visible page.
 *
 * So the page registers its own `settings.section` and renders one control per
 * knob, reading through `ctx.remote.settings.describe()` and writing through
 * `ctx.remote.settings.mutate(ns, ops, revision)` — the same contract the
 * built-in sections use.
 *
 * ## Values are read from the namespace view, not the schema
 *
 * `describe()` returns a namespace row with `value` (the effective config) and
 * `revision` (needed for a conflict-safe write). The schema is used only for the
 * label and the numeric bounds, so this page never has to interpret Cordis
 * expressions.
 *
 * @module dsh-context-fold/settings-page
 */

/** One field on the page. */
interface FieldSpec {
  /** Config key. */
  key: string
  /** Label. */
  label: string
  /** Help text under the control. */
  hint: string
  /** Control kind. */
  kind: 'number' | 'boolean'
  /** Lower bound, for numbers. */
  min?: number
  /** Upper bound, for numbers. */
  max?: number
}

/** The knobs, in reading order: what to fold, then how, then whether. */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'enabled',
    label: 'Enable folding',
    hint: 'Turn stage-boundary folding on or off for the whole session.',
    kind: 'boolean',
  },
  {
    key: 'dryRun',
    label: 'Dry run',
    hint: 'Compute and report candidates without mutating the session. Useful for judging a threshold change before applying it.',
    kind: 'boolean',
  },
  {
    key: 'minFoldChars',
    label: 'Minimum tool result size',
    hint: 'Skip tool results smaller than this many characters. Never below 300 — below that the marker costs as much as the text it replaces.',
    kind: 'number',
    min: 300,
    max: 1_000_000,
  },
  {
    key: 'minBatchChars',
    label: 'Minimum batch size',
    hint: 'Only fold a batch of candidates whose combined size reaches this many characters.',
    kind: 'number',
    min: 1,
    max: 10_000_000,
  },
  {
    key: 'keepRecentSteps',
    label: 'Keep recent steps',
    hint: 'Never fold a result from the newest N steps: those are the ones still being reasoned about.',
    kind: 'number',
    min: 0,
    max: 1000,
  },
  {
    key: 'staleSteps',
    label: 'Stale after',
    hint: 'Age in steps after which a result may fold inside one long turn.',
    kind: 'number',
    min: 1,
    max: 10_000,
  },
  {
    key: 'batchSpanSteps',
    label: 'Batch span',
    hint: 'Split a turn longer than this many steps into contiguous sub-batches.',
    kind: 'number',
    min: 1,
    max: 10_000,
  },
  {
    key: 'foldReasoning',
    label: 'Fold reasoning',
    hint: 'Fold reasoning blocks on historical tool-call turns. Reasoning on plain turns is never re-sent, so it is not folded.',
    kind: 'boolean',
  },
  {
    key: 'foldPlainTurnReasoning',
    label: 'Fold reasoning on plain turns',
    hint: 'Enable only when the route re-sends plain-turn reasoning (e.g. dsh-router-core). dsh-llm-deepseek drops it, so folding there saves nothing.',
    kind: 'boolean',
  },
]

/** What this module needs from the client context. */
export interface SettingsPageContext {
  /** Slot registry. */
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(descriptor: Record<string, unknown>, render: (props: unknown) => unknown): unknown
  }
  /** Locale service. */
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string) => string
  }
  /** Remote namespace providing the settings document. */
  remote?: {
    settings?: {
      describe(): Promise<{ ok: boolean; value?: SettingsDocument; error?: { message?: string } }>
      mutate(
        ns: string,
        ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
        revision: number,
      ): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
    }
  }
}

/** One namespace row from the settings document. */
interface SettingsNamespace {
  ns: string
  /** Effective value. */
  value?: Record<string, unknown>
  /** User override layer. */
  user?: Record<string, unknown>
  /** Revision guard for writes. */
  revision: number
  /** Whether writes are accepted. */
  writable?: boolean
}

/** The document `describe()` returns. */
interface SettingsDocument {
  namespaces: SettingsNamespace[]
  writable?: boolean
}

/** Locale namespace for this page. */
export const SETTINGS_NS = 'contextFoldSettings'

/**
 * Translate a key through the locale service, falling back to the English
 * dictionary so a missing binding never renders a raw key.
 *
 * @param ctx - client context.
 * @param key - dictionary key.
 * @returns the text.
 */
function translate(ctx: SettingsPageContext, key: string): string {
  try {
    const bound = ctx.locale.bind(SETTINGS_NS)(key)
    if (typeof bound === 'string' && bound !== '' && bound !== key) return bound
    return en[key] ?? zh[key] ?? key
  } catch {
    return en[key] ?? zh[key] ?? key
  }
}

/** Label and control strings. */
const zh: Record<string, string> = {
  'settings.nav': '上下文折叠',
  'page.title': '上下文折叠',
  'page.intro': '阶段边界的折叠阈值。改动会写入当前 profile，重启后生效。',
  'page.save': '保存',
  'page.saving': '保存中…',
  'page.saved': '已保存',
  'page.failed': '保存失败',
  'page.reload': '重新读取',
  'page.loading': '读取中…',
  'page.readonly': '当前配置不可写。',
  'page.unavailable': '此插件的配置命名空间未注册。',
}

/** English strings. */
const en: Record<string, string> = {
  'settings.nav': 'Context fold',
  'page.title': 'Context fold',
  'page.intro': 'Stage-boundary fold thresholds. Changes are written to the current profile and apply after a restart.',
  'page.save': 'Save',
  'page.saving': 'Saving…',
  'page.saved': 'Saved',
  'page.failed': 'Save failed',
  'page.reload': 'Reload',
  'page.loading': 'Loading…',
  'page.readonly': 'This configuration is not writable.',
  'page.unavailable': 'The configuration namespace for this plugin is not registered.',
}

/** The namespace this plugin's Config is mounted under. */
function namespaceOf(): string {
  return 'context-fold'
}

/** Read a plain value out of a namespace layer. */
function valueOf(layer: Record<string, unknown> | undefined, key: string): unknown {
  if (layer === undefined) return undefined
  const raw = layer[key]
  // A volatile field may arrive as a reference even in the view.
  if (raw !== null && typeof raw === 'object' && typeof (raw as { get?: unknown }).get === 'function') {
    return (raw as { get: () => unknown }).get()
  }
  return raw
}

/**
 * Build the settings page registration.
 *
 * The slot expects a **React component**, not a rendered element: the host mounts
 * it and calls its hooks. `createPage` therefore returns a function component
 * (which resolves React lazily, inside the render the host controls), never a
 * pre-built element — an element created at registration time would be rendered
 * outside React's hook context and come out empty.
 *
 * @param ctx - client context carrying slots, locale and the remote namespace.
 * @returns the slot disposer, when the host returns one.
 */
export function registerSettingsPage(ctx: SettingsPageContext): unknown {
  // The component is module-scoped (so the host sees a stable reference), which
  // means it cannot close over `ctx`; stash it here for the render pass.
  pageContext = ctx
  return ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'context-fold',
        // After the built-in sections (general 0, plugins 15).
        order: 60,
        locale: SETTINGS_NS,
        label: () => translate(ctx, 'settings.nav'),
      },
      SettingsSection,
    ),
  )
}

/** The context captured for the module-scoped section component. */
let pageContext: SettingsPageContext | undefined

/**
 * The section component.
 *
 * Declared at module scope and passed to `slots.register` as a stable component
 * reference, so the host mounts it once per navigation rather than remounting a
 * fresh closure each render.
 *
 * @param props - slot props (carries the React runtime seat).
 * @returns the rendered section.
 */
function SettingsSection(props: unknown): unknown {
  const ctx = pageContext
  // `pageContext` is assigned by `registerSettingsPage` before the host can mount
  // this component, so this is only a defensive branch.
  if (ctx === undefined) {
    const react = reactOf(props)
    return react.createElement('div', { className: 'cf-set' }, 'context-fold: settings context was released; reload the page.')
  }
  try {
    return renderPage(ctx, reactOf(props))
  } catch (error) {
    // The shell wraps every slot entry in an error boundary that renders an empty
    // anchor on failure, so a thrown error here shows as a blank section with no
    // message anywhere. Render the failure instead: a visible reason is worth far
    // more than a clean-looking page.
    const react = reactOf(props)
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return react.createElement(
      'div',
      { className: 'cf-set' },
      react.createElement('div', { className: 'cf-set-title' }, translate(ctx, 'page.failed')),
      react.createElement('pre', { className: 'cf-set-crash' }, message),
    )
  }
}

/** Resolve the React runtime from the slot props, falling back to the platform table. */
function reactOf(props: unknown): ReactSeat {
  const injected = (props as { react?: ReactSeat } | undefined)?.react
  return injected ?? requireReact()
}

/**
 * The shell hands this bundle its `require` through the module factory, so React
 * resolves against the shared platform module table.
 */
declare function require(id: string): unknown

/** Minimal React face used here. */
interface ReactSeat {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** Resolve the shell's React through the module factory. */
function requireReact(): ReactSeat {
  return require('react') as ReactSeat
}

/** Page state. */
interface PageState {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  /** Effective values. */
  values: Record<string, unknown>
  /** Revision for the next write. */
  revision?: number
  /** Whether the host accepts writes. */
  writable: boolean
  /** Last action's message. */
  message?: string
  /** Whether a write is in flight. */
  busy: boolean
}

/**
 * Render the settings page.
 *
 * @param ctx - client context.
 * @param react - React seat.
 * @returns the page element.
 */
function renderPage(ctx: SettingsPageContext, react: ReactSeat): unknown {
  const el = react.createElement
  const [state, setState] = react.useState<PageState>({
    status: 'loading',
    values: {},
    writable: false,
    busy: false,
  })

  const settings = ctx.remote?.settings
  const ns = namespaceOf()

  const load = (): void => {
    if (settings === undefined) {
      setState({ status: 'unavailable', values: {}, writable: false, busy: false })
      return
    }
    setState((previous) => ({ ...previous, status: 'loading', busy: false }))
    void settings.describe().then(
      (response) => {
        if (!response.ok || response.value === undefined) {
          setState({
            status: 'error',
            values: {},
            writable: false,
            busy: false,
            message: response.error?.message ?? 'could not read settings',
          })
          return
        }
        const row = response.value.namespaces.find((candidate) => candidate.ns === ns)
        if (row === undefined) {
          setState({ status: 'unavailable', values: {}, writable: false, busy: false })
          return
        }
        const values: Record<string, unknown> = {}
        for (const field of FIELDS) {
          const resolved = valueOf(row.value, field.key) ?? valueOf(row.user, field.key)
          if (resolved !== undefined) values[field.key] = resolved
        }
        setState({
          status: 'ready',
          values,
          revision: row.revision,
          writable: row.writable !== false && response.value.writable !== false,
          busy: false,
        })
      },
      // A rejected promise used to leave the page stuck on "loading" with no
      // explanation; surface it as a real error state instead.
      (error: unknown) => {
        setState({
          status: 'error',
          values: {},
          writable: false,
          busy: false,
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }

  react.useEffect(() => {
    load()
    // Load once per mount: a settings page is short-lived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Write one field. */
  const write = (field: FieldSpec, next: unknown): void => {
    if (settings === undefined || state.revision === undefined) return
    setState((previous) => ({ ...previous, busy: true, message: undefined, values: { ...previous.values, [field.key]: next } }))
    void settings
      .mutate(ns, [{ op: 'set', path: [field.key], value: next }], state.revision)
      .then((response) => {
        if (response.ok) {
          // The write bumps the revision; reload so the next edit is not a conflict.
          setState((previous) => ({ ...previous, busy: false, message: 'saved' }))
          load()
          return
        }
        setState((previous) => ({
          ...previous,
          busy: false,
          message: response.error?.message ?? 'write refused',
        }))
        load()
      })
  }

  const t = (key: string): string => translate(ctx, key)

  const header = el(
    'div',
    { className: 'cf-set-head', key: 'h' },
    el('div', { className: 'cf-set-title' }, t('page.title')),
    el('div', { className: 'cf-set-intro' }, t('page.intro')),
  )

  if (state.status === 'loading') {
    return el('div', { className: 'cf-set' }, header, el('div', { className: 'cf-set-note' }, t('page.loading')))
  }
  if (state.status === 'unavailable') {
    return el('div', { className: 'cf-set' }, header, el('div', { className: 'cf-set-note' }, t('page.unavailable')))
  }
  if (state.status === 'error') {
    return el(
      'div',
      { className: 'cf-set' },
      header,
      el('div', { className: 'cf-set-note cf-bad' }, state.message ?? t('page.failed')),
      el('button', { className: 'cf-set-btn', type: 'button', onClick: load }, t('page.reload')),
    )
  }

  const rows = FIELDS.map((field) => {
    const current = state.values[field.key]
    const disabled = !state.writable || state.busy
    const control =
      field.kind === 'boolean'
        ? el('input', {
            type: 'checkbox',
            className: 'cf-set-check',
            checked: current === true,
            disabled,
            onChange: (event: { currentTarget?: { checked?: boolean } }) => write(field, event.currentTarget?.checked === true),
          })
        : el('input', {
            type: 'number',
            className: 'cf-set-num',
            value: typeof current === 'number' ? String(current) : '',
            min: field.min,
            max: field.max,
            step: 1,
            disabled,
            onChange: (event: { currentTarget?: { value?: string } }) => {
              const parsed = Number(event.currentTarget?.value)
              if (!Number.isFinite(parsed)) return
              const clamped = Math.max(field.min ?? 0, Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.round(parsed)))
              write(field, clamped)
            },
          })
    return el(
      'div',
      { className: 'cf-set-row', key: field.key },
      el(
        'div',
        { className: 'cf-set-label-col' },
        el('label', { className: 'cf-set-label' }, field.label),
        el('div', { className: 'cf-set-hint' }, field.hint),
      ),
      el('div', { className: 'cf-set-control' }, control),
    )
  })

  const status =
    state.message === undefined
      ? null
      : el(
          'div',
          { className: state.message === 'saved' ? 'cf-set-note cf-good' : 'cf-set-note cf-bad', key: 's' },
          state.message === 'saved' ? t('page.saved') : state.message,
        )

  return el(
    'div',
    { className: 'cf-set' },
    header,
    !state.writable ? el('div', { className: 'cf-set-note cf-warn' }, t('page.readonly')) : null,
    el('div', { className: 'cf-set-rows' }, ...rows),
    status,
    el('div', { className: 'cf-set-actions' }, el('button', { className: 'cf-set-btn', type: 'button', onClick: load, disabled: state.busy }, t('page.reload'))),
  )
}

/** Stylesheet for this page, injected once. */
const CSS_KEY = 'dsh-context-fold/settings.css'

/** Rules, scoped under `.cf-set`. */
const CSS = `
.cf-set { box-sizing: border-box; padding: 4px 2px 28px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary, #e8e8ea); }
.cf-set-head { margin-bottom: 16px; }
.cf-set-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.cf-set-intro { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b8b93); }
.cf-set-rows { display: flex; flex-direction: column; gap: 2px; }
.cf-set-row { display: flex; gap: 16px; align-items: flex-start; padding: 11px 0; border-bottom: .5px solid var(--dsw-alias-border-l2, #303036); }
.cf-set-label-col { flex: 1 1 auto; min-width: 0; }
.cf-set-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #e8e8ea); }
.cf-set-hint { margin-top: 2px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8b8b93); }
.cf-set-control { flex: none; display: flex; align-items: center; min-height: 26px; }
.cf-set-num { box-sizing: border-box; width: 120px; padding: 5px 9px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l3, #3a3a40); background: var(--dsw-alias-bg-layer-2, #202024); color: inherit; font-family: inherit; font-size: 12px; font-variant-numeric: tabular-nums; outline: none; }
.cf-set-num:focus { border-color: var(--dsw-alias-brand-primary, #6b8afd); }
.cf-set-num:disabled { opacity: .5; }
.cf-set-check { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary, #6b8afd); cursor: pointer; }
.cf-set-check:disabled { cursor: not-allowed; opacity: .5; }
.cf-set-note { margin-top: 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b8b93); }
.cf-set-note.cf-bad { color: var(--dsw-alias-state-error-primary, #f87171); }
.cf-set-note.cf-good { color: var(--dsw-alias-state-success-primary, #4ade80); }
.cf-set-note.cf-warn { color: var(--dsw-alias-state-warn-primary, #facc15); }
.cf-set-actions { margin-top: 18px; }
.cf-set-btn { border: .5px solid var(--dsw-alias-border-l3, #3a3a40); border-radius: 7px; padding: 5px 12px; font-family: inherit; font-size: 12px; cursor: pointer; background: var(--dsw-alias-bg-layer-2, #202024); color: var(--dsw-alias-label-secondary, #a9a9b2); transition: background-color var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease-in-out); }
.cf-set-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #26262c); }
.cf-set-btn:disabled { opacity: .5; cursor: not-allowed; }
.cf-set-crash { margin: 8px 0 0; padding: 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-3, #2a2a30); color: var(--dsw-alias-state-error-primary, #f87171); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
`

/**
 * Inject the page stylesheet once.
 *
 * The conversation tab injects its own sheet through the same mechanism, so this
 * only adds the settings-specific selectors.
 */
export function ensureSettingsCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_KEY)}]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-context-fold'
  style.dataset.pluginCss = CSS_KEY
  style.textContent = CSS
  document.head.appendChild(style)
}

/** Dictionaries this page registers, keyed by locale id. */
export const settingsDictionaries = { zh, en }
