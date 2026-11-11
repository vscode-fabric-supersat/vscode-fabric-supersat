// Desktop-only tests: the browser runner imports every shared test file (esbuild has no glob
// imports, so a new file left out of src/test/web/index.ts would silently never run on the web).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** The repository's src/test folder (tests run from out/test/node/, compiled with rootDir src). */
const TEST_SRC = path.resolve(__dirname, '../../../src/test');

suite('Browser test runner', () => {
  test('src/test/web/index.ts imports every shared test file in src/test/suite/', () => {
    const shared = fs
      .readdirSync(path.join(TEST_SRC, 'suite'))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort();
    const runner = fs.readFileSync(path.join(TEST_SRC, 'web', 'index.ts'), 'utf8');
    const imported = [...runner.matchAll(/import\('\.\.\/suite\/([^']+)\.js'\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(
      shared.filter((name) => !imported.includes(name)),
      [],
      'Shared test files missing from src/test/web/index.ts',
    );
    assert.deepStrictEqual(
      imported.filter((name) => !shared.includes(name)),
      [],
      'src/test/web/index.ts imports test files that don’t exist',
    );
  });
});
