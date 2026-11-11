import * as assert from 'assert';
import * as vscode from 'vscode';
import { readYamlFile, updateYamlFile, YamlFileError } from '../../util/yamlFile';
import { MemFs } from './memFs';

suite('yamlFile', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let uri: vscode.Uri;
  const write = (text: string) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  const text = () => memFs.text(uri.path);

  suiteSetup(async () => {
    registration = vscode.workspace.registerFileSystemProvider('fss-yaml-test', memFs);
    await vscode.workspace.fs.createDirectory(vscode.Uri.parse('fss-yaml-test:/dir'));
  });
  suiteTeardown(() => registration.dispose());
  setup(() => {
    uri = vscode.Uri.parse(`fss-yaml-test:/dir/file${++run}.yaml`);
  });

  test('a missing file reads as undefined', async () => {
    assert.strictEqual(await readYamlFile(uri), undefined);
  });

  test('creates a missing file from the template', async () => {
    await updateYamlFile(uri, [[['a', 'b'], 'x']], '# about a\na:\n  b: ""\n');
    assert.strictEqual(text(), '# about a\na:\n  b: "x"\n');
  });

  test('updates values in place, keeping comments, order, blank lines and quoting', async () => {
    await write("# top\n\nz: 1 # zed\na:\n  b: 'old'\n  c: plain\n\n# end\n");
    await updateYamlFile(uri, [[['a', 'b'], 'new']], '');
    assert.strictEqual(text(), '# top\n\nz: 1 # zed\na:\n  b: "new"\n  c: plain\n\n# end\n');
  });

  test('quotes strings that would otherwise read as other types', async () => {
    await updateYamlFile(uri, [[['v'], 'no'], [['n'], '0123'], [['d'], '2024-01-01'], [['e'], '']], '');
    const file = await readYamlFile(uri);
    assert.deepStrictEqual(file?.document.toJS(), { v: 'no', n: '0123', d: '2024-01-01', e: '' });
  });

  test('adds missing keys and removes values set to undefined', async () => {
    await write('a:\n  b: "1"\n');
    await updateYamlFile(uri, [[['a', 'b'], undefined], [['a', 'c'], 2], [['x'], true]], '');
    assert.strictEqual(text(), 'a:\n  c: 2\nx: true\n');
  });

  test('getString trims, accepts numbers and booleans, and rejects maps and lists', async () => {
    await write('s: "  hi  "\nn: 2024\nb: true\nempty: ""\nnull:\nmap: { k: v }\n');
    const file = (await readYamlFile(uri))!;
    assert.strictEqual(file.getString(['s']), 'hi');
    assert.strictEqual(file.getString(['n']), '2024');
    assert.strictEqual(file.getString(['b']), 'true');
    assert.strictEqual(file.getString(['empty']), undefined);
    assert.strictEqual(file.getString(['null']), undefined);
    assert.strictEqual(file.getString(['missing', 'deep']), undefined);
    assert.throws(() => file.getString(['map']), /"map" should be a single value/);
  });

  test('reports invalid YAML with the file and line, and never overwrites it', async () => {
    const broken = 'a: 1\nb: "unclosed\n';
    await write(broken);
    await assert.rejects(readYamlFile(uri), (err: Error) => {
      assert.ok(err instanceof YamlFileError);
      assert.match(err.message, new RegExp(`${uri.path}: line \\d+: `));
      return true;
    });
    await assert.rejects(updateYamlFile(uri, [[['a'], 2]], ''), YamlFileError);
    assert.strictEqual(text(), broken);
  });

  test('refuses to update a file whose top level is not a map', async () => {
    await write('- a\n- b\n');
    await assert.rejects(updateYamlFile(uri, [[['a'], 'x']], ''), /can't update it/);
    assert.strictEqual(text(), '- a\n- b\n');
  });
});
