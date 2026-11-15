import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

/**
 * The settings page is not a separate artefact: the Settings service renders one
 * from the config schema, but only when `volatileForm(schema)` finds volatile
 * fields — `describe()` drops any entry whose form is `undefined`.
 *
 * So "does this plugin have a settings page?" reduces to "does every field carry
 * `meta.volatile`?", which is what is asserted here. It matters because
 * `.volatile()` returns a type-compatible schema: drop it and the plugin still
 * works through the Cordis patch, but no page is listed and nothing is editable
 * in the GUI — with no warning anywhere. This test is the guard for that.
 *
 * `toJSON()` serialises as `{ uid, refs }` where `refs` is keyed by child uid, so
 * the root is resolved through `refs[uid]` and fields through `refs[uid].dict`.
 */
interface SchemaNode {
  type?: string
  meta?: { volatile?: boolean; description?: string; default?: unknown }
  dict?: Record<string, unknown>
}

interface SerializedSchema {
  uid: number
  refs: Record<string, SchemaNode>
}

function serialized(): SerializedSchema {
  return Config.toJSON() as unknown as SerializedSchema
}

/** The root object schema. */
function root(): SchemaNode {
  const json = serialized()
  const node = json.refs[String(json.uid)]
  expect(node, 'the root schema must resolve through refs[uid]').toBeDefined()
  return node!
}

/** Field name -> resolved schema node. */
function fields(): Record<string, SchemaNode> {
  const json = serialized()
  const dict = root().dict ?? {}
  return Object.fromEntries(
    Object.entries(dict).map(([name, ref]) => {
      const uid = typeof ref === 'number' ? String(ref) : String((ref as { uid?: number })?.uid)
      return [name, json.refs[uid] ?? (ref as SchemaNode)]
    }),
  )
}

describe('settings schema', () => {
  /** Every knob this plugin documents; keep in sync with `ContextFoldConfig`. */
  const EXPECTED_FIELDS = [
    'minFoldChars',
    'minBatchChars',
    'keepRecentSteps',
    'staleSteps',
    'batchSpanSteps',
    'foldReasoning',
    'foldPlainTurnReasoning',
    'enabled',
    'dryRun',
  ]

  it('is a root object with declared fields', () => {
    expect(Object.keys(fields()).length).toBeGreaterThan(0)
  })

  it('lists exactly the documented knobs', () => {
    // A field whose `.volatile()` is dropped does not disappear from the dict in
    // every schemastery version (the flag can be re-derived), so the flag check
    // below is the primary guard. This set comparison is the second line of
    // defence: it catches a knob that is added to the interface but never wired
    // into the schema, which would leave it configurable in the patch but absent
    // from the page.
    expect(Object.keys(fields()).sort()).toEqual([...EXPECTED_FIELDS].sort())
  })

  it('exposes every field as volatile, so the settings page is generated', () => {
    const all = fields()
    expect(Object.keys(all).length).toBeGreaterThan(0)
    for (const [name, field] of Object.entries(all)) {
      expect(field.meta?.volatile, `${name} must be volatile to appear in settings`).toBe(true)
    }
  })

  it('describes every field, because the generated page shows the description', () => {
    for (const [name, field] of Object.entries(fields())) {
      expect(field.meta?.description, `${name} needs a description`).toBeTruthy()
    }
  })

  it('resolves a full config from an empty patch', () => {
    // `.volatile()` makes `Config()` return volatile *references* rather than
    // plain values, so business code must go through `resolveConfig`. This pins
    // that the defaults still come out as plain numbers and booleans.
    const resolved = resolveConfig({})
    expect(resolved.enabled).toBe(true)
    expect(resolved.dryRun).toBe(false)
    expect(resolved.foldReasoning).toBe(true)
    // Off by default: plain-turn reasoning is not re-sent by the DeepSeek route.
    expect(resolved.foldPlainTurnReasoning).toBe(false)
    expect(typeof resolved.minFoldChars).toBe('number')
    expect(resolved.minFoldChars).toBe(1000)
  })
})
