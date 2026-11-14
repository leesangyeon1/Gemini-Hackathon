import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    passWithNoTests: true,
    testTimeout: 15000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server-and-verification',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/client/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'client-ui',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}', 'tests/**/*.test.tsx'],
        },
      },
    ],
  },
});
