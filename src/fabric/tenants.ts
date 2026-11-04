/**
 * Lists the Microsoft Entra tenants the signed-in user belongs to, using Azure Resource
 * Manager's Tenants API (https://learn.microsoft.com/rest/api/resources/tenants/list).
 * No `vscode` dependency, so it can be unit-tested offline like `FabricClient`.
 */

export const ARM_BASE_URL = 'https://management.azure.com';
const API_VERSION = '2022-12-01';

export interface Tenant {
  tenantId: string;
  displayName?: string;
  defaultDomain?: string;
}

interface TenantPage {
  value: Tenant[];
  nextLink?: string;
}

export async function listTenants(
  getToken: () => Promise<string>,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<Tenant[]> {
  const tenants: Tenant[] = [];
  let url: string | undefined = `${ARM_BASE_URL}/tenants?api-version=${API_VERSION}`;
  while (url) {
    // Never send the token anywhere but Azure Resource Manager.
    if (new URL(url).origin !== ARM_BASE_URL) {
      throw new Error(`Refusing to follow ${url}`);
    }
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`.trim();
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        detail = body.error?.message ?? detail;
      } catch {
        // Not JSON; keep the status line.
      }
      throw new Error(`Listing tenants failed: ${detail}`);
    }
    const page = (await response.json()) as TenantPage;
    tenants.push(
      ...(page.value ?? []).map(({ tenantId, displayName, defaultDomain }) => ({
        tenantId,
        displayName,
        defaultDomain,
      })),
    );
    url = page.nextLink;
  }
  return tenants;
}
