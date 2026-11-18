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
  /** Dictionary key for the label. */
  labelKey: string
  /** Dictionary key for the help text under the control. */
  hintKey: string
  /** Control kind. */
  kind: 'number' | 'boolean'
  /** Lower bound, for numbers. */
  min?: number
  /** Upper bound, for numbers. */
  max?: number
}

/** The knobs, in reading order: what to fold, then how, then whether. */
const FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', labelKey: 'field.enabled.label', hintKey: 'field.enabled.hint', kind: 'boolean' },
  { key: 'dryRun', labelKey: 'field.dryRun.label', hintKey: 'field.dryRun.hint', kind: 'boolean' },
  {
    key: 'minFoldChars',
    labelKey: 'field.minFoldChars.label',
    hintKey: 'field.minFoldChars.hint',
    kind: 'number',
    min: 300,
    max: 1_000_000,
  },
  {
    key: 'minBatchChars',
    labelKey: 'field.minBatchChars.label',
    hintKey: 'field.minBatchChars.hint',
    kind: 'number',
    min: 1,
    max: 10_000_000,
  },
  {
    key: 'keepRecentSteps',
    labelKey: 'field.keepRecentSteps.label',
    hintKey: 'field.keepRecentSteps.hint',
    kind: 'number',
    min: 0,
    max: 1000,
  },
  {
    key: 'staleSteps',
    labelKey: 'field.staleSteps.label',
    hintKey: 'field.staleSteps.hint',
    kind: 'number',
    min: 1,
    max: 10_000,
  },
  {
    key: 'batchSpanSteps',
    labelKey: 'field.batchSpanSteps.label',
    hintKey: 'field.batchSpanSteps.hint',
    kind: 'number',
    min: 1,
    max: 10_000,
  },
  {
    key: 'foldReasoning',
    labelKey: 'field.foldReasoning.label',
    hintKey: 'field.foldReasoning.hint',
    kind: 'boolean',
  },
  {
    key: 'minFoldReasoningChars',
    labelKey: 'field.minFoldReasoningChars.label',
    hintKey: 'field.minFoldReasoningChars.hint',
    kind: 'number',
    min: 0,
    max: 1_000_000,
  },
  {
    key: 'minFoldArgsChars',
    labelKey: 'field.minFoldArgsChars.label',
    hintKey: 'field.minFoldArgsChars.hint',
    kind: 'number',
    min: 0,
    max: 1_000_000,
  },
  {
    key: 'keepRecentTurns',
    labelKey: 'field.keepRecentTurns.label',
    hintKey: 'field.keepRecentTurns.hint',
    kind: 'number',
    min: 1,
    max: 20,
  },
  {
    key: 'foldTurnArchive',
    labelKey: 'field.foldTurnArchive.label',
    hintKey: 'field.foldTurnArchive.hint',
    kind: 'boolean',
  },
  {
    key: 'foldPlainTurnReasoning',
    labelKey: 'field.foldPlainTurnReasoning.label',
    hintKey: 'field.foldPlainTurnReasoning.hint',
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
    // Chinese first: the UI defaults to Chinese, and the dictionaries are authored
    // zh-first. English is the fallback for a shell running another language.
    return zh[key] ?? en[key] ?? key
  } catch {
    return zh[key] ?? en[key] ?? key
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

  'field.enabled.label': '启用折叠',
  'field.enabled.hint': '为整个会话开启或关闭阶段边界折叠。',
  'field.dryRun.label': '试运行',
  'field.dryRun.hint': '只计算并报告候选，不改动会话。适合在正式调整阈值前先看效果。',
  'field.minFoldChars.label': '工具结果最小长度',
  'field.minFoldChars.hint': '小于该字符数的工具结果不折叠。最低 300 —— 再短的话，标记本身的开销就抵得上被替换的正文了。',
  'field.minBatchChars.label': '统一折叠门槛',
  'field.minBatchChars.hint':
    '工具结果与思考过程合计至少要释放这么多字符，任一才会折叠。两者共用同一门槛，因为改动任一处都会让同一段提示词缓存失效，分开判定会让同一步付出两次失效代价。',
  'field.keepRecentSteps.label': '保留最近步数',
  'field.keepRecentSteps.hint': '最近 N 步的结果不折叠：这些内容还在被推理使用。',
  'field.staleSteps.label': '超过多少步算陈旧',
  'field.staleSteps.hint': '结果在同一个长回合里停留超过这么多步后，就可以被折叠。',
  'field.batchSpanSteps.label': '分批跨度',
  'field.batchSpanSteps.hint': '回合超过这么多步时，按连续区间拆成多个子批次分别处理。',
  'field.foldReasoning.label': '折叠思考过程',
  'field.foldReasoning.hint': '折叠历史工具调用轮次里的思考内容。纯文本轮的思考不会被重发，因此不折叠。',
  'field.minFoldReasoningChars.label': '思考过程最小长度',
  'field.minFoldReasoningChars.hint': '小于该字符数的思考块不折叠。默认 900。',
  'field.minFoldArgsChars.label': '工具参数最小长度',
  'field.minFoldArgsChars.hint': '小于该字符数的工具调用参数不折叠。默认 400；归档轮次里的所有参数仍会全部折叠。',
  'field.keepRecentTurns.label': '保留最近轮次',
  'field.keepRecentTurns.hint': '最近 N 轮保持完整；更早轮次的工具调用、工具结果和思考过程会归档到独立文件，只保留正文。默认 5。',
  'field.foldTurnArchive.label': '启用轮次归档',
  'field.foldTurnArchive.hint': '超过保留轮次后，把工具调用、工具和思考过程写入每轮一个的归档文件，并保留召回路径。',
  'field.foldPlainTurnReasoning.label': '折叠纯文本轮的思考',
  'field.foldPlainTurnReasoning.hint': '只有当路由会重发纯文本轮思考时才需要开启（例如 dsh-router-core）。dsh-llm-deepseek 会直接丢弃它，折了也省不到。',
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

  'field.enabled.label': 'Enable folding',
  'field.enabled.hint': 'Turn stage-boundary folding on or off for the whole session.',
  'field.dryRun.label': 'Dry run',
  'field.dryRun.hint': 'Compute and report candidates without mutating the session. Useful for judging a threshold change before applying it.',
  'field.minFoldChars.label': 'Minimum tool result size',
  'field.minFoldChars.hint': 'Skip tool results smaller than this many characters. Never below 300 — below that the marker costs as much as the text it replaces.',
  'field.minBatchChars.label': 'Shared fold gate',
  'field.minBatchChars.hint':
    'Tool results and reasoning together must free at least this many characters before either folds. They share one gate because any change invalidates the same prompt-cache prefix, so judging them separately made a single step pay twice.',
  'field.keepRecentSteps.label': 'Keep recent steps',
  'field.keepRecentSteps.hint': 'Never fold a result from the newest N steps: those are the ones still being reasoned about.',
  'field.staleSteps.label': 'Stale after',
  'field.staleSteps.hint': 'Age in steps after which a result may fold inside one long turn.',
  'field.batchSpanSteps.label': 'Batch span',
  'field.batchSpanSteps.hint': 'Split a turn longer than this many steps into contiguous sub-batches.',
  'field.foldReasoning.label': 'Fold reasoning',
  'field.foldReasoning.hint': 'Fold reasoning blocks on historical tool-call turns. Reasoning on plain turns is never re-sent, so it is not folded.',
  'field.minFoldReasoningChars.label': 'Minimum reasoning size',
  'field.minFoldReasoningChars.hint': 'Skip reasoning blocks smaller than this many characters. Default 900.',
  'field.minFoldArgsChars.label': 'Minimum tool argument size',
  'field.minFoldArgsChars.hint': 'Skip tool-call arguments smaller than this many characters. Default 400; archived turns still fold every argument.',
  'field.keepRecentTurns.label': 'Keep recent turns',
  'field.keepRecentTurns.hint': 'Keep the newest N turns intact; older turns have tool calls, results and reasoning archived to a file, keeping only text. Default 5.',
  'field.foldTurnArchive.label': 'Enable turn archive',
  'field.foldTurnArchive.hint': 'Past the recent-turn window, write tool calls, results and reasoning into one archive file per turn, with a recall path left in view.',
  'field.foldPlainTurnReasoning.label': 'Fold reasoning on plain turns',
  'field.foldPlainTurnReasoning.hint': 'Enable only when the route re-sends plain-turn reasoning (e.g. dsh-router-core). dsh-llm-deepseek drops it, so folding there saves nothing.',
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
 * Host operations, resolved once while the plugin's inject context is live.
 *
 * Reading `ctx.remote` during a render throws `cannot get property "remote"
 * without inject`: a Cordis context only resolves its services inside the scope
 * its `inject` was declared for, and a component body runs later, outside it. The
 * official pages follow the same rule — they build their Host callbacks in
 * `apply()` and inject the callbacks into the component, which never touches
 * `ctx` itself.
 *
 * So this is captured at registration and passed down as plain functions.
 */
export interface SettingsOps {
  /** Read the settings document. */
  describe(): Promise<{ ok: boolean; value?: SettingsDocument; error?: { message?: string } }>
  /** Apply one namespace mutation, guarded by a revision. */
  mutate(
    ns: string,
    ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
    revision: number,
  ): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>
}

/**
 * Resolve the settings operations from a live context.
 *
 * @param ctx - the plugin context, whose `inject` must include `remote.settings`.
 * @returns the operations, or undefined when the remote is absent.
 */
export function settingsOpsOf(ctx: { remote?: { settings?: SettingsOps } }): SettingsOps | undefined {
  let settings: SettingsOps | undefined
  try {
    settings = ctx.remote?.settings
  } catch {
    // A Cordis context throws rather than returning undefined when its service is
    // not resolvable in the current scope. Treat that as "no remote": a missing
    // settings service must not be able to break plugin activation.
    return undefined
  }
  if (settings === undefined) return undefined
  // Bind so the returned functions keep working after the render pass; the
  // methods are captured here, not looked up later.
  return {
    describe: () => settings!.describe(),
    mutate: (ns, ops, revision) => settings!.mutate(ns, ops, revision),
  }
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
  // Resolve the Host operations once, here in the apply scope. The component below
  // must never read `ctx` itself: its body runs during render, long after
  // `apply()` returned, where the context no longer resolves services.
  //
  // This is safe only because the plugin's `inject` declares BOTH `remote` and
  // `remote.settings`. Declaring just the dotted name leaves `ctx.remote`
  // unresolvable and this line throws — the failure that stopped the plugin from
  // activating at all.
  const ops = settingsOpsOf(ctx)
  const label = (key: string): string => translate(ctx, key)

  return ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'context-fold',
        // After the built-in sections (general 0, plugins 15).
        order: 60,
        locale: SETTINGS_NS,
        label: () => label('settings.nav'),
        // The official pages pass their Host operations through `inject`; the
        // component receives them as props instead of resolving services.
        inject: () => ({ ops }),
      },
      SettingsSection,
    ),
  )
}

