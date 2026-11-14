# Fabric Supersat

A Microsoft Fabric VS Code extension that takes a source code first approach.

- The general workflow, once signed in to Fabric, is to drive by [Commands](#commands) (Ctrl+Shift+P or Cmd+Shift+P).
- Work is primarily performed in the VS Code Editor, and source control (e.g Git) is considered the source of truth.
- Extension Settings store and control behaviour: press Ctrl+Shift+P and type `Fabric Supersat: Open Settings`.

This Visual Studio Code extension runs in **VS Code Desktop** and **VS Code for the Web** (vscode.dev, github.dev, Codespaces in the browser) from a single TypeScript codebase.

## Commands

| Command | Description |
| --- | --- |
| `Fabric Supersat: Compare with Workspace` | Lists which notebooks differ between `src/Notebooks` and the current workspace (different, only in Fabric, only local, same), and opens a diff of the one you pick, Fabric on the left. Changes nothing. See [Comparing with a workspace](#comparing-with-a-workspace). |
| `Fabric Supersat: Configure Sign-In` | Shows and changes the sign-in method, app registration client ID and tenant. **Tenant** lists your Microsoft Entra tenants to pick from (Azure CLI and VS Code methods), or lets you type a tenant ID or domain, or clear it to use your default tenant. See [Signing in to Fabric](#signing-in-to-fabric). |
| `Fabric Supersat: Create New Fabric Notebook` | Asks for the notebook type (PySpark or Python) and a name, and creates `src/Notebooks/<Name>/<Name>.py` (and its `.ipynb`) with one empty Python cell, then opens it. Upload it with **Save and Upload Notebook**. |
| `Fabric Supersat: Download All Notebooks` | Downloads every notebook in the current workspace. If some already have local copies, asks once whether to replace or skip them. Notebooks that can't be downloaded (e.g. Spark SQL or T-SQL notebooks) are skipped; the summary links to the reasons in the log. Cancellable. Works on several notebooks at once. |
| `Fabric Supersat: Download Notebook` | Browse the notebooks in the current workspace and download the one you pick (see [Notebooks](#notebooks)). Asks for a workspace if none is selected, and signs you in first if needed. |
| `Fabric Supersat: Download Workspace Metadata` | Saves everything readable about the current workspace (item counts, folders, notebooks and their lakehouses, lakehouse and warehouse connection strings, member roles…) in `.fabric-supersat/workspaces/<Workspace Name>/metadata.md` and `metadata.json`, and opens it. See [Workspace metadata](#workspace-metadata). |
| `Fabric Supersat: Open Settings` | Opens the Settings editor filtered to this extension's settings. |
| `Fabric Supersat: Save and Upload Notebook` | Saves the open notebook and uploads it to the current workspace, replacing the notebook with the same name or creating it. Also a button in the notebook toolbar. |
| `Fabric Supersat: Select Workspace` | Lists your Fabric workspaces and saves the one you pick as the current workspace (see [Current Workspace](#current-workspace)). Also available by clicking the workspace in the status bar, which shows from startup. |
| `Fabric Supersat: Show Log` | Opens the extension's log in the Output panel. |
| `Fabric Supersat: Sign In to Fabric` | Signs in with the configured method (see below) and shows the account. |
| `Fabric Supersat: Sign Out of Fabric` | Forgets a pasted token, or tells you how to sign out for the other methods. |
| `Fabric Supersat: Test Notebook Formats` | Downloads both Fabric exports of every notebook in the current workspace and checks the extension's format conversions against them, without changing `src/`. Report in `.fabric-supersat/diagnostics/format-test.md`. See [Testing notebook formats](#testing-notebook-formats). |
| `Fabric Supersat: Upload All Notebooks` | Saves any open notebooks, then uploads every notebook in `src/Notebooks` to the current workspace. Asks once, listing which notebooks it will overwrite and create, and which it skips (e.g. not a Fabric notebook). Cancellable. Offers **Upload Changed** for only the notebooks changed locally since they were last downloaded from or uploaded to that workspace. Works on several notebooks at once. |

## Current Workspace

Commands that work in a Fabric workspace use the current workspace. Pick it with **Fabric Supersat: Select Workspace** or the status bar item. If none is selected, the first command that needs one asks you to pick it and remembers your choice.

Only the workspace's **name** is saved, never its ID. Where it's read from:

| Situation | Read from |
| --- | --- |
| A folder is open | `.fabric-supersat/settings.yaml` in that folder (the first folder of a multi-root workspace). |
| No folder open, the folder is read-only (some virtual workspaces), or the folder isn't trusted ([Restricted Mode](#restricted-mode)) | User setting `fabric-supersat.workspace.name`. |

The file and the user setting are kept in sync, however you change the workspace:

- **Select Workspace** saves the name in both.
- **Editing `settings.yaml`** copies the name to the user setting when you save the file.
- **Changing the user setting** copies it into `settings.yaml`, if the folder has one. A project without the file still starts with no workspace selected.
- **Opening a folder** copies the workspace named in its `settings.yaml` to the user setting. A folder with no workspace named leaves the setting alone.

The user setting is shared by all your VS Code windows. So changes, whether from the command, the file or the setting, are synced only in the window you made them in (the one with focus). Other open projects keep their own workspace. Deleting `settings.yaml` (for example with `git clean`) doesn't clear the user setting.

The first time a command needs the workspace in a session, the extension lists your workspaces in Fabric and finds the one with that name (ignoring case, as Fabric does). The ID is cached until VS Code restarts, or until you sign in again, sign out, or change the sign-in method, client ID or tenant. So the name you see is always the workspace you work in. The command stops, with a **Select Workspace** button, if:

- no workspace you can access has that name (it was renamed or deleted, or is in another tenant), or
- **more than one** workspace has that name. The extension never guesses which one you meant.

When several workspaces share a name, **Select Workspace** lists each of them with a warning and its ID; click the ID you want. That ID is used until VS Code restarts (or you sign in again, sign out or change sign-in settings). Since only the name is saved, the next session asks you to pick again. Renaming the workspaces in Fabric so their names are unique avoids this.

The `.fabric-supersat` folder is local to you and is never committed: the extension puts a `.gitignore` containing `*` inside it, so git ignores the whole folder without any change to your project's own `.gitignore`. Each person working on the project picks their own workspace (for example their own dev workspace).

The extension **always asks before creating** the `.fabric-supersat` folder. It's created when something first needs it: selecting a workspace, downloading or uploading notebooks, or making a notebook's `.ipynb` copy (for example, at startup in a fresh clone). If you say no, nothing is written. Commands ask again the next time they need the folder. Automatic updates (at startup, or when a `.py` changes on disk) don't ask again until VS Code restarts.

`settings.yaml` is meant to be read and edited by hand. Your comments and layout are kept when the extension updates it, and the status bar (and the user setting) update when you save it:

```yaml
# Fabric Supersat settings for this project.
# They are yours only: this folder is ignored by git. Edit them here or with
# Fabric Supersat commands; your comments and layout are kept.

# Name of the Fabric workspace that commands work in.
# Change it with "Fabric Supersat: Select Workspace".
workspace:
  name: "Sales (dev)"

# Notebook lakehouse and environment references. These override the VS Code settings
# of the same names (fabric-supersat.notebooks.*), which supplied the values below
# when this file was created. A setting removed from here uses the VS Code setting.
notebooks:
  # On upload: "replace" points each reference at the item with the same name in the
  # workspace you upload to (writing the new ID to the local files); "keep" leaves it.
  upload:
    defaultLakehouse: "replace"
    otherLakehouses: "replace"
    environment: "replace"
  # true saves the workspace as "same workspace" (all zeros) where it is the notebook's
  # own: in downloaded notebooks, and when upload writes new IDs to the local files.
  sameWorkspace:
    defaultLakehouse: false
    environment: false
```

The `notebooks` values are explained in [Lakehouses and environments in other workspaces](#lakehouses-and-environments-in-other-workspaces). As soon as the extension creates the `.fabric-supersat` folder, it writes `settings.yaml` with the `notebooks` values in effect: your current VS Code settings, defaults included. **Select Workspace** creates the file the same way if the folder exists but the file doesn't, and adds any `notebooks` values missing from an existing file. Otherwise the extension never changes these values; edit them in the file. Values in the file override the VS Code settings, and a value you remove from the file falls back to the VS Code setting. An invalid value (for example `environment: swap`) stops the command with an error naming the setting, and the file is left alone.

An `id` left in the file by an earlier version is ignored, and removed the next time the extension saves the file.

With Red Hat's [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) installed, editing the file gives autocomplete, descriptions on hover and warnings for typos. Without it the file is still plain YAML. If the file has a YAML error, it is ignored (no workspace is selected) and the extension won't overwrite it; the error message names the line.

Changing the tenant in **Configure Sign-In** clears the saved workspace (blanking it in the file, and in the user settings) when the tenant changes, since workspaces belong to a tenant; the next command that needs one asks you to pick it.

## Notebooks

Notebooks are kept as files in your project and identified by **name**, no Fabric item ID (GUID) is stored. Importantly, this means that notebooks are not tied to a GUID that Fabric owns and changes, notebooks are easily uploaded and deployed to other workspaces (e.g. Test and Prod, with their lakehouse and environment matched by name, see [Uploading to other workspaces](#lakehouses-and-environments-in-other-workspaces)), and that **save/upload will overwrite** any notebook of the same name in the currently selected workspace. For convenience, the folder name is also the notebook's name.

Downloading a notebook (**Download Notebook**, then pick one, or **Download All Notebooks**) writes two files:

| File | Format | Purpose |
| --- | --- | --- |
| `src/Notebooks/<Name>/<Name>.py` | Fabric's Git format: plain Python with `# CELL` markers, the same content Fabric's own Git integration writes (as `notebook-content.py`). | The source to commit. This is what gets uploaded. |
| `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb` | Jupyter, generated from the `.py`. Holds the outputs of cells you run locally. | Your local working copy. Ignored by git. |

Each notebook takes one request to Fabric: its Git-format `.py`, saved exactly as Fabric exports it. The `.ipynb` is generated from it, so **cell outputs from Fabric aren't downloaded**. When you download a notebook again, your local `.ipynb` keeps the outputs of cells whose code hasn't changed, as saving the `.py` does. **Test Notebook Formats** checks the conversion against Fabric's own `.ipynb` for every notebook in a workspace (see [Testing notebook formats](#testing-notebook-formats)). If you already have a local copy, you're asked before it is replaced. The `.ipynb` then opens.

> **Recommended:** Microsoft's [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter) (`ms-toolsai.jupyter`). VS Code can open and edit notebooks without it, but you need it to run cells locally against a Python kernel.

- **Either file opens in the notebook editor.** For the `.py`, the extension sets a default for the `workbench.editorAssociations` setting, so a `.py` file directly in a `src/Notebooks/<Name>/` folder opens as a notebook while other Python files open as usual. Notebooks from Fabric's own Git integration (`<Name>.Notebook/notebook-content.py`) open as notebooks too. Use **Reopen Editor With… → Text Editor** to see the raw file.
- **Saving either file updates the other.** Saving the `.ipynb` regenerates the `.py`. Saving the `.py` updates the `.ipynb` and keeps the outputs of cells you didn't change. If the other file is open with unsaved changes, it isn't touched and you get a warning.
- **The `.py` is the source of truth.** When a `.py` changes outside the editor (for example `git restore`, a branch switch or `git pull`), its `.ipynb` is regenerated from it, keeping the outputs of unchanged cells. At startup, any `.ipynb` older than its `.py` is regenerated, and a `.py` without one (for example in a fresh clone) gets its `.ipynb`. An `.ipynb` open with unsaved changes is left alone, with a warning.
- **Save and Upload** (the cloud button in the notebook toolbar) saves, then uploads the `.py` to the current workspace. A notebook with the same name (ignoring case) is overwritten, otherwise a new one is created. You're asked to confirm either way.

**Which files count as notebooks.** A file is treated as a notebook only if both its path and its content say so:

- **Path:** `src/Notebooks/<Name>/<Name>.py` or `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`, with the file named after its folder.
- **Content:** a `.py` must start with the line `# Fabric notebook source`. A `.ipynb` must be a Jupyter notebook carrying Fabric's `microsoft` metadata, which Fabric writes on the notebook and its cells.

A file that fails the content check is never synced, overwritten or uploaded; you get a warning instead. Only the notebook itself (and its optional `notebook.yaml`, below) belongs directly in its folder. Files in a subfolder (for example notes) open as ordinary files and are never uploaded. For code shared between notebooks, see [Sharing code between notebooks](#sharing-code-between-notebooks).

**Description (`notebook.yaml`).** A notebook's description in Fabric can be kept in source control in an optional `src/Notebooks/<Name>/notebook.yaml`, next to the `.py`:

```yaml
# Fabric notebook properties. The notebook's name is its folder name.
description: "Loads daily sales into the bronze lakehouse"
```

- **Upload** sets the description in Fabric to the one in the file. It is sent only when it differs from Fabric's (on create, or as a separate property update), and no IDs are stored anywhere.
- **No file, or no `description` in it:** upload leaves the description in Fabric as it is, exactly as before this file existed. `description: ""` clears it.
- **Download** writes the file only when the notebook has a description in Fabric. If the file already exists, it is updated (your comments are kept); a notebook without a description gets `description: ""`.
- Fabric allows at most 256 characters. A longer description, or a file with a YAML error, stops the upload with a message naming the file, before anything is sent. **Upload All** skips that notebook and says why.
- With Red Hat's YAML extension installed, the file gets autocomplete and a warning past 256 characters.

This is the extension's own file, not Fabric Git integration's `.platform`. That format needs a `logicalId`, which this extension doesn't use.

**Creating a notebook.** Run **Create New Fabric Notebook**, choose the type and enter a name. The types are the ones the extension supports: **PySpark** (Python on Spark, Fabric's default) and **Python** (Python without Spark, lighter and quicker to start). It creates both files with one empty Python cell, set up as Fabric sets up that type, and opens the notebook. The name is checked as you type: it must work as a folder name and not already exist in the project. Nothing is created in Fabric until you upload. Creating an empty `src/Notebooks/<Name>/<Name>.py` by hand also works: it opens as an empty notebook, and saving it writes a valid Fabric file. Everything the extension writes passes the content check.

### Supported notebooks

A Fabric notebook has a **notebook language**, which decides where its code runs, and each cell can also have its own **cell language**. "SQL" can mean two different things here:

- **Spark SQL** runs on a Spark cluster, against lakehouse tables.
- **T-SQL** runs on a warehouse or SQL analytics endpoint.

| Notebook language | Supported | SQL cells inside it |
| --- | --- | --- |
| **PySpark** (Python on Spark) | Yes | Spark SQL cells (`%%sql`) are supported. |
| **Python** (Python without Spark) | Yes | T-SQL cells (`%%tsql`) are supported. |
| **Spark SQL** | Not yet | Fabric stores it as `notebook-content.sql`. |
| **T-SQL** | Not yet | Recognised by its `sqldatawarehouse` kernel. Its attached warehouses and SQL analytics endpoints are stored under `dependencies.warehouse`. |
| **Scala**, **SparkR** | Not yet | Fabric stores them as `notebook-content.scala` and `.r`. |

Downloading a notebook that isn't supported yet says which kind it is, and is skipped by **Download All Notebooks**. If you only need some SQL, use SQL cells in a PySpark or Python notebook instead.

**Built-in resources aren't supported.** Files in a notebook's Built-in resources folder in Fabric (for example `helper.py`) aren't downloaded or uploaded, and the extension has no local equivalent, because Fabric's public API doesn't include them ([Microsoft: Notebooks Resources Folder Support in Git](https://learn.microsoft.com/fabric/data-engineering/notebook-source-control-deployment#notebooks-resources-folder-support-in-git)). Microsoft's own deployment tool, fabric-cicd, has the same limitation: Fabric silently ignores resource files sent to its API, so a deployed notebook can fail on its first `import` of a resource ([fabric-cicd issue #1095](https://github.com/microsoft/fabric-cicd/issues/1095), labelled a known product issue). Uploading sends only the notebook's cells and metadata; Microsoft doesn't document whether that leaves a notebook's existing Built-in resources untouched. Instead of Built-in resources, share code as described below.

### Sharing code between notebooks

Keep shared code in Fabric items that the extension (or Fabric's own tools) can deploy, not in Built-in resources:

| Notebook language | Share code with | How |
| --- | --- | --- |
| **Python** | Another notebook, loaded with `%run` | Put the shared functions in their own Python notebook (for example `Common`, created with **Create New Fabric Notebook** → **Python**) and upload it to the same workspace. In each notebook that uses it, run `%run Common` (in its own cell, near the top); its functions and variables are then available. `%run` loads notebooks in the same workspace only, and can't load `.py` files ([Microsoft: Python experience on notebook](https://learn.microsoft.com/fabric/data-engineering/using-python-experience-on-notebook)). |
| **PySpark** | An Environment | Package the shared code as a Python library (`.whl`, or a single `.py`) and add it to a Fabric Environment's custom libraries, then attach the Environment to the notebook ([Microsoft: Library management in Fabric environments](https://learn.microsoft.com/fabric/data-engineering/environment-manage-library)). The notebook can then `import` it. The attachment is stored in the notebook's metadata (`dependencies.environment`), which download keeps and upload points at the target workspace's environment of the same name (see [Uploading to other workspaces](#lakehouses-and-environments-in-other-workspaces)). The extension doesn't manage Environments (yet); use the Fabric portal. |

Notebook names must also work as folder names: names containing `\ / : * ? " < > |`, or starting or ending with a space, or ending with a dot, are refused rather than changed (a changed name wouldn't match on upload). Rename the notebook in Fabric first.

### Lakehouses and environments in other workspaces

A notebook's header (the `# META` block at the top of the `.py`) refers to its **default lakehouse**, any **other lakehouses** attached to it, and its **environment** by ID. The default lakehouse and the environment also name the workspace they are in: by ID, or as **"same workspace"** (`00000000-0000-0000-0000-000000000000`), meaning the notebook's own workspace, which is how Fabric's Git integration writes them. Uploaded unchanged to another workspace, for example from Dev to Test, a notebook would still use Dev's lakehouse.

**On upload**, by default each reference is pointed at the item with the **same name** (ignoring case) in the workspace you upload to, much as Microsoft's [fabric-cicd](https://microsoft.github.io/fabric-cicd/) does when deploying:

- **The new IDs are written to your local files first** (the `.py` and its `.ipynb`), then uploaded, so what's in Fabric is what's on disk. Source control shows the change: commit it, or discard it to go back.
- **Items already in the target workspace are left as they are**, so uploading to the notebook's own workspace changes nothing.
- **If the target workspace has no item with that name**, the reference is kept and you get a warning. The log (**Show Log**) lists each reference kept and why, and every ID changed.
- **"Same workspace" always stays "same workspace"**, and is never warned about. If such an item isn't in the target workspace, a default lakehouse is still matched by name (the header stores its name). An environment can't be, since only its ID is stored. In that case it's kept, and this is only logged.
- **Other lakehouses** have no workspace in the header. They are looked up in the default lakehouse's workspace.
- **Code cells are never changed.** IDs, paths or connection strings written in code (for example `abfss://` paths) aren't touched.

**Settings**: one per kind of reference. They are set in `.fabric-supersat/settings.yaml` under `notebooks` (see [Current Workspace](#current-workspace)), which overrides the VS Code settings of the same names below. The VS Code settings supply the values the file is created with, and apply on their own when no folder is open, the folder is read-only, or it isn't trusted:

| Setting | Values | Does |
| --- | --- | --- |
| `fabric-supersat.notebooks.upload.defaultLakehouse` | `replace` (default), `keep` | On upload, points the default lakehouse at the target workspace's lakehouse of the same name, or leaves it as it is. |
| `fabric-supersat.notebooks.upload.otherLakehouses` | `replace` (default), `keep` | The same for the other attached lakehouses. |
| `fabric-supersat.notebooks.upload.environment` | `replace` (default), `keep` | The same for the environment. |
| `fabric-supersat.notebooks.sameWorkspace.defaultLakehouse` | `false` (default), `true` | Saves the default lakehouse's workspace as "same workspace" when it is the notebook's own workspace: in downloaded notebooks, and when upload writes new IDs to the files. |
| `fabric-supersat.notebooks.sameWorkspace.environment` | `false` (default), `true` | The same for the environment. |

With the `sameWorkspace` settings on, your files name no workspace, only lakehouse and environment IDs. Other lakehouses have no `sameWorkspace` setting, because the header has no workspace field for them. New notebooks start without a lakehouse or environment, so they have nothing to save.

## Workspace metadata

**Download Workspace Metadata** saves what Fabric reports about the current workspace in `.fabric-supersat/workspaces/<Workspace Name>/` (one folder per workspace, so Dev, Test and Prod sit side by side):

- `metadata.md` is easy to read, and opens when the command finishes. It starts with summaries: item types and their counts, notebooks by language, and how notebooks compare with `src/Notebooks`. Then come the workspace and its Git connection, the folder tree, and one section per item type. That includes each notebook's language, default lakehouse and environment, each lakehouse's SQL connection string, OneLake paths and tables, and each warehouse's connection string. Next are member roles and Spark settings. Finally, copyable lists: names of each item type one per line, and every item as CSV.
- `metadata.json` holds the same data, for copying or for other tools.

**Notebook details**, ticked by default in the command's options, fetches each notebook's content to fill in its language, references and comparison. It's slower on workspaces with many notebooks. **Member roles** (names and email addresses) are included unless you turn off `fabric-supersat.metadata.includeMemberRoles`. Anything Fabric won't show you, for example member roles without a role that can see them, is listed under **Not available** at the end, and the rest is still saved.

The files are for reading only: no command acts on an ID read from them. Run the command again to refresh them.

## Testing notebook formats

**Test Notebook Formats** checks that the extension handles every notebook in the current workspace exactly as Fabric exports it. For each notebook it downloads both Fabric exports (the Git-format `notebook-content.py` and the `.ipynb`), and checks, without changing anything in `src/`:

1. Reading and rewriting Fabric's `.py` gives back exactly the same text.
2. The `.py` generated from Fabric's `.ipynb` is identical to Fabric's `.py`.
3. The `.ipynb` generated from Fabric's `.py` (what download writes; here keeping Fabric's outputs, as a local `.ipynb`'s outputs are kept) matches Fabric's `.ipynb`.
4. Both exports agree on whether the notebook is supported (for example, T-SQL). Download decides from the `.py`.
5. Uploading it back to its own workspace leaves its lakehouse and environment IDs alone. A warning here usually means it refers to items in another workspace.

The report is `.fabric-supersat/diagnostics/format-test.md`, with the results also in `format-test.json`. It has a table of every notebook's checks and the first difference for each failure. Both exports of each failing notebook are saved in `.fabric-supersat/diagnostics/samples/<Notebook>/`, with every ID replaced by a numbered placeholder (the same ID gets the same placeholder in both files), ready to share as an example. **Review samples before sharing**: names, code and cell outputs are kept as they are.

## Comparing with a workspace

**Compare with Workspace** fetches every notebook in the current workspace and compares it with `src/Notebooks`. It fetches each notebook's `.py`, as download does. A notebook counts as the same when downloading it would write exactly your file, with your `sameWorkspace` settings applied. The list shows each notebook as **different**, **only in Fabric**, **only local**, **not supported** or **same**, with differences first, and stays open while you look through it. Pick a notebook to open it:

- **Different** or **same** opens a diff: Fabric's version on the left (read-only), your `src/` file on the right.
- **Only in Fabric** opens Fabric's version, read-only.
- **Only local** opens your file.

It changes nothing. To bring a notebook across, use **Download Notebook** or **Save and Upload Notebook**.

## Speed and diagnostics

Most of the time spent downloading and uploading is waiting for Fabric to finish each request. So bulk commands (**Download All Notebooks**, **Upload All Notebooks**, **Download Workspace Metadata**, **Test Notebook Formats**, **Compare with Workspace**) work on several notebooks at once: 4 by default, set with `fabric-supersat.fabric.maxConcurrentRequests` (1 to 16). If Fabric throttles requests (HTTP 429), they're retried after the wait Fabric asks for.

**Upload All Notebooks** remembers what was last downloaded from or uploaded to each workspace, in `.fabric-supersat/workspaces/<Workspace Name>/sync-state.json` (a hash of each notebook's `.py`). If only some notebooks changed locally since, it offers **Upload Changed** next to **Upload All**. Upload Changed can't see changes made in Fabric since; Upload All overwrites them.

While `fabric-supersat.diagnostics.logToFiles` is on (the default), the extension keeps these files in `.fabric-supersat` (git-ignored, each capped in size, with one older copy kept as `<name>.1`):

| File | Contents |
| --- | --- |
| `diagnostics/requests.jsonl` | One line per Fabric request: time, command, method, address, status, duration, retries and the wait Fabric asked for. One line per long-running operation: how many times it was polled and how long was spent waiting. Never tokens or notebook contents. |
| `logs/fabric-supersat.log` | A copy of the Output channel (**Show Log**), readable after VS Code closes. |
| `history.jsonl` | Each notebook download and upload: notebook, workspace, time, result, and the lakehouse and environment IDs changed. |

Each command that talks to Fabric also logs a summary, for example: `Download All Notebooks: 74 requests, 37 long-running operations, 6m12s, of which 4m50s waiting on Fabric`. Waiting time is summed over requests running at once, so it can exceed the command's duration. These files are only written once `.fabric-supersat` exists; logging never creates it.

## Restricted Mode

A folder you haven't trusted (VS Code's [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust)) could have been prepared by someone else, so until you trust it the extension:

- doesn't update notebook files automatically (at startup, or when a `.py` changes on disk). Saving a notebook yourself still updates its other file;
- doesn't read or write the folder's `.fabric-supersat/settings.yaml`, and uses the workspace in your user settings instead.

Both start working as soon as you trust the folder. In any mode, the extension never writes through a symbolic link inside the project (for example a `.fabric-supersat` folder that links elsewhere): the write fails with an error naming the link.

## Signing in to Fabric

The default authentication method, `auto`, picks the first method that applies:

| Method | Where | Setup |
| --- | --- | --- |
| [Azure CLI](#azure-cli-default-on-desktop) | Desktop | Install the Azure CLI and run `az login`. |
| [Pasted Token](#pasted-token-fallback-on-the-web) | Desktop and web | None. Paste a token when asked; it lasts about an hour. |
| [VS Code Sign In](#vs-code-sign-in-with-your-own-app-registration) | Desktop and web | Your own Microsoft Entra app registration. |

Choose a different method with **Fabric Supersat: Configure Sign-In**, which also sets the app registration client ID and tenant. **Tenant** lists your tenants to pick from and signs in to the one you pick; if they can't be listed (for example before your first `az login`, or with a pasted token) you can type a tenant ID or domain instead. **Clear tenant** goes back to your default tenant.

These sign-in settings are deliberately **not** VS Code settings: they are never read from any `settings.json` (user, workspace or folder) or `settings.yaml`, so a project you open can't redirect your sign-in to another tenant or app registration. They are kept in the extension's own storage on the current machine, and the command checks them (the client ID must be a GUID; the tenant a tenant ID or domain).

With `auto`, desktop uses the **Azure CLI**. The web uses **VS Code sign-in** if a client ID is set, otherwise a **pasted token**. Every method asks you to sign in only when a command needs it. If something is missing, the error message has a button that fixes it (run `az login`, configure sign-in, and so on).

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
> The extension runs `az account get-access-token --resource https://api.fabric.microsoft.com` (plus `--tenant` when a tenant is set) and reuses the token until shortly before it expires.
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
  - *Accounts in this organizational directory only* (single tenant): simplest. Set the tenant to this tenant (step 4).
  - *Accounts in any organizational directory* (multi-tenant): needed only if you pick other tenants in **Configure Sign-In** to work in tenants other than the app's own.
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
| **Azure Service Management** | `user_impersonation` | Listing your tenants in **Configure Sign-In → Tenant**. Optional. |

Because the extension requests `.default`, every permission it uses must be listed here. Users consent to all of them at their first sign-in. If your organization doesn't allow user consent, an admin must select **Grant admin consent**.

#### 4. Configure the extension

Run **Fabric Supersat: Configure Sign-In** and set:

| Item | Value |
| --- | --- |
| Sign-in method | **VS Code (app registration)** (or leave **Auto** on the web). |
| App registration client ID | The Application (client) ID. Required. |
| Tenant | The Directory (tenant) ID or a domain such as `contoso.onmicrosoft.com`. Required for single-tenant registrations. |

Then run **Fabric Supersat: Sign In to Fabric**. If sign-in fails, the error message names the item or registration step to fix. Details are in **Fabric Supersat: Show Log**.

## CI Build

GitHub Actions in `.github/` are configured to build a `.vsix` file on every push to the repository. Each file is named `<name>-<version>+<commit>.vsix`, e.g. `vscode-fabric-supersat-0.0.1+1a2b3c4.vsix`, so you can tell which commit it was built from.

Download the latest builds from https://github.com/vscode-fabric-supersat/vscode-fabric-supersat/actions

Note: GitHub delivers it inside a zip, so an unzip is required to get the .vsix.

## Development

Building, testing, the source layout and how to add a feature are in [DEVELOPMENT.md](DEVELOPMENT.md).

### Test Results

Run: 2026-11-11, on Linux (headless, with `xvfb-run`).

| Suite | Command | Runs | Result |
| --- | --- | --- | --- |
| Desktop | `xvfb-run -a npm test` | Shared and desktop-only tests in VS Code 1.145.3 | 124 passing, 0 failing |
| Web | `npm run test:web` | Shared tests in headless Chromium | 112 passing, 0 failing |

The web run has fewer tests because the desktop-only ones (Azure CLI sign-in) can't run in a browser.

## Disclaimer

This is an independent, community project. It is not affiliated with, endorsed by, or supported by Microsoft. Microsoft, Microsoft Fabric, Visual Studio Code and VS Code are trademarks of the Microsoft group of companies.

## License

[MIT](LICENSE)
