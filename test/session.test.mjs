import assert from 'node:assert/strict';
import test from 'node:test';
import { MattermostApi, SessionStore, normalizeServerUrl } from '../dist/session.js';

const root = `/tmp/mattermost-mcp-test-${process.pid}`;

test('normalizes secure Mattermost URL', () => {
  assert.equal(normalizeServerUrl('https://chat.webpat.co/'), 'https://chat.webpat.co');
  assert.throws(() => normalizeServerUrl('http://chat.webpat.co'));
  assert.throws(() => normalizeServerUrl('https://chat.webpat.co/path'));
});

test('stores and loads a session token', async () => {
  const store = new SessionStore('https://chat.webpat.co', root);
  await store.save('session-token');
  const loaded = await store.load();
  assert.equal(loaded?.serverUrl, 'https://chat.webpat.co');
  assert.equal(loaded?.token, 'session-token');
  assert.equal(typeof loaded?.createdAt, 'string');
  await store.clear();
});

test('does not expose tokens in API errors', async () => {
  const store = new SessionStore('https://chat.webpat.co', root);
  await store.save('secret-token');
  const api = new MattermostApi('https://chat.webpat.co', store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"status_code":401,"message":"Invalid token"}', { status: 401 });
  await assert.rejects(() => api.request('/users/me'), /Session 已失效/);
  globalThis.fetch = originalFetch;
  await store.clear();
});
