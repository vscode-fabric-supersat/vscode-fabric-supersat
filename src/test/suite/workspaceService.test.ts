import * as assert from 'assert';
import * as vscode from 'vscode';
import { ID_PREFIX } from '../../constants';
import type { Workspace } from '../../fabric/client';
import { LOCAL_GITIGNORE, NEW_SETTINGS_FILE, WorkspaceService } from '../../workspace/service';
import { MemFs } from './memFs';

const ws = (id: string, displayName: string): Workspace => ({ id, displayName, type: 'Workspace' });
const settings = () => vscode.workspace.getConfiguration(ID_PREFIX);
const clearSettings = async () => {
  await settings().update('workspace.name', undefined, vscode.ConfigurationTarget.Global);
  await settings().update('workspace.id', undefined, vscode.ConfigurationTarget.Global);
};

/** A service whose picker returns the queued workspaces, recording the `currentId` it was given. */
function createService(localDir: vscode.Uri | undefined) {
  const picks: (Workspace | undefined)[] = [];
  const pickerCalls: (string | undefined)[] = [];
  const service = new WorkspaceService({
    pick: async (currentId) => {
      pickerCalls.push(currentId);
      return picks.shift();
    },
    localDir: () => localDir,
  });
  return { service, picks, pickerCalls };
}

suite('WorkspaceService: no folder open (user settings)', () => {
  let t: ReturnType<typeof createService>;

  setup(async () => {
    await clearSettings();
    t = createService(undefined);
    await t.service.refresh();
  });

  teardown(async () => {
    t.service.dispose();
    await clearSettings();
  });

  test('has no current workspace until one is selected', () => {
    assert.strictEqual(t.service.current, undefined);
    assert.strictEqual(t.service.localFile, undefined);
  });

  test('select saves the picked workspace in user settings', async () => {
    t.picks.push(ws('w1', 'Sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w1', name: 'Sales' });
    assert.deepStrictEqual(t.service.current, { id: 'w1', name: 'Sales' });
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, 'w1');
  });

  test('select keeps the saved workspace when the picker is cancelled, and marks it current', async () => {
    await t.service.save({ id: 'w1', name: 'Sales' });
    assert.strictEqual(await t.service.select(), undefined);
    assert.deepStrictEqual(t.pickerCalls, ['w1']);
    assert.deepStrictEqual(t.service.current, { id: 'w1', name: 'Sales' });
  });

  test('resolve prompts only when no workspace is saved', async () => {
    t.picks.push(ws('w2', 'Finance'));
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.strictEqual(t.pickerCalls.length, 1);
  });

  test('falls back to the ID when no name is saved', async () => {
    await t.service.save({ id: 'w3', name: '' });
    assert.deepStrictEqual(t.service.current, { id: 'w3', name: 'w3' });
  });

  test('fires onDidChange when the setting is edited', async () => {
    const changed = new Promise<unknown>((resolve) => {
      const sub = t.service.onDidChange((value) => {
        if (value?.id === 'w4') {
          sub.dispose();
          resolve(value);
        }
      });
    });
    await settings().update('workspace.name', 'Ops', vscode.ConfigurationTarget.Global);
    await settings().update('workspace.id', 'w4', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(await changed, { id: 'w4', name: 'Ops' });
  });
});

