import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Security-rules tests need the Firestore emulator: `npm run test:rules`.
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/rules/**', 'node_modules/**'], environment: 'node' },
});
