/**
 * Browser client bundle for @fooxe/dsh-memory, mirroring the DeepSeek Harness
 * client preset (as reproduced by dsh-market): a closure-factory artifact
 * calling window.__ModuleLoader__.load({ id, factory }) with externals resolved
 * through the injected require (loader module table).
 */
import { defineConfig } from 'tsdown'

const id = '@fooxe/dsh-memory'

/** Platform seed entries this bundle requires; everything else inlines. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
