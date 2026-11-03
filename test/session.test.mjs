import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MattermostApi, SessionStore, normalizeServerUrl } from '../dist/session.js';

const SITE = 'https://mattermost.example.com';

test('normalizes secure Mattermost URL', () => {
  assert.equal(normalizeServerUrl(`${SITE}/`), SITE);
  assert.throws(() => normalizeServerUrl('http://mattermost.example.com'));
  assert.throws(() => normalizeServerUrl(`${SITE}/path`));
});

test('stores and loads a session token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mattermost-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(SITE, root);
  await store.save('test-session-token');
  const loaded = await store.load();
  assert.equal(loaded?.serverUrl, SITE);
  assert.equal(loaded?.token, 'test-session-token');
  assert.equal(typeof loaded?.createdAt, 'string');
  await store.clear();
});

test('does not expose tokens in API errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mattermost-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(SITE, root);
  await store.save('test-secret-token');
  const api = new MattermostApi(SITE, store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"status_code":401,"message":"Invalid token"}', { status: 401 });
  try { await assert.rejects(() => api.request('/users/me'), /Session 已失效/); }
  finally { globalThis.fetch = originalFetch; }
});