suite('WorkspaceService: folder open (local .fabric-supersat folder)', () => {
  const memFs = new MemFs();
  const readOnlyFs = new MemFs();
  let registrations: vscode.Disposable[];
  let run = 0;
  let dir: vscode.Uri;
  let t: ReturnType<typeof createService>;
  const file = () => memFs.text(`${dir.path}/settings.yaml`);
  const writeFile = (text: string) =>
    vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'settings.yaml'), new TextEncoder().encode(text));

  suiteSetup(() => {
    registrations = [
      vscode.workspace.registerFileSystemProvider('fss-test', memFs),
      vscode.workspace.registerFileSystemProvider('fss-test-ro', readOnlyFs, { isReadonly: true }),
    ];
  });

  suiteTeardown(() => registrations.forEach((r) => r.dispose()));

  setup(async () => {
    await clearSettings();
    // A fresh project folder per test.
    const project = vscode.Uri.parse(`fss-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(project);
    dir = vscode.Uri.joinPath(project, '.fabric-supersat');
    t = createService(dir);
    await t.service.refresh();
  });

  teardown(async () => {
    t.service.dispose();
    await clearSettings();
  });

  test('select creates settings.yaml from the template, git-ignores the folder, and leaves user settings alone', async () => {
    t.picks.push(ws('w1', 'Sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w1', name: 'Sales' });
    assert.strictEqual(file(), NEW_SETTINGS_FILE.replace('id: ""', 'id: "w1"').replace('name: ""', 'name: "Sales"'));
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), LOCAL_GITIGNORE);
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, undefined);
    assert.strictEqual(t.service.localFile?.toString(), vscode.Uri.joinPath(dir, 'settings.yaml').toString());
  });

  test('keeps hand-written comments and other settings when saving', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('# my notes\nworkspace:\n  id: old # dev workspace\n\nother: keep me\n');
    await t.service.save({ id: 'w1', name: 'Sales' });
    assert.strictEqual(file(), '# my notes\nworkspace:\n  id: "w1" # dev workspace\n  name: "Sales"\n\nother: keep me\n');
  });

  test('does not overwrite an existing .gitignore in the folder', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, '.gitignore'), new TextEncoder().encode('mine\n'));
    await t.service.save({ id: 'w1', name: 'Sales' });
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), 'mine\n');
  });

  test('ignores user settings while a folder is open', async () => {
    await settings().update('workspace.id', 'global', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await t.service.refresh(), undefined);
    await t.service.save({ id: 'local', name: 'Local' });
    assert.deepStrictEqual(t.service.current, { id: 'local', name: 'Local' });
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, 'global');
  });

  test('picks up hand edits, including unquoted values', async () => {
    await t.service.save({ id: 'w1', name: 'Sales' });
    await writeFile('workspace:\n  id:  w2 \n  name: 2024\n');
    assert.deepStrictEqual(await t.service.refresh(), { id: 'w2', name: '2024' });
    await writeFile('workspace:\n  id: ""\n');
    assert.strictEqual(await t.service.refresh(), undefined);
  });

  test('treats an invalid file as no workspace, and refuses to overwrite it', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    const broken = 'workspace:\n  id: "w1\n';
    await writeFile(broken);
    assert.strictEqual(await t.service.refresh(), undefined);
    await assert.rejects(t.service.save({ id: 'w2', name: 'Finance' }), /settings\.yaml: line \d+/);
    assert.strictEqual(file(), broken);
  });

  test('clearing blanks the values (keeping the comments) and clears the user settings', async () => {
    await settings().update('workspace.id', 'global', vscode.ConfigurationTarget.Global);
    await t.service.save({ id: 'w1', name: 'Sales' });
    await t.service.save(undefined);
    assert.strictEqual(file(), NEW_SETTINGS_FILE);
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, undefined);
    assert.strictEqual(t.service.current, undefined);
  });

  test('clearing does not create the file', async () => {
    await t.service.save(undefined);
    assert.strictEqual(file(), undefined);
  });

  test('uses user settings, for reading and saving, when the folder is read-only', async () => {
    t.service.dispose();
    await settings().update('workspace.id', 'global', vscode.ConfigurationTarget.Global);
    t = createService(vscode.Uri.parse('fss-test-ro:/project/.fabric-supersat'));
    assert.strictEqual(t.service.localFile, undefined);
    assert.deepStrictEqual(await t.service.refresh(), { id: 'global', name: 'global' });
    await t.service.save({ id: 'w1', name: 'Sales' });
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, 'w1');
    assert.deepStrictEqual(t.service.current, { id: 'w1', name: 'Sales' });
  });
});
