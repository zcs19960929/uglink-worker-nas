import { afterEach, expect, it, vi } from 'vitest';
import { uploadProxyWorker } from '../../src/infrastructure/cloudflare/api-client';

afterEach(() => { vi.unstubAllGlobals(); });

for (const existing of [false, true]) {
  it(`${existing ? 'reuses' : 'creates'} the coordinator while preserving existing migration history`, async () => {
    let metadata: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        metadata = JSON.parse(await ((init.body as FormData).get('metadata') as Blob).text());
        return Response.json({ success: true, result: { deployment_id: 'deployment-id' } });
      }
      return Response.json({ success: true, result: {
        migration_tag: existing ? 'uglink-sessions-v1' : 'earlier-migration',
        bindings: existing ? [{
          name: 'UGLINK_SESSIONS', type: 'durable_object_namespace', class_name: 'UgreenSessionCoordinator'
        }] : []
      } });
    }));
    await uploadProxyWorker('test-token', {
      accountId: 'test-account', accountName: 'Test account', workerName: 'test-worker'
    }, {
      version: 2, uglink: { id: 'test-device', username: 'test-user' }, services: []
    }, { id: 'test-namespace', title: 'Test namespace' });
    expect(metadata.migrations).toEqual(existing ? undefined : {
      old_tag: 'earlier-migration', new_tag: 'uglink-sessions-v1',
      new_sqlite_classes: ['UgreenSessionCoordinator']
    });
    expect(metadata.bindings).toContainEqual({
      name: 'UGLINK_SESSIONS', type: 'durable_object_namespace', class_name: 'UgreenSessionCoordinator'
    });
  });
}
