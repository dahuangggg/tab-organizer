/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src'),
  publicDir: r('./public'),
  plugins: [preact()],
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'chrome138',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: r('./src/popup/index.html'),
        options: r('./src/options/index.html'),
        background: r('./src/background/index.ts'),
      },
      output: {
        // The service worker path is fixed in manifest.json.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    root: r('.'),
    include: ['tests/**/*.test.ts'],
  },
});
