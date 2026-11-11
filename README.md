# Fabric Supersat

A Microsoft Fabric VS Code extension that takes a source code first approach.

- The general workflow, once signed in to Fabric, is to drive by [Commands](#commands) (Ctrl+Shift+P or Cmd+Shift+P).
- Work is primarily performed in the VS Code Editor, and source control (e.g. Git) is considered the source of truth.
- Get Started: press Ctrl+Shift+P and type:
  - `Fabric Supersat: Create New Fabric Notebook`
  - `Fabric Supersat: Configure Sign-In`
  - `Fabric Supersat: Open Settings`

This Visual Studio Code extension runs in **VS Code Desktop** and **VS Code for the Web** (vscode.dev, github.dev, Codespaces in the browser) from a single TypeScript codebase.

## Commands

| Command | Description |
| --- | --- |
| `Fabric Supersat: Compare All Notebooks with Workspace` | Lists which notebooks differ between `src/Notebooks` and the selected workspace as of its last **Refresh Workspace Information** (Different, Only in Fabric, Only Local, Not Supported, Same), and which have a different description or folder from their `notebook.yaml`, and opens a diff of the one you pick, Fabric on the left. Uses the cached notebooks, so it's instant and sends no requests; its refresh button refreshes first. Changes nothing. See [Comparing with a Workspace](#comparing-with-a-workspace). |
| `Fabric Supersat: Compare Notebook with Workspace` | Compares the open notebook (and its description and folder) with its current version in the selected workspace, and opens a diff if they differ. Also a button in the notebook toolbar. See [Comparing with a Workspace](#comparing-with-a-workspace). |
| `Fabric Supersat: Configure Sign-In` | Shows and changes the sign-in method, app registration client ID and tenant. **Tenant** lists your Microsoft Entra tenants to pick from (Azure CLI and VS Code methods), or lets you type a tenant ID or domain, or clear it to use your default tenant. See [Signing in to Fabric](#signing-in-to-fabric). |
| `Fabric Supersat: Create New Fabric Notebook` | Asks for the notebook type (PySpark or Python) and a name, and creates `src/Notebooks/<Name>/<Name>.py` (and its `.ipynb`) with one empty Python cell, then opens it. Upload it with **Save and Upload Notebook**. |
| `Fabric Supersat: Delete All Notebooks in Workspace` | Deletes every notebook in the selected workspace, in Fabric, for everyone using it. Lists them and asks you to confirm, then asks you to type the workspace name. Your local files aren't changed, so you can upload the notebooks again; **Upload Changed** treats them as changed. Fabric keeps deleted notebooks in the workspace's recycle bin only if it has one turned on. One failure doesn't stop the rest. |
| `Fabric Supersat: Delete Notebook` | Deletes the open notebook, or one you pick: **Local Only**, **Workspace Only** or **Both**, offering only the choices that apply. Also in the notebook toolbar's **…** menu and the Explorer's right-click menu. See [Deleting a notebook](#deleting-a-notebook). |
| `Fabric Supersat: Download All Notebooks` | Downloads every notebook in the selected workspace. If some already have local copies, asks once whether to replace or skip them. Notebooks that are not supported (e.g. Spark SQL or T-SQL notebooks) are skipped; the summary links to the reasons in the log. Cancellable. Works on several notebooks at once. |
| `Fabric Supersat: Download Notebook` | Browse the notebooks in the selected workspace and download the one you pick. Asks for a workspace if none is selected, and signs you in first if needed. See [Notebooks](#notebooks). |
| `Fabric Supersat: Open Settings` | Opens the Settings editor filtered to this extension's settings. |
| `Fabric Supersat: Refresh Workspace Information` | Saves everything readable about the selected workspace (item counts, folders, notebooks and their lakehouses, lakehouse and warehouse connection strings, member roles…) in `.fabric-supersat/workspaces/<Workspace Name>/<Workspace Name>.md` and `.json`, and opens it. Also caches the workspace's notebooks for **Compare All Notebooks with Workspace**, and updates the sync state for **Upload Changed**. See [Workspace Information](#workspace-information). |
| `Fabric Supersat: Save and Upload Notebook` | Saves the open notebook and uploads it to the selected workspace, replacing the notebook with the same name or creating it, in the workspace folder its `notebook.yaml` names (see [Workspace folders](#notebook-folders)). Also a button in the notebook toolbar. |
| `Fabric Supersat: Select Workspace` | Lists your Fabric workspaces and saves the one you pick as the selected workspace. Also available by clicking the workspace in the status bar, which shows from startup. See [Selected Workspace](#selected-workspace). |
| `Fabric Supersat: Show Log` | Opens the extension's log in the Output panel. |
| `Fabric Supersat: Sign In to Fabric` | Signs in with the configured method and shows the account. See `Fabric Supersat: Configure Sign-In`. |
| `Fabric Supersat: Sign Out of Fabric` | Forgets a pasted token, or tells you how to sign out for the other methods. |
| `Fabric Supersat: Sync Workspace` | Makes the selected workspace match `src/Notebooks` (uploads and deletes in Fabric), or `src/Notebooks` match the workspace (downloads and deletes local files). Fetches every notebook first and compares them as **Compare All Notebooks with Workspace** does, description and folder included, then lists what would change, each with its diff, for you to untick any; nothing changes until you confirm. See [Syncing with a Workspace](#syncing-with-a-workspace). |
| `Fabric Supersat: Switch Between .py and .ipynb` | Opens the open notebook's other file in its place: the `.py` (what you commit and upload) or the `.ipynb` (with your outputs). Creates the other file first if it's missing. Also a button in the notebook toolbar. |
| `Fabric Supersat: Test Notebook Formats` | Downloads both `.py` and `.ipynb` Fabric exports of every notebook in the selected workspace and checks the extension's format conversions against them, without changing `src/`. Report in `.fabric-supersat/diagnostics/format-test.md`. See [Testing Notebook Formats](#testing-notebook-formats). |
| `Fabric Supersat: Upload All Notebooks` | Saves any open notebooks, then uploads every notebook in `src/Notebooks` to the selected workspace. Asks once, listing which notebooks it will overwrite, create and move to another [folder](#notebook-folders), and which it skips (e.g. not a Fabric notebook). Cancellable. Offers **Upload Changed** for only the notebooks changed locally since they were last downloaded from or uploaded to that workspace. Works on several notebooks at once. |

## Selected Workspace

Commands that work in a Fabric workspace use the *Selected Workspace*. Pick it with `Fabric Supersat: Select Workspace` or the status bar item. If none is selected, the first command that needs one asks you to pick it and remembers your choice.

Only the workspace's **name** is saved, never its ID. The name is used to perform an ID lookup, which is cached for each session.

The extension remembers the last selected workspace, it is read from:

| Situation | Read from |
| --- | --- |
| A folder is open | `.fabric-supersat/settings.yaml` in that folder (the first folder of a multi-root workspace). |
| No folder open, the folder is read-only (some virtual workspaces), or the folder isn't trusted ([Restricted Mode](#restricted-mode)) | User setting `fabric-supersat.workspace.name`. |

The file and the user setting are kept in sync, however you change the workspace:

- **Select Workspace** saves the name in both.
- **Editing `settings.yaml`** copies the name to the user setting when you save the file.
- **Changing the user setting** copies it into `settings.yaml`, if the folder has one. A project without the file still starts with no workspace selected.
- **Opening a folder** copies the workspace named in its `settings.yaml` to the user setting. A folder with no workspace named leaves the setting alone.

The user setting is shared by all your VS Code windows. So changes, whether from the command, the file or the setting, are synced only in the window you made them in (the one with focus). Other open projects keep their own workspace. Deleting `settings.yaml` (for example, with `git clean`) doesn't clear the user setting.

The first time a command needs the workspace in a session, the extension lists your workspaces in Fabric and finds the one with that name (ignoring case, as Fabric does). The ID is cached until VS Code restarts, or until you sign in again, sign out, or change the sign-in method, client ID or tenant. So the name you see is always the workspace you work in. If no workspace you can access has that name (it was renamed or deleted, or is in another tenant), the command stops, with a **Select Workspace** button.

If **more than one** workspace has that name, the extension never guesses which one you meant: it lists just those workspaces, each with its ID, and you click the one you want (**Select Workspace** lists them the same way, with a warning). That ID is used until VS Code restarts (or you sign in again, sign out or change sign-in settings). Since only the name is saved, the next session asks you to pick again. Renaming the workspaces in Fabric so their names are unique avoids this.

The `.fabric-supersat` folder is local to you and should never be committed: the extension puts a `.gitignore` containing `*` inside it, so git ignores the whole folder without any change to your project's own `.gitignore`. If that `.gitignore` is changed so it no longer ignores everything (for example, one committed to the repository), the extension puts its own back and warns you, since the folder holds workspace metadata (member emails, connection strings), logs and your notebooks' local outputs; files committed before then stay tracked until you run `git rm -r --cached .fabric-supersat`. Each person working on the project picks their own workspace, this can be a shared workspace (for example, to share lakehouse data stages) or their own dev workspace.

The extension **always asks before creating** the `.fabric-supersat` folder. It's created when something first needs it: selecting a workspace, downloading or uploading notebooks, or making a notebook's `.ipynb` copy (for example, at startup in a fresh clone). If you say no, nothing is written. Commands ask again the next time they need the folder. Automatic updates (at startup, or when a `.py` changes on disk) don't ask again until VS Code restarts.

The `settings.yaml` file is meant to be read and edited by hand. Your comments and layout are kept when the extension updates it, and the status bar (and the user setting) update when you save it:

```yaml
# Fabric Supersat settings for this project.
# They are yours only: this folder is ignored by git. Edit them here or with
# Fabric Supersat commands; your comments and layout are kept.

# Name of the selected Fabric workspace, which commands work in.
# Change it with "Fabric Supersat: Select Workspace".
workspace:
  name: "Sales (dev)"
```

The notebook settings aren't in this file: they are shared with everyone on the project, so they're committed in `src/fabric-supersat.yaml` (see [Lakehouses and Environments in Other Workspaces](#lakehouses-and-environments-in-other-workspaces)).

With Red Hat's [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) installed, editing the file gives autocomplete, descriptions on hover and warnings for typos. Without it the file is still plain YAML. If the file has a YAML error, it is ignored (no workspace is selected) and the extension won't overwrite it; the error message names the line.

Changing the tenant in **Configure Sign-In** clears the saved workspace (blanking it in the file, and in the user settings) when the tenant changes, since workspaces belong to a tenant; the next command that needs one asks you to pick it.

## Notebooks

Notebooks are kept as files in your project and identified by **name**, no Fabric item ID (GUID) is stored. Importantly, this means that notebooks are not tied to a GUID that Fabric owns and changes, notebooks are easily uploaded and deployed to other workspaces (e.g. Test and Prod, with their lakehouse and environment matched by name, see [Uploading to Other Workspaces](#lakehouses-and-environments-in-other-workspaces)), and that **save/upload will overwrite** any notebook of the same name in the currently selected workspace. For convenience, the folder name is also the notebook's name.

Downloading a notebook (`Fabric Supersat: Download Notebook`, or `Fabric Supersat: Download All Notebooks`) writes two files:

| File | Format | Purpose |
| --- | --- | --- |
| `src/Notebooks/<Name>/<Name>.py` | Fabric's Git format: plain Python with `# CELL` markers, the same content Fabric's own Git integration writes (as `notebook-content.py`). | The source to commit. This is what gets uploaded. |
| `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb` | Jupyter, generated from the `.py`. Holds the outputs of cells you run locally. | Your local working copy. Ignored by git. |

Download performance considerations. Each notebook download takes one request to Fabric, so under normal operations only its Git-format `.py` file is downloaded and saved exactly as Fabric exports it. The `.ipynb` is generated from it, so **cell outputs from Fabric aren't downloaded**. When you download a notebook again, your local `.ipynb` keeps the outputs of cells whose code hasn't changed, as does saving the `.py`. If you already have a local copy, you're asked before it is replaced. The `.ipynb` then opens.

> **Recommended:** Microsoft's [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter) (`ms-toolsai.jupyter`). VS Code can open and edit notebooks without it, but you need it to run cells locally against a Python kernel.

- **Either file opens in the notebook editor.** For the `.py`, the extension sets a default for the `workbench.editorAssociations` setting, so a `.py` file directly in a `src/Notebooks/<Name>/` folder opens as a notebook while other Python files open as usual. Notebooks from Fabric's own Git integration (`<Name>.Notebook/notebook-content.py`) open as notebooks too. Use **Reopen Editor With… → Text Editor** to see the raw file.
- **Saving either file updates the other.** Saving the `.ipynb` regenerates the `.py`. Saving the `.py` updates the `.ipynb` and keeps the outputs of cells you didn't change. If the other file is open with unsaved changes, it isn't touched and you get a warning.
- **The `.py` is the source of truth.** It's the file you commit and upload; the `.ipynb` is always rebuilt to match it. When a `.py` changes outside the editor (for example, `git restore`, a branch switch or `git pull`), its `.ipynb` is regenerated from it, keeping the outputs of unchanged cells. At startup, any `.ipynb` older than its `.py` is regenerated, and a `.py` without one (for example, in a fresh clone) gets its `.ipynb`. An `.ipynb` open with unsaved changes is left alone, with a warning. A `.py` with no cells never replaces an `.ipynb` that has some (for example, a file emptied by mistake); you get a warning instead.
- **Only code and markdown cells.** Fabric notebooks have no other cell types, so the `.py` can't hold, for example, a Jupyter raw cell. Saving an `.ipynb` that has one doesn't update the `.py`: you get a warning asking you to change the cell to code or markdown, or delete it. If the `.ipynb` is rewritten from the `.py` while it still has such cells (you save the `.py`, the `.py` changes on disk, or you download the notebook again), they are removed, since the `.py` is the source of truth, and a warning names how many were removed.
- **Save and Upload** (the cloud button in the notebook editor toolbar) saves, then uploads the `.py` to the selected workspace. A notebook with the same name (ignoring case) is overwritten, otherwise a new one is created. You're asked to confirm either way.
- **Switch Between .py and .ipynb** (the swap button in the notebook editor toolbar, or in the editor title when the `.py` is open as text) opens the notebook's other file in place of the one open. If the other file doesn't exist yet, it's created from this one, as saving would. A file with unsaved changes stays open, and you're reminded that saving it updates the other.
- **Compare Notebook with Workspace** (the compare button in the notebook editor toolbar) shows how the notebook differs from its version in the selected workspace. See [Comparing with a Workspace](#comparing-with-a-workspace).

**Deleting a notebook.** <a id="deleting-a-notebook"></a>Run **Delete Notebook** with a notebook open, from the notebook toolbar's **…** menu, or by right-clicking its folder, `.py` or `.ipynb` in the Explorer; otherwise it lists the notebooks in `src/Notebooks` and the selected workspace, saying where each is. A dialog asks where to delete it, offering only the choices that apply:

- **Local Only** deletes `src/Notebooks/<Name>/` (with everything in it, such as `notebook.yaml`) and `.fabric-supersat/Notebooks/<Name>/`, moving them to the trash where the file system supports it. Source control can restore committed files. Its editors are closed. A file with unsaved changes stops it, before anything is deleted.
- **Workspace Only** deletes it in the selected workspace, for everyone using it. Fabric keeps it in the workspace's recycle bin only if it has one turned on. It's forgotten in the sync state (so **Upload Changed** uploads it again) and in the notebook cache.
- **Both** deletes it in the workspace first; if Fabric refuses, the local files are left alone.

**Which files count as notebooks.** A file is treated as a notebook only if both its path and its content say so:

- **Path:** `src/Notebooks/<Name>/<Name>.py` or `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`, with the file named after its folder.
- **Content:** a `.py` must start with the line `# Fabric notebook source`. A `.ipynb` must be a Jupyter notebook carrying Fabric's `microsoft` metadata, which Fabric writes on the notebook and its cells.

A file that fails the content check is never synced, overwritten or uploaded; you get a warning instead. Only the notebook itself (and its optional `notebook.yaml`, below) belongs directly in its folder. Files in a subfolder (for example, notes) open as ordinary files and are never uploaded. For code shared between notebooks, see [Sharing Code Between Notebooks](#sharing-code-between-notebooks).

**Description and folder (`notebook.yaml`).** A notebook's description and workspace folder in Fabric can be kept in source control in an optional `src/Notebooks/<Name>/notebook.yaml`, next to the `.py`:

```yaml
# Fabric notebook properties. The notebook's name is its folder name.
description: "Loads daily sales into the bronze lakehouse."
folder: "Bronze/Ingest"
```

- **Upload** sets the description in Fabric to the one in the file. It is sent only when it differs from Fabric's (on create, or as a separate property update), and no IDs are stored anywhere.
- **No file, or no `description` in it:** upload leaves the description in Fabric as it is; setting `description: ""` clears the notebooks description in Fabric on next upload.
- **Download** writes the file only when the notebook has a description in Fabric. If the file already exists, it is updated (your comments are kept).
- Fabric allows at most 256 characters. A longer description, or a file with a YAML error, stops the upload with a message naming the file, before anything is sent. **Upload All** skips that notebook and says why.
- With Red Hat's YAML extension installed, the file gets autocomplete, a warning for a description past 256 characters, and a warning for characters Fabric doesn't allow in folder names.

**Workspace folders.** <a id="notebook-folders"></a>`folder` is the [workspace folder](https://learn.microsoft.com/fabric/fundamentals/workspaces-folders) the notebook is in. This extension provides basic folder support. However, the recommendation is to *not* use folders, rather use suitable notebook naming conventions. Fabric REST API support for folders appears to be in preview at the time of writing. It works the same way as `description`:

- **Matched by name** in each workspace, never by ID, so the same `notebook.yaml` puts the notebook in the same place in Dev, Test and Prod. Folder names are matched exactly, or ignoring case if no folder matches exactly.
- **Upload** creates any of the path's folders that don't exist yet, then creates the notebook there, or moves the existing notebook there if it's somewhere else. The confirmation says where the notebook goes. A folder Fabric won't create (for example, the workspace has too many folders) stops that notebook's upload before anything else changes.
- **No file, or no `folder` in it:** upload leaves the notebook where it is in Fabric, and creates new notebooks in the workspace root. `folder: ""` moves the notebook to the root.
- **Download** writes `folder` when the notebook is in a folder. Notebooks in the root get no `folder`, unless the file already has one (then it's set to `""`). If Fabric's folders can't be read, the notebook still downloads, and `folder` is left as it was.
- **Upload Changed** counts a notebook as changed if it's in a different folder from the one its `notebook.yaml` names, or has a different description from the one it sets. **Upload All** lists which notebooks it will move.
- **Compare** and **Sync Workspace** compare the description and folder too (see [Comparing with a Workspace](#comparing-with-a-workspace)).
- Only the notebook is moved. Upload never renames or deletes folders, even ones it leaves empty.
- Notebook names are unique across the whole workspace, whatever folder they're in, so a notebook's folder never changes which notebook it is. Its local files stay in `src/Notebooks/<Name>/` wherever it is in Fabric.
- Folder names can't contain `~ " # . & * : < > ? { | }`, start or end with a space, or be `recycled` or `recycler`, and can be up to 255 characters. Fabric allows at most 10 levels of folders. A `folder` that breaks these rules stops the upload, with a message naming the file, before anything is sent.
- Creating folders and moving notebooks needs the Contributor role or higher in the workspace and, with your own app registration, the `Workspace.ReadWrite.All` permission (see [Add API permissions](#3-add-api-permissions)). Fabric's folder API is in preview.

The `notebook.yaml` file is the extension's own format, not Fabric Git integration's `.platform`. That format needs a `logicalId`, which this extension doesn't use.

**Creating a notebook.** Run `Fabric Supersat: Create New Fabric Notebook`, choose the type and enter a name. The types are the ones the extension supports: **PySpark** (Python on Spark, Fabric's default) and **Python** (Python without Spark, lighter and quicker to start). It creates both files with one empty Python cell, set up as Fabric sets up that type, and opens the notebook. The name is checked as you type: it must work as a folder name and not already exist in the project. Nothing is created in Fabric until you upload. Creating an empty `src/Notebooks/<Name>/<Name>.py` by hand also works: it opens as an empty notebook, and saving it writes a valid Fabric file. Everything the extension writes passes the content check.

### Supported Notebooks

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

Notebook names must also work as folder names: names containing `\ / : * ? " < > |`, or starting or ending with a space, or ending with a dot, are refused rather than changed (a changed name wouldn't match on upload). Rename the notebook in Fabric first.

**Built-in resources aren't supported.** Files in a notebook's Built-in resources folder in Fabric (for example, `helper.py`) aren't downloaded or uploaded, and the extension has no local equivalent, because Fabric's public API doesn't include them ([Microsoft: Notebooks Resources Folder Support in Git](https://learn.microsoft.com/fabric/data-engineering/notebook-source-control-deployment#notebooks-resources-folder-support-in-git)). Microsoft's own deployment tool, fabric-cicd, has the same limitation: Fabric silently ignores resource files sent to its API, so a deployed notebook can fail on its first `import` of a resource ([fabric-cicd issue #1095](https://github.com/microsoft/fabric-cicd/issues/1095), labelled a known product issue). Uploading sends only the notebook's cells and metadata. Microsoft doesn't document whether that leaves a notebook's existing Built-in resources untouched, a single test at the time of writing showed that it did, but that still leaves Built-in resources undocumented and unsupported. Instead of Built-in resources, share code as described below.

### Sharing Code Between Notebooks

Keep shared code in Fabric items that the extension (or Fabric's own tools) can deploy, not in Notebook Built-in resources:

| Notebook language | Share code with | How |
| --- | --- | --- |
| **Python** | Another notebook, loaded with `%run` | Put the shared functions in their own Python notebook (for example, `Common`, created with **Create New Fabric Notebook** → **Python**) and upload it to the same workspace. In each notebook that uses it, run `%run Common` (in its own cell, near the top); its functions and variables are then available. `%run` loads notebooks in the same workspace only, and can't load `.py` files ([Microsoft: Python experience on notebook](https://learn.microsoft.com/fabric/data-engineering/using-python-experience-on-notebook)). |
| **PySpark** | An Environment | Package the shared code as a Python library (`.whl`, or a single `.py`) and add it to a Fabric Environment's custom libraries, then attach the Environment to the notebook ([Microsoft: Library management in Fabric environments](https://learn.microsoft.com/fabric/data-engineering/environment-manage-library)). The notebook can then `import` it. The attachment is stored in the notebook's metadata (`dependencies.environment`), which download keeps and upload points at the target workspace's environment of the same name (see [Uploading to Other Workspaces](#lakehouses-and-environments-in-other-workspaces)). The extension doesn't manage Environments (yet); use the Fabric portal. |

### Lakehouses and Environments in Other Workspaces

A notebook's header (the `# META` block at the top of the `.py`) refers to its **default lakehouse**, any **other lakehouses** attached to it, and its **environment** by ID. Uploaded unchanged to another workspace, for example from Dev to Test, a notebook would still use Dev's lakehouse. The default lakehouse and the environment also name the workspace they are in: by ID, or as **"current workspace"** (`00000000-0000-0000-0000-000000000000`), meaning the workspace the notebook runs in, which is how Fabric's Git integration writes them. A "current workspace" reference names no workspace, so it follows the notebook to whichever workspace it's uploaded to.

Recommendations:

1. New notebooks start without a lakehouse or environment:
    - Recommendation: *do not* set default lakehouse or other lakehouses, and always use shortcuts to lakehouses outside the workspace combined with 3-part naming (Lakehouse.Schema.Table) to reference lakehouses in the same workspace. Ideally the names are in shared methods.
    - For environments: consider the keep or replace setting.
1. With the `currentWorkspace` settings on, your files name no workspace, only lakehouse and environment IDs. Other lakehouses have no `currentWorkspace` setting, because the header has no workspace field for them.
1. If you must set lakehouses, this extention provides some options.

**On upload**, by default each reference is pointed at the item with the **same name** (ignoring case) in the workspace you upload to, much as Microsoft's [fabric-cicd](https://microsoft.github.io/fabric-cicd/) does when deploying:

- **The new IDs are written to your local files first** (the `.py` and its `.ipynb`), then uploaded, so what's in Fabric is what's on disk. Source control shows the change: commit it, or discard it to go back.
- **Items already in the target workspace are left as they are**, so uploading back to the workspace a notebook came from changes nothing.
- **If the target workspace has no item with that name**, the reference is kept and you get a warning. The log (**Show Log**) lists each reference kept and why, and every ID changed.
- **"Current workspace" always stays "current workspace"**, and is never warned about. If such an item isn't in the target workspace, a default lakehouse is still matched by name (the header stores its name). An environment can't be, since only its ID is stored. In that case it's kept, and this is only logged.
- **Other lakehouses** have no workspace in the header. They are looked up in the default lakehouse's workspace. The default lakehouse's own entry among them always follows the default lakehouse's setting.
- **Code cells are never changed.** IDs, paths or connection strings written in code (for example, `abfss://` paths) aren't touched.

**Settings**: one per kind of reference. They are set in `src/fabric-supersat.yaml`, next to `src/Notebooks`, and **committed with your notebooks**, so everyone working on the project uploads with the same rules:

```yaml
# Fabric Supersat notebook settings for this project.
# Commit this file with your notebooks: everyone using the project uploads with these
# settings. Edit them here; your comments and layout are kept.

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
  # true saves the workspace as "current workspace" (all zeros: the workspace the notebook
  # runs in) where it is the workspace downloaded from or uploaded to: in downloaded
  # notebooks, and when upload writes new IDs to the local files.
  currentWorkspace:
    defaultLakehouse: false
    environment: false
```

- **Created** the first time you download, upload or create a notebook in a project without one, with the settings in effect: your current VS Code settings, defaults included. After that the extension never changes it; edit it in the file.
- **Values in the file override the VS Code settings** of the same names (below). A value you remove from the file falls back to the VS Code setting, and without the file (or with no folder open) the VS Code settings apply on their own.
- **An invalid value** (for example, `environment: swap`) stops the command with an error naming the setting, and the file is left alone.
- **Used in every mode**, [Restricted Mode](#restricted-mode) included, like the notebook files themselves.
- With Red Hat's YAML extension installed, the file gets autocomplete, descriptions on hover and warnings for typos.


| Setting | Values | Does |
| --- | --- | --- |
| `fabric-supersat.notebooks.upload.defaultLakehouse` | `replace` (default), `keep` | On upload, points the default lakehouse at the target workspace's lakehouse of the same name, or leaves it as it is. |
| `fabric-supersat.notebooks.upload.otherLakehouses` | `replace` (default), `keep` | The same for the other attached lakehouses. |
| `fabric-supersat.notebooks.upload.environment` | `replace` (default), `keep` | The same for the environment. |
| `fabric-supersat.notebooks.currentWorkspace.defaultLakehouse` | `false` (default), `true` | Saves the default lakehouse's workspace as "current workspace" when it is the workspace downloaded from or uploaded to: in downloaded notebooks, and when upload writes new IDs to the files. |
| `fabric-supersat.notebooks.currentWorkspace.environment` | `false` (default), `true` | The same for the environment. |

## Workspace Information

The `Fabric Supersat: Refresh Workspace Information` command saves what Fabric reports about the selected workspace in `.fabric-supersat/workspaces/<Workspace Name>/` (one folder per workspace, so Dev, Test and Prod can sit side by side). The folder and files are named after the workspace; a name that can't be a file name on every OS (for example, one with `/` or `:`) is encoded, as `%2F` or `%3A`:

- `<Workspace Name>.md` is easy to read, and opens when the command finishes. It starts with summaries: item types and their counts, notebooks by language, and how notebooks compare with `src/Notebooks`. Then come the workspace and its Git connection, the folder tree, and one section per item type. That includes each notebook's language, default lakehouse and environment, and how it compares with `src/Notebooks` (local-only notebooks are listed there too, as **Only Local**), each lakehouse's SQL connection string, OneLake paths and tables, and each warehouse's connection string. Next are member roles and Spark settings. Finally, copyable lists: names of each item type one per line, and every item as CSV.
- `<Workspace Name>.json` holds the same data, for copying or for other tools.
- `notebooks-cache/<Notebook Name>/` holds each notebook as fetched, for **Compare All Notebooks with Workspace**: Fabric's file (`notebook-content.py`) and `cache-info.json` (its ID, when it was fetched, why it couldn't be, if it couldn't, and its description and folder).

**Notebook details**, ticked by default in the command's options, fetches each notebook's content to fill in its language, references and comparison. It's slower on workspaces with many notebooks. It also:

- **Caches the notebooks**, replacing the previous cache and removing notebooks no longer in the workspace. If you cancel, notebooks not reached yet keep their previous cached version, which may be out of date: a warning (also in the log) names them, and any with no cached version, which show as **Not Fetched**. After a refresh, downloading, uploading or deleting a notebook, and **Compare Notebook with Workspace**, update that notebook in the cache. Changes made in Fabric by anyone else show only after the next refresh.
- **Updates the sync state** used by **Upload Changed** (see [Speed and Diagnostics](#speed-and-diagnostics)): a notebook found the **Same** as Fabric's is recorded as synced, so Upload Changed skips it, and a local notebook no longer in Fabric is forgotten, so it counts as changed. A **Different** notebook is left as it was, since it may have been changed in Fabric rather than locally.

Without notebook details, the cache and sync state aren't changed. **Member roles** (names and email addresses) are included unless you turn off `fabric-supersat.metadata.includeMemberRoles`. Anything Fabric won't show you, for example, member roles without a role that can see them, is listed under **Not available** at the end, and the rest is still saved. If the workspace's item list isn't available, the cache and sync state aren't changed, and no notebook is called **Only Local**.

The files are for reading only: no command acts on an ID read from them. Run the command again to refresh them.

## Testing Notebook Formats

The `Fabric Supersat: Test Notebook Formats` command checks the extension's conversion from `.py` against Fabric's own `.ipynb` for every notebook in a workspace (see [Testing Notebook Formats](#testing-notebook-formats)).
**Test Notebook Formats** checks that the extension handles every notebook in the selected workspace exactly as Fabric exports it. For each notebook it downloads both Fabric exports (the Git-format `notebook-content.py` and the `.ipynb`), and checks, without changing anything in `src/`:

1. Reading and rewriting Fabric's `.py` gives back exactly the same text.
2. The `.py` generated from Fabric's `.ipynb` is identical to Fabric's `.py`.
3. The `.ipynb` generated from Fabric's `.py` (what download writes; here keeping Fabric's outputs, as a local `.ipynb`'s outputs are kept) matches Fabric's `.ipynb`.
4. Both exports agree on whether the notebook is supported (for example, T-SQL). Download decides from the `.py`.
5. Uploading it back to its own workspace leaves its lakehouse and environment IDs alone. A warning here usually means it refers to items in another workspace.
6. It has only the header keys (`kernel_info`, `dependencies`) and cell types (code, markdown) the extension knows. Other header keys are left out by download, upload and editing, and an `.ipynb` with other cell types (for example, raw cells) isn't synced to the `.py`, so a warning here lists what they are.

The report is `.fabric-supersat/diagnostics/format-test.md`, with the results also in `format-test.json`. It has a table of every notebook's checks and the first difference for each failure. Both exports of each failing notebook are saved in `.fabric-supersat/diagnostics/samples/<Notebook>/`, with every ID replaced by a numbered placeholder (the same ID gets the same placeholder in both files), ready to share as an example. **Review samples before sharing**: names, code and cell outputs are kept as they are.

## Comparing with a Workspace

A notebook counts as the same when downloading it would write exactly your file, with your `currentWorkspace` settings applied. Each notebook is shown as **Different**, **Only in Fabric**, **Only Local**, **Not Supported**, **Not Fetched** or **Same**.

**Description and folder.** For a notebook in both places, its description and [workspace folder](#notebook-folders) in Fabric are compared with its `notebook.yaml` too, by the rules upload and download follow, and shown next to its status (for example, **Same · description differs**):

- A value `notebook.yaml` sets differs if Fabric's isn't the same. Folders are compared as paths, ignoring case, as upload matches them.
- A value it doesn't set (no file, or no `description` or `folder` in it) differs only if downloading would write it: a description in Fabric, or a folder other than the workspace root. Upload leaves such a value alone, so it isn't something uploading can change.
- A `notebook.yaml` with an error isn't compared, and that's shown instead (**notebook.yaml can't be read**).

The properties diff shows `notebook.yaml` on both sides: on the left as downloading would write it (Fabric's description and folder, in your file with your comments), on the right your file (empty if you have none). Caches written before descriptions and folders were kept have none to compare; **Refresh Workspace Information** adds them.

The `Fabric Supersat: Compare All Notebooks with Workspace` command compares every notebook in `src/Notebooks` with the workspace's notebooks as of its last **Refresh Workspace Information** (the cached notebooks; see [Workspace Information](#workspace-information)). It sends no requests to Fabric, so it's instant, and the title says how up to date the cache is (when its oldest notebook was fetched). If there's no cache yet, it offers to refresh first. The refresh button in the list's title bar refreshes and compares again. The list shows differences first, and stays open while you look through it. Pick a notebook to open it:

- **Different** or **Same** opens a diff: Fabric's version on the left (read-only), your `src/` file on the right. A **Same** notebook whose description or folder differs opens its `notebook.yaml` diff instead.
- The properties button next to a notebook whose description or folder differs opens its `notebook.yaml` diff.
- **Only in Fabric** opens Fabric's version, read-only.
- **Only Local** opens your file.

The `Fabric Supersat: Compare Notebook with Workspace` command (also the compare button in the notebook toolbar) compares the open notebook with its current version in Fabric, fetched there and then. It opens a diff if they differ, opens Fabric's version if you have no local `.py`, and otherwise says whether it's the same, not in the workspace, or not supported. If only the description or folder differs, it says so and opens the `notebook.yaml` diff; if the content differs too, it opens the content diff and offers **Compare notebook.yaml**. It compares the saved file. It also updates that notebook in the cache (if there is one) and in the sync state, as a refresh does.

Neither command changes `src/` or Fabric. They are a convenience or last resort tool to aid in getting on track with the source code first workflow. To act on the differences, use **Sync Workspace** (see [Syncing with a Workspace](#syncing-with-a-workspace)).

## Syncing with a Workspace

The `Fabric Supersat: Sync Workspace` command brings the selected workspace and `src/Notebooks` into line, in the direction you pick:

| Direction | Different | Only Local | Only in Fabric |
| --- | --- | --- | --- |
| **Make the workspace match src/Notebooks** | Uploaded, overwriting Fabric's | Created in Fabric | Deleted in Fabric |
| **Make src/Notebooks match the workspace** | Downloaded, replacing the local files | Local files deleted | Downloaded |

1. **It fetches every notebook from Fabric first** (one request each, cancellable), rather than using the notebook cache, so it never acts on an out-of-date copy. Like **Refresh Workspace Information** with notebook details, that replaces the notebook cache and updates the sync state. Cancelling the fetch changes nothing.
2. **It compares** each notebook as [Comparing with a Workspace](#comparing-with-a-workspace) describes: your `currentWorkspace` settings applied, line endings ignored, description and folder included. A notebook the **Same** in content still counts as changed when its description or folder differs: syncing to the workspace sets Fabric's to the ones `notebook.yaml` names (moving the notebook, and creating folders as needed), and syncing to `src/Notebooks` writes Fabric's into `notebook.yaml`, keeping your comments. A description or folder only in Fabric (one `notebook.yaml` doesn't set) changes only when syncing to `src/Notebooks`, since upload leaves those alone. Notebooks that differ in content are uploaded or downloaded whole, which brings their description and folder into line too.
3. **It lists what would change**, all ticked, with any description and folder differences. Untick any to leave them alone. Each has a compare button that opens its content diff (Fabric on the left), and, where the description or folder differs, a properties button that opens its `notebook.yaml` diff, as **Compare All Notebooks with Workspace** does. The list stays open while you look.
4. **It asks you to confirm**, listing each kind of change. Then it uploads, downloads and deletes exactly as **Upload All Notebooks**, **Download All Notebooks** and **Delete Notebook** do: uploads point lakehouse and environment references at the workspace's items (see [Uploading to Other Workspaces](#lakehouses-and-environments-in-other-workspaces)) and create any folders `notebook.yaml` names; downloads keep the outputs of unchanged cells; deletes in Fabric are for everyone using the workspace; local deletes move `src/Notebooks/<Name>/` and `.fabric-supersat/Notebooks/<Name>/` to the trash where possible. One failure doesn't stop the rest.

Left alone in both directions, and listed in the log: notebooks that aren't [supported](#supported-notebooks) or couldn't be fetched (a local notebook whose Fabric version couldn't be fetched is never treated as Only Local). Syncing to the workspace saves open notebooks first, as **Upload All** does, and leaves out any it can't save. Syncing to `src/Notebooks` leaves out notebooks with unsaved changes in an editor, rather than replacing or deleting files under it.

## Speed and Diagnostics

Most of the time spent downloading and uploading is waiting for Fabric to finish each request. So bulk commands (**Download All Notebooks**, **Upload All Notebooks**, **Refresh Workspace Information**, **Test Notebook Formats**) send many requests at once, within the limits Fabric documents ([Microsoft: Throttling](https://learn.microsoft.com/rest/api/fabric/articles/throttling)). There is no setting:

- **Fabric's quotas are per user, per minute, in separate buckets**: 500 requests for most APIs, and another 500 for checking on long-running operations (such as exporting or updating a notebook). Each is a fixed one-minute window: using it up blocks every request until the minute ends.
- **Each bucket has a budget**: most APIs up to 180 requests at once, then 5 a second; checks on long-running operations up to 300 at once, then 3 a second (a bulk command makes about two or three per notebook). Either way that is at most 480 in any minute, under the quota, with a little left for other VS Code windows and tools using your account. Jobs within the burst run at full speed; bigger ones go at a steady rate instead of stalling for up to a minute.
- **Getting notebook definitions is held to 150 in any minute.** Fabric publishes no limit for it, but throttled it after about 170–200 in a sliding minute, so running two bulk commands back to back waits here for room rather than being throttled.
- **Bulk commands work on up to 128 notebooks at once**, and **up to 32 requests run at once** across all commands and both buckets, as a safety limit. Most of a notebook's time is spent waiting for Fabric, which doesn't take a request slot. The budget, not these limits, keeps requests within the quota.
- **If Fabric throttles a request for its rate** (HTTP 429), every request in that bucket pauses for the wait Fabric asks for (up to a minute, the length of Fabric's quota window), and the bucket's budget is halved. It climbs back a step after each 20 requests in a row without throttling. Throttling in one bucket doesn't pause the other: paused requests don't hold a request slot, so the other bucket's requests keep going.
- **If Fabric says its capacity is overloaded** (HTTP 429 `CapacityLimitExceeded`), that bucket pauses for 5s, then 10s, 20s and so on up to a minute, or for as long as Fabric asks if that's longer (up to 10 minutes), and its budget stays as it is: fewer requests don't help an overloaded capacity.
- Throttled requests are retried up to 6 times. Fabric's wait is read whether it's given in seconds or as a date; one that can't be read is ignored.
- **Passing faults are retried**: a request that can't reach Fabric, or that Fabric answers with 500, 502, 503 or 504, is retried up to 3 times, after 1s, 2s and 4s (or the wait Fabric asks for). Creating a notebook is the exception, since Fabric may have created it anyway: upload it again, and it's found by name and updated. A delete retried this way that finds the notebook already gone counts as deleted.
- **Long-running operations are checked early**: 2s after Fabric accepts the request, then 4s, 8s and so on, never later than Fabric asks (it asks for 20s, but notebook operations usually finish within 2s), and never more than a minute apart. An operation that hasn't finished 10 minutes after Fabric accepted it is reported as timed out.
- **One sign-in for many requests**: requests that need a token while one is being fetched wait for that one, so a bulk command runs `az` once, or asks for a pasted token once. Each request gets its token just before it's sent, after any wait for the budget, so it is never sent with a token that expired while waiting.
- **Uploads of the same notebook run one at a time**, from any command. Uploading a notebook again while it's uploading waits, then uploads the files as they are by then; asking again while one is waiting joins that one.

Fabric's limits are per user, so other tools using your account at the same time count against them too.

**Upload All Notebooks** remembers what was last downloaded from or uploaded to each workspace, or found the same as Fabric's by **Refresh Workspace Information** or **Compare Notebook with Workspace**, in `.fabric-supersat/workspaces/<Workspace Name>/sync-state.json` (a hash of each notebook's `.py`). If only some notebooks changed locally since, it offers **Upload Changed** next to **Upload All**. Upload Changed can't see changes made in Fabric since; Upload All overwrites them. Bulk commands update the file a few times in all, not once per notebook: changes made while it's being written are saved together in the next write, which keeps commands quick where file access is slow (for example, with antivirus scanning).

While `fabric-supersat.diagnostics.logToFiles` is on (the default), the extension keeps these files in `.fabric-supersat` (git-ignored, each capped in size, with one older copy kept as `<name>.1`):

| File | Contents |
| --- | --- |
| `diagnostics/requests.jsonl` | One line per Fabric request: time, command, method, address, status, duration, retries, the wait Fabric asked for, and how many requests were running at once. Lines for a long-running operation share its `operationId`: the request Fabric accepted (202), each status check (with the `state` Fabric reported, such as `Running`, and its `percentComplete`), and the result fetch. Then one summary line (`"kind":"operation"`): how many times it was polled, how long was spent waiting, how long Fabric says it took (`fabricMs`), and how it ended (`result`: `succeeded`, `failed`, `timedOut`, or `error` if it couldn't be followed), with Fabric's `errorCode` and `requestId` when it didn't succeed. One line (`"kind":"throttle"`) each time throttling paused a bucket's requests: which bucket, why (`rate` or `capacity`), for how long, and the bucket's budget after it. Never tokens or notebook contents. |
| `logs/fabric-supersat.log` | A copy of the Output channel (**Show Log**), readable after VS Code closes. Every command logs a `Starting <command>…` line and a `Finished <command>: …` line. |
| `history.jsonl` | Each notebook download and upload: notebook, workspace, time, result, and the lakehouse and environment IDs changed. |

Every command logs two lines, `Starting <command>…` when it starts and `Finished <command>: …` when it ends. For a command that talks to Fabric, the second is a summary, for example: `Finished Download All Notebooks: 302 requests, 100 long-running operations, up to 32 at once, 2m51s, of which 33m20s waiting on Fabric`. If Fabric throttled the command, the summary says so, for example `throttled by Fabric 2 times (requests paused 1m05s, rate lowered to 1.25/s)` or `Fabric capacity overloaded 1 time (requests paused 5s)`. Other commands just say how long they took (`Finished Select Workspace: 2.4s`), and a command that ended with an error says `(failed)` after its name. Waiting time is summed over requests running at once, so it can exceed the command's duration. These files are only written once `.fabric-supersat` exists; logging never creates it.

**Errors and warnings.** An **error** in the log means something unexpected: a problem in the extension, or Fabric failing. Something you can see to is a **warning** that says the command could not proceed and why, for example `Download All Notebooks could not proceed: user did not consent to login.` Examples are a declined or expired sign-in, no workspace with the saved name, no access to the workspace, a file that isn't a Fabric notebook, a notebook type that isn't supported, or unsaved changes. The notification is a warning too, with the same buttons to fix it. In bulk commands, a notebook stopped for such a reason is counted as **skipped** and logged as a warning; only unexpected problems count as **failed**. Cancelling a sign-in prompt is only logged.

## Restricted Mode

A folder you haven't trusted (VS Code's [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust)) could have been prepared by someone else, so until you trust it the extension:

- doesn't read or write the folder's `.fabric-supersat/settings.yaml`, and uses the workspace in your user settings instead. This starts working as soon as you trust the folder.

The notebook settings in `src/fabric-supersat.yaml`, and the folder's own values for the `fabric-supersat.notebooks.*` settings, apply in every mode, like the notebook files they go with. A notebook's two files are kept in sync in every mode, Restricted Mode included: saving either file updates the other, a `.py` changed on disk (git discard, checkout, pull) updates the `.ipynb`, and at startup each `.ipynb` older than its `.py` is regenerated. In any mode, the extension never writes through a symbolic link inside the project (for example, a `.fabric-supersat` folder that links elsewhere): the write fails with an error naming the link.

## Signing in to Fabric

The default authentication method, `auto`, picks the first method that applies:

| Method | Where | Setup |
| --- | --- | --- |
| [Azure CLI](#azure-cli-default-on-desktop) | Desktop | Install the Azure CLI and run `az login`. |
| [VS Code Sign In](#vs-code-sign-in-with-your-own-app-registration) | Desktop and web | Your own Microsoft Entra app registration. |
| [Pasted Token](#pasted-token-fallback-on-the-web) | Desktop and web | None. Paste a token when asked; it lasts about an hour. |

Choose a different method with `Fabric Supersat: Configure Sign-In`, which also sets the app registration client ID and tenant. **Tenant** lists your tenants to pick from and signs in to the one you pick; if they can't be listed (for example, before your first `az login`, or with a pasted token) you can type a tenant ID or domain instead. **Clear tenant** goes back to your default tenant.

These sign-in settings are deliberately **not** VS Code settings: they are never read from any `settings.json` (user, workspace or folder) or `settings.yaml`, so a project you open can't redirect your sign-in to another tenant or app registration. They are kept in the extension's own storage on the current machine, and the command checks them (the client ID must be a GUID; the tenant a tenant ID or domain).

With `auto`, desktop uses the **Azure CLI**. The web uses **VS Code sign-in** if a client ID is set, otherwise a **pasted token**. Every method asks you to sign in only when a command needs it. If something is missing, the error message has a button that fixes it (run `az login`, configure sign-in, and so on).

> **Can you help?**  
>
> If any Microsoft Fabric or VS Code people are reading this, get in touch or raise a ticket on GitHub for anything including adding this extension as a VS Code Trusted and/or Fabric extension approved satellite.

### Azure CLI (default on desktop)

Uses the account you signed in with `az login`. No app registration is needed: Microsoft has already authorized the Azure CLI for the Fabric API. Microsoft's [fabric-cicd](https://microsoft.github.io/fabric-cicd/) library uses the same approach.

The extension runs `az` by its full path, found in the folders on your `PATH` (only absolute ones). It never runs an `az` from the current folder or a relative `PATH` entry, so a project can't supply its own `az`.

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

- **Name:** for example, `Fabric Supersat (VS Code)`.
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
| **Power BI Service** | `Workspace.ReadWrite.All` | Creating workspace folders and moving notebooks into them, for a `folder` in [`notebook.yaml`](#notebook-folders). Optional. |
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

Run: 2026-11-21, on Linux (headless, with `xvfb-run`).

| Suite | Command | Runs | Result |
| --- | --- | --- | --- |
| Desktop | `xvfb-run -a npm test` | Shared and desktop-only tests in VS Code 1.147.0 | 334 passing, 0 failing |
| Web | `npm run test:web` | Shared tests in headless Chromium | 318 passing, 0 failing |

The web run has fewer tests because the desktop-only ones (Azure CLI sign-in, and the check that the browser runner includes every shared test file) can't run in a browser.

## Disclaimer

This is an independent, community project. It is not affiliated with, endorsed by, or supported by Microsoft. Microsoft, Microsoft Fabric, Visual Studio Code and VS Code are trademarks of the Microsoft group of companies.

## License

[MIT](LICENSE)
