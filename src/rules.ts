/**
 * Deterministic fold rules: turn one tool result into a self-contained
 * conclusion that is strictly smaller than the result and contains no
 * information absent from it (design §6.3).
 *
 * Nothing here calls a model, reads the clock, or consults session state, so a
 * given result always produces the same conclusion.
 *
 * @module dsh-context-fold/rules
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One candidate result as the rules see it. */
export interface FoldFacts {
  /** Tool name from the paired `tool/call`. */
  toolName: string
  /** The result's model-issued call id. */
  callId: string
  /** Current model-visible content of the result. */
  content: readonly ContentBlock[]
  /** Raw `arguments` JSON of the paired `tool/call`, when that event is still present. */
  args?: string
  /** Whole-result character count under {@link codePointLength}. */
  chars: number
}

/** Parsed spill notice: where the full text already lives. */
export interface SpillNotice {
  locator: string
  bytes: number | undefined
}

const NOTICE_LOCATION = ' Full formatted result stored at: '

/** Longest conclusion line before ellipsis. */
const LINE_BUDGET = 120
/** Longest total conclusion body. */
const BODY_BUDGET = 320

const SHELL_TOOLS = new Set(['ops_bash', 'pwsh', 'bash', 'shell', 'ops_pwsh', 'wsl'])
const READ_TOOLS = new Set(['read', 'ops_read_files', 'ops_inspect_local_file', 'wsl-read', 'ops_read_pdf', 'ops_read_docx'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ops_grep', 'ops_glob', 'ops_result', 'wsl-grep', 'ops_discover_tools'])
const WEB_TOOLS = new Set(['web_fetch', 'web_search', 'platform_search', 'domain_search', 'research', 'web_tools', 'video_search', 'multi_search', 'advanced_search'])

/**
 * Count Unicode code points without splitting surrogate pairs, matching the
 * pruner's measurement so sizes are comparable across plugins.
 *
 * @param text - text to measure.
 * @returns the code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Model-visible text of one result, including image/file placeholders.
 *
 * @param content - ordered result blocks.
 * @returns concatenated text with a stable placeholder for non-text blocks.
 */
export function textOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'image') text += `\n[image ${block.attachment.attachmentId}]\n`
    else if (block.type === 'file') text += `\n[file ${block.attachment.attachmentId}]\n`
  }
  return text
}

/**
 * Whether a result can be folded without losing anything structural.
 *
 * Image and unknown blocks are never folded: their placeholder text is not the
 * content, and phase 1 must not trade an attachment for a sentence about it.
 *
 * @param content - ordered result blocks.
 * @returns true when every block is text.
 */
export function isFoldableContent(content: readonly ContentBlock[]): boolean {
  return content.every((block) => block.type === 'text')
}

/**
 * Find the spill notice an already-bounded result carries, so folding reuses
 * that locator instead of spilling the same text twice (design §6.5).
 *
 * @param text - result text.
 * @returns the parsed notice, or undefined when the result was never spilled.
 */
export function parseSpillNotice(text: string): SpillNotice | undefined {
  const at = text.indexOf(NOTICE_LOCATION)
  if (at < 0) return undefined
  const rest = text.slice(at + NOTICE_LOCATION.length)
  const end = rest.indexOf('. ')
  const locator = (end < 0 ? rest : rest.slice(0, end)).replace(/\)\s*$/, '').trim()
  if (locator === '') return undefined
  const head = text.slice(0, at)
  const bytes = /([\d,]+)\s+bytes\s+omitted/i.exec(head)?.[1]
  return { locator, bytes: bytes === undefined ? undefined : Number(bytes.replaceAll(',', '')) }
}

/**
 * Produce the one-line conclusion for a result.
 *
 * The rule is chosen by tool family, mirroring design §6.3, and falls back to
 * the first line plus a size for anything unlisted. A conclusion is always
 * shorter than the result it replaces; callers still compare sizes before
 * folding, because a pathological result can defeat any rule.
 *
 * @param facts - candidate facts.
 * @returns the conclusion body (without the fold header), or undefined when the
 *   result carries no foldable text.
 */
export function conclude(facts: FoldFacts): string | undefined {
  const text = textOf(facts.content)
  if (text.trim() === '') return undefined
  const args = parseArgs(facts.args)
  let body: string
  if (facts.toolName.startsWith('cordis_inspect')) body = inspectConclusion(text)
  else if (SHELL_TOOLS.has(facts.toolName)) body = shellConclusion(text, facts)
  else if (READ_TOOLS.has(facts.toolName)) body = readConclusion(text, args)
  else if (SEARCH_TOOLS.has(facts.toolName)) body = searchConclusion(text, args)
  else if (WEB_TOOLS.has(facts.toolName)) body = webConclusion(text, args)
  else body = fallbackConclusion(text)
  const capped = cap(body, BODY_BUDGET)
  return capped === '' ? undefined : capped
}

