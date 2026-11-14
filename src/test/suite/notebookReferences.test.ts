import * as assert from 'assert';
import { parseFabricPy } from '../../notebooks/format';
import {
  DEFAULT_REFERENCE_SETTINGS,
  type NamedItem,
  ReferenceMapper,
  type ReferenceSettings,
  type ReferencedItemType,
  SAME_WORKSPACE_ID,
  toSameWorkspace,
} from '../../notebooks/references';
import { FABRIC_CICD_EXAMPLE_PY, FABRIC_CICD_HELLO_WORLD_PY, SCRATCH2_TSQL_LAKEHOUSE_PY } from './fixtures/fabricSamples';

// IDs in the fixtures: FABRIC_CICD_EXAMPLE_PY's lakehouse "WithoutSchema" is ...09 in workspace ...10;
// FABRIC_CICD_HELLO_WORLD_PY's environment is ...11 in the "same workspace" (all zeros).
const SOURCE = '00000000-0000-0000-0000-000000000010';
const TARGET = 'aaaaaaaa-0000-0000-0000-000000000001';
const DEV_LAKEHOUSE = '00000000-0000-0000-0000-000000000009';
const DEV_ENVIRONMENT = '00000000-0000-0000-0000-000000000011';

type Workspaces = Record<string, Partial<Record<ReferencedItemType, NamedItem[]>>>;

function mapper(workspaces: Workspaces, settings: ReferenceSettings = DEFAULT_REFERENCE_SETTINGS) {
  const calls: string[] = [];
  const m = new ReferenceMapper(
    async (ws, type) => {
      calls.push(`${ws}/${type}`);
      const items = workspaces[ws]?.[type];
      if (!items) {
        throw new Error('403 Forbidden');
      }
      return items;
    },
    TARGET,
    settings,
  );
  return { m, calls };
}

const settings = (changes: {
  upload?: Partial<ReferenceSettings['upload']>;
  sameWorkspace?: Partial<ReferenceSettings['sameWorkspace']>;
}): ReferenceSettings => ({
  upload: { ...DEFAULT_REFERENCE_SETTINGS.upload, ...changes.upload },
  sameWorkspace: { ...DEFAULT_REFERENCE_SETTINGS.sameWorkspace, ...changes.sameWorkspace },
});

const dependenciesOf = (py: string) => parseFabricPy(py).meta!.dependencies as Record<string, Record<string, unknown>>;
const lakehouseOf = (py: string) => dependenciesOf(py).lakehouse;
const environmentOf = (py: string) => dependenciesOf(py).environment;
const inWorkspace = (py: string, workspaceId: string) => py.replace(SAME_WORKSPACE_ID, workspaceId);

