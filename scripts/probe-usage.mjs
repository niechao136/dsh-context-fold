/**
 * Empirical probe for design §11 open question 1 (cache behaviour) and the
 * "before vs after" numbers the UI must show.
 *
 * Reads real session logs and reports, per turn:
 *   - prompt composition: uncached input vs cache read vs cache write
 *   - the effective cache-read ratio
 *   - what a fold would have saved and what it costs to invalidate
 *
 * Not shipped. Run: node scripts/probe-usage.mjs [root] [count]
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createZstdDecompress } from 'node:zlib'

const ROOT = process.argv[2] ?? 'C:/Users/nie.chao/.dsh/sessions'
const COUNT = Number(process.argv[3] ?? 4)

async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collect(path))
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

async function readEvents(path) {
  const inflated = createReadStream(path).pipe(createZstdDecompress())
  const lines = createInterface({ input: inflated, crlfDelay: Infinity })
  const events = []
  for await (const line of lines) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* skip torn line */ }
  }
  return events
}

const sized = []
for (const path of await collect(ROOT)) {
  try { sized.push({ path, size: (await stat(path)).size }) } catch { /* skip */ }
}
sized.sort((a, b) => b.size - a.size)

for (const file of sized.slice(0, COUNT)) {
  const events = await readEvents(file.path)
  const steps = []
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.usage === undefined) continue
    const u = event.usage
    const cacheRead = u.cacheReadTokens ?? 0
    const cacheWrite = u.cacheWriteTokens ?? 0
    const input = u.inputTokens ?? 0
    const prompt = input + cacheRead + cacheWrite
    steps.push({
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      input,
      cacheRead,
      cacheWrite,
      output: u.outputTokens ?? 0,
      reasoning: u.reasoningTokens ?? 0,
      prompt,
      cacheRatio: prompt === 0 ? 0 : cacheRead / prompt,
    })
  }
  if (steps.length === 0) {
    console.log(`\n=== ${file.path.split('sessions\\')[1]}`)
    console.log('  no usage on any assistant/message event')
    continue
  }
  const totalPrompt = steps.reduce((sum, s) => sum + s.prompt, 0)
  const totalCacheRead = steps.reduce((sum, s) => sum + s.cacheRead, 0)
  const totalCacheWrite = steps.reduce((sum, s) => sum + s.cacheWrite, 0)
  const totalInput = steps.reduce((sum, s) => sum + s.input, 0)
  const withCache = steps.filter((s) => s.cacheRead > 0 || s.cacheWrite > 0).length
  console.log(`\n=== ${file.path.split('sessions\\')[1]}`)
  console.log(`  steps with usage: ${steps.length}; steps reporting any cache field: ${withCache}`)
  console.log(`  prompt tokens total: ${totalPrompt.toLocaleString()}  (uncached input ${totalInput.toLocaleString()}, cache read ${totalCacheRead.toLocaleString()}, cache write ${totalCacheWrite.toLocaleString()})`)
  console.log(`  session-wide cache-read ratio: ${totalPrompt === 0 ? 'n/a' : (totalCacheRead / totalPrompt * 100).toFixed(1) + '%'}`)
  const first = steps[0]
  const last = steps[steps.length - 1]
  console.log(`  first step prompt: ${first.prompt.toLocaleString()} (cache ${first.cacheRead.toLocaleString()}), last: ${last.prompt.toLocaleString()} (cache ${last.cacheRead.toLocaleString()})`)
  const monotone = steps.every((s, i) => i === 0 || s.cacheRead >= steps[i - 1].cacheRead)
  console.log(`  cacheRead monotone non-decreasing across the session: ${monotone}`)
  // A cache break shows up as cacheRead dropping while prompt grows.
  const drops = steps.filter((s, i) => i > 0 && s.cacheRead < steps[i - 1].cacheRead)
  console.log(`  observed cache breaks (cacheRead dropped): ${drops.length}${drops.length === 0 ? '' : ' at turns ' + drops.slice(0, 5).map((d) => d.turn + '.' + d.step).join(', ')}`)
}
