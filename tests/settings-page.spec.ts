import { describe, expect, it } from 'vitest'
import { registerSettingsPage, settingsDictionaries } from '../src/settings-page.ts'

/** English dictionary, so a label assertion can check a real translation. */
const en = settingsDictionaries.en

/**
 * The settings page is the only path to the plugin's knobs in the GUI: the host
 * can generate a form from the schema, but no shipped client renders one, so the
 * page is hand-built here. These tests drive it against a fake settings remote to
 * pin the read/write contract.
 *
 * The fake React seat implements `useState`/`useEffect` with immediate (non-batched)
 * updates. A real client re-renders after a state change; the harness models that
 * by re-invoking `render()` after each `effect()` and promise flush, which is why
 * the tree is re-read after loading instead of being captured once.
 */

interface Node {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

/** Walk a rendered tree. */
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isNode(node)) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

/** Flush pending promise callbacks. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A tiny React stand-in plus a mounted component handle that can re-render.
 *
 * React identifies hook slots by call order within one component instance, so the
 * harness keeps a state cursor that resets to 0 at the start of each render while
 * the backing array persists. Without that cursor every render would re-read index
 * 0 and the component would appear stuck in its initial state.
 *
 * Props are supplied as the slot kit does: the component reads `ops` (captured at
 * registration) and `t` (the slot translator). It must never need a Cordis context
 * — touching one during render throws "cannot get property … without inject".
 */
function mount(render: (props: unknown) => unknown, props: Record<string, unknown> = {}) {
  const states: unknown[] = []
  const effects: (() => void)[] = []
  let cursor = 0
  const seat = {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
      return { type, props: props ?? {}, children }
    },
    useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      const set = (next: T | ((previous: T) => T)): void => {
        const previous = states[index] as T
        states[index] = typeof next === 'function' ? (next as (p: T) => T)(previous) : next
      }
      return [states[index] as T, set]
    },
    useEffect(effect: () => void | (() => void)): void {
      // Effects run once per mount, matching the page's empty dependency list.
      cursor++
      effects.push(effect as () => void)
    },
  }
  let tree: unknown
  const rerender = (): void => {
    cursor = 0
    tree = render({ react: seat, ...props })
  }
  const handle = {
    states,
    /** Render once, run queued effects, and settle into the loaded tree. */
    async start(): Promise<unknown> {
      rerender()
      for (const effect of effects.splice(0)) effect()
      await flush()
      rerender()
      return tree
    },
    /** Re-render after an interaction, then settle. */
    async settle(): Promise<unknown> {
      await flush()
      rerender()
      return tree
    },
    get current(): unknown {
      return tree
    },
  }
  return handle
}

/** A fake settings remote backed by an in-memory namespace. */
function makeRemote(initial: Record<string, unknown> = {}) {
  const writes: { ns: string; ops: readonly { op: string; path: string[]; value?: unknown }[]; revision: number }[] = []
  const state = { value: { ...initial }, revision: 3, writable: true }
  return {
    writes,
    state,
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            namespaces: [
              { ns: 'context-fold', value: state.value, user: state.value, revision: state.revision, writable: state.writable },
            ],
          },
        }),
        mutate: async (ns: string, ops: readonly { op: string; path: string[]; value?: unknown }[], revision: number) => {
          writes.push({ ns, ops, revision })
          for (const op of ops) if (op.op === 'set' && op.path[0] !== undefined) state.value[op.path[0]] = op.value
          state.revision += 1
          return { ok: true, value: {} }
        },
      },
    },
  }
}

/** Build a client context that records the registered section. */
function makeCtx(remote: unknown) {
  const registrations: { descriptor: Record<string, unknown>; render: (props: unknown) => unknown }[] = []
  return {
    registrations,
    ctx: {
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (descriptor: Record<string, unknown>, render: (props: unknown) => unknown) => {
          registrations.push({ descriptor, render })
          return () => {}
        },
      },
      locale: {
        register: () => () => {},
        // Model the real service: a registered key resolves, an unregistered one
        // returns the key itself (which is how "settings.nav" leaked out).
        bind: () => (key: string) => en[key] ?? key,
      },
      remote,
    },
  }
}

/** All `<input>` nodes with their props. */
function inputs(tree: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  walk(tree, (node) => {
    if (node.type === 'input') found.push(node.props)
  })
  return found
}

/**
 * Mount the registered section with the props the slot would supply.
 *
 * The descriptor's `inject` factory is the supported way to hand a component the
 * Host operations, so the harness calls it exactly as the slot does.
 */
function mountSection(registration: { descriptor: Record<string, unknown>; render: (props: unknown) => unknown }) {
  const injectFactory = registration.descriptor['inject'] as (() => Record<string, unknown>) | undefined
  const injected = injectFactory === undefined ? {} : injectFactory()
  return mount(registration.render, injected)
}

