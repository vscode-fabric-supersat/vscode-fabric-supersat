// Keeping a notebook's two files in sync, driven the way VS Code drives it: documents saved
// in VS Code, files changed on disk (seen by a file system watcher), and the startup refresh.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { NotebookSync, saveForCommand, type SyncEvent } from '../../features/notebookSync';
import { type NotebookFiles, notebookFiles, syncNotebookFiles } from '../../notebooks/files';
import { MemFs } from './memFs';

const PY = `# Fabric notebook source

# CELL ********************

print("one")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

/** How long to watch for a sync that shouldn't happen (the watcher debounces by 300 ms). */
const QUIET_MS = 1200;

suite('Notebook sync: saves, file changes and startup', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  let files: NotebookFiles;
  let sync: NotebookSync | undefined;
  let warnings: string[];
  let events: SyncEvent[];
  const encode = (text: string) => new TextEncoder().encode(text);
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };
  const cells = (uri: vscode.Uri) => JSON.parse(text(uri)!).cells.map((c: { source: string[] }) => c.source.join(''));

  /** Starts syncing the test's project, recording syncs and warnings. */
  async function start(): Promise<NotebookSync> {
    sync = new NotebookSync({ root: () => root, warn: (message) => warnings.push(message) });
    sync.onDidSync((e) => events.push(e));
    await sync.ready;
    return sync;
  }

  /** Resolves with the first sync (already recorded or still to come) matching `trigger`. */
  async function nextSync(trigger: SyncEvent['trigger'], timeoutMs = 4000): Promise<SyncEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find((e) => e.trigger === trigger);
      if (found) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`No "${trigger}" sync within ${timeoutMs} ms (got: ${JSON.stringify(events.map((e) => e.trigger))})`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));

  /** Opens `uri` as a text document and replaces its whole text (leaving it unsaved). */
  async function edit(uri: vscode.Uri, change: (text: string) => string): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(uri, all, change(doc.getText()));
    assert.ok(await vscode.workspace.applyEdit(workspaceEdit));
    assert.ok(doc.isDirty);
    return doc;
  }

  let autoSave: string | undefined;
  suiteSetup(async () => {
    registration = vscode.workspace.registerFileSystemProvider('fss-sync-test', memFs);
    // Documents are left unsaved on purpose, so auto save (on by default in VS Code for the web) is turned off.
    const files = vscode.workspace.getConfiguration('files');
    autoSave = files.inspect<string>('autoSave')?.globalValue;
    await files.update('autoSave', 'off', vscode.ConfigurationTarget.Global);
  });
  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('files').update('autoSave', autoSave, vscode.ConfigurationTarget.Global);
    registration.dispose();
  });
  setup(async () => {
    root = vscode.Uri.parse(`fss-sync-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
    files = notebookFiles(root, 'Load');
    warnings = [];
    events = [];
  });
  teardown(() => {
    sync?.dispose();
    sync = undefined;
  });

  test('at startup, an .ipynb older than its .py (or missing) is regenerated', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await write(files.py, PY.replace('print("one")', 'print("pulled")')); // e.g. a git pull while VS Code was closed
    const fresh = notebookFiles(root, 'Fresh');
    await write(fresh.py, PY); // e.g. a fresh clone: no .ipynb yet
    await start();
    assert.deepStrictEqual(cells(files.ipynb), ['print("pulled")']);
    assert.deepStrictEqual(cells(fresh.ipynb), ['print("one")']);
    assert.deepStrictEqual(events.map((e) => [e.files.name, e.trigger]).sort(), [['Fresh', 'startup'], ['Load', 'startup']]);
  });

  test('saving the .py in VS Code updates the .ipynb, once (the watcher leaves the save to the save hook)', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const doc = await edit(files.py, (t) => t.replace('print("one")', 'print("saved")'));
    assert.ok(await doc.save());
    const event = await nextSync('save');
    assert.strictEqual(event.from, 'py');
    assert.deepStrictEqual(cells(files.ipynb), ['print("saved")']);
    await quiet();
    assert.deepStrictEqual(events.map((e) => e.trigger), ['save'], 'synced once: no second sync from the watcher');
    assert.deepStrictEqual(warnings, []);
  });

  test('saving the .ipynb in VS Code regenerates the .py', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const doc = await edit(files.ipynb, (t) => t.replace('print(\\"one\\")', 'print(\\"from ipynb\\")'));
    assert.ok(await doc.save());
    assert.strictEqual((await nextSync('save')).from, 'ipynb');
    assert.strictEqual(text(files.py), PY.replace('print("one")', 'print("from ipynb")'));
  });

  test('a .py changed on disk (git restore, checkout, pull) regenerates the .ipynb', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    await write(files.py, PY.replace('print("one")', 'print("checked out")'));
    await nextSync('disk');
    assert.deepStrictEqual(cells(files.ipynb), ['print("checked out")']);
  });

  test('the extension’s own writes to the .py aren’t synced back again', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const ipynb = JSON.parse(text(files.ipynb)!);
    ipynb.cells[0].source = ['print("regenerated")'];
    await write(files.ipynb, JSON.stringify(ipynb, undefined, 1));
    assert.strictEqual(await syncNotebookFiles(files, 'ipynb'), true); // writes the .py
    await quiet();
    assert.deepStrictEqual(events, []);
  });

  test('a command’s own save isn’t also synced by the save hook (the command syncs and reports itself)', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const before = text(files.ipynb);
    const doc = await edit(files.py, (t) => t.replace('print("one")', 'print("command")'));
    assert.ok(await saveForCommand(doc));
    await quiet();
    assert.deepStrictEqual(events, [], 'neither the save hook nor the watcher synced it');
    assert.strictEqual(text(files.ipynb), before);
  });

  test('saving one file while the other has unsaved changes leaves the other alone, with a warning', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const before = text(files.ipynb);
    const ipynb = await edit(files.ipynb, (t) => t.replace('print(\\"one\\")', 'print(\\"unsaved\\")'));
    const py = await edit(files.py, (t) => t.replace('print("one")', 'print("saved")'));
    assert.ok(await py.save());
    await quiet();
    assert.strictEqual(text(files.ipynb), before);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Load\.ipynb has unsaved changes, so it wasn't updated from the file you saved\./);
    assert.deepStrictEqual(events, []);
    // Revert the unsaved .ipynb, or auto save (restored after the suite) writes it once its file system is gone.
    await vscode.window.showTextDocument(ipynb);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.ok(!ipynb.isDirty);
  });

  test('warnings: a .py emptied on disk, an .ipynb saved with a raw cell, and raw cells removed from the .py', async () => {
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    await start();
    const before = text(files.ipynb);

    // A .py emptied on disk doesn't wipe the .ipynb.
    await write(files.py, '');
    await new Promise((r) => setTimeout(r, QUIET_MS));
    assert.strictEqual(text(files.ipynb), before);
    assert.match(warnings.shift() ?? '', /^Not synced: Load\.py has no cells, so Load\.ipynb \(which has some\) wasn't updated/);
    await write(files.py, PY);
    await new Promise((r) => setTimeout(r, QUIET_MS));

    // An .ipynb saved with a raw cell isn't synced to the .py.
    const withRaw = await edit(files.ipynb, (t) => {
      const ipynb = JSON.parse(t);
      ipynb.cells.push({ cell_type: 'raw', id: 'r1', metadata: {}, source: ['notes'] });
      return JSON.stringify(ipynb, undefined, 1);
    });
    assert.ok(await withRaw.save());
    await quiet();
    assert.strictEqual(text(files.py), PY);
    assert.match(warnings.shift() ?? '', /^Not synced: The \.ipynb has 1 raw cell; Fabric notebooks only have code and markdown cells\./);

    // Rewriting the .ipynb from the .py (here, a .py changed on disk) removes the raw cell, and says so.
    await write(files.py, PY.replace('print("one")', 'print("two")'));
    await nextSync('disk');
    assert.deepStrictEqual(cells(files.ipynb), ['print("two")']);
    assert.match(warnings.shift() ?? '', /^Load\.ipynb had 1 raw cell, which was removed when it was updated from Load\.py/);
    assert.deepStrictEqual(warnings, []);
  });

  test('notebooks outside the project are left alone', async () => {
    await start();
    const other = notebookFiles(vscode.Uri.parse('fss-sync-test:/elsewhere'), 'Load');
    await write(other.py, PY);
    const doc = await edit(other.py, (t) => t.replace('print("one")', 'print("x")'));
    assert.ok(await doc.save());
    await quiet();
    assert.strictEqual(text(other.ipynb), undefined);
    assert.deepStrictEqual(events, []);
  });
});
