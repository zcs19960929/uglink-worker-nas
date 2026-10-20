import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Miniflare, Request, Response, type MiniflareOptions } from 'miniflare';

async function runtime(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'uglink-sessions-'));
  const script = await readFile('.generated/gateway/entry.js', 'utf8');
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  let mode = 'healthy';
  let loginCalls = 0;
  let proxyCalls = 0;
  let activeLogins = 0;
  let maximumLogins = 0;
  const options: MiniflareOptions = {
    modules: true, script, compatibilityDate: '2026-08-03', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      UGLINK_ID: 'test-device', USERNAME: 'test-user', PASSWORD: 'test-password',
      SESSION_NAMESPACE: 'runtime-test', SETUP_MODE: 'false',
      SERVICE_MAP: '{"service.example.com":"8317","other.example.com":"8080"}'
    },
    durableObjects: { UGLINK_SESSIONS: { className: 'UgreenSessionCoordinator', useSQLite: true } },
    resourcePersistencePath: directory, kvNamespaces: ['UGLINK_CACHE'],
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.includes('/nodeInfo/byAlias')) {
        if (mode === 'discovery-down') return new Response(null, { status: 503 });
        return Response.json({ code: 200, data: { alias: 'test-device', relayDomain: 'example.ug.link' } });
      }
      if (url.pathname === '/desktop/') return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/verify/check')) {
        return new Response(null, { headers: { 'X-Rsa-Token': Buffer.from(publicKey).toString('base64') } });
      }
      if (url.pathname.endsWith('/verify/login')) {
        loginCalls++;
        activeLogins++;
        maximumLogins = Math.max(maximumLogins, activeLogins);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeLogins--;
        if (mode === 'locked') return Response.json({ code: 1120 });
        return Response.json({ code: 200, data: { token: 'fake-token', auth_type: 'url' } });
      }
      if (url.pathname.endsWith('/gateway/proxy/dockerToken')) {
        return Response.json({ code: 200, data: { redirect_url: `https://proxy.example.test/auth/${loginCalls}` } });
      }
      if (url.pathname.startsWith('/auth/')) {
        return new Response(null, { status: 302, headers: {
          'Set-Cookie': `ugreen-proxy-token=session-${loginCalls}; Path=/; Secure`
        } });
      }
      assert.equal(url.hostname, 'proxy.example.test');
      proxyCalls++;
      if (mode === 'expired' && request.headers.get('cookie')?.includes('session-1')) {
        return new Response(null, { status: 302, headers: {
          Location: 'https://test-device.example.ug.link/desktop/#/login/account'
        } });
      }
      if (mode === 'app-503') {
        mode = 'healthy';
        return new Response('temporary outage', { status: 503 });
      }
      return new Response('application');
    }
  };
  let worker = new Miniflare(options);
  await worker.ready;
  context.after(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  return {
    get logins() { return loginCalls; }, get proxyCalls() { return proxyCalls; },
    get maximumLogins() { return maximumLogins; },
    set mode(value: string) { mode = value; },
    async request(host = 'service.example.com', method = 'GET') {
      const response = await worker.dispatchFetch(`https://${host}/api/data`, {
        method, ...(method === 'POST' ? { body: 'one write' } : {})
      });
      const body = await response.text();
      return { status: response.status, error: response.headers.get('X-UGLINK-Error'), body };
    },
    async restart() { await worker.dispose(); worker = new Miniflare(options); }
  };
}

test('Workers runtime shares cold logins and refreshes across independent HTTP requests', async (context) => {
  const f = await runtime(context);
  const cold = await Promise.all(Array.from({ length: 6 }, () => f.request()));
  assert.ok(cold.every((response) => response.status === 200));
  assert.equal(f.logins, 1);
  f.mode = 'expired';
  const refreshed = await Promise.all(Array.from({ length: 6 }, () => f.request()));
  assert.ok(refreshed.every((response) => response.status === 200));
  assert.equal(f.logins, 2);
  assert.equal(f.maximumLogins, 1);
  await f.restart();
  assert.equal((await f.request()).status, 200);
  assert.equal(f.logins, 2, 'a restarted object must reuse its persisted session');
});

test('Workers runtime serializes different ports and recovers immediately after discovery failure', async (context) => {
  const f = await runtime(context);
  f.mode = 'discovery-down';
  assert.equal((await f.request()).status, 502);
  f.mode = 'healthy';
  const responses = await Promise.all([f.request(), f.request('other.example.com')]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(f.logins, 2);
  assert.equal(f.maximumLogins, 1);
});

test('Workers runtime preserves account-lock errors and cooldown across RPC and restarts', async (context) => {
  const f = await runtime(context);
  f.mode = 'locked';
  assert.deepEqual(await f.request(), {
    status: 502, error: 'account_locked', body: 'Upstream proxy request failed'
  });
  f.mode = 'healthy';
  await f.restart();
  assert.equal((await f.request()).error, 'account_locked');
  assert.equal(f.logins, 1);
});

test('Workers runtime retries a transient GET once and does not replay POST', async (context) => {
  const f = await runtime(context);
  await f.request();
  f.mode = 'app-503';
  assert.equal((await f.request()).status, 200);
  assert.equal(f.proxyCalls, 3);
  assert.equal(f.logins, 1);
  f.mode = 'app-503';
  assert.equal((await f.request('service.example.com', 'POST')).status, 503);
  assert.equal(f.proxyCalls, 4);
});
