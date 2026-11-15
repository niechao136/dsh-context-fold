import { describe, expect, it } from 'vitest'
import { zhDictionary, enDictionary } from '../src/client-dictionaries.ts'
import { settingsDictionaries } from '../src/settings-page.ts'

/**
 * The UI is Chinese by default, so the two dictionaries have to agree: a key
 * present in one and missing in the other silently falls back, and a key used by
 * a component but absent from both renders as the raw key (the "settings.nav"
 * symptom).
 *
 * These assertions pin three things: zh and en carry the same keys, no value is
 * empty, and every key matches the dotted `area.name` convention so a typo shows
 * up as a structural mismatch rather than a stray English string.
 */
const DICTIONARIES: [string, Record<string, string>, Record<string, string>][] = [
  ['conversation tab', zhDictionary, enDictionary],
  ['settings page', settingsDictionaries.zh, settingsDictionaries.en],
]

describe.each(DICTIONARIES)('%s dictionaries', (_name, zh, en) => {
  it('has a Chinese string for every English key and vice versa', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty values', () => {
    for (const [key, value] of Object.entries(zh)) expect(value.trim(), key).not.toBe('')
    for (const [key, value] of Object.entries(en)) expect(value.trim(), key).not.toBe('')
  })

  it('uses dotted area.name keys', () => {
    // Keys nest (`tab.subtitle.summary`), so allow one or more segments.
    for (const key of Object.keys(zh)) expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/)
  })

  it('leaves no untranslated English in the Chinese dictionary', () => {
    // A Chinese value byte-identical to English means the entry was copied over
    // and never translated. Two things are legitimately identical: the tab label
    // (a brand-ish name) and pure placeholders/symbols such as `T{n}` or `tok`.
    const allowedIdentical = new Set(['tab.contextFold'])
    const carriesNoWords = (value: string): boolean => !/[a-zA-Z]{3,}/.test(value.replace(/\{\w+\}/g, ''))
    for (const key of Object.keys(zh)) {
      if (allowedIdentical.has(key)) continue
      if (carriesNoWords(zh[key]!)) continue
      expect(zh[key], `${key} is untranslated`).not.toBe(en[key])
    }
  })
})

describe('chinese coverage of interface strings', () => {
  it('translates every settings field label and hint', () => {
    for (const key of Object.keys(settingsDictionaries.zh)) {
      if (!key.startsWith('field.')) continue
      expect(settingsDictionaries.zh[key], key).toBeTruthy()
      // And the Chinese must actually differ from the English.
      expect(settingsDictionaries.zh[key], `${key} is untranslated`).not.toBe(settingsDictionaries.en[key])
    }
  })
})
