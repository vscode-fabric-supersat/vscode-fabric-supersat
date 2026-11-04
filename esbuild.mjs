// Bundles the extension twice from the same sources:
//   dist/node/extension.js  -> desktop VS Code (Node.js extension host)
//   dist/web/extension.js   -> VS Code for the Web (browser web-worker extension host)
// plus the browser test bundle used by `npm run test:web`.
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Logs build results in a format the `$esbuild-watch` problem matcher understands. */
const problemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

/**
 * mocha >= 12 is `"type": "module"`, so esbuild treats its prebuilt UMD browser build
 * (`mocha/mocha.js`) as ESM and inlines it unwrapped. Its `module.exports = factory()`
 * then overwrites the test bundle's own exports (our `run`). Loading the file from a
 * separate namespace hides the package type, so it is wrapped as CommonJS instead.
 */
const mochaUmdPlugin = {
  name: 'mocha-umd-as-cjs',
  setup(build) {
    const mochaPath = createRequire(import.meta.url).resolve('mocha/mocha.js');
    build.onResolve({ filter: /^mocha\/mocha(\.js)?$/ }, () => ({
      path: mochaPath,
      namespace: 'mocha-umd',
    }));
    build.onLoad({ filter: /.*/, namespace: 'mocha-umd' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'js',
    }));
  },
};

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  external: ['vscode'],
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** @type {esbuild.BuildOptions[]} */
const configs = [
  {
    ...shared,
    entryPoints: ['src/node/extension.ts'],
    platform: 'node',
    target: 'node20',
    outfile: 'dist/node/extension.js',
  },
  {
    ...shared,
    entryPoints: ['src/web/extension.ts'],
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/web/extension.js',
    define: { global: 'globalThis' },
  },
];

if (!production) {
  configs.push({
    ...shared,
    entryPoints: ['src/test/web/index.ts'],
    platform: 'browser',
    target: 'es2022',
    outfile: 'dist/web/test/index.js',
    plugins: [...shared.plugins, mochaUmdPlugin],
    // Node built-ins used by tests (e.g. `assert`) resolve to their npm browser polyfills.
    define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false' },
  });
}

async function main() {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
