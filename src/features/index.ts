import type { Feature } from './feature';
import { fabricAuth } from './fabricAuth';
import { log } from './log';
import { notebooks } from './notebooks';
import { settings } from './settings';
import { workspace } from './workspace';

/** Every feature activated by the extension, in order. Register new features here. */
export const features: readonly Feature[] = [log, settings, fabricAuth, workspace, notebooks];
