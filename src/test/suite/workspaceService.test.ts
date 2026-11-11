import * as assert from 'assert';
import * as vscode from 'vscode';
import { EXTENSION_FULL_ID, ID_PREFIX } from '../../constants';
import type { Workspace } from '../../fabric/client';
import { LOCAL_GITIGNORE } from '../../util/localState';
import { NEW_SETTINGS_FILE, WorkspaceNameError, WorkspaceService, workspacesNamed } from '../../workspace/service';
import { MemFs } from './memFs';

const ws = (id: string, displayName: string): Workspace => ({ id, displayName, type: 'Workspace' });
const settings = () => vscode.workspace.getConfiguration(ID_PREFIX);
const clearSettings = () => settings().update('workspace.name', undefined, vscode.ConfigurationTarget.Global);

/**
 * A service over a fake Fabric whose workspaces are `fabric` (editable by the test), and a
 * picker that returns the queued workspaces, recording the current name it was given.
 */
function createService(localDir: vscode.Uri | undefined, options: { isTrusted?: () => boolean } = {}) {
  const fabric: Workspace[] = [ws('w1', 'Sales'), ws('w2', 'Finance')];
  const picks: (Workspace | undefined)[] = [];
  const pickerCalls: (string | undefined)[] = [];
  let listCalls = 0;
  const service = new WorkspaceService({
    list: async () => {
      listCalls++;
      return [...fabric];
    },
    pick: async (_all, currentName) => {
      pickerCalls.push(currentName);
      return picks.shift();
    },
    localDir: () => localDir,
    ...options,
  });
  return { service, fabric, picks, pickerCalls, listCalls: () => listCalls };
}

