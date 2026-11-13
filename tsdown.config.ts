import { defineConfig } from 'tsdown'

export default defineConfig({
  // Two entries: the server plugin and the browser tab. The client bundle is
  // imported by the shell's own bundler, so it must stay a separate `./client`
  // export rather than being pulled into the server entry.
  entry: { index: 'src/index.ts', client: 'src/client.ts' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
