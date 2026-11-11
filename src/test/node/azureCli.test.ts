// Desktop-only tests: the Azure CLI provider with a fake `az` (nothing is executed).
import * as assert from 'assert';
import { AuthError } from '../../auth/types';
import { AzureCliTokenProvider, loginCommand, type ExecFn } from '../../node/azureCli';
import { fakeJwt, nowSeconds } from '../suite/jwtHelper';

function fakeAz(results: (string | Error)[]) {
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    const next = results.shift();
    if (next === undefined) {
      throw new Error('unexpected az call');
    }
    if (next instanceof Error) {
      throw next;
    }
    return { stdout: next, stderr: '' };
  };
  return { exec, calls };
}

const azOutput = (token: string, expiresOn = nowSeconds() + 3600) =>
  JSON.stringify({ accessToken: token, expires_on: expiresOn, tokenType: 'Bearer' });

const azError = (stderr: string, code: unknown = 1) => Object.assign(new Error('Command failed'), { code, stderr });

suite('AzureCliTokenProvider', () => {
  test('runs az for the Fabric resource and caches the token', async () => {
    const token = fakeJwt({ upn: 'ada@contoso.com' });
    const { exec, calls } = fakeAz([azOutput(token)]);
    const provider = new AzureCliTokenProvider({ getTenant: () => '', exec });

    assert.strictEqual(await provider.getToken('fabric'), token);
    assert.strictEqual(await provider.getToken('fabric'), token);
    assert.deepStrictEqual(calls, [
      ['az', 'account', 'get-access-token', '--resource', 'https://api.fabric.microsoft.com', '--output', 'json'],
    ]);
  });

  test('passes the tenant, and uses the ARM resource for tenant listing', async () => {
    const { exec, calls } = fakeAz([azOutput('t')]);
    await new AzureCliTokenProvider({ getTenant: () => 'contoso.onmicrosoft.com', exec }).getToken('arm');
    assert.deepStrictEqual(calls[0].slice(-4), ['--output', 'json', '--tenant', 'contoso.onmicrosoft.com']);
    assert.strictEqual(calls[0][4], 'https://management.azure.com');
  });

  test('refreshes tokens that expire within five minutes', async () => {
    const { exec, calls } = fakeAz([azOutput('old', nowSeconds() + 120), azOutput('new')]);
    const provider = new AzureCliTokenProvider({ getTenant: () => '', exec });
    assert.strictEqual(await provider.getToken('fabric'), 'old');
    assert.strictEqual(await provider.getToken('fabric'), 'new');
    assert.strictEqual(calls.length, 2);
  });

  test('sign in reports the account from the token', async () => {
    const { exec } = fakeAz([azOutput(fakeJwt({ upn: 'ada@contoso.com' }))]);
    assert.strictEqual(await new AzureCliTokenProvider({ getTenant: () => '', exec }).signIn(), 'ada@contoso.com');
  });

  test('rejects unsafe tenant values before running anything', async () => {
    const { exec, calls } = fakeAz([]);
    await assert.rejects(new AzureCliTokenProvider({ getTenant: () => 'x & calc', exec }).getToken('fabric'), AuthError);
    assert.strictEqual(calls.length, 0);
  });

  test('not installed: offers the install page', async () => {
    const { exec } = fakeAz([azError('', 'ENOENT')]);
    await assert.rejects(new AzureCliTokenProvider({ getTenant: () => '', exec }).getToken('fabric'), (err: AuthError) => {
      assert.match(err.message, /isn't installed/);
      assert.strictEqual(err.fix.link?.label, 'Install Azure CLI');
      return true;
    });
  });

  test('not logged in: offers az login (with the tenant)', async () => {
    const { exec } = fakeAz([azError("ERROR: Please run 'az login' to setup account.")]);
    await assert.rejects(new AzureCliTokenProvider({ getTenant: () => 'tid', exec }).getToken('fabric'), (err: AuthError) => {
      assert.match(err.message, /Please run 'az login'/);
      assert.strictEqual(err.fix.terminalCommand, 'az login --tenant tid --allow-no-subscriptions');
      return true;
    });
  });

  test('uses the az login command the CLI suggests, if it is safe', async () => {
    const stderr = [
      'ERROR: AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.',
      'Run the command below to authenticate interactively; additional arguments may be added as needed:',
      'az login --tenant "00000000-0000-0000-0000-000000000001" --scope "https://api.fabric.microsoft.com/.default"',
    ].join('\n');
    const { exec } = fakeAz([azError(stderr)]);
    await assert.rejects(new AzureCliTokenProvider({ getTenant: () => '', exec }).getToken('fabric'), (err: AuthError) => {
      assert.strictEqual(
        err.fix.terminalCommand,
        'az login --tenant "00000000-0000-0000-0000-000000000001" --scope "https://api.fabric.microsoft.com/.default" --allow-no-subscriptions',
      );
      return true;
    });
  });

  test('ignores suggested commands with shell metacharacters', async () => {
    const { exec } = fakeAz([azError("ERROR: run 'az login'\naz login; rm -rf ~")]);
    await assert.rejects(new AzureCliTokenProvider({ getTenant: () => '', exec }).getToken('fabric'), (err: AuthError) => {
      assert.strictEqual(err.fix.terminalCommand, 'az login --allow-no-subscriptions');
      return true;
    });
  });

  test('remote / browser-based hosts get --use-device-code', async () => {
    const { exec } = fakeAz([azError("ERROR: Please run 'az login' to setup account.")]);
    const provider = new AzureCliTokenProvider({ getTenant: () => 'tid', exec, preferDeviceCode: true });
    await assert.rejects(provider.getToken('fabric'), (err: AuthError) => {
      assert.strictEqual(err.fix.terminalCommand, 'az login --tenant tid --use-device-code --allow-no-subscriptions');
      return true;
    });
  });
});

suite('loginCommand', () => {
  test('does not repeat flags the CLI already suggested', () => {
    assert.strictEqual(
      loginCommand('az login --use-device-code --allow-no-subscriptions', '', true),
      'az login --use-device-code --allow-no-subscriptions',
    );
  });

  test('local desktop: browser sign-in, still allowing no subscriptions', () => {
    assert.strictEqual(loginCommand(undefined, '', false), 'az login --allow-no-subscriptions');
  });
});
