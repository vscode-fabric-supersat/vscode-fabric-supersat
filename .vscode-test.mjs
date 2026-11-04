import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  // suite/: shared tests (also run in the browser by `npm run test:web`); node/: desktop-only.
  files: ['out/test/suite/**/*.test.js', 'out/test/node/**/*.test.js'],
  mocha: { ui: 'tdd', timeout: 20000 },
});
