// What the extension writes locally is safe: generated Markdown shows Fabric's text as it
// is, folders named after Fabric items follow one set of rules, and .fabric-supersat stays
// out of git.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { checkNotebookFormats, renderFormatReport } from '../../notebooks/formatTest';
import { checkNotebookName } from '../../notebooks/files';
import { folderNameProblem, safeFolderName } from '../../util/folderNames';
import {
  ensureLocalStateDir,
  ignoresEverything,
  LOCAL_GITIGNORE,
  onLocalGitignoreRepaired,
} from '../../util/localState';
import { fence, mdText } from '../../util/markdown';
import { renderMetadataMarkdown, type WorkspaceMetadata } from '../../workspace/metadata';
import { workspaceFolderName } from '../../workspace/state';
import { SCRATCH3_IPYNB, SCRATCH3_PY } from './fixtures/fabricSamples';
import { MemFs } from './memFs';

/** Text another workspace member could put in an item's name or description. */
const HOSTILE = '![x](https://attacker.example/p.png) <img src="https://attacker.example/i.png"> [link](https://a.example) $x$ *b* | c';

suite('Generated Markdown shows Fabric’s text as it is', () => {
  test('mdText escapes everything that could become a link, image, HTML, math or formatting', () => {
    assert.strictEqual(
      mdText(HOSTILE),
      '\\!\\[x\\]\\(https://attacker.example/p.png\\) \\<img src="https://attacker.example/i.png"\\> ' +
        '\\[link\\]\\(https://a.example\\) \\$x\\$ \\*b\\* \\| c',
    );
    assert.strictEqual(mdText('two\nlines\r\nhere'), 'two lines here');
    assert.strictEqual(mdText('Sales (dev) 2024-01'), 'Sales \\(dev\\) 2024-01', '- and + are left alone mid-line');
    assert.strictEqual(mdText(42), '42');
  });

  test('fence: the fence is longer than any backticks in the text, so the text can’t close it', () => {
    assert.deepStrictEqual(fence('plain', 'json'), ['```json', 'plain', '```']);
    assert.deepStrictEqual(fence('a ``` b ```` c'), ['`````', 'a ``` b ```` c', '`````']);
  });

  test('metadata.md: hostile names and descriptions can’t inject images, HTML or links', () => {
    const m: WorkspaceMetadata = {
      format: 1,
      capturedAt: '2026-11-15T00:00:00Z',
      workspace: { id: 'ws', name: `Sales ${HOSTILE}` },
      summary: { itemTypes: [{ type: 'Notebook', count: 1 }] },
      folders: [{ id: 'f', name: 'x', path: 'Bronze\n```\n![f](https://attacker.example/f.png)' }],
      items: [{ id: 'nb1', name: `Load ${HOSTILE}`, type: 'Notebook', description: HOSTILE }],
      lakehouses: [{ id: 'lh', name: `Lake ${HOSTILE}` }],
      warehouses: [],
      environments: [],
      notebooks: [{ id: 'nb1', name: `Load ${HOSTILE}`, description: HOSTILE }],
      unavailable: [],
    };
    const md = renderMetadataMarkdown(m);
    // Outside code blocks, nothing of the hostile text is live Markdown or HTML.
    const outsideCode = md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '');
    assert.doesNotMatch(outsideCode, /(?<!\\)!\[|(?<!\\)<img|(?<!\\)\]\(/);
    assert.match(md, /^# Sales \\!\\\[x\\\]/);
    // A code block (here, folder paths) can't be closed by backticks in a name.
    assert.match(md, /## Folders\n\n````\nBronze\n```\n!\[f\]\(https:\/\/attacker\.example\/f\.png\)\n````\n/);
  });

  test('format-test.md: notebook names are escaped, and quoted notebook lines can’t close their code block', async () => {
    const markdownWithFence = SCRATCH3_PY.replace('# Welcome to your new notebook', '# ```\n# ![x](https://attacker.example/p.png)');
    const result = await checkNotebookFormats(
      { notebook: { id: 'n', displayName: `Evil <img src=x> ![y](https://attacker.example/y.png)`, type: 'Notebook', workspaceId: 'w' }, gitPath: 'notebook-content.py', gitText: SCRATCH3_PY, ipynbText: SCRATCH3_IPYNB.replace('Welcome', 'Changed') },
    );
    const report = renderFormatReport('Sales', '2026-11-15T00:00:00Z', [
      result,
      await checkNotebookFormats({ notebook: { id: 'm', displayName: 'Fence', type: 'Notebook', workspaceId: 'w' }, gitPath: 'notebook-content.py', gitText: markdownWithFence, ipynbText: SCRATCH3_IPYNB }),
    ]);
    assert.match(report, /\| Evil \\<img src=x\\> \\!\\\[y\\\]\\\(https:\/\/attacker\.example\/y\.png\\\) \|/);
    assert.match(report, /### Evil \\<img src=x\\>/);
    // The difference quoted for "Fence" contains ``` and is fenced with ````.
    assert.match(report, /### Fence[\s\S]*?\n````\n[\s\S]*?```[\s\S]*?\n````\n/);
  });
});

suite('Folders named after Fabric items: one set of rules', () => {
  test('safe names are used as they are; others are encoded into safe ones', () => {
    for (const name of ['Sales (dev)', 'Load_2024-v2', 'Café', '100%', 'Console', 'COM10']) {
      assert.strictEqual(folderNameProblem(name), undefined, name);
      assert.strictEqual(safeFolderName(name), name, name);
    }
    assert.strictEqual(safeFolderName('A/B: "C"?'), 'A%2FB%3A %22C%22%3F');
    assert.strictEqual(safeFolderName('100% done.'), '100%25 done%2E');
    assert.strictEqual(safeFolderName('..'), '.%2E');
    assert.strictEqual(safeFolderName('.'), '%2E');
    assert.strictEqual(safeFolderName(''), '%');
    assert.strictEqual(safeFolderName('  padded '), '%20%20padded%20');
    assert.strictEqual(safeFolderName('CON'), '%43ON');
    assert.strictEqual(safeFolderName('nul.txt'), '%6Eul.txt');
    assert.strictEqual(safeFolderName('lpt1'), '%6Cpt1');
  });

  test('an encoded name always passes the rules', () => {
    for (const name of ['a/b', '..', '.', '', ' x ', 'CON', 'com1.log', 'x.', 'a\u0001b', 'tab\t', '%', '<>|*?:"\\']) {
      assert.strictEqual(folderNameProblem(safeFolderName(name)), undefined, JSON.stringify(name));
    }
  });

  test('notebook folders, notebook samples and workspace folders follow the same rules', () => {
    for (const name of ['Good Name', 'a/b', 'CON', 'trailing.', ' lead']) {
      const problem = folderNameProblem(name);
      // A notebook's own folders are refused exactly when the rules find a problem (a notebook is never renamed)...
      if (problem) {
        assert.throws(() => checkNotebookName(name), new RegExp(problem.replace(/[()\\.*?|[\]]/g, '\\$&')));
      } else {
        checkNotebookName(name);
      }
      // ...and its samples folder, like a workspace's folder, is its name whenever the rules allow.
      assert.strictEqual(workspaceFolderName(name), safeFolderName(name));
      assert.strictEqual(safeFolderName(name) === name, !problem);
    }
  });
});

suite('.fabric-supersat stays out of git', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let dir: vscode.Uri;
  const gitignore = () => vscode.Uri.joinPath(dir, '.gitignore');
  const text = (uri: vscode.Uri) => memFs.text(uri.path);

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-safety-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    const root = vscode.Uri.parse(`fss-safety-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
    dir = vscode.Uri.joinPath(root, '.fabric-supersat');
  });

  test('what counts as ignoring everything', () => {
    assert.ok(ignoresEverything(LOCAL_GITIGNORE));
    assert.ok(ignoresEverything('*\n'));
    assert.ok(ignoresEverything('# mine\r\n/**\r\n'));
    assert.ok(!ignoresEverything(''));
    assert.ok(!ignoresEverything('# nothing ignored\n'));
    assert.ok(!ignoresEverything('*.log\nlogs/\n'));
    assert.ok(!ignoresEverything('*\n!workspaces/**\n'), 'a ! pattern brings files back');
  });

  test('a .gitignore that doesn’t ignore everything (e.g. committed to the repo) is replaced, and said so', async () => {
    const repaired: string[] = [];
    const listening = onLocalGitignoreRepaired((uri, previous) => repaired.push(`${uri.path}|${previous}`));
    try {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(gitignore(), new TextEncoder().encode('*\n!workspaces/\n'));
      await ensureLocalStateDir(dir);
      assert.strictEqual(text(gitignore()), LOCAL_GITIGNORE);
      assert.deepStrictEqual(repaired, [`${gitignore().path}|*\n!workspaces/\n`]);

      // One that already ignores everything (even with other lines) is left as it is, quietly.
      await vscode.workspace.fs.writeFile(gitignore(), new TextEncoder().encode('# my notes\n*\n'));
      await ensureLocalStateDir(dir);
      assert.strictEqual(text(gitignore()), '# my notes\n*\n');
      assert.strictEqual(repaired.length, 1);
    } finally {
      listening.dispose();
    }
  });

  test('a missing .gitignore is created without a warning', async () => {
    const repaired: unknown[] = [];
    const listening = onLocalGitignoreRepaired(() => repaired.push(1));
    try {
      await ensureLocalStateDir(dir);
      assert.strictEqual(text(gitignore()), LOCAL_GITIGNORE);
      assert.deepStrictEqual(repaired, []);
    } finally {
      listening.dispose();
    }
  });
});
