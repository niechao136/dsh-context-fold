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
  /** Only fold when the candidate batch is worth the one cache invalidation. */
  minBatchChars: number
  /** Never fold the newest N steps. */
  keepRecentSteps: number
  /** Age condition that lets a single long turn fold without a turn boundary. */
  staleSteps: number
  /** Split a very long turn into contiguous step ranges of this size. */
  batchSpanSteps: number
  /** Fold reasoning blocks on historical tool-call turns (phase 2). */
  foldReasoning: boolean
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
  minBatchChars: 8000,
  keepRecentSteps: 6,
  staleSteps: 12,
  batchSpanSteps: 20,
  foldReasoning: true,
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
      .description('Only fold a batch of candidates whose combined size reaches this many characters.')
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
 * Resolve and validate a partly-specified configuration.
 *
 * @param config - raw plugin configuration.
 * @returns a detached, frozen configuration.
 * @throws when a budget is not a safe integer or `minFoldChars` is below 300.
 */
export function resolveConfig(config: Partial<ContextFoldConfig> = {}): ContextFoldConfig {
  const resolved: ContextFoldConfig = {
    minFoldChars: config.minFoldChars ?? DEFAULT_CONFIG.minFoldChars,
    minBatchChars: config.minBatchChars ?? DEFAULT_CONFIG.minBatchChars,
    keepRecentSteps: config.keepRecentSteps ?? DEFAULT_CONFIG.keepRecentSteps,
    staleSteps: config.staleSteps ?? DEFAULT_CONFIG.staleSteps,
    batchSpanSteps: config.batchSpanSteps ?? DEFAULT_CONFIG.batchSpanSteps,
    foldReasoning: config.foldReasoning ?? DEFAULT_CONFIG.foldReasoning,
    foldPlainTurnReasoning: config.foldPlainTurnReasoning ?? DEFAULT_CONFIG.foldPlainTurnReasoning,
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    dryRun: config.dryRun ?? DEFAULT_CONFIG.dryRun,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'enabled' || key === 'dryRun' || key === 'foldReasoning' || key === 'foldPlainTurnReasoning') continue
    assertInteger(key, value, key === 'minFoldChars' ? 300 : key === 'minBatchChars' ? 1 : 0)
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