/** Shell: exit code, first stdout line, last stderr line, line count. */
function shellConclusion(text: string, facts: FoldFacts): string {
  const parts: string[] = []
  const exit = /\[exit code:\s*(-?\d+)\s*\]/i.exec(text)
  if (exit !== null) parts.push(`exit ${exit[1]}`)
  const stderrAt = /^\[stderr\]$/m.exec(text)
  const body = stderrAt === null ? text : text.slice(0, stderrAt.index)
  const stdout = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^\[cwd:/.test(line) && !/^\[exit code:/.test(line))
  if (stdout[0] !== undefined) parts.push(`first ${quote(cap(stdout[0], LINE_BUDGET))}`)
  if (stderrAt !== null) {
    const stderr = text
      .slice(stderrAt.index + stderrAt[0].length)
      .split('\n')
      .filter((line) => !/^\[exit code:/.test(line.trim()))
      .join('\n')
    const tail = lastNonEmpty(stderr)
    if (tail !== '') parts.push(`stderr ${quote(cap(tail, LINE_BUDGET))}`)
  }
  parts.push(`${countLines(text)} lines, ${formatNumber(facts.chars)} chars`)
  return parts.join('; ')
}

/** Read: path, line range, first content line. */
function readConclusion(text: string, args: Record<string, string>): string {
  const parts: string[] = []
  const path = args.path ?? args.file_path ?? /^=== FILE:\s*(.+?)(?:\s+\(|$)/m.exec(text)?.[1]
  if (path !== undefined) parts.push(`path ${quote(cap(path.trim(), LINE_BUDGET))}`)
  const range = /\(Lines (\d+)-(\d+) of (\d+)\)/.exec(text)
  if (range !== null) parts.push(`lines ${range[1]}-${range[2]} of ${range[3]}`)
  const first = firstNonEmpty(
    text.split('\n').filter((line) => !/^=== FILE:/.test(line) && !/^\[Notice:/.test(line)),
  )
  if (first !== '') parts.push(`first ${quote(cap(first, LINE_BUDGET))}`)
  parts.push(`${countLines(text)} lines total`)
  return parts.join('; ')
}

/** Search: pattern, hit count, first few matched paths. */
function searchConclusion(text: string, args: Record<string, string>): string {
  const parts: string[] = []
  const pattern = args.pattern ?? args.query
  if (pattern !== undefined) parts.push(`pattern ${quote(cap(pattern, LINE_BUDGET))}`)
  const files = new Set<string>()
  for (const match of text.matchAll(/^=== FILE:\s*(.+?)(?:\s+\(|$)/gm)) files.add(match[1]!.trim())
  const hits = text.split('\n').filter((line) => line.trim() !== '' && !/^\[Notice:/.test(line)).length
  parts.push(`${hits} non-empty lines`)
  if (files.size > 0) {
    const shown = [...files].slice(0, 3)
    parts.push(`${files.size} files: ${shown.join(', ')}`)
  }
  if (files.size === 0) {
    const firstPath = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !/^\[Notice:/.test(line))
    if (firstPath !== undefined) parts.push(`first ${quote(cap(firstPath, LINE_BUDGET))}`)
  }
  return parts.join('; ')
}

/** Inspect: section headings only, never the declaration bodies. */
function inspectConclusion(text: string): string {
  const headings: string[] = []
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1]!.trim()
    if (heading !== '' && !headings.includes(heading)) headings.push(heading)
    if (headings.length >= 5) break
  }
  if (headings.length > 0) return `sections: ${headings.join(', ')}; ${countLines(text)} lines`
  return fallbackConclusion(text)
}

/** Web: URL or query, then the first meaningful line. */
function webConclusion(text: string, args: Record<string, string>): string {
  const parts: string[] = []
  const url = args.url ?? args.query
  if (url !== undefined) parts.push(`url ${quote(cap(url, LINE_BUDGET))}`)
  const first = firstNonEmpty(text.split('\n').filter((line) => !/^#{1,6}\s/.test(line)))
  if (first !== '') parts.push(`first ${quote(cap(first, LINE_BUDGET))}`)
  parts.push(`${countLines(text)} lines, ${formatNumber(codePointLength(text))} chars`)
  return parts.join('; ')
}

/** Unknown tools: first line plus the measured size. */
function fallbackConclusion(text: string): string {
  const first = firstNonEmpty(text.split('\n'))
  return `first ${quote(cap(first, LINE_BUDGET))}; ${countLines(text)} lines, ${formatNumber(codePointLength(text))} chars`
}

/** Parse the small argument subset the rules quote, tolerating malformed JSON. */
function parseArgs(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, string> = {}
  for (const key of ['path', 'file_path', 'pattern', 'query', 'url', 'command', 'description']) {
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** First non-empty line, trimmed. */
function firstNonEmpty(lines: readonly string[]): string {
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** Last non-empty line, trimmed. */
function lastNonEmpty(text: string): string {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const trimmed = lines[index]!.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** Line count of a text. */
function countLines(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

/** Cap by code point with a trailing ellipsis. */
function cap(text: string, budget: number): string {
  const points = Array.from(text)
  return points.length <= budget ? text : `${points.slice(0, budget - 1).join('')}…`
}

/** Render a quoted, single-line excerpt. */
function quote(text: string): string {
  return `"${text.replaceAll('"', "'").replaceAll('\n', ' ')}"`
}

/** Group digits for readability; the value itself is unchanged. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}
