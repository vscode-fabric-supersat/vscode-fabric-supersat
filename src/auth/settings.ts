/**
 * Sign-in settings: the method, the app registration's client ID and the tenant.
 *
 * These are deliberately NOT VS Code settings and never come from any `settings.json`
 * or `settings.yaml`: a folder's `.vscode/settings.json` (or a committed settings file)
 * could otherwise point sign-in at another tenant or app registration. They live in the
 * extension's global state, on this machine only, and change only through the
 * "Configure Sign-In" command, which validates them.
 */
import type * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { AuthMethod } from './types';

export type AuthMethodSetting = AuthMethod | 'auto';

export interface AuthSettings {
  readonly method: AuthMethodSetting;
  /** Application (client) ID of the user's Entra app registration ('' when not set). */
  readonly clientId: string;
  /** Tenant ID or domain ('' for the default tenant). */
  readonly tenant: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = { method: 'auto', clientId: '', tenant: '' };

export const AUTH_METHOD_SETTINGS: readonly AuthMethodSetting[] = ['auto', 'azureCli', 'vscode', 'token'];

/** Tenant IDs and domains only; keeps the value safe as a command-line argument and in sign-in scopes. */
export const SAFE_TENANT = /^[A-Za-z0-9.-]{1,256}$/;
/** Entra application (client) IDs are GUIDs. */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_KEY = `${ID_PREFIX}.authSettings`;

type Store = Pick<vscode.Memento, 'get' | 'update'>;
let store: Store | undefined;

/** Called once at activation with `context.globalState` (tests pass an in-memory store). */
export function initAuthSettings(memento: Store | undefined): void {
  store = memento;
}

/** An error message for an invalid client ID, or `undefined` if it's fine ('' clears it). */
export function validateClientId(value: string): string | undefined {
  return value === '' || CLIENT_ID.test(value)
    ? undefined
    : 'Enter the Application (client) ID, a GUID such as 00000000-0000-0000-0000-000000000000.';
}

/** An error message for an invalid tenant, or `undefined` if it's fine ('' means the default tenant). */
export function validateTenant(value: string): string | undefined {
  return value === '' || SAFE_TENANT.test(value)
    ? undefined
    : 'Enter a tenant ID or domain, such as contoso.onmicrosoft.com.';
}

/** The current sign-in settings. Anything stored that isn't valid is ignored. */
export function getAuthSettings(): AuthSettings {
  const raw = store?.get<Partial<Record<keyof AuthSettings, unknown>>>(STATE_KEY) ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const method = AUTH_METHOD_SETTINGS.find((m) => m === raw.method) ?? DEFAULT_AUTH_SETTINGS.method;
  const clientId = str(raw.clientId);
  const tenant = str(raw.tenant);
  return {
    method,
    clientId: validateClientId(clientId) ? '' : clientId,
    tenant: validateTenant(tenant) ? '' : tenant,
  };
}

/** Changes some sign-in settings. Throws if a value isn't valid. */
export async function updateAuthSettings(changes: Partial<AuthSettings>): Promise<AuthSettings> {
  if (!store) {
    throw new Error('Sign-in settings are not available yet.');
  }
  const next = { ...getAuthSettings(), ...changes };
  next.clientId = next.clientId.trim();
  next.tenant = next.tenant.trim();
  const problem =
    (!AUTH_METHOD_SETTINGS.includes(next.method) ? `"${next.method}" is not a sign-in method.` : undefined) ??
    validateClientId(next.clientId) ??
    validateTenant(next.tenant);
  if (problem) {
    throw new Error(problem);
  }
  await store.update(STATE_KEY, next);
  return next;
}
