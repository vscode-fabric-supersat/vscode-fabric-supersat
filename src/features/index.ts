import { environments } from './environments';
import { environmentTools } from './environmentTools';
import { fabricDataEngineering } from './fabricDataEngineering';
import type { Feature } from './feature';
import { fabricAuth } from './fabricAuth';
import { log } from './log';
import { notebooks } from './notebooks';
import { notebookSync } from './notebookSync';
import { settings } from './settings';
import { workspace } from './workspace';
import { workspaceSync } from './workspaceSync';
import { workspaceTools } from './workspaceTools';

/** Every feature activated by the extension, in order. Register new features here. */
export const features: readonly Feature[] = [log, settings, fabricAuth, workspace, notebookSync, notebooks, workspaceTools, workspaceSync, environments, environmentTools, fabricDataEngineering];
