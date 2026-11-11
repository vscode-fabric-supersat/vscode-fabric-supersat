import { Commands } from '../constants';
import { getLogger } from '../util/logger';
import type { Feature } from './feature';
import { registerCommand } from '../util/commands';

export const log: Feature = {
  name: 'log',
  activate(context) {
    context.subscriptions.push(
      registerCommand(Commands.showLog, 'Show Log', () => getLogger().show()),
    );
  },
};
