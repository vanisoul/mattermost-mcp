import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOidcContext, assertManifest, cleanOidcEnvironment, withOidcEnvironment } from '../scripts/release.mjs';

const pkg = { name: 'mattermost-mcp', version: '0.1.0', repository: { url: 'git+https://github.com/vanisoul/mattermost-mcp.git' }, publishConfig: { access: 'public' } };
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'vanisoul/mattermost-mcp', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), RUNNER_ENVIRONMENT: 'github-hosted',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/test-oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-oidc-only',
};

test('OIDC 僅接受正式 repository、main 與 GitHub-hosted runner', () => {
  assert.doesNotThrow(() => assertOidcContext(pkg, env));
  for (const patch of [
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/v0.1.0' },
    { GITHUB_REPOSITORY: 'other/fork' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { GITHUB_SHA: '' },
  ]) assert.throws(() => assertOidcContext(pkg, { ...env, ...patch }));
});

test('Artifact 必須符合 SHA-512、版本與來源 commit', () => {
  const bytes = Buffer.from('test-only-archive');
  const manifest = { name: pkg.name, version: pkg.version, repository: pkg.repository.url,
    filename: 'mattermost-mcp-0.1.0.tgz', sourceSha: env.GITHUB_SHA,
    sha512: createHash('sha512').update(bytes).digest('hex') };
  assert.doesNotThrow(() => assertManifest(pkg, manifest, bytes, env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, manifest, Buffer.from('tampered'), env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, { ...manifest, version: '9.0.0' }, bytes, env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, manifest, bytes, 'b'.repeat(40)));
});

test('OIDC 環境移除長效 npm Token 與所有 npm_config 覆寫', () => {
  const cleaned = cleanOidcEnvironment({ ...env, NPM_TOKEN: 'test-only-secret', node_auth_token: 'test-only-secret',
    npm_config_registry: 'https://example.com', NPM_CONFIG_USERCONFIG: '/tmp/not-used' });
  assert.equal(cleaned.NPM_TOKEN, undefined);
  assert.equal(cleaned.node_auth_token, undefined);
  assert.equal(cleaned.npm_config_registry, undefined);
  assert.equal(cleaned.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(cleaned.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
});

test('OIDC 使用獨立 npm 設定與工作目錄，結束後清除', async () => {
  let temporary;
  await withOidcEnvironment({ ...env, NPM_TOKEN: 'test-only-secret' }, async (cleaned, directory) => {
    temporary = directory;
    assert.equal(cleaned.NPM_TOKEN, undefined);
    assert.equal(await readFile(cleaned.NPM_CONFIG_USERCONFIG, 'utf8'), 'registry=https://registry.npmjs.org/\n');
    assert.equal(await readFile(cleaned.NPM_CONFIG_GLOBALCONFIG, 'utf8'), '');
    assert.equal(join(directory, 'user.npmrc'), cleaned.NPM_CONFIG_USERCONFIG);
  });
  await assert.rejects(() => readFile(join(temporary, 'user.npmrc')), { code: 'ENOENT' });
});
