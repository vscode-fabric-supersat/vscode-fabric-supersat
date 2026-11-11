// Errors carry their own fix (or say they're quiet), so reportError needn't know who threw them.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { AuthCancelledError, AuthError } from '../../auth/types';
import { FabricApiError } from '../../fabric/client';
import { isDeclined } from '../../auth/vscodeSession';
import { NotebookFormatError } from '../../notebooks/format';
import { ActionNeededError, fixOf, isQuiet, isWarning } from '../../util/errorFix';
import { continueSentence, describeError } from '../../util/errors';
import { YamlFileError } from '../../util/yamlFile';
import { LocalStateDirDeclinedError, requireProjectRoot } from '../../util/localState';
import { WorkspaceNameError } from '../../workspace/service';

suite('Error fixes', () => {
  test('each kind of error carries the fix reportError offers', () => {
    assert.deepStrictEqual(fixOf(new AuthError('x', { configureSignIn: true })), { configureSignIn: true });
    assert.deepStrictEqual(fixOf(new WorkspaceNameError('x')), { selectWorkspace: true });
    assert.strictEqual(fixOf(new FabricApiError(401, undefined, 'x'))?.configureSignIn, true);
    assert.strictEqual(fixOf(new FabricApiError(403, undefined, 'x'))?.selectWorkspace, true);
    assert.strictEqual(fixOf(new FabricApiError(404, undefined, 'x'))?.selectWorkspace, true);
    assert.strictEqual(fixOf(new FabricApiError(500, undefined, 'x')), undefined);
    assert.strictEqual(fixOf(new Error('x')), undefined);
    assert.strictEqual(fixOf('not an error'), undefined);
  });

  test('cancelling sign-in, or declining the .fabric-supersat folder, is quiet: logged, not shown as a failure', () => {
    assert.ok(isQuiet(new AuthCancelledError()));
    assert.ok(isQuiet(new LocalStateDirDeclinedError(vscode.Uri.parse('file:///p/.fabric-supersat'))));
    assert.ok(!isQuiet(new AuthError('x')));
    assert.ok(!isQuiet(new Error('x')));
  });

  test('something to do first (open a folder or a notebook) is a warning: shown, and logged without a stack trace', () => {
    assert.ok(isWarning(new ActionNeededError('Open a notebook first.')));
    // The test host has no folder open.
    assert.throws(() => requireProjectRoot('upload notebooks from'), (err: unknown) => isWarning(err) && !isQuiet(err));
    assert.ok(!isWarning(new Error('x')));
  });

  test('what the user sees to is a warning; unexpected problems (bugs, Fabric failures) are errors', () => {
    const uri = vscode.Uri.parse('file:///p/src/fabric-supersat.yaml');
    for (const err of [
      new AuthError('User did not consent to login.'),
      new AuthError('Sign in to the Azure CLI first.'),
      new WorkspaceNameError('No Fabric workspace you can access is named "Sales".'),
      new FabricApiError(401, 'TokenExpired', 'x'),
      new FabricApiError(403, 'InsufficientPrivileges', 'x'),
      new NotebookFormatError('Not a valid .ipynb: no "cells" list.'),
      new YamlFileError(uri, 'bad'),
      new ActionNeededError('x'),
    ]) {
      assert.strictEqual(describeError('X', err).level, 'warn', `${err.name}: ${err.message}`);
    }
    for (const err of [
      new AuthError('Azure CLI: something odd', {}, { unexpected: true }),
      new FabricApiError(404, 'ItemNotFound', 'x'),
      new FabricApiError(500, undefined, 'x'),
      new FabricApiError(0, 'OperationFailed', 'x'),
      new TypeError('Cannot read properties of undefined'),
      new Error('x'),
    ]) {
      assert.strictEqual(describeError('X', err).level, 'error', `${err.name}: ${err.message}`);
    }
    assert.strictEqual(describeError('X', new AuthCancelledError()).level, 'info');
  });

  test('warnings say the command could not proceed, continuing the sentence; errors say it failed', () => {
    assert.strictEqual(
      describeError('Download All Notebooks', new AuthError('User did not consent to login.')).text,
      'Download All Notebooks could not proceed: user did not consent to login.',
    );
    assert.strictEqual(
      describeError('Download Notebook', new WorkspaceNameError('No Fabric workspace you can access is named "Sales".')).text,
      'Download Notebook could not proceed: no Fabric workspace you can access is named "Sales".',
    );
    assert.strictEqual(describeError('Download Notebook', new Error('Boom')).text, 'Download Notebook failed: Boom');
    // A fix's hint follows the message.
    assert.match(describeError('Download Notebook', new FabricApiError(401, undefined, 'Unauthorized')).text, /could not proceed: unauthorized\. Your sign-in may have expired/);
  });

  test('a message continuing a sentence keeps the capitals of names, file names and paths', () => {
    assert.strictEqual(continueSentence('User did not consent.'), 'user did not consent.');
    assert.strictEqual(continueSentence('Fabric returned nothing.'), 'Fabric returned nothing.');
    assert.strictEqual(continueSentence('Azure CLI: x'), 'Azure CLI: x');
    assert.strictEqual(continueSentence('Load.py isn\'t a Fabric notebook'), 'Load.py isn\'t a Fabric notebook');
    assert.strictEqual(continueSentence('src/Notebooks/A/A.py has unsaved changes'), 'src/Notebooks/A/A.py has unsaved changes');
    assert.strictEqual(continueSentence('VS Code sign-in'), 'VS Code sign-in');
    assert.strictEqual(continueSentence('"Sales" is gone'), '"Sales" is gone');
  });

  test('declining or cancelling VS Code sign-in is recognised, so it is a warning', () => {
    assert.ok(isDeclined(new Error('User did not consent to login.')));
    assert.ok(isDeclined(new Error('Cancelled')));
    assert.ok(!isDeclined(new Error('AADSTS65002: consent required')));
    assert.ok(!isDeclined('User did not consent to login.'));
  });
});
