import * as assert from 'assert';
import * as vscode from 'vscode';
import { EXTENSION_FULL_ID, ID_PREFIX } from '../../constants';
import type { Workspace } from '../../fabric/client';
import {
  ensureLocalStateDir,
  LOCAL_GITIGNORE,
  LocalStateDirDeclinedError,
  setLocalStateDirConfirmation,
} from '../../util/localState';
import { DEFAULT_REFERENCE_SETTINGS } from '../../notebooks/references';
import { NEW_SETTINGS_FILE, WorkspaceNameError, WorkspaceService, workspacesNamed } from '../../workspace/service';
import { MemFs } from './memFs';

const ws = (id: string, displayName: string): Workspace => ({ id, displayName, type: 'Workspace' });
const settings = () => vscode.workspace.getConfiguration(ID_PREFIX);
const NOTEBOOK_SETTINGS = [
  'notebooks.upload.defaultLakehouse',
  'notebooks.upload.otherLakehouses',
  'notebooks.upload.environment',
  'notebooks.sameWorkspace.defaultLakehouse',
  'notebooks.sameWorkspace.environment',
];
const clearSettings = async () => {
  for (const key of ['workspace.name', ...NOTEBOOK_SETTINGS]) {
    await settings().update(key, undefined, vscode.ConfigurationTarget.Global);
  }
};

/**
 * A service over a fake Fabric whose workspaces are `fabric` (editable by the test), and a
 * picker that returns the queued workspaces, recording the current name it was given.
 */