/**
 * The section component.
 *
 * Reads everything it needs from props: the slot `kit` (`t`), and the `ops`
 * captured at registration. It never touches a Cordis context, which is why it
 * survives being mounted after `apply()` has returned.
 *
 * @param props - slot props: `ops`, optional `react`, and the slot `kit`.
 * @returns the rendered section.
 */
function SettingsSection(props: unknown): unknown {
  const { ops } = (props ?? {}) as { ops?: SettingsOps }
  const text = (props ?? {}) as { t?: (key: string) => string }
  // `t` comes from the slot kit because the entry declares a locale namespace.
  const translateKey = typeof text.t === 'function' ? text.t : undefined
  try {
    return renderPage(reactOf(props), ops, translateKey)
  } catch (error) {
    // The shell wraps every slot entry in an error boundary that renders an empty
    // anchor on failure, so a thrown error here shows as a blank section with no
    // message anywhere. Render the failure instead.
    const react = reactOf(props)
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return react.createElement(
      'div',
      { className: 'cf-set' },
      react.createElement('div', { className: 'cf-set-title' }, 'Context fold — settings failed to render'),
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
function renderPage(react: ReactSeat, settings: SettingsOps | undefined, t?: (key: string) => string): unknown {
  const el = react.createElement
  const [state, setState] = react.useState<PageState>({
    status: 'loading',
    values: {},
    writable: false,
    busy: false,
  })
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

  // Prefer the slot's translator (bound to this entry's locale namespace), then
  // this module's own dictionary. No service lookup: the component must not read
  // a Cordis context during render.
  // Resolution order: the slot's translator, then Chinese, then English, then the
  // raw key. Chinese comes before English deliberately — the dictionaries are
  // authored zh-first and the UI defaults to Chinese, so a locale service that is
  // missing or still loading must not downgrade the page to English.
  const tr = (key: string): string => {
    if (t !== undefined) {
      const translated = t(key)
      if (typeof translated === 'string' && translated !== '' && translated !== key) return translated
    }
    return zh[key] ?? en[key] ?? key
  }

  const header = el(
    'div',
    { className: 'cf-set-head', key: 'h' },
    el('div', { className: 'cf-set-title' }, tr('page.title')),
    el('div', { className: 'cf-set-intro' }, tr('page.intro')),
  )

  if (state.status === 'loading') {
    return el('div', { className: 'cf-set' }, header, el('div', { className: 'cf-set-note' }, tr('page.loading')))
  }
  if (state.status === 'unavailable') {
    return el('div', { className: 'cf-set' }, header, el('div', { className: 'cf-set-note' }, tr('page.unavailable')))
  }
  if (state.status === 'error') {
    return el(
      'div',
      { className: 'cf-set' },
      header,
      el('div', { className: 'cf-set-note cf-bad' }, state.message ?? tr('page.failed')),
      el('button', { className: 'cf-set-btn', type: 'button', onClick: load }, tr('page.reload')),
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
        el('label', { className: 'cf-set-label' }, tr(field.labelKey)),
        el('div', { className: 'cf-set-hint' }, tr(field.hintKey)),
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
          state.message === 'saved' ? tr('page.saved') : state.message,
        )

  return el(
    'div',
    { className: 'cf-set' },
    header,
    !state.writable ? el('div', { className: 'cf-set-note cf-warn' }, tr('page.readonly')) : null,
    el('div', { className: 'cf-set-rows' }, ...rows),
    status,
    el('div', { className: 'cf-set-actions' }, el('button', { className: 'cf-set-btn', type: 'button', onClick: load, disabled: state.busy }, tr('page.reload'))),
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
