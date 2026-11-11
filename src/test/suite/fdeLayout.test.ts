// Fabric Data Engineering's work folder layout (src/fde/layout.ts): its file structure as of FDE 1.28.0 and 1.28.1.
import * as assert from 'assert';
import {
  artifactInfoFile,
  DIFFERS_FROM_FABRIC,
  type FdeNotebook,
  type FdeWorkspace,
  isOwnWorkFolder,
  notebookFiles,
  notebookIpynbPath,
  parseCopyPath,
  readArtifactInfo,
  readWorkspaceInfo,
  workFolderInfoFile,
  workspaceInfoFile,
} from '../../fde/layout';

const workspace: FdeWorkspace = { id: 'ws-1', name: 'Dev', capacityId: 'cap-1', personal: false };
const notebook: FdeNotebook = { workspaceId: 'ws-1', capacityId: 'cap-1', itemId: 'nb-1', displayName: 'Ingest' };
const copy = { lastUpdatedDate: '2026-11-22T10:53:30.000Z', contentHash: 'abc123' };

suite('FDE work folder layout', () => {
  test('marks the folder as layout version 1', () => {
    assert.deepStrictEqual(workFolderInfoFile(), { path: ['.work-folder-info'], text: '{"version":1}' });
  });

  test('puts the notebook at <workspace>/SynapseNotebook/<item>/<name>/<name>.ipynb', () => {
    assert.deepStrictEqual(notebookIpynbPath(notebook), ['ws-1', 'SynapseNotebook', 'nb-1', 'Ingest', 'Ingest.ipynb']);
  });

  test('puts .artifact-info two folders above the .ipynb, with the notebook IDs, copy date and content hash', () => {
    const info = artifactInfoFile(notebook, copy);
    assert.deepStrictEqual(info.path, [...notebookIpynbPath(notebook).slice(0, -2), '.artifact-info']);
    assert.deepStrictEqual(JSON.parse(info.text), {
      objectId: 'nb-1',
      artifactType: 'SynapseNotebook',
      displayName: 'Ingest',
      folderObjectId: 'ws-1',
      capacityObjectId: 'cap-1',
      lastUpdatedDate: '2026-11-22T10:53:30.000Z',
      _remoteContentHash: 'abc123',
    });
  });

  test('a copy that differs from Fabric gets a hash that never matches, so FDE shows it as modified', () => {
    const info = JSON.parse(artifactInfoFile(notebook, { lastUpdatedDate: copy.lastUpdatedDate }).text);
    assert.strictEqual(info._remoteContentHash, DIFFERS_FROM_FABRIC);
    assert.ok(!/^[0-9a-f]{64}$/.test(DIFFERS_FROM_FABRIC));
  });

  test('IDs are lowercase in paths and files; the display name is kept as it is', () => {
    const upper: FdeNotebook = { workspaceId: 'WS-A', capacityId: 'CAP-A', itemId: 'NB-A', displayName: 'Load Sales' };
    assert.deepStrictEqual(notebookIpynbPath(upper), ['ws-a', 'SynapseNotebook', 'nb-a', 'Load Sales', 'Load Sales.ipynb']);
    const info = JSON.parse(artifactInfoFile(upper, copy).text);
    assert.deepStrictEqual([info.objectId, info.folderObjectId, info.capacityObjectId], ['nb-a', 'ws-a', 'cap-a']);
    const ws = workspaceInfoFile({ id: 'WS-A', name: 'Dev', capacityId: 'CAP-A', personal: false });
    assert.deepStrictEqual(ws.path, ['ws-a', '.workspace-info']);
  });

  test('describes the workspace as a Folder ("My workspace" as User), keeping one FDE wrote', () => {
    const info = workspaceInfoFile(workspace);
    assert.deepStrictEqual(JSON.parse(info.text), { id: 'ws-1', name: 'Dev', type: 'Folder', capacityObjectId: 'cap-1' });
    assert.strictEqual(info.keepExisting, true);
    assert.strictEqual(JSON.parse(workspaceInfoFile({ ...workspace, personal: true }).text).type, 'User');
  });

  test('writes the workspace info, the artifact info, the resource info and the notebook, unchanged', () => {
    const files = notebookFiles(workspace, notebook, '{"cells":[]}', copy);
    assert.deepStrictEqual(
      files.map((f) => f.path.join('/')),
      [
        'ws-1/.workspace-info',
        'ws-1/SynapseNotebook/nb-1/.artifact-info',
        'ws-1/SynapseNotebook/nb-1/.resource-info',
        'ws-1/SynapseNotebook/nb-1/Ingest/Ingest.ipynb',
      ],
    );
    assert.strictEqual(files[2].text, '[]');
    assert.strictEqual(files[3].text, '{"cells":[]}');
  });

  test('recognises work folders this extension set', () => {
    assert.ok(isOwnWorkFolder('/home/me/project/.fabric-supersat/fabric-de'));
    assert.ok(isOwnWorkFolder('C:\\Users\\me\\project\\.fabric-supersat\\fabric-de\\'));
    assert.ok(!isOwnWorkFolder('/home/me/fde-work'));
    assert.ok(!isOwnWorkFolder('/home/me/project/.fabric-supersat/fabric-de/other'));
    assert.ok(!isOwnWorkFolder(undefined));
  });

  test('reads a copy\'s path back: workspace, item and name; anything else is not a copy', () => {
    assert.deepStrictEqual(parseCopyPath(notebookIpynbPath(notebook)), { workspaceId: 'ws-1', itemId: 'nb-1', displayName: 'Ingest' });
    assert.strictEqual(parseCopyPath(['ws-1', 'SynapseNotebook', 'nb-1', 'Ingest', 'Other.ipynb']), undefined);
    assert.strictEqual(parseCopyPath(['ws-1', 'Lakehouse', 'nb-1', 'Ingest', 'Ingest.ipynb']), undefined);
    assert.strictEqual(parseCopyPath(['ws-1', 'SynapseNotebook', 'nb-1', 'Ingest.ipynb']), undefined);
  });

  test('reads .workspace-info and .artifact-info back, as written here or by FDE', () => {
    assert.deepStrictEqual(readWorkspaceInfo(workspaceInfoFile(workspace).text), { id: 'ws-1', name: 'Dev', capacityId: 'cap-1', personal: false });
    assert.strictEqual(readWorkspaceInfo('{"type":"User"}')?.personal, true);
    assert.strictEqual(readWorkspaceInfo('not json'), undefined);
    assert.deepStrictEqual(readArtifactInfo(artifactInfoFile(notebook, copy).text), { itemId: 'nb-1', displayName: 'Ingest', capacityId: 'cap-1' });
    assert.strictEqual(readArtifactInfo('[]'), undefined);
  });
});
