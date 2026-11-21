import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // The Retell client bundles a WebRTC stack; it is loaded only when a call starts.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['tests/setup.ts'],
  },
});
