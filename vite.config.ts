import { builtinModules } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((mod) => `node:${mod}`),
];

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT || 8080}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: isSsrBuild ? 'dist/server' : 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: isSsrBuild
      ? {
          external: nodeBuiltins,
          output: {
            entryFileNames: 'index.js',
          },
        }
      : undefined,
  },
  ssr: {
    external: nodeBuiltins,
  },
}));