describe('settings page registration', () => {
  it('registers a settings.section for this plugin', () => {
    const { remote } = makeRemote()
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.descriptor['name']).toBe('settings.section')
    expect(registrations[0]!.descriptor['id']).toBe('context-fold')
    expect(typeof registrations[0]!.render).toBe('function')
  })

  it('registers a component, not a pre-built element', async () => {
    // The host mounts the registered value as a React component and calls its
    // hooks. An element created eagerly at registration time renders outside the
    // hook context and comes out empty — the failure this pins.
    const { remote } = makeRemote()
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const registered = registrations[0]!.render
    expect(typeof registered).toBe('function')
    // A component is *called* by the host; an element would already be an object.
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    expect(tree).not.toBeNull()
    // And it is a real page, not the empty section that a bad registration yields.
    expect(inputs(tree).length).toBeGreaterThan(0)
  })

  it('never touches the Cordis context while rendering', async () => {
    // `ctx.remote` throws "cannot get property … without inject" outside the
    // apply scope, which is where a component body runs. The section therefore
    // gets its operations through `inject`, captured against a context that is
    // unreadable afterwards: if the component reached for ctx it would throw here.
    const { remote } = makeRemote({ minFoldChars: 1000 })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const trapped = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`component read ctx.${String(property)} during render`)
        },
      },
    )
    // Capture the injected operations while the real ctx is still live.
    const injectFactory = registrations[0]!.descriptor['inject'] as (() => Record<string, unknown>) | undefined
    const injected = injectFactory === undefined ? {} : injectFactory()
    const page = mount(registrations[0]!.render, { ...injected, ctx: trapped })
    const tree = await page.start()
    expect(inputs(tree).length).toBeGreaterThan(0)
  })

  it('translates the nav label instead of showing the raw key', () => {
    // A missing dictionary surfaced the literal "settings.nav" in the sidebar.
    const { remote } = makeRemote()
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const label = (registrations[0]!.descriptor['label'] as () => string)()
    expect(label).not.toBe('settings.nav')
    expect(label.length).toBeGreaterThan(0)
  })
})

describe('settings page behaviour', () => {
  it('renders a control for every knob once loaded', async () => {
    const { remote } = makeRemote({ minFoldChars: 1000, enabled: true })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    // 9 knobs: 2 booleans early, then numbers, then 2 booleans.
    expect(inputs(tree).length).toBe(9)
  })

  it('reads the effective values from the namespace view', async () => {
    const { remote } = makeRemote({ minFoldChars: 1000, minBatchChars: 8000, enabled: true })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    const numbers = inputs(tree).filter((props) => props['type'] === 'number')
    const checks = inputs(tree).filter((props) => props['type'] === 'checkbox')
    expect(numbers.some((props) => props['value'] === '1000')).toBe(true)
    expect(checks.some((props) => props['checked'] === true)).toBe(true)
  })

  it('writes a field through mutate with the current revision', async () => {
    const { remote, writes } = makeRemote({ minFoldChars: 1000 })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    const number = inputs(tree).find((props) => props['type'] === 'number')!
    ;(number['onChange'] as (event: unknown) => void)({ currentTarget: { value: '1500' } })
    await page.settle()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.ns).toBe('context-fold')
    expect(writes[0]!.ops[0]).toEqual({ op: 'set', path: ['minFoldChars'], value: 1500 })
    expect(writes[0]!.revision).toBe(3)
  })

  it('clamps a numeric write to the schema floor instead of sending a bad value', async () => {
    const { remote, writes } = makeRemote({ minFoldChars: 1000 })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    const number = inputs(tree).find((props) => props['type'] === 'number')!
    ;(number['onChange'] as (event: unknown) => void)({ currentTarget: { value: '10' } })
    await page.settle()
    // minFoldChars floors at 300.
    expect(writes[0]!.ops[0]!.value).toBe(300)
  })

  it('writes a boolean through mutate', async () => {
    const { remote, writes } = makeRemote({ dryRun: false })
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    const firstCheck = inputs(tree).find((props) => props['type'] === 'checkbox')!
    ;(firstCheck['onChange'] as (event: unknown) => void)({ currentTarget: { checked: true } })
    await page.settle()
    expect(writes[0]!.ops[0]).toEqual({ op: 'set', path: ['enabled'], value: true })
  })

  it('reports an unavailable namespace rather than rendering empty controls', async () => {
    const remote = {
      settings: {
        describe: async () => ({ ok: true, value: { namespaces: [] } }),
        mutate: async () => ({ ok: true }),
      },
    }
    const { ctx, registrations } = makeCtx(remote)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    expect(inputs(tree)).toHaveLength(0)
    let text = ''
    walk(tree, (node) => {
      for (const child of node.children) if (typeof child === 'string') text += child
    })
    // The message is translated, so assert on the English text rather than the key.
    expect(text).toContain(en['page.unavailable'])
  })

  it('degrades when the client has no settings remote at all', async () => {
    const { ctx, registrations } = makeCtx(undefined)
    registerSettingsPage(ctx as never)
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    expect(inputs(tree)).toHaveLength(0)
  })

  it('survives a context whose remote cannot be resolved', async () => {
    // Web boot once failed with "dsh-context-fold: loading" because `apply()`
    // threw: a Cordis context raises on an undeclared service instead of
    // returning undefined, and `remote.settings` alone does not make `ctx.remote`
    // resolvable. Registration must degrade, never throw — a missing settings
    // service cannot be allowed to take the whole client plugin down.
    const registrations: { descriptor: Record<string, unknown>; render: (props: unknown) => unknown }[] = []
    const throwing = {
      get remote(): never {
        throw new Error('cannot get property "remote" without inject')
      },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (descriptor: Record<string, unknown>, render: (props: unknown) => unknown) => {
          registrations.push({ descriptor, render })
          return () => {}
        },
      },
      locale: { register: () => () => {}, bind: () => (key: string) => en[key] ?? key },
    }
    expect(() => registerSettingsPage(throwing as never)).not.toThrow()
    expect(registrations).toHaveLength(1)
    // And the page itself reports the missing namespace rather than crashing.
    const page = mountSection(registrations[0]!)
    const tree = await page.start()
    expect(inputs(tree)).toHaveLength(0)
  })
})
