/**
 * Configuration resolution for deterministic tool-result folding.
 *
 * Every knob is a plain integer or boolean, so the same content always yields
 * the same decision on the same log prefix (design §2 goal 3).
 *
 * @module dsh-context-fold/config
 */
import z from '@deepseek-ai/schemastery'

/** Resolved, validated fold budgets. */
export interface ContextFoldConfig {
  /** Skip results smaller than this many characters. Never below 300 (design §3.4: negative return below that). */
  minFoldChars: number
  /**
   * Size the shared fold pool must reach before anything folds.
   *
   * Tool results and reasoning draw on **one** pool rather than two: any change
   * to a historical message invalidates the same prompt-cache prefix, so two
   * independent thresholds would each think their own fold was worth the cost
   * and pay it twice in the same step. Summing both and gating once means a
   * step either folds everything eligible or nothing.
   */
  minBatchChars: number
  /** Never fold the newest N steps. */
  keepRecentSteps: number
  /** Age condition that lets a single long turn fold without a turn boundary. */
  staleSteps: number
  /** Split a very long turn into contiguous step ranges of this size. */
  batchSpanSteps: number
  /** Fold reasoning blocks on historical tool-call turns (phase 2). */
  foldReasoning: boolean
  /** Minimum size of a reasoning block before it is a fold candidate. */
  minFoldReasoningChars: number
  /** Minimum size of a tool-call argument before it is a fold candidate. */
  minFoldArgsChars: number
  /**
   * Keep the newest N turns fully unfolded; older turns are archived.
   *
   * Turn archive is orthogonal to the char-based gate: once a turn crosses
   * this boundary its tool calls, results and reasoning are archived into a
   * per-turn spill file, keeping only the assistant/user text in view.
   */
  keepRecentTurns: number
  /** Master switch for turn archiving. */
  foldTurnArchive: boolean
  /** Directory (under the spill root) where per-turn archives are written. */
  turnArchiveDir: string
  /**
   * Also fold reasoning on plain (non-tool-call) turns.
   *
   * Off by default because `dsh-llm-deepseek` drops plain-turn reasoning, so on
   * that route folding it saves nothing. Turn it on for a route whose serializer
   * re-sends plain-turn reasoning unconditionally (e.g. `dsh-router-core`), where
   * it is a real saving.
   */
  foldPlainTurnReasoning: boolean
  /** Master switch; `false` means the plugin does nothing at all. */
  enabled: boolean
  /** Compute and report candidates without mutating anything. */
  dryRun: boolean
}

/** Low-friction defaults from design §6.9. */
export const DEFAULT_CONFIG: Readonly<ContextFoldConfig> = deepFreeze({
  minFoldChars: 1000,
  minBatchChars: 16000,
  keepRecentSteps: 6,
  staleSteps: 12,
  batchSpanSteps: 20,
  foldReasoning: true,
  minFoldReasoningChars: 900,
  minFoldArgsChars: 400,
  keepRecentTurns: 5,
  foldTurnArchive: true,
  turnArchiveDir: 'turns',
  foldPlainTurnReasoning: false,
  enabled: true,
  dryRun: false,
})

/**
 * Config schema shown in the settings UI.
 *
 * Every field ends in `.volatile()`, and that is load-bearing rather than
 * cosmetic: the Settings service builds a page from `volatileForm(schema)` and
 * returns no page at all when the schema has no volatile field
 * (`describe()` drops the entry outright). Without it the plugin simply has no
 * configuration surface — the fields still work through the Cordis patch, but
 * nothing is listed and nothing is editable in the GUI.
 *
 * Fields are also individually described, because the auto-generated page uses
 * the description as the field's help text.
 */
export const Config = z
  .object({
    minFoldChars: z
      .number()
      .step(1)
      .min(300)
      .default(DEFAULT_CONFIG.minFoldChars)
      .description('Skip tool results smaller than this many characters. Never below 300.')
      .volatile(),
    minBatchChars: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_CONFIG.minBatchChars)
      .description(
        'Shared size gate: tool results and reasoning together must free at least this many characters before either folds. One number because both kinds of change invalidate the same cache prefix.',
      )
      .volatile(),
    keepRecentSteps: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULT_CONFIG.keepRecentSteps)
      .description('Never fold a result from the newest N steps.')
      .volatile(),
    staleSteps: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_CONFIG.staleSteps)
      .description('Age (in steps) after which a result may fold inside one long turn.')
      .volatile(),
    batchSpanSteps: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_CONFIG.batchSpanSteps)
      .description('Split a turn longer than this many steps into contiguous sub-batches.')
      .volatile(),
    foldReasoning: z
      .boolean()
      .default(DEFAULT_CONFIG.foldReasoning)
      .description(
        'Fold reasoning blocks on historical tool-call turns. Reasoning on plain turns is never re-sent, so it is not folded.',
      )
      .volatile(),
    minFoldReasoningChars: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULT_CONFIG.minFoldReasoningChars)
      .description('Skip reasoning blocks smaller than this many characters.')
      .volatile(),
    minFoldArgsChars: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULT_CONFIG.minFoldArgsChars)
      .description('Skip tool-call arguments smaller than this many characters.')
      .volatile(),
    keepRecentTurns: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_CONFIG.keepRecentTurns)
      .description('Keep the newest N turns unfolded. Older turns have their tool calls, results and reasoning archived.')
      .volatile(),
    foldTurnArchive: z
      .boolean()
      .default(DEFAULT_CONFIG.foldTurnArchive)
      .description('Archive tool calls, results and reasoning of turns older than keepRecentTurns into per-turn spill files.')
      .volatile(),
    turnArchiveDir: z
      .string()
      .default(DEFAULT_CONFIG.turnArchiveDir)
      .description('Directory under the spill root where per-turn archive files are written.')
      .volatile(),
    foldPlainTurnReasoning: z
      .boolean()
      .default(DEFAULT_CONFIG.foldPlainTurnReasoning)
      .description(
        'Also fold reasoning on plain turns. Enable when the route re-sends it (e.g. dsh-router-core); leave off for dsh-llm-deepseek, which drops it.',
      )
      .volatile(),
    enabled: z
      .boolean()
      .default(DEFAULT_CONFIG.enabled)
      .description('Turn folding on or off.')
      .volatile(),
    dryRun: z
      .boolean()
      .default(DEFAULT_CONFIG.dryRun)
      .description('Compute and report candidates without mutating the session.')
      .volatile(),
  })
  .description('Stage-boundary folding of completed tool results and historical reasoning.')

