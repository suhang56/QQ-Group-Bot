import { defineConfig, Plugin } from 'vitest/config';
import { createRequire } from 'node:module';

// node:sqlite is experimental in Node 22+ but NOT in require('module').builtinModules,
// so Vite doesn't recognize it as external and tries to load it as a file.
// This plugin intercepts the load step and returns the module content inline.
const nodeSqlitePlugin: Plugin = {
  name: 'node-sqlite-external',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'node:sqlite' || id === 'sqlite') {
      return '\0virtual:node-sqlite';
    }
    return undefined;
  },
  load(id) {
    if (id === '\0virtual:node-sqlite') {
      // Load the module via createRequire to bypass Vite's file loader
      const req = createRequire(import.meta.url);
      const mod = req('node:sqlite') as Record<string, unknown>;
      // Export everything from node:sqlite
      const keys = Object.keys(mod);
      const exports = keys.map(k => `export const ${k} = __sqlite__.${k};`).join('\n');
      return `const __sqlite__ = require('node:sqlite');\n${exports}\nexport default __sqlite__;`;
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [nodeSqlitePlugin],
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
