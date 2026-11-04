// Web entry point (package.json "browser"). Runs in a web worker: no Node.js APIs.
import { createExtension } from '../extension';

export const { activate, deactivate } = createExtension({
  name: 'web',
  platformTokenProviders: () => [],
});
