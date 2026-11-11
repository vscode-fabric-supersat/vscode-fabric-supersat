// Fabric Data Engineering's copies as notebooks' .ipynb (src/fde/copies.ts): finding them in the
// work folder, using them while "Use Fabric Data Engineering" is on, and keeping them current.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { FdeCopies } from '../../fde/copies';
import { DIFFERS_FROM_FABRIC } from '../../fde/layout';
import {
  deleteNotebookFiles,
  notebookFiles,
  notebookFilesFor,
  syncNotebookFiles,
} from '../../notebooks/files';
import { forgetSync, hashText, recordItemSync, recordSync } from '../../workspace/state';
import { MemFs } from './memFs';

const PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   }
# META }

# CELL ********************

print("one")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

suite('Fabric Data Engineering copies', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  let fde: vscode.Uri;
  let enabled: boolean;
  let selected: { name: string } | undefined;
  let selectedId: string | undefined;
  let copies: FdeCopies | undefined;
  const changed = new vscode.EventEmitter<undefined>();
  const encode = (text: string) => new TextEncoder().encode(text);
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };
  const cells = (uri: vscode.Uri) => JSON.parse(text(uri)!).cells.map((c: { source: string[] }) => c.source.join(''));
  const artifactInfo = (ws: string, item: string) => JSON.parse(text(vscode.Uri.joinPath(fde, ws, 'SynapseNotebook', item, '.artifact-info'))!);
  const copyUri = (ws: string, item: string, name: string) => vscode.Uri.joinPath(fde, ws, 'SynapseNotebook', item, name, `${name}.ipynb`);

  /** A workspace folder in the work folder, as "Use Fabric Data Engineering" writes it. */
  async function workspaceFolder(id: string, name: string): Promise<void> {
    await write(vscode.Uri.joinPath(fde, id, '.workspace-info'), JSON.stringify({ id, name, type: 'Folder', capacityObjectId: 'cap-1' }));
  }

  /** A copy of a local notebook: its .ipynb generated from `py`, and its .artifact-info. */
  async function copy(ws: string, item: string, name: string, py = PY): Promise<vscode.Uri> {
    const uri = copyUri(ws, item, name);
    await write(notebookFiles(root, name).py, py);
    await syncNotebookFiles(notebookFiles(root, name, uri), 'py');
    await write(
      vscode.Uri.joinPath(fde, ws, 'SynapseNotebook', item, '.artifact-info'),
      JSON.stringify({ objectId: item, artifactType: 'SynapseNotebook', displayName: name, folderObjectId: ws, capacityObjectId: 'cap-1' }),
    );
    return uri;
  }

  async function start(): Promise<FdeCopies> {
    copies = new FdeCopies({
      root: () => root,
      workspace: { get selected() { return selected; }, get selectedId() { return selectedId; }, onDidChange: changed.event },
      isEnabled: () => enabled,
    });
    await copies.ready;
    return copies;
  }

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-fde-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-fde-test:/project${++run}`);
    fde = vscode.Uri.joinPath(root, '.fabric-supersat', 'fabric-de');
    await vscode.workspace.fs.createDirectory(root);
    await write(vscode.Uri.joinPath(root, '.fabric-supersat', '.gitignore'), '*\n');
    enabled = true;
    selected = { name: 'Sales' };
    selectedId = undefined;
    await workspaceFolder('ws-1', 'Sales');
    await workspaceFolder('ws-2', 'Sales (test)');
  });
  teardown(() => {
    copies?.dispose();
    copies = undefined;
  });

  test('while on, a notebook with a copy in the selected workspace uses it as its .ipynb; others keep theirs', async () => {
    const uri = await copy('ws-1', 'nb-1', 'Load');
    await write(notebookFiles(root, 'Other').py, PY);
    await start();
    const files = notebookFiles(root, 'Load');
    assert.strictEqual(files.ipynb.toString(), uri.toString());
    assert.strictEqual(files.localIpynb.path, `${root.path}/.fabric-supersat/Notebooks/Load/Load.ipynb`);
    const other = notebookFiles(root, 'Other');
    assert.strictEqual(other.ipynb.toString(), other.localIpynb.toString(), 'no copy: its .fabric-supersat/Notebooks .ipynb');
  });

  test('the selected workspace is matched by its ID when known, else by name; off, nothing changes', async () => {
    const uri = await copy('ws-1', 'nb-1', 'Load');
    await copy('ws-2', 'nb-9', 'Load');
    await start();
    assert.strictEqual(notebookFiles(root, 'Load').ipynb.toString(), uri.toString(), 'by the name in .workspace-info');
    selectedId = 'WS-2';
    assert.strictEqual(notebookFiles(root, 'Load').ipynb.toString(), copyUri('ws-2', 'nb-9', 'Load').toString(), 'by ID, ignoring case');
    selected = { name: 'Elsewhere' };
    selectedId = undefined;
    const none = notebookFiles(root, 'Load');
    assert.strictEqual(none.ipynb.toString(), none.localIpynb.toString(), 'no copy in that workspace');
    selected = { name: 'Sales' };
    enabled = false;
    const files = notebookFiles(root, 'Load');
    assert.strictEqual(files.ipynb.toString(), files.localIpynb.toString(), 'off: the .fabric-supersat/Notebooks .ipynb');
  });

  test('a copy is its notebook\'s .ipynb for syncing, on or off, matched to src/Notebooks ignoring case', async () => {
    enabled = false;
    await write(notebookFiles(root, 'Load').py, PY);
    const uri = copyUri('ws-1', 'nb-1', 'load');
    await syncNotebookFiles(notebookFiles(root, 'Load', uri), 'py');
    await start();
    const match = notebookFilesFor(root, uri);
    assert.strictEqual(match?.kind, 'ipynb');
    assert.strictEqual(match.files.name, 'Load');
    assert.strictEqual(match.files.ipynb.toString(), uri.toString());
    // Saving the copy updates the .py.
    const ipynb = JSON.parse(text(uri)!);
    ipynb.cells[0].source = ['print("edited in the copy")'];
    await write(uri, JSON.stringify(ipynb));
    await syncNotebookFiles(match.files, 'ipynb');
    assert.match(text(notebookFiles(root, 'Load').py)!, /print\("edited in the copy"\)/);
    // The .fabric-supersat/Notebooks .ipynb is still its own file for syncing.
    const local = notebookFilesFor(root, notebookFiles(root, 'Load').localIpynb);
    assert.strictEqual(local?.files.ipynb.toString(), notebookFiles(root, 'Load').localIpynb.toString());
    // A copy of a notebook not in src/Notebooks isn't one of this project's notebooks.
    await write(copyUri('ws-1', 'nb-2', 'FdeOnly'), '{}');
    await copies!.rebuild();
    assert.strictEqual(notebookFilesFor(root, copyUri('ws-1', 'nb-2', 'FdeOnly')), undefined);
  });

  test('ensureCopy starts a copy from the .fabric-supersat/Notebooks .ipynb (outputs kept), then keeps it', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    const local = JSON.parse(text(files.localIpynb)!);
    local.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: ['one\n'] }];
    await write(files.localIpynb, JSON.stringify(local));
    await start();
    const workspace = { id: 'ws-1', name: 'Sales', capacityId: 'cap-1', personal: false };
    const notebook = { workspaceId: 'ws-1', capacityId: 'cap-1', itemId: 'nb-1', displayName: 'Load' };
    const uri = await copies!.ensureCopy(root, workspace, notebook, 'Load', true);
    assert.ok(uri);
    assert.deepStrictEqual(JSON.parse(text(uri)!).cells[0].outputs, local.cells[0].outputs);
    assert.strictEqual(artifactInfo('ws-1', 'nb-1')._remoteContentHash, await hashText(text(uri)!), 'the same as Fabric: its hash');
    // Edits in the copy are kept when it is ensured again (no longer replaced).
    const edited = JSON.parse(text(uri)!);
    edited.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: ['run in FDE\n'] }];
    await write(uri, JSON.stringify(edited));
    await copies!.ensureCopy(root, workspace, notebook, 'Load', false);
    assert.deepStrictEqual(JSON.parse(text(uri)!).cells[0].outputs, edited.cells[0].outputs);
    assert.strictEqual(artifactInfo('ws-1', 'nb-1')._remoteContentHash, DIFFERS_FROM_FABRIC);
  });

  test('download/upload of a re-created notebook moves its copy to the new item; a sync updates the hash', async () => {
    const old = await copy('ws-1', 'nb-1', 'Load');
    await start();
    await recordSync(root, 'Sales', 'Load', PY, 'upload', 'nb-2');
    await copies!.rebuild();
    const moved = copyUri('ws-1', 'nb-2', 'Load');
    assert.strictEqual(text(old), undefined, 'the copy of the old item is removed');
    assert.deepStrictEqual(cells(moved), ['print("one")']);
    assert.strictEqual(notebookFiles(root, 'Load').ipynb.toString(), moved.toString());
    assert.strictEqual(artifactInfo('ws-1', 'nb-2')._remoteContentHash, await hashText(text(moved)!));
    // A .py changed (and synced) since: recording it as the same as Fabric updates the copy and its hash.
    const changedPy = PY.replace('print("one")', 'print("two")');
    await write(notebookFiles(root, 'Load').py, changedPy);
    await recordSync(root, 'Sales', 'Load', changedPy, 'compare');
    await copies!.rebuild();
    assert.deepStrictEqual(cells(moved), ['print("two")']);
    assert.strictEqual(artifactInfo('ws-1', 'nb-2')._remoteContentHash, await hashText(text(moved)!));
  });

  test('a notebook new in the workspace gets a copy; one deleted there loses it, its .ipynb kept locally', async () => {
    await write(notebookFiles(root, 'Fresh').py, PY);
    await start();
    await recordSync(root, 'Sales', 'Fresh', PY, 'upload', 'nb-5');
    await copies!.rebuild();
    const uri = copyUri('ws-1', 'nb-5', 'Fresh');
    assert.deepStrictEqual(cells(uri), ['print("one")']);
    const ipynb = JSON.parse(text(uri)!);
    ipynb.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: ['from FDE\n'] }];
    await write(uri, JSON.stringify(ipynb));
    await forgetSync(root, 'Sales', 'fresh');
    await copies!.rebuild();
    assert.strictEqual(text(uri), undefined, 'the copy is removed');
    const files = notebookFiles(root, 'Fresh');
    assert.strictEqual(files.ipynb.toString(), files.localIpynb.toString());
    assert.deepStrictEqual(JSON.parse(text(files.localIpynb)!).cells[0].outputs, ipynb.cells[0].outputs, 'outputs kept');
  });

  test('environments recorded in the sync state are none of its business', async () => {
    await write(notebookFiles(root, 'Fresh').py, PY);
    await start();
    await recordItemSync(root, 'Sales', 'environment', 'Fresh', 'hash', 'upload', 'nb-5');
    await copies!.rebuild();
    assert.strictEqual(text(copyUri('ws-1', 'nb-5', 'Fresh')), undefined);
  });

  test('nothing is followed while off', async () => {
    enabled = false;
    await write(notebookFiles(root, 'Fresh').py, PY);
    await start();
    await recordSync(root, 'Sales', 'Fresh', PY, 'upload', 'nb-5');
    await copies!.rebuild();
    assert.strictEqual(text(copyUri('ws-1', 'nb-5', 'Fresh')), undefined);
  });

  test('deleting a notebook\'s local files deletes its copies in every workspace', async () => {
    await copy('ws-1', 'nb-1', 'Load');
    await copy('ws-2', 'nb-9', 'Load');
    await start();
    const deleted = await deleteNotebookFiles(notebookFiles(root, 'Load'));
    assert.strictEqual(deleted.length, 3, deleted.map((d) => d.path).join(', '));
    assert.strictEqual(text(copyUri('ws-1', 'nb-1', 'Load')), undefined);
    assert.strictEqual(text(copyUri('ws-2', 'nb-9', 'Load')), undefined);
  });

  test('copyBack copies the selected workspace\'s copies to .fabric-supersat/Notebooks where newer', async () => {
    const uri = await copy('ws-1', 'nb-1', 'Load');
    const files = notebookFiles(root, 'Load');
    await start();
    assert.strictEqual(await copies!.copyBack(root), 1);
    assert.strictEqual(text(files.localIpynb), text(uri));
    assert.strictEqual(await copies!.copyBack(root), 0, 'not again: the local one is as new now');
  });
});
