// Obscuring Fabric Data Engineering's work folder for "Log Fabric Data Engineering Structure" (src/fde/structureLog.ts).
import * as assert from 'assert';
import { Obscurer, obscureJson, summarizeIpynb } from '../../fde/structureLog';

const WS = 'A60A0DA1-92B0-42DB-8B8F-2F66868E6DD4';
const ITEM = '11111111-2222-3333-4444-555555555555';

suite('FDE structure log obscuring', () => {
  test('the same ID gets the same placeholder, ignoring case; the zero GUID is kept', () => {
    const o = new Obscurer();
    assert.strictEqual(o.id(WS), '<id-1>');
    assert.strictEqual(o.id(WS.toLowerCase()), '<id-1>');
    assert.strictEqual(o.id(ITEM), '<id-2>');
    assert.strictEqual(o.id('00000000-0000-0000-0000-000000000000'), '00000000-0000-0000-0000-000000000000');
  });

  test('path segments: structure names and dot-files kept, IDs and names replaced, extensions kept', () => {
    const o = new Obscurer();
    assert.strictEqual(o.pathSegment('SynapseNotebook'), 'SynapseNotebook');
    assert.strictEqual(o.pathSegment('.artifact-info'), '.artifact-info');
    assert.strictEqual(o.pathSegment('conf'), 'conf');
    assert.strictEqual(o.pathSegment(WS), '<id-1>');
    assert.strictEqual(o.pathSegment('Sales Ingest'), '<name-1>');
    assert.strictEqual(o.pathSegment('Sales Ingest.ipynb'), '<name-1>.ipynb');
    assert.strictEqual(o.pathSegment('helper.py'), '<name-2>.py');
  });

  test('JSON: IDs, emails, names and text replaced; kinds, numbers, booleans, empty strings and date formats kept', () => {
    const o = new Obscurer();
    const out = obscureJson(
      {
        objectId: ITEM,
        folderObjectId: WS,
        displayName: 'Sales Ingest',
        artifactType: 'SynapseNotebook',
        owner: 'someone@contoso.com',
        lastUpdatedDate: '2026-11-22T07:27:26.003',
        etag: 7,
        isMerging: false,
        refresh_token: '',
        url: `https://example.com/${WS}`,
        lakehouses: { [WS]: { name: 'Bronze' } },
        kernel: 'synapse_pyspark',
      },
      o,
    );
    assert.deepStrictEqual(out, {
      objectId: '<id-1>',
      folderObjectId: '<id-2>',
      displayName: '<text, 12 chars>',
      artifactType: 'SynapseNotebook',
      owner: '<text, 19 chars>',
      lastUpdatedDate: 'dddd-dd-ddTdd:dd:dd.ddd',
      etag: 7,
      isMerging: false,
      refresh_token: '',
      url: '<text, 56 chars>',
      lakehouses: { '<id-2>': { name: '<text, 6 chars>' } },
      kernel: 'synapse_pyspark',
    });
  });

  test('numbers under ID keys are replaced (the same number gets the same placeholder); other numbers kept', () => {
    const o = new Obscurer();
    assert.deepStrictEqual(
      obscureJson({ ownerUserId: 204221, ownerUser: { id: 204221, name: 'A Person' }, permissions: 71, attributes: 0 }, o),
      { ownerUserId: '<number-1>', ownerUser: { id: '<number-1>', name: '<text, 8 chars>' }, permissions: 71, attributes: 0 },
    );
  });

  test('FDE structure names and kinds seen in real work folders are kept', () => {
    const o = new Obscurer();
    assert.strictEqual(o.pathSegment('builtin'), 'builtin');
    assert.deepStrictEqual(obscureJson({ provisionState: 'Active', kernel_info: { name: 'jupyter' }, compute_id: '/trident/default' }, o), {
      provisionState: 'Active',
      kernel_info: { name: 'jupyter' },
      compute_id: '/trident/default',
    });
  });

  test('keys holding emails are replaced', () => {
    const o = new Obscurer();
    assert.deepStrictEqual(obscureJson({ 'someone@contoso.com': 1 }, o), { '<email-1>': 1 });
  });

  test('.ipynb: metadata obscured, cells counted by type, no cell source or outputs', () => {
    const o = new Obscurer();
    const summary = summarizeIpynb(
      {
        nbformat: 4,
        metadata: { kernel_info: { name: 'synapse_pyspark' }, dependencies: { lakehouse: { default_lakehouse: ITEM } } },
        cells: [
          { cell_type: 'code', source: ['secret = "x"'], outputs: [{ text: 'x' }], metadata: { microsoft: { language: 'python' } } },
          { cell_type: 'markdown', source: ['# Title'], metadata: {} },
          { cell_type: 'code', source: ['print(1)'], metadata: {} },
        ],
      },
      o,
    );
    assert.deepStrictEqual(summary, {
      nbformat: 4,
      metadata: { kernel_info: { name: 'synapse_pyspark' }, dependencies: { lakehouse: { default_lakehouse: '<id-1>' } } },
      cells: { count: 3, types: { code: 2, markdown: 1 }, firstCellMetadata: { microsoft: { language: 'python' } } },
    });
    assert.ok(!JSON.stringify(summary).includes('secret'));
  });
});
