import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  skipNodeModulesBundle: true,
  noExternal: [/^@traderalice\//],
  esbuildOptions: (options) => { options.conditions = ['openalice-source', ...(options.conditions ?? [])] },
})