function createService(
  localDir: vscode.Uri | undefined,
  options: { isTrusted?: () => boolean; isFocused?: () => boolean } = {},
) {
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
    // Not focused unless a test says so, so automatic syncs don't race the test's own steps.
    isFocused: () => false,
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

  test('select creates settings.yaml (name only) from the template, git-ignores the folder, and sets the user setting too', async () => {
    t.picks.push(ws('w1', 'Sales'));
    assert.deepStrictEqual(await t.service.select(), { id: 'w1', name: 'Sales' });
    assert.strictEqual(file(), NEW_SETTINGS_FILE.replace('name: ""', 'name: "Sales"'));
    assert.doesNotMatch(file() ?? '', /\bid:/);
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), LOCAL_GITIGNORE);
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');
    assert.strictEqual(t.service.localFile?.toString(), vscode.Uri.joinPath(dir, 'settings.yaml').toString());
  });

  test('ignores an ID in the file, and removes it on save, keeping comments and other settings, adding notebook settings', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('# my notes\nworkspace:\n  id: "attacker-id"\n  name: Finance # dev workspace\n\nother: keep me\n');
    assert.deepStrictEqual(await t.service.refresh(), { name: 'Finance' });
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' }, 'the ID comes from Fabric');
    await t.service.save({ name: 'Sales' });
    assert.strictEqual(
      file(),
      '# my notes\nworkspace:\n  name: "Sales" # dev workspace\n\nother: keep me\n' +
        'notebooks:\n  upload:\n    defaultLakehouse: "replace"\n    otherLakehouses: "replace"\n    environment: "replace"\n' +
        '  sameWorkspace:\n    defaultLakehouse: false\n    environment: false\n',
    );
  });

  test('select adds only the notebook settings missing from an existing file, with the current values', async () => {
    await settings().update('notebooks.upload.otherLakehouses', 'keep', vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('workspace:\n  name: ""\nnotebooks:\n  upload:\n    environment: keep # mine\n');
    t.picks.push(ws('w1', 'Sales'));
    await t.service.select();
    assert.strictEqual(
      file(),
      'workspace:\n  name: "Sales"\nnotebooks:\n  upload:\n    environment: keep # mine\n' +
        '    defaultLakehouse: "replace"\n    otherLakehouses: "keep"\n' +
        '  sameWorkspace:\n    defaultLakehouse: false\n    environment: false\n',
    );
  });

  test('opening a folder copies the workspace in its settings.yaml to the user setting', async () => {
    await settings().update('workspace.name', 'Global', vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('workspace:\n  name: "Finance"\n');
    t.service.dispose();
    t = createService(dir);
    assert.deepStrictEqual(await t.service.resolve(), { id: 'w2', name: 'Finance' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Finance');

    // A folder with no workspace named leaves the setting alone.
    await writeFile('workspace:\n  name: ""\n');
    t.service.dispose();
    t = createService(dir);
    await t.service.refresh();
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Finance');
  });

  test('a change to settings.yaml made in this window is copied to the user setting', async () => {
    await t.service.save({ name: 'Sales' });
    await writeFile('workspace:\n  name: "Finance"\n');
    await t.service.syncFromFile(); // not focused
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');

    t.service.dispose();
    t = createService(dir, { isFocused: () => true });
    await writeFile('workspace:\n  name: "Finance"\n');
    await t.service.syncFromFile();
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Finance');
    assert.deepStrictEqual(t.service.current, { name: 'Finance' });

    // Blanking it clears the setting; an invalid file changes nothing.
    await writeFile('workspace:\n  name: ""\n');
    await t.service.syncFromFile();
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, undefined);
    await t.service.save({ name: 'Sales' });
    await writeFile('workspace:\n  name: "Fin\n');
    await t.service.syncFromFile();
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Sales');
  });

  test('a change to the user setting made in this window is copied to settings.yaml, if it exists', async () => {
    t.service.dispose();
    t = createService(dir, { isFocused: () => true });
    await settings().update('workspace.name', 'Sales', vscode.ConfigurationTarget.Global);
    await t.service.syncFromSetting();
    assert.strictEqual(file(), undefined, 'a project without settings.yaml still starts with no workspace');
    assert.strictEqual(t.service.current, undefined);

    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('# mine\nworkspace:\n  name: "Finance" # dev\n');
    await t.service.syncFromSetting();
    assert.strictEqual(file(), '# mine\nworkspace:\n  name: "Sales" # dev\n');
    assert.deepStrictEqual(t.service.current, { name: 'Sales' });

    await settings().update('workspace.name', undefined, vscode.ConfigurationTarget.Global);
    await t.service.syncFromSetting();
    assert.strictEqual(file(), '# mine\nworkspace:\n  name: "" # dev\n');
    assert.strictEqual(t.service.current, undefined);

    // Not focused: another window's change, so this folder's file is left alone.
    t.service.dispose();
    t = createService(dir);
    await settings().update('workspace.name', 'Other', vscode.ConfigurationTarget.Global);
    await t.service.syncFromSetting();
    assert.strictEqual(file(), '# mine\nworkspace:\n  name: "" # dev\n');
  });

  test('notebook settings: creating .fabric-supersat writes settings.yaml with the current values, even defaults', async () => {
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    await settings().update('notebooks.sameWorkspace.defaultLakehouse', true, vscode.ConfigurationTarget.Global);
    assert.strictEqual(await t.service.notebookSettings().then(() => file()), undefined, 'reading writes nothing');
    await ensureLocalStateDir(dir); // e.g. a download creating the folder for its .ipynb
    assert.deepStrictEqual(await t.service.notebookSettings(), {
      upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, environment: 'keep' },
      sameWorkspace: { ...DEFAULT_REFERENCE_SETTINGS.sameWorkspace, defaultLakehouse: true },
    });
    assert.strictEqual(
      file(),
      NEW_SETTINGS_FILE.replace('environment: "replace"', 'environment: "keep"').replace(
        'sameWorkspace:\n    defaultLakehouse: false',
        'sameWorkspace:\n    defaultLakehouse: true',
      ),
    );
    assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), LOCAL_GITIGNORE);

    // Changing the VS Code settings later doesn't change the file; its values win.
    await settings().update('notebooks.upload.environment', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual((await t.service.notebookSettings()).upload.environment, 'keep');
  });

  test('notebook settings: an existing folder isn’t given a settings file just by using it', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await ensureLocalStateDir(dir);
    assert.strictEqual(file(), undefined);
    // Select Workspace creates it, with the notebook settings.
    t.picks.push(ws('w1', 'Sales'));
    await t.service.select();
    assert.strictEqual(file(), NEW_SETTINGS_FILE.replace('name: ""', 'name: "Sales"'));
  });

  test('notebook settings: the file’s values override VS Code settings; missing ones use them', async () => {
    await settings().update('notebooks.upload.defaultLakehouse', 'keep', vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('workspace:\n  name: "Sales"\nnotebooks:\n  upload:\n    defaultLakehouse: replace # mine\n  sameWorkspace:\n    environment: true\n');
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(await t.service.notebookSettings(), {
      upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, environment: 'keep' },
      sameWorkspace: { defaultLakehouse: false, environment: true },
    });
    assert.strictEqual(
      file(),
      'workspace:\n  name: "Sales"\nnotebooks:\n  upload:\n    defaultLakehouse: replace # mine\n  sameWorkspace:\n    environment: true\n',
      'never written to on use',
    );
  });

  test('notebook settings: an invalid value is an error naming it, and the file is left alone', async () => {
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('notebooks:\n  upload:\n    environment: swap\n');
    await assert.rejects(t.service.notebookSettings(), /"notebooks\.upload\.environment" should be "replace" or "keep", not "swap"/);
    await writeFile('notebooks:\n  sameWorkspace:\n    environment: yes\n');
    await assert.rejects(t.service.notebookSettings(), /"notebooks\.sameWorkspace\.environment" should be true or false, not "yes"/);
    assert.strictEqual(file(), 'notebooks:\n  sameWorkspace:\n    environment: yes\n');
  });

  test('notebook settings: in Restricted Mode, VS Code settings are used and nothing is written', async () => {
    await settings().update('notebooks.upload.otherLakehouses', 'keep', vscode.ConfigurationTarget.Global);
    await vscode.workspace.fs.createDirectory(dir);
    await writeFile('notebooks:\n  upload:\n    otherLakehouses: replace\n');
    t.service.dispose();
    t = createService(dir, { isTrusted: () => false });
    assert.strictEqual((await t.service.notebookSettings()).upload.otherLakehouses, 'keep');
    assert.strictEqual(file(), 'notebooks:\n  upload:\n    otherLakehouses: replace\n');
  });

  test('asks before creating .fabric-supersat; declining writes nothing', async () => {
    const asked: string[] = [];
    let answer = false;
    setLocalStateDirConfirmation(async (folder) => {
      asked.push(folder.path);
      return answer;
    });
    try {
      await assert.rejects(t.service.save({ name: 'Sales' }), LocalStateDirDeclinedError);
      await assert.rejects(ensureLocalStateDir(dir), LocalStateDirDeclinedError, 'commands ask again');
      assert.deepStrictEqual(asked, [dir.path, dir.path]);
      assert.strictEqual(await vscode.workspace.fs.stat(dir).then(() => true, () => false), false);

      // Background writes don't ask again once declined.
      await assert.rejects(ensureLocalStateDir(dir, { background: true }), LocalStateDirDeclinedError);
      assert.strictEqual(asked.length, 2);

      // Writes at the same time share one question; once the folder exists, nothing is asked.
      answer = true;
      await Promise.all([ensureLocalStateDir(dir), ensureLocalStateDir(dir)]);
      assert.strictEqual(asked.length, 3);
      await t.service.save({ name: 'Sales' });
      assert.strictEqual(asked.length, 3);
      assert.strictEqual(memFs.text(`${dir.path}/.gitignore`), LOCAL_GITIGNORE);
      assert.match(file() ?? '', /notebooks:/);
    } finally {
      setLocalStateDirConfirmation(undefined);
    }
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

  test('reads the folder’s file, not the user setting, while a folder is open; saving writes both', async () => {
    await settings().update('workspace.name', 'Global', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await t.service.refresh(), undefined);
    await t.service.save({ name: 'Local' });
    assert.deepStrictEqual(t.service.current, { name: 'Local' });
    assert.strictEqual(settings().inspect('workspace.name')?.globalValue, 'Local');
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
