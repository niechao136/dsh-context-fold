import { defineConfig } from 'tsdown'

/** The package id the client bundle registers itself under. */
const PLUGIN_ID = 'dsh-context-fold'

/**
 * The shell executes client bundles as classic scripts that call
 * `window.__ModuleLoader__.load({id, factory})`; the factory receives `require`
 * and returns the plugin's module exports. A bare ESM bundle is never executed —
 * the loader has no import hook — so `client` is wrapped here rather than left
 * as `export {…}`.
 */
export default defineConfig([
  {
    // The server plugin: plain ESM, imported by the Node side.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    // The browser tab. CommonJS output is what makes `require('react')`
    // expressible; the factory wrapper turns the module record into the
    // registration the loader consumes.
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    // `exports["./client"]` names `lib/client.js`, and the shell serves that file
    // as-is. The package is `type: module`, so without this override tsdown
    // would emit `client.cjs` and the declaration would point at nothing.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    platform: 'browser',
    target: 'es2022',
    dts: true,
    // `react` comes from the shell's shared module table, so it must stay a
    // `require` call instead of being bundled into the plugin.
    deps: { neverBundle: ['react', /^@deepseek-ai\//] },
    banner: [
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(PLUGIN_ID)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
    footer: ['    return module.exports;', '  },', '});'].join('\n'),
  },
])
