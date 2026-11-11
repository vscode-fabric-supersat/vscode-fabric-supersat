# Developing Fabric Supersat

How to build, test and extend the extension. For what it does and how to use it, see the [README](README.md).

## Getting Started

Requires Node.js 22 or later.

```sh
npm install
npm run watch        # type-check + rebuild on change
```

Press **F5** in VS Code and pick a launch config:

- **Run Extension (Desktop)** runs the Node.js extension host using `dist/node/extension.js`.
- **Run Extension (Web Worker)** runs the browser extension host inside desktop VS Code using `dist/web/extension.js`.

To try it in a real browser: `npm run run:web`, then open http://localhost:3000.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run compile` | Type-check, lint, and build both bundles. |
| `npm run package` | Production (minified) build. |
| `npm test` | Run tests in desktop VS Code (Electron). On headless Linux, use `xvfb-run -a npm test`. |
| `npm run test:web` | Run the same tests in headless Chromium. Needs `npx playwright install chromium` once. |
| `npm run icon` | Re-render `icon.png` from `images/icon.svg`. Needs `npx playwright install chromium` once. |
| `npm run vsce:package` | Build a `.vsix`. |
| `code --install-extension ./vscode-fabric-supersat-0.0.1.vsix` | Install `.vsix` in VS Code. |

## Running Tests on Headless Linux

`npm test` downloads VS Code into `.vscode-test/` and runs the tests in it, and `npm run test:web` runs them in Playwright's Chromium. On a Linux machine or container with no desktop (SSH, WSL, Dev Containers, Codespaces, Coder), install a virtual display and the libraries VS Code and Chromium need once (Debian/Ubuntu):

```sh
sudo apt-get update && sudo apt-get install -y xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libcairo2 libgtk-3-0 \
  libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libasound2t64 libatspi2.0-0

npx playwright install chromium   # for npm run test:web

sudo npx playwright install-deps chromium   # for the browser tests alone install what Chromium needs
```

On older releases (before Debian 13 / Ubuntu 24.04) the sound library is `libasound2` instead of `libasound2t64`.

Then run:

```sh
xvfb-run -a npm test    # desktop tests (shared + desktop-only)
npm run test:web        # the shared tests in headless Chromium
```

If VS Code fails with `error while loading shared libraries: <name>.so`, list what's still missing with `ldd .vscode-test/vscode-linux-x64-*/code | grep 'not found'`.

## Layout

```
src/
  extension.ts        shared activation (createExtension), used by both entry points
  node/
    extension.ts      desktop entry point (package.json "main")
    azureCli.ts       Azure CLI sign-in (desktop only: runs `az`)
  web/
    extension.ts      web entry point (package.json "browser")
  constants.ts        command IDs and the setting prefix
  auth/
    types.ts          TokenProvider interface, AuthError
    service.ts        picks the sign-in method (auth.method setting)
    vscodeSession.ts  VS Code sign-in with your app registration
    pastedToken.ts    pasted access token (SecretStorage)
    jwt.ts            reads token claims (account, audience, expiry)
  fabric/
    client.ts         Fabric REST API client (paging, throttling, errors)
    tenants.ts        lists the user's Entra tenants (Azure Resource Manager)
  features/
    feature.ts        Feature interface
    index.ts          list of registered features
    log.ts            "Show Log" command
    settings.ts       "Open Settings" command
    fabricAuth.ts     "Sign In", "Sign Out" and "Switch Tenant" commands
    workspace.ts      "Select Workspace" command and status bar item
    notebooks.ts      "List Notebooks" command
  workspace/
    service.ts        current Fabric workspace (.fabric-supersat/settings.yaml or user settings) and its picker
  util/
    config.ts         typed settings accessor
    errors.ts         error message + log helper
    progress.ts       progress notification helper
    yamlFile.ts       reads and updates YAML files, keeping comments and layout
    logger.ts         shared LogOutputChannel
  test/
    suite/*.test.ts   tests that run on both desktop and web
    suite/memFs.ts    in-memory file system for tests that read and write files
    node/*.test.ts    desktop-only tests
    web/index.ts      browser mocha runner (imports test files explicitly)
schemas/              JSON schemas for the YAML files (package.json "yamlValidation")
esbuild.mjs           builds dist/node, dist/web and the web test bundle
images/icon.svg       icon source (npm run icon renders it to icon.png)
```

## Adding a Feature

1. Create `src/features/myFeature.ts` that exports a `Feature` and registers its disposables on `context.subscriptions`. Its `activate(context, services)` also receives shared services, such as `services.auth` for Fabric tokens, `services.fabric` for the Fabric API and `services.workspace` for the current workspace (`await services.workspace.resolve()` returns it, asking the user only if none is saved).
2. Add it to the array in `src/features/index.ts`.
3. Declare its commands, settings, views and so on under `contributes` in `package.json`, and add the IDs to `src/constants.ts`.
4. Add tests in `src/test/suite/`, and import new test files in `src/test/web/index.ts`.

## Files for People: YAML

Files the extension writes for people to read and edit (local settings now, item metadata later) are YAML, with the `.yaml` extension. Read and write them only through `src/util/yamlFile.ts`, so they all behave the same way:

- `updateYamlFile` changes only the values it is given, keeping comments, key order, blank lines and end-of-line comments. A new file starts from a template whose comments explain it, with placeholders (`id: ""`) that keep each comment next to its value.
- Strings are written double-quoted, so IDs, names and dates are never read back as numbers or booleans. Read values with the typed accessors such as `YamlFile.getString`.
- A file with YAML errors is never overwritten. `YamlFileError` names the file and line.

Give each file a JSON schema in `schemas/` and register it under `yamlValidation` in `package.json`. With Red Hat's YAML extension, people then get autocomplete, hover descriptions and typo warnings. Put the explanation in each property's `description`, since that is what people see on hover. Keep `additionalProperties: false` so typos are flagged, and add new keys to the schema when a feature adds them.

Local, per-person files go in `.fabric-supersat/` in the project folder, which git ignores through the `.gitignore` the extension creates there.

## Desktop and Web Rules

Feature code runs in both a Node.js host and a browser **web worker**, so:

- Use `vscode.workspace.fs` and `vscode.Uri`, not `fs` or `path`.
- Use `fetch`, not `http`/`https`.
- Don't spawn processes or use other Node-only modules in shared code. Put desktop-only code in `src/node/` and wire it in from `src/node/extension.ts` (as the Azure CLI sign-in is). Its tests go in `src/test/node/`.
- Don't assume `file://` URIs. Workspaces may be virtual (`vscode-vfs://`, `vscode-test-web://`).

## Before Publishing

- The extension ID is `publisher.name`; keep `EXTENSION_FULL_ID` in `src/constants.ts` in sync if either changes.