/** FABRIC_CICD_EXAMPLE_PY with a second known lakehouse, "lh-silver-dev". */
const WITH_SILVER = FABRIC_CICD_EXAMPLE_PY.replace(
  /("known_lakehouses": \[\n# META\s+\{\n# META\s+"id": "00000000-0000-0000-0000-000000000009"\n# META\s+\})/,
  '$1,\n# META         {\n# META           "id": "lh-silver-dev"\n# META         }',
);

suite('ReferenceMapper: lakehouse and environment IDs on upload', () => {
  test('swaps the default lakehouse for the target workspace’s one with the same name', async () => {
    const { m } = mapper({ [TARGET]: { Lakehouse: [{ id: 'lh-test', displayName: 'WithoutSchema' }] } });
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.deepStrictEqual(lakehouseOf(result.py), {
      default_lakehouse: 'lh-test',
      default_lakehouse_name: 'WithoutSchema',
      default_lakehouse_workspace_id: TARGET,
      known_lakehouses: [{ id: 'lh-test' }],
    });
    assert.deepStrictEqual(result.replaced, [`Lakehouse "WithoutSchema": ${DEV_LAKEHOUSE} → lh-test`]);
    assert.deepStrictEqual([result.kept, result.notes], [[], []]);
    // Only the header changes: cells are exactly as they were.
    assert.deepStrictEqual(parseFabricPy(result.py).cells, parseFabricPy(FABRIC_CICD_EXAMPLE_PY).cells);
  });

  test('matches names ignoring case, and uses the target’s spelling', async () => {
    const { m } = mapper({ [TARGET]: { Lakehouse: [{ id: 'lh-test', displayName: 'withoutschema' }] } });
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(lakehouseOf(result.py).default_lakehouse_name, 'withoutschema');
  });

  test('uploading back to the notebook’s own workspace changes nothing (byte-identical)', async () => {
    const same = new ReferenceMapper(async () => [{ id: DEV_LAKEHOUSE, displayName: 'WithoutSchema' }], SOURCE);
    const result = await same.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(result.py, FABRIC_CICD_EXAMPLE_PY);
    assert.deepStrictEqual([result.replaced, result.kept], [[], []]);
  });

  test('an item already in the target workspace keeps its ID; its workspace ID is corrected', async () => {
    const { m } = mapper({ [TARGET]: { Lakehouse: [{ id: DEV_LAKEHOUSE, displayName: 'WithoutSchema' }] } });
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(lakehouseOf(result.py).default_lakehouse, DEV_LAKEHOUSE);
    assert.strictEqual(lakehouseOf(result.py).default_lakehouse_workspace_id, TARGET);
  });

  test('warns (once) about a lakehouse with no same-named one in the target', async () => {
    const { m } = mapper({ [TARGET]: { Lakehouse: [{ id: 'other', displayName: 'Bronze' }] } });
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(result.py, FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(result.kept.length, 1);
    assert.match(result.kept[0], /"WithoutSchema".*no lakehouse with that name/);
    assert.deepStrictEqual(m.kept, result.kept);
  });

  test('warns when the target workspace can’t be listed', async () => {
    const { m } = mapper({});
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(result.py, FABRIC_CICD_EXAMPLE_PY);
    assert.match(result.kept[0], /couldn't list/);
  });

  test('looks up an environment’s name in its workspace, then swaps it by name', async () => {
    const { m } = mapper({
      [SOURCE]: { Environment: [{ id: DEV_ENVIRONMENT, displayName: 'Spark Env' }] },
      [TARGET]: { Environment: [{ id: 'env-test', displayName: 'Spark Env' }] },
    });
    const result = await m.retarget(inWorkspace(FABRIC_CICD_HELLO_WORLD_PY, SOURCE));
    assert.deepStrictEqual(environmentOf(result.py), { environmentId: 'env-test', workspaceId: TARGET });
  });

  test('"same workspace" wins: the zeros are kept, and an unmatched reference is not warned about', async () => {
    const found = mapper({ [TARGET]: { Environment: [{ id: DEV_ENVIRONMENT, displayName: 'Env' }] } });
    const kept = await found.m.retarget(FABRIC_CICD_HELLO_WORLD_PY);
    assert.strictEqual(kept.py, FABRIC_CICD_HELLO_WORLD_PY);

    const missing = mapper({ [TARGET]: { Environment: [{ id: 'env-test', displayName: 'Spark Env' }] } });
    const result = await missing.m.retarget(FABRIC_CICD_HELLO_WORLD_PY);
    assert.strictEqual(result.py, FABRIC_CICD_HELLO_WORLD_PY);
    assert.deepStrictEqual(result.kept, []);
    assert.match(result.notes[0], /environment .* the notebook's own workspace/);
    assert.deepStrictEqual(missing.m.kept, []);
  });

  test('a "same workspace" default lakehouse is still swapped by name, keeping the zeros', async () => {
    const { m } = mapper({ [TARGET]: { Lakehouse: [{ id: 'lh-test', displayName: 'WithoutSchema' }] } });
    const result = await m.retarget(FABRIC_CICD_EXAMPLE_PY.replace(SOURCE, SAME_WORKSPACE_ID));
    assert.strictEqual(lakehouseOf(result.py).default_lakehouse, 'lh-test');
    assert.strictEqual(lakehouseOf(result.py).default_lakehouse_workspace_id, SAME_WORKSPACE_ID);
  });

  test('the sameWorkspace settings write "same workspace" instead of the target’s ID', async () => {
    const { m } = mapper(
      {
        [SOURCE]: { Environment: [{ id: DEV_ENVIRONMENT, displayName: 'Spark Env' }] },
        [TARGET]: {
          Lakehouse: [{ id: 'lh-test', displayName: 'WithoutSchema' }],
          Environment: [{ id: 'env-test', displayName: 'Spark Env' }],
        },
      },
      settings({ sameWorkspace: { defaultLakehouse: true, environment: true } }),
    );
    const lakehouse = await m.retarget(FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(lakehouseOf(lakehouse.py).default_lakehouse_workspace_id, SAME_WORKSPACE_ID);
    const environment = await m.retarget(inWorkspace(FABRIC_CICD_HELLO_WORLD_PY, SOURCE));
    assert.deepStrictEqual(environmentOf(environment.py), { environmentId: 'env-test', workspaceId: SAME_WORKSPACE_ID });
  });

  test('other known lakehouses are looked up in the default lakehouse’s workspace', async () => {
    const { m, calls } = mapper({
      [SOURCE]: { Lakehouse: [{ id: 'lh-silver-dev', displayName: 'Silver' }] },
      [TARGET]: {
        Lakehouse: [
          { id: 'lh-test', displayName: 'WithoutSchema' },
          { id: 'lh-silver-test', displayName: 'Silver' },
        ],
      },
    });
    const result = await m.retarget(WITH_SILVER);
    assert.deepStrictEqual(lakehouseOf(result.py).known_lakehouses, [{ id: 'lh-test' }, { id: 'lh-silver-test' }]);

    // Listings are cached across notebooks.
    await m.retarget(WITH_SILVER);
    assert.strictEqual(new Set(calls).size, calls.length);
  });

  test('each kind of reference can be set to keep its IDs', async () => {
    const workspaces: Workspaces = {
      [SOURCE]: {
        Lakehouse: [{ id: 'lh-silver-dev', displayName: 'Silver' }],
        Environment: [{ id: DEV_ENVIRONMENT, displayName: 'Spark Env' }],
      },
      [TARGET]: {
        Lakehouse: [
          { id: 'lh-test', displayName: 'WithoutSchema' },
          { id: 'lh-silver-test', displayName: 'Silver' },
        ],
        Environment: [{ id: 'env-test', displayName: 'Spark Env' }],
      },
    };
    const keepDefault = await mapper(workspaces, settings({ upload: { defaultLakehouse: 'keep' } })).m.retarget(WITH_SILVER);
    assert.deepStrictEqual(lakehouseOf(keepDefault.py), {
      ...lakehouseOf(WITH_SILVER),
      known_lakehouses: [{ id: DEV_LAKEHOUSE }, { id: 'lh-silver-test' }],
    });
    // The default lakehouse's own entry in known_lakehouses follows the default lakehouse setting.
    const keepOthers = await mapper(workspaces, settings({ upload: { otherLakehouses: 'keep' } })).m.retarget(WITH_SILVER);
    assert.deepStrictEqual(lakehouseOf(keepOthers.py).known_lakehouses, [{ id: 'lh-test' }, { id: 'lh-silver-dev' }]);
    assert.strictEqual(lakehouseOf(keepOthers.py).default_lakehouse, 'lh-test');

    const env = inWorkspace(FABRIC_CICD_HELLO_WORLD_PY, SOURCE);
    const { m, calls } = mapper(workspaces, settings({ upload: { environment: 'keep' } }));
    assert.strictEqual((await m.retarget(env)).py, env);
    assert.deepStrictEqual(calls, []);
  });

  test('a notebook with no dependencies is returned as it is', async () => {
    const { m, calls } = mapper({});
    const py = '# Fabric notebook source\n\n# CELL ********************\n\nprint(1)\n';
    assert.strictEqual((await m.retarget(py)).py, py);
    assert.deepStrictEqual(calls, []);
  });
});

suite('toSameWorkspace: saving references as "same workspace"', () => {
  const both = { defaultLakehouse: true, environment: true };

  test('writes the notebook’s own workspace as all zeros, for the kinds turned on', () => {
    const lakehouse = toSameWorkspace(FABRIC_CICD_EXAMPLE_PY, SOURCE, both);
    assert.strictEqual(lakehouseOf(lakehouse).default_lakehouse_workspace_id, SAME_WORKSPACE_ID);
    assert.deepStrictEqual(parseFabricPy(lakehouse).cells, parseFabricPy(FABRIC_CICD_EXAMPLE_PY).cells);

    const env = inWorkspace(FABRIC_CICD_HELLO_WORLD_PY, SOURCE);
    assert.strictEqual(toSameWorkspace(env, SOURCE.toUpperCase(), both), FABRIC_CICD_HELLO_WORLD_PY);
    assert.strictEqual(toSameWorkspace(env, SOURCE, { defaultLakehouse: true, environment: false }), env);
    assert.strictEqual(
      toSameWorkspace(FABRIC_CICD_EXAMPLE_PY, SOURCE, { defaultLakehouse: false, environment: true }),
      FABRIC_CICD_EXAMPLE_PY,
    );
  });

  test('leaves items in other workspaces, and notebooks without references, as they are', () => {
    assert.strictEqual(toSameWorkspace(FABRIC_CICD_EXAMPLE_PY, TARGET, both), FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(toSameWorkspace(SCRATCH2_TSQL_LAKEHOUSE_PY, TARGET, both), SCRATCH2_TSQL_LAKEHOUSE_PY);
  });
});
