import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { codePointLength, conclude, isFoldableContent, parseSpillNotice, textOf } from '../src/rules.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

describe('textOf and measurement', () => {
  it('joins text blocks in order', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('😀😀')).toBe(2)
    expect('😀😀'.length).toBe(4)
  })

  it('treats images as unfoldable', () => {
    const image = {
      type: 'image',
      attachment: { attachmentId: 'i1', mediaType: 'image/png', width: 1, height: 1 },
    } as unknown as ContentBlock
    expect(isFoldableContent([...text('x'), image])).toBe(false)
    expect(isFoldableContent(text('x'))).toBe(true)
  })
})

describe('conclude — shell', () => {
  it('keeps exit code, first stdout line, stderr tail and sizes', () => {
    const out = `=== deps ===\ntypescript 6.0.3\nvitest 4.1.8\n[stderr]\nwarning: peer dep\n[exit code: 0]`
    const body = conclude({ toolName: 'ops_bash', callId: 'c1', content: text(out), chars: out.length })
    expect(body).toContain('exit 0')
    expect(body).toContain('=== deps ===')
    expect(body).toContain('warning: peer dep')
    expect(body).toContain(`${out.split('\n').length} lines`)
  })

  it('records a failure exit code', () => {
    const out = 'boom\n[stderr]\nfatal\n[exit code: 2]'
    const body = conclude({ toolName: 'ops_bash', callId: 'c1', content: text(out), chars: out.length })
    expect(body).toContain('exit 2')
  })

  it('quotes the first stdout line without inventing content', () => {
    const out = 'hello world\nmore\n[exit code: 0]'
    const body = conclude({ toolName: 'pwsh', callId: 'c1', content: text(out), chars: out.length })!
    expect(body).toContain('first "hello world"')
  })
})

describe('conclude — read', () => {
  it('keeps path, line range and first content line', () => {
    const out = '=== FILE: F:\\repo\\src\\a.ts (Lines 1-40 of 300) ===\n[Notice: revision=abc; bytes=12]\n1 | export const a = 1'
    const body = conclude({
      toolName: 'read',
      callId: 'c1',
      content: text(out),
      chars: out.length,
      args: JSON.stringify({ file_path: 'F:\\repo\\src\\a.ts' }),
    })!
    expect(body).toContain('path "F:\\repo\\src\\a.ts"')
    expect(body).toContain('lines 1-40 of 300')
    expect(body).toContain('export const a = 1')
  })
})

describe('conclude — search', () => {
  it('keeps pattern, hit count and matched paths', () => {
    const out = '=== FILE: src/a.ts (3 matches) ===\n1 | x\n=== FILE: src/b.ts (1 match) ===\n2 | y'
    const body = conclude({
      toolName: 'grep',
      callId: 'c1',
      content: text(out),
      chars: out.length,
      args: JSON.stringify({ pattern: 'surfaceOp' }),
    })!
    expect(body).toContain('pattern "surfaceOp"')
    expect(body).toContain('2 files')
    expect(body).toContain('src/a.ts')
  })
})

describe('conclude — inspect, web, fallback', () => {
  it('keeps section headings for cordis_inspect tools', () => {
    const out = '## Service\nlong declarations\n## Events\nmore'
    const body = conclude({ toolName: 'cordis_inspect_service', callId: 'c1', content: text(out), chars: out.length })!
    expect(body).toContain('sections: Service, Events')
    expect(body).not.toContain('long declarations')
  })

  it('keeps the url and first paragraph for web tools', () => {
    const out = 'Some title\nFirst paragraph body.\nmore text'
    const body = conclude({
      toolName: 'web_fetch',
      callId: 'c1',
      content: text(out),
      chars: out.length,
      args: JSON.stringify({ url: 'https://example.com/x' }),
    })!
    expect(body).toContain('url "https://example.com/x"')
    expect(body).toContain('Some title')
  })

  it('falls back to the first line plus size for unknown tools', () => {
    const out = 'opaque first line\nrest'
    const body = conclude({ toolName: 'mystery', callId: 'c1', content: text(out), chars: out.length })!
    expect(body).toContain('first "opaque first line"')
    expect(body).toContain(`${codePointLength(out)} chars`)
  })

  it('returns undefined for empty content', () => {
    expect(conclude({ toolName: 'ops_bash', callId: 'c1', content: text('   '), chars: 3 })).toBeUndefined()
  })

  it('caps a pathological single line', () => {
    const out = `x${'y'.repeat(5000)}`
    const body = conclude({ toolName: 'mystery', callId: 'c1', content: text(out), chars: out.length })!
    expect(codePointLength(body)).toBeLessThan(2000)
    expect(body.endsWith('…') || body.includes('…')).toBe(true)
  })

  it('renders the same conclusion for the same input', () => {
    const out = 'a\nb\nc'
    const first = conclude({ toolName: 'mystery', callId: 'c9', content: text(out), chars: out.length })
    const second = conclude({ toolName: 'mystery', callId: 'c9', content: text(out), chars: out.length })
    expect(first).toBe(second)
  })
})

describe('parseSpillNotice', () => {
  it('recognizes the spill-policy notice', () => {
    const notice =
      '(... 1000 bytes omitted. Full formatted result stored at: C:\\spill\\a.txt. Use read with offset/limit, or grep this path to search within it.)'
    expect(parseSpillNotice(notice)).toEqual({ locator: 'C:\\spill\\a.txt', bytes: 1000 })
  })

  it('returns undefined when no notice is present', () => {
    expect(parseSpillNotice('plain result')).toBeUndefined()
  })
})