/**
 * Unwrap one configuration value.
 *
 * Every field is `.volatile()`, and the host therefore hands `apply()` a
 * *reference* per field (`{ get(): T }`) instead of the plain value — that is the
 * documented contract: "Business plugins read their Config references directly."
 * Accepting a plain value too keeps this callable from tests and from a profile
 * patch that bypasses schema parsing.
 *
 * @param value - a volatile reference, a plain value, or undefined.
 * @param fallback - used when the reference resolves to `undefined`.
 * @returns the plain value.
 */
function readField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') {
    const get = (value as { get?: unknown }).get
    if (typeof get === 'function') {
      const resolved = (get as () => T | undefined).call(value)
      return resolved === undefined ? fallback : resolved
    }
  }
  return value as T
}

/**
 * Resolve and validate a partly-specified configuration.
 *
 * Accepts the raw plugin configuration as the host supplies it — volatile
 * references per field — and also accepts plain values.
 *
 * @param config - raw plugin configuration.
 * @returns a detached, frozen configuration.
 * @throws when a budget is not a safe integer or `minFoldChars` is below 300.
 */
export function resolveConfig(config: Partial<ContextFoldConfig> = {}): ContextFoldConfig {
  const raw = config as Record<string, unknown>
  const resolved: ContextFoldConfig = {
    minFoldChars: readField(raw['minFoldChars'], DEFAULT_CONFIG.minFoldChars),
    minBatchChars: readField(raw['minBatchChars'], DEFAULT_CONFIG.minBatchChars),
    keepRecentSteps: readField(raw['keepRecentSteps'], DEFAULT_CONFIG.keepRecentSteps),
    staleSteps: readField(raw['staleSteps'], DEFAULT_CONFIG.staleSteps),
    batchSpanSteps: readField(raw['batchSpanSteps'], DEFAULT_CONFIG.batchSpanSteps),
    foldReasoning: readField(raw['foldReasoning'], DEFAULT_CONFIG.foldReasoning),
    minFoldReasoningChars: readField(raw['minFoldReasoningChars'], DEFAULT_CONFIG.minFoldReasoningChars),
    minFoldArgsChars: readField(raw['minFoldArgsChars'], DEFAULT_CONFIG.minFoldArgsChars),
    keepRecentTurns: readField(raw['keepRecentTurns'], DEFAULT_CONFIG.keepRecentTurns),
    foldTurnArchive: readField(raw['foldTurnArchive'], DEFAULT_CONFIG.foldTurnArchive),
    turnArchiveDir: readField(raw['turnArchiveDir'], DEFAULT_CONFIG.turnArchiveDir),
    foldPlainTurnReasoning: readField(raw['foldPlainTurnReasoning'], DEFAULT_CONFIG.foldPlainTurnReasoning),
    enabled: readField(raw['enabled'], DEFAULT_CONFIG.enabled),
    dryRun: readField(raw['dryRun'], DEFAULT_CONFIG.dryRun),
  }
  const nonIntegerKeys = new Set([
    'enabled', 'dryRun', 'foldReasoning', 'foldPlainTurnReasoning', 'foldTurnArchive', 'turnArchiveDir',
  ])
  for (const [key, value] of Object.entries(resolved)) {
    if (nonIntegerKeys.has(key)) continue
    assertInteger(key, value as number, key === 'minFoldChars' ? 300 : key === 'minBatchChars' ? 1 : 0)
  }
  if (resolved.staleSteps < 1) throw new Error(`context-fold: staleSteps (${resolved.staleSteps}) must be at least 1`)
  if (resolved.batchSpanSteps < 1) throw new Error(`context-fold: batchSpanSteps (${resolved.batchSpanSteps}) must be at least 1`)
  return deepFreeze(resolved)
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`context-fold: ${name} (${String(value)}) must be an integer of at least ${minimum}`)
  }
}

/** Recursively freeze a configuration object. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
