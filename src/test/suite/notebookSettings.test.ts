import * as assert from 'assert';
import * as vscode from 'vscode';
import { ID_PREFIX } from '../../constants';
import { NEW_NOTEBOOK_SETTINGS_FILE, NotebookSettings } from '../../notebooks/notebookSettings';
import { DEFAULT_REFERENCE_SETTINGS } from '../../notebooks/references';
import { ProjectSettings } from '../../workspace/projectSettings';
import { MemFs } from './memFs';

const settings = () => vscode.workspace.getConfiguration(ID_PREFIX);
const NOTEBOOK_SETTINGS = [
  'notebooks.upload.defaultLakehouse',
  'notebooks.upload.otherLakehouses',
  'notebooks.upload.environment',
  'notebooks.pythonVersion',
];
const clearSettings = async () => {
  for (const key of NOTEBOOK_SETTINGS) {
    await settings().update(key, undefined, vscode.ConfigurationTarget.Global);
  }
};

suite('Notebook settings: src/fabric-supersat.yaml', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  let notebookSettings: NotebookSettings;
  const file = () => memFs.text(`${root.path}/src/fabric-supersat.yaml`);
  const writeFile = async (text: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'src'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'src', 'fabric-supersat.yaml'), new TextEncoder().encode(text));
  };

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-nb-settings', memFs);
  });

  suiteTeardown(() => registration.dispose());

  setup(async () => {
    await clearSettings();
    // A fresh project folder per test.
    root = vscode.Uri.parse(`fss-nb-settings:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
    notebookSettings = new NotebookSettings({ root: () => root });
  });

  teardown(clearSettings);

  test('without the file, the VS Code settings are used, and reading writes nothing', async () => {
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(await notebookSettings.read(), {
      upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, environment: 'keep' },
    });
    assert.strictEqual(file(), undefined);
  });

  test('createFile writes the current values, even defaults, and never changes an existing file', async () => {
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    await notebookSettings.createFile();
    const created = NEW_NOTEBOOK_SETTINGS_FILE.replace('environment: "replace"', 'environment: "keep"');
    assert.strictEqual(file(), created);

    // Changing the VS Code settings later doesn't change the file; its values win.
    await clearSettings();
    await notebookSettings.createFile();
    assert.strictEqual(file(), created);
    assert.deepStrictEqual(await notebookSettings.read(), {
      upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, environment: 'keep' },
    });
  });

  test('the file’s values override VS Code settings; missing ones use them', async () => {
    await settings().update('notebooks.upload.defaultLakehouse', 'keep', vscode.ConfigurationTarget.Global);
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    const text = 'notebooks:\n  upload:\n    defaultLakehouse: replace # mine\n';
    await writeFile(text);
    assert.deepStrictEqual(await notebookSettings.read(), {
      upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, environment: 'keep' },
    });
    assert.strictEqual(file(), text, 'never written to on use');
  });

  test('an invalid value is an error naming it, and the file is left alone', async () => {
    await writeFile('notebooks:\n  upload:\n    environment: swap\n');
    await assert.rejects(notebookSettings.read(), /"notebooks\.upload\.environment" should be "replace" or "keep", not "swap"/);
    assert.strictEqual(file(), 'notebooks:\n  upload:\n    environment: swap\n');
  });

  test('pythonVersion: the VS Code setting (default 3.12) without the file; created with it; the file’s value wins', async () => {
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.12');
    await settings().update('notebooks.pythonVersion', ' 3.11 ', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.11');
    assert.strictEqual(file(), undefined, 'reading writes nothing');

    await notebookSettings.createFile();
    assert.ok(file()!.includes('  pythonVersion: "3.11"\n'));
    await settings().update('notebooks.pythonVersion', '3.12', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.11');
  });

  test('pythonVersion: missing from the file uses the VS Code setting; an invalid VS Code value uses the default', async () => {
    await writeFile('notebooks:\n  upload:\n    environment: keep\n');
    await settings().update('notebooks.pythonVersion', '3.10', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.10');
    await settings().update('notebooks.pythonVersion', 'latest', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.12');
  });

  test('pythonVersion: an invalid or unquoted value in the file is an error naming it', async () => {
    await writeFile('notebooks:\n  pythonVersion: "3.x"\n');
    await assert.rejects(notebookSettings.readPythonVersion(), /"notebooks\.pythonVersion" should be a Python version such as "3\.12", not "3\.x"/);
    await writeFile('notebooks:\n  pythonVersion: 3.10\n');
    await assert.rejects(notebookSettings.readPythonVersion(), /"notebooks\.pythonVersion" should be in quotes/);
    await writeFile("notebooks:\n  pythonVersion: '3.10'\n");
    assert.strictEqual(await notebookSettings.readPythonVersion(), '3.10');
  });

  test('is used in Restricted Mode, while .fabric-supersat/settings.yaml is not', async () => {
    await settings().update('notebooks.upload.otherLakehouses', 'keep', vscode.ConfigurationTarget.Global);
    await writeFile('notebooks:\n  upload:\n    otherLakehouses: replace\n');
    const local = vscode.Uri.joinPath(root, '.fabric-supersat');
    await vscode.workspace.fs.createDirectory(local);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(local, 'settings.yaml'), new TextEncoder().encode('workspace:\n  name: "Sales"\n'));
    const untrusted = new ProjectSettings({ localDir: () => local, isTrusted: () => false });

    assert.strictEqual(await untrusted.readWorkspaceName(), undefined);
    assert.strictEqual((await notebookSettings.read()).upload.otherLakehouses, 'replace');
  });

  test('without a project folder, the VS Code settings are used and nothing is created', async () => {
    const none = new NotebookSettings({ root: () => undefined });
    await settings().update('notebooks.upload.environment', 'keep', vscode.ConfigurationTarget.Global);
    assert.strictEqual((await none.read()).upload.environment, 'keep');
    await none.createFile();
    assert.strictEqual(none.file, undefined);
  });
});
