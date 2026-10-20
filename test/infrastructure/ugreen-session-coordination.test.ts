import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createUgreenSessionService, type SessionCache } from '../../src/infrastructure/ugreen/session-service';

function fixture(context: test.TestContext) {
  let now = 0;
  const values = new Map<string, { value: string; expires: number }>();
  const cache: SessionCache = {
    async get(key) {
      const entry = values.get(key);
      return entry && entry.expires > now ? entry.value : null;
    },
    async put(key, value, options) {
      values.set(key, { value, expires: now + (options?.expirationTtl ?? Infinity) });
    },
    async delete(key) { values.delete(key); }
  };
  const runtime = {
    uglinkId: 'test-device', username: 'test-user', password: 'test-password',
    sessionNamespace: 'test-coordination', cache
  };
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let mode = 'healthy';
  let logins = 0;
  let activeLogins = 0;
  let maximumLogins = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/nodeInfo/byAlias')) {
      if (mode === 'discovery-down') throw new TypeError('temporary discovery outage');
      return Response.json({ code: 200, data: { alias: 'test-device', relayDomain: 'example.ug.link' } });
    }
    if (url.endsWith('/desktop/')) return new Response(null, { status: 404 });
    if (url.endsWith('/verify/check')) {
      return new Response(null, { headers: { 'X-Rsa-Token': Buffer.from(publicKey).toString('base64') } });
    }
    if (url.endsWith('/verify/login')) {
      logins++;
      activeLogins++;
      maximumLogins = Math.max(maximumLogins, activeLogins);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeLogins--;
      if (mode === 'login-down') throw new TypeError('temporary login outage');
      if (mode === 'login-503') return new Response(null, { status: 503 });
      if (mode === 'locked') return Response.json({ code: 1120 });
      return Response.json({ code: 200, data: { token: 'fake-token', auth_type: 'url' } });
    }
    if (url.includes('/gateway/proxy/dockerToken?')) {
      return Response.json({ code: 200, data: { redirect_url: `https://proxy.example.test/auth/${logins}` } });
    }
    if (url.startsWith('https://proxy.example.test/auth/')) {
      return new Response(null, { status: 302, headers: {
        'Set-Cookie': `ugreen-proxy-token=session-${logins}; Path=/; Secure`
      } });
    }
    throw new Error('Unexpected upstream request');
  };
  return {
    service: createUgreenSessionService(runtime), runtime, cache,
    get logins() { return logins; }, get maximumLogins() { return maximumLogins; },
    set mode(value: string) { mode = value; },
    advance(seconds: number) { now += seconds; }
  };
}

test('concurrent cold requests share the established session instead of failing with backoff', async (context) => {
  const f = fixture(context);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.get('8317')));
  const sessions = results.map((result) => {
    assert.ok(result.status === 'fulfilled');
    return result.value;
  });
  assert.equal(f.logins, 1);
  assert.equal(new Set(sessions.map((session) => session.cookie)).size, 1);
});

test('different ports serialize login without rejecting either service', async (context) => {
  const f = fixture(context);
  const results = await Promise.allSettled([f.service.get('8317'), f.service.get('8080')]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(f.logins, 2);
  assert.equal(f.maximumLogins, 1);
});

test('a failed discovery does not leave a five-minute login reservation', async (context) => {
  const f = fixture(context);
  f.mode = 'discovery-down';
  await assert.rejects(f.service.get('8317'), /discovery failed/u);
  f.mode = 'healthy';
  assert.match((await f.service.get('8317')).cookie, /session-1/u);
});

for (const failure of ['login-down', 'login-503']) {
  test(`${failure} applies a short cooldown and recovers without waiting ten minutes`, async (context) => {
    const f = fixture(context);
    f.mode = failure;
    await assert.rejects(f.service.get('8317'));
    f.mode = 'healthy';
    await assert.rejects(f.service.get('8317'));
    assert.equal(f.logins, 1);
    f.advance(31);
    assert.match((await f.service.get('8317')).cookie, /session-2/u);
  });
}

test('account locks retain the thirty-minute cooldown across coordinator restarts', async (context) => {
  const f = fixture(context);
  f.mode = 'locked';
  await assert.rejects(f.service.get('8317'));
  f.mode = 'healthy';
  f.advance(31);
  await assert.rejects(createUgreenSessionService(f.runtime).get('8317'));
  assert.equal(f.logins, 1);
  f.advance(1800);
  await f.service.get('8317');
  assert.equal(f.logins, 2);
});

test('simultaneous stale-session refreshes reuse one replacement session', async (context) => {
  const f = fixture(context);
  const stale = await f.service.get('8317');
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.service.refresh('8317', stale)));
  const sessions = results.map((result) => {
    assert.ok(result.status === 'fulfilled');
    return result.value;
  });
  assert.equal(f.logins, 2);
  assert.equal(new Set(sessions.map((session) => session.cookie)).size, 1);
  assert.notEqual(sessions[0]?.cookie, stale.cookie);
});

test('an old failed request cannot invalidate a replacement session', async (context) => {
  const f = fixture(context);
  const stale = await f.service.get('8317');
  const fresh = await f.service.refresh('8317', stale);
  await f.service.invalidate('8317', stale);
  assert.deepEqual(await f.service.get('8317'), fresh);
  assert.equal(f.logins, 2);
});

test('legacy KV authentication reservations no longer control login', async (context) => {
  const f = fixture(context);
  await f.cache.put('uglink:auth-attempt:v1:test-coordination', 'stale-reservation');
  await f.service.get('8317');
  assert.equal(f.logins, 1);
});
