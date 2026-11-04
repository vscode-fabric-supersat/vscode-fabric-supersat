// Browser test runner for `npm run test:web`. Bundled by esbuild into dist/web/test/index.js.
// esbuild has no glob imports, so import each shared test file explicitly below.
import 'mocha/mocha';

export async function run(): Promise<void> {
  // 'spec' logs to the console; mocha's browser default (HTML) needs a DOM, which web workers lack.
  mocha.setup({ ui: 'tdd', reporter: 'spec', timeout: 20000 });

  // Test files must be loaded after mocha.setup() so the `suite`/`test` globals exist.
  await import('../suite/extension.test.js');
  await import('../suite/fabricAuth.test.js');
  await import('../suite/fabricClient.test.js');
  await import('../suite/tenants.test.js');
  await import('../suite/authService.test.js');
  await import('../suite/pastedToken.test.js');

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