suite('workspacesNamed', () => {
  test('matches names ignoring case, and returns every match', () => {
    const all = [ws('a', 'Sales'), ws('b', 'sales'), ws('c', 'Sales Dev')];
    assert.deepStrictEqual(workspacesNamed(all, 'SALES').map((w) => w.id), ['a', 'b']);
    assert.deepStrictEqual(workspacesNamed(all, 'Sales Dev').map((w) => w.id), ['c']);
    assert.deepStrictEqual(workspacesNamed(all, 'Ops'), []);
  });
});

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

  test('select saves only the picked workspace’s name in user settings', async () => {
    t.picks.push(ws('w1', 'Sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w1', name: 'Sales' });
    assert.deepStrictEqual(t.service.current, { name: 'Sales' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');
    assert.strictEqual(settings().inspect('workspace.id')?.globalValue, undefined);
    const properties = vscode.extensions.getExtension(EXTENSION_FULL_ID)?.packageJSON.contributes.configuration.properties;
    assert.ok(!(`${ID_PREFIX}.workspace.id` in properties), 'there is no workspace.id setting');
  });

  test('select keeps the saved workspace when the picker is cancelled, and marks it current', async () => {
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(await t.service.select(), undefined);
    assert.deepStrictEqual(t.pickerCalls, ['Sales']);
    assert.deepStrictEqual(t.service.current, { name: 'Sales' });
  });

  test('select lets the user pick one of several same-named workspaces by ID, for this session only', async () => {
    t.fabric.push(ws('w9', 'sales'));
    t.picks.push(ws('w9', 'sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w9', name: 'sales', nameShared: true });
    assert.deepStrictEqual(t.service.current, { name: 'sales' }, 'only the name is saved');
    // The picked ID is used for the rest of the session, without asking or listing again.
    const listed = t.listCalls();
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w9', name: 'sales', nameShared: true });
    assert.strictEqual(t.listCalls(), listed);
    // A new session (or a sign-in change) can't tell them apart from the name: pick again.
    t.service.forgetIds();
    await assert.rejects(t.service.resolve(), (err: Error) => {
      assert.ok(err instanceof WorkspaceNameError);
      assert.match(err.message, /2 Fabric workspaces are named "sales" \(w1, w9\).*pick the one you want by its ID/);
      return true;
    });
  });

  test('select of a uniquely named workspace is not marked as shared', async () => {
    t.picks.push(ws('w2', 'Finance'));
    assert.strictEqual((await t.service.select())?.nameShared, undefined);
  });

  test('resolve prompts only when no workspace is saved', async () => {
    t.picks.push(ws('w2', 'Finance'));
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.strictEqual(t.pickerCalls.length, 1);
  });

  test('resolve looks the ID up by name once per session, using Fabric’s spelling', async () => {
    await settings().update('workspace.name', 'finance', vscode.ConfigurationTarget.Global);
    await t.service.refresh();
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.strictEqual(t.listCalls(), 1);
    assert.strictEqual(t.pickerCalls.length, 0);

    t.service.forgetIds();
    t.fabric[1] = ws('w2-new', 'Finance');
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2-new', name: 'Finance' });
    assert.strictEqual(t.listCalls(), 2);
  });

  test('resolve refuses a name that matches more than one workspace', async () => {
    t.fabric.push(ws('w3', 'Sales'));
    await t.service.save({ name: 'Sales' });
    await assert.rejects(t.service.resolve(), (err: Error) => {
      assert.ok(err instanceof WorkspaceNameError);
      assert.match(err.message, /2 Fabric workspaces are named "Sales" \(w1, w3\)/);
      return true;
    });
  });

  test('resolve fails when no workspace has the name (renamed, deleted or another tenant)', async () => {
    await t.service.save({ name: 'Gone' });
    await assert.rejects(t.service.resolve(), (err: Error) => {
      assert.ok(err instanceof WorkspaceNameError);
      assert.match(err.message, /No Fabric workspace you can access is named "Gone"/);
      return true;
    });
  });

  test('fires onDidChange when the setting is edited', async () => {
    const changed = new Promise<unknown>((resolve) => {
      const sub = t.service.onDidChange((value) => {
        if (value?.name === 'Ops') {
          sub.dispose();
          resolve(value);
        }
      });
    });
    await settings().update('workspace.name', 'Ops', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(await changed, { name: 'Ops' });
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

  test('select creates settings.yaml (name only) from the template, git-ignores the folder, and leaves user settings alone', async () => {
    t.picks.push(ws('w1', 'Sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w1', name: 'Sales' });
    assert.strictEqual(file(), NEW_SETTINGS_FILE.replace('name: ""', 'name: "Sales"'));
    assert.doesNotMatch(file() ?? '', /\bid:/);
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), LOCAL_GITIGNORE);
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, undefined);
    assert.strictEqual(t.service.localFile?.toString(), vscode.Uri.joinPath(dir, 'settings.yaml').toString());
  });

  test('ignores an ID in the file, and removes it on save, keeping comments and other settings', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('# my notes\nworkspace:\n  id: "attacker-id"\n  name: Finance # dev workspace\n\nother: keep me\n');
    assert.deepStrictEqual(await t.service.refresh(), { name: 'Finance' });
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' }, 'the ID comes from Fabric');
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(file(), '# my notes\nworkspace:\n  name: "Sales" # dev workspace\n\nother: keep me\n');
  });

  test('a file with only an ID (from an earlier version) has no workspace', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('workspace:\n  id: "w1"\n');
    assert.strictEqual(await t.service.refresh(), undefined);
  });

  test('does not overwrite an existing .gitignore in the folder', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, '.gitignore'), new TextEncoder().encode('mine\n'));
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), 'mine\n');
  });

  test('ignores user settings while a folder is open', async () => {
    await settings().update('workspace.name', 'Global', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await t.service.refresh(), undefined);
    await t.service.save({ name: 'Local' });
    assert.deepStrictEqual(t.service.current, { name: 'Local' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Global');
  });

  test('picks up hand edits, including unquoted values', async () => {
    await t.service.save({ name: 'Sales' });
    await writeFile('workspace:\n  name:  2024 \n');
    assert.deepStrictEqual(await t.service.refresh(), { name: '2024' });
    await writeFile('workspace:\n  name: ""\n');
    assert.strictEqual(await t.service.refresh(), undefined);
  });

  test('treats an invalid file as no workspace, and refuses to overwrite it', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    const broken = 'workspace:\n  name: "Sales\n';
    await writeFile(broken);
    assert.strictEqual(await t.service.refresh(), undefined);
    await assert.rejects(t.service.save({ name: 'Finance' }), /settings\.yaml: line \d+/);
    assert.strictEqual(file(), broken);
  });

  test('clearing blanks the name (keeping the comments) and clears the user setting', async () => {
    await settings().update('workspace.name', 'Global', vscode.ConfigurationTarget.Global);
    await t.service.save({ name: 'Sales' });
    await t.service.save(undefined);
    assert.strictEqual(file(), NEW_SETTINGS_FILE);
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, undefined);
    assert.strictEqual(t.service.current, undefined);
  });

  test('clearing does not create the file', async () => {
    await t.service.save(undefined);
    assert.strictEqual(file(), undefined);
  });

  test('in Restricted Mode, ignores the folder’s settings.yaml (it may be the repo author’s) and uses user settings', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('workspace:\n  name: "Planted"\n');
    t.service.dispose();
    let trusted = false;
    t = createService(dir, { isTrusted: () => trusted });
    assert.strictEqual(t.service.localFile, undefined);
    assert.strictEqual(await t.service.refresh(), undefined);
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');
    assert.match(file() ?? '', /Planted/, 'the folder’s file is not written either');
    trusted = true;
    assert.deepStrictEqual(await t.service.refresh(), { name: 'Planted' });
  });

  test('never writes settings.yaml through a symlinked .fabric-supersat folder', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    memFs.markSymlink(dir.path);
    await assert.rejects(t.service.save({ name: 'Sales' }), /symbolic link/);
    assert.strictEqual(file(), undefined);
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), undefined);
  });

  test('uses user settings, for reading and saving, when the folder is read-only', async () => {
    t.service.dispose();
    await settings().update('workspace.name', 'Global', vscode.ConfigurationTarget.Global);
    t = createService(vscode.Uri.parse('fss-test-ro:/project/.fabric-supersat'));
    assert.strictEqual(t.service.localFile, undefined);
    assert.deepStrictEqual(await t.service.refresh(), { name: 'Global' });
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');
    assert.deepStrictEqual(t.service.current, { name: 'Sales' });
  });
});
