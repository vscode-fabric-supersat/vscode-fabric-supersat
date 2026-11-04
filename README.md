# Fabric Supersat

A Microsoft Fabric VS Code extension that takes a source code first approach.

- The general workflow, once signed in to Fabric, is to drive by [Commands](#commands) (Ctrl+Shift+P or Cmd+Shift+P).
- Work is primarily performed in the VS Code Editor, and source control (e.g Git) is considered the source of truth.
- Extension Settings store and control behaviour: press Ctrl+Shift+P and type `Fabric Supersat: Open Settings`.

This Visual Studio Code extension runs in **VS Code Desktop** and **VS Code for the Web** (vscode.dev, github.dev, Codespaces in the browser) from a single TypeScript codebase.

## Commands

| Command | Description |
| --- | --- |
| `Fabric Supersat: Show Log` | Opens the extension's log in the Output panel. |
| `Fabric Supersat: Open Settings` | Opens the Settings editor filtered to this extension's settings. |
| `Fabric Supersat: Sign In to Fabric` | Signs in with the configured method (see below) and shows the account. |
| `Fabric Supersat: Sign Out of Fabric` | Forgets a pasted token, or tells you how to sign out for the other methods. |
| `Fabric Supersat: Switch Tenant` | Lists your Microsoft Entra tenants and signs in to the one you pick (saved in `fabric-supersat.auth.tenant`). Azure CLI and VS Code methods only. |
| `Fabric Supersat: List Notebooks` | Pick a workspace, then browse its notebooks. Selecting a notebook copies its ID. Signs you in first if needed. |

## Signing in to Fabric

The default authentication method, `auto`, picks the first method one that applies:

| Method | Setting value | Where | Setup |
| --- | --- | --- | --- |
| [Azure CLI](#azure-cli-default-on-desktop) | `azureCli` | Desktop | Install the Azure CLI and run `az login`. |
| [Pasted Token](#pasted-token-fallback-on-the-web) | `token` | Desktop and web | None. Paste a token when asked; it lasts about an hour. |
| [VS Code Sign In](#vs-code-sign-in-with-your-own-app-registration) | `vscode` | Desktop and web | Your own Microsoft Entra app registration. |

The chosen method can be set and saved in the extension setting `fabric-supersat.auth.method`. 

With `auto`, desktop uses the **Azure CLI**. The web uses **VS Code sign-in** if `fabric-supersat.auth.clientId` is set, otherwise a **pasted token**. Every method asks you to sign in only when a command needs it. If something is missing, the error message has a button that fixes it (run `az login`, open settings, and so on).

> **Can you help?**  
>
> If any Microsoft Fabric or VS Code people are reading this, get in touch or raise a ticket on GitHub for anything including adding this extension as a VS Code Trusted and/or Fabric extension approved satellite.

### Azure CLI (default on desktop)

Uses the account you signed in with `az login`. No app registration is needed: Microsoft has already authorized the Azure CLI for the Fabric API. Microsoft's [fabric-cicd](https://microsoft.github.io/fabric-cicd/) library uses the same approach.

1. [Install the Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) **where the extension runs**. For a remote window (SSH, WSL, Dev Containers, Codespaces) that's the remote machine, not your local one.
2. Sign in to the Azure CLI:
   - Local desktop: `az login --allow-no-subscriptions`
   - Remote window or browser-based VS Code (SSH, WSL, containers, Codespaces, Coder): `az login --use-device-code --allow-no-subscriptions`. The normal browser sign-in redirects to `localhost` on the remote machine, which your browser can't reach. With a device code, you enter a code at https://microsoft.com/devicelogin in any browser instead.
   - Add `--tenant <tenant>` for a specific tenant.
3. Run **Fabric Supersat: Sign In to Fabric** to check. If the Azure CLI isn't signed in, the error has a **Run "az login …"** button that opens a terminal with the right command for your setup.

> **Notes:**  
>
> `--allow-no-subscriptions` lets accounts without an Azure subscription sign in; without it, `az login` fails with "No subscriptions found". If you do have subscriptions, it only adds "tenant level account" entries to `az account list`; your subscriptions are unaffected.
>
> `az account show` can also be used to check if az login was successful.
>
> The extension runs `az account get-access-token --resource https://api.fabric.microsoft.com` (plus `--tenant` when `fabric-supersat.auth.tenant` is set) and reuses the token until shortly before it expires.
>
> To sign out, run `az logout`.


### Pasted Token (fallback on the web)

The Azure CLI can't run in VS Code for the Web, so the web falls back to asking for an access token. Get one from any machine where you're signed in:

- Azure CLI: `az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv`
- A Fabric notebook: `notebookutils.credentials.getToken('pbi')`

Paste it when asked. The extension checks that the token is for the Fabric API and not expired, then keeps it in VS Code's secret storage until it expires (about an hour), when it asks again. **Sign Out of Fabric** deletes it. Treat a token like a password: anyone who has it can act as you until it expires.

### VS Code Sign In (with your own app registration)

Uses VS Code's built-in Microsoft account provider, so the account appears in VS Code's **Accounts** menu (bottom of the Activity Bar). Sign out from there. This is the only method that works on the web without pasting tokens.

The extension requests `https://analysis.windows.net/powerbi/api/.default`. That gives it whichever Power BI Service (Fabric) permissions you grant the app registration below, so adding a permission later needs no code change. Microsoft's own Fabric extension requests the same scope.

You need your own Microsoft Entra app registration. VS Code's built-in app isn't pre-authorized by Microsoft for the Fabric (Power BI) API, so it always fails with `AADSTS65002`.

#### 1. Register an app

In the [Microsoft Entra admin center](https://entra.microsoft.com), go to **Identity → Applications → App registrations → New registration**:

- **Name:** for example `Fabric Supersat (VS Code)`.
- **Supported account types:**
  - *Accounts in this organizational directory only* (single tenant): simplest. Set `fabric-supersat.auth.tenant` to this tenant.
  - *Accounts in any organizational directory* (multi-tenant): needed only if you use **Switch Tenant** to work in tenants other than the app's own.
- Leave **Redirect URI** empty for now, then select **Register**.

Copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page.

#### 2. Configure authentication

Under **Authentication**:

- **Add a platform → Mobile and desktop applications**, then add these custom redirect URIs:
  - `http://localhost`: browser sign-in on desktop.
  - `https://vscode.dev/redirect`: sign-in from remote windows (SSH, WSL, containers, tunnels).
  - `msauth.com.microsoft.VSCode://auth`: only if you sign in on macOS with the system account broker.
- **Advanced settings → Allow public client flows: Yes**, for VS Code's device-code fallback.

#### 3. Add API permissions

Under **API permissions → Add a permission**, add these delegated permissions:

| API | Permission | Needed for |
| --- | --- | --- |
| **Power BI Service** | `Workspace.Read.All` | Listing workspaces and notebooks. Required. |
| **Azure Service Management** | `user_impersonation` | **Switch Tenant** (listing your tenants). Optional. |

Because the extension requests `.default`, every permission it uses must be listed here. Users consent to all of them at their first sign-in. If your organization doesn't allow user consent, an admin must select **Grant admin consent**.

#### 4. Configure the extension

| Setting | Value |
| --- | --- |
| `fabric-supersat.auth.method` | `vscode` (or leave `auto` on the web). |
| `fabric-supersat.auth.clientId` | The Application (client) ID. Required. |
| `fabric-supersat.auth.tenant` | The Directory (tenant) ID or a domain such as `contoso.onmicrosoft.com`. Required for single-tenant registrations. |

Then run **Fabric Supersat: Sign In to Fabric**. If sign-in fails, the error message names the setting or registration step to fix. Details are in **Fabric Supersat: Show Log**.

## CI Build

GitHub Actions in `.github/` are configured to build a `.vsix` file on every push to the repository. Each file is named `<name>-<version>+<commit>.vsix`, e.g. `vscode-fabric-supersat-0.0.1+1a2b3c4.vsix`, so you can tell which commit it was built from.

Download the latest builds from https://github.com/vscode-fabric-supersat/vscode-fabric-supersat/actions

Note: GitHub delivers it inside a zip, so an unzip is required to get the .vsix.

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run watch        # type-check + rebuild on change
```

Press **F5** in VS Code and pick a launch config:

- **Run Extension (Desktop)** runs the Node.js extension host using `dist/node/extension.js`.
- **Run Extension (Web Worker)** runs the browser extension host inside desktop VS Code using `dist/web/extension.js`.

To try it in a real browser: `npm run run:web`, then open http://localhost:3000.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run compile` | Type-check, lint, and build both bundles. |
| `npm run package` | Production (minified) build. |
| `npm test` | Run tests in desktop VS Code (Electron). On headless Linux, use `xvfb-run -a npm test`. |
| `npm run test:web` | Run the same tests in headless Chromium. Needs `npx playwright install chromium` once. |
| `npm run icon` | Re-render `icon.png` from `images/icon.svg`. Needs `npx playwright install chromium` once. |
| `npm run vsce:package` | Build a `.vsix`. |
| `code --install-extension ./vscode-fabric-supersat-0.0.1.vsix` | Install `.vsix` in VS Code. |

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
    notebooks.ts      "List Notebooks" command
  util/
    config.ts         typed settings accessor
    errors.ts         error message + log helper
    logger.ts         shared LogOutputChannel
  test/
    suite/*.test.ts   tests that run on both desktop and web
    node/*.test.ts    desktop-only tests
    web/index.ts      browser mocha runner (imports test files explicitly)
esbuild.mjs           builds dist/node, dist/web and the web test bundle
images/icon.svg       icon source (npm run icon renders it to icon.png)
```

## Adding a Feature

1. Create `src/features/myFeature.ts` that exports a `Feature` and registers its disposables on `context.subscriptions`. Its `activate(context, services)` also receives shared services, such as `services.auth` for Fabric tokens.
2. Add it to the array in `src/features/index.ts`.
3. Declare its commands, settings, views and so on under `contributes` in `package.json`, and add the IDs to `src/constants.ts`.
4. Add tests in `src/test/suite/`, and import new test files in `src/test/web/index.ts`.

### Desktop and Web Rules

Feature code runs in both a Node.js host and a browser **web worker**, so:

- Use `vscode.workspace.fs` and `vscode.Uri`, not `fs` or `path`.
- Use `fetch`, not `http`/`https`.
- Don't spawn processes or use other Node-only modules in shared code. Put desktop-only code in `src/node/` and wire it in from `src/node/extension.ts` (as the Azure CLI sign-in is). Its tests go in `src/test/node/`.
- Don't assume `file://` URIs. Workspaces may be virtual (`vscode-vfs://`, `vscode-test-web://`).

## Before Publishing

- The extension ID is `publisher.name`; keep `EXTENSION_FULL_ID` in `src/constants.ts` in sync if either changes.

## Disclaimer

This is an independent, community project. It is not affiliated with, endorsed by, or supported by Microsoft. Microsoft, Microsoft Fabric, Visual Studio Code and VS Code are trademarks of the Microsoft group of companies.

## License

[MIT](LICENSE)
