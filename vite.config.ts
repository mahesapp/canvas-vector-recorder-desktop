import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      '/api/v1': {
        target: 'https://www.mahes.app',
        changeOrigin: true,
        secure: true,
      },
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, target: ['es2021', 'chrome105'], sourcemap: false },
});
