import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOidcContext, assertManifest, cleanOidcEnvironment, withOidcEnvironment, publishOidc } from '../scripts/release.mjs';
import { assertReleaseSource } from '../scripts/check-release.mjs';

const pkg = { name: 'mattermost-mcp', version: '1.0.0', repository: { url: 'git+https://github.com/vanisoul/mattermost-mcp.git' }, publishConfig: { access: 'public' } };
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'vanisoul/mattermost-mcp', GITHUB_REF: 'refs/tags/v1.0.0',
  GITHUB_SHA: 'a'.repeat(40), RUNNER_ENVIRONMENT: 'github-hosted',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/test-oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-oidc-only',
};

test('OIDC 僅接受正式 repository、版本 Tag 與 GitHub-hosted runner', () => {
  assert.doesNotThrow(() => assertOidcContext(pkg, env));
  for (const patch of [
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/tags/v1.0.1' },
    { GITHUB_REPOSITORY: 'other/fork' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { GITHUB_SHA: '' },
  ]) assert.throws(() => assertOidcContext(pkg, { ...env, ...patch }));
});

test('本機發布只接受 main，CI 則接受 main 歷史中的正確 Tag', () => {
  assert.doesNotThrow(() => assertReleaseSource(pkg, { branch: 'main' }));
  assert.throws(() => assertReleaseSource(pkg, { branch: 'feat/test' }));
  const source = { ref: 'refs/tags/v1.0.0', head: env.GITHUB_SHA, sha: env.GITHUB_SHA, onMain: true, branch: '' };
  assert.doesNotThrow(() => assertReleaseSource(pkg, source));
  assert.throws(() => assertReleaseSource(pkg, { ...source, onMain: false }));
  assert.throws(() => assertReleaseSource(pkg, { ...source, ref: 'refs/tags/v1.0.1' }));
  assert.throws(() => assertReleaseSource(pkg, { ...source, head: 'b'.repeat(40) }));
  assert.throws(() => assertReleaseSource(pkg, { ...source, ref: 'refs/heads/main' }));
});

test('Artifact 必須符合 SHA-512、版本與來源 commit', () => {
  const bytes = Buffer.from('test-only-archive');
  const manifest = { name: pkg.name, version: pkg.version, repository: pkg.repository.url,
    filename: 'mattermost-mcp-1.0.0.tgz', sourceSha: env.GITHUB_SHA,
    sha512: createHash('sha512').update(bytes).digest('hex') };
  assert.doesNotThrow(() => assertManifest(pkg, manifest, bytes, env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, manifest, Buffer.from('tampered'), env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, { ...manifest, version: '9.0.0' }, bytes, env.GITHUB_SHA));
  assert.throws(() => assertManifest(pkg, manifest, bytes, 'b'.repeat(40)));
});

test('沿用成功案例，以 npm publish 發布已驗證 tarball，不使用 stage', async () => {
  const bytes = Buffer.from('test-only-archive');
  const manifest = {
    name: pkg.name, version: pkg.version, repository: pkg.repository.url,
    filename: 'mattermost-mcp-1.0.0.tgz', sourceSha: env.GITHUB_SHA,
    sha512: createHash('sha512').update(bytes).digest('hex'),
  };
  const archive = '/tmp/test-only/mattermost-mcp-1.0.0.tgz';
  let calls = 0;
  await publishOidc(pkg, manifest, bytes, archive, { ...env, NPM_TOKEN: 'test-only-secret' }, async (command, args, options) => {
    calls++;
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['publish', archive, '--access=public', '--registry=https://registry.npmjs.org/', '--ignore-scripts', '--provenance=true', '--json']);
    assert.equal(options.env.NPM_TOKEN, undefined);
    assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    assert.notEqual(options.cwd, process.cwd());
    assert.equal(await readFile(options.env.NPM_CONFIG_USERCONFIG, 'utf8'), 'registry=https://registry.npmjs.org/\n');
  });
  assert.equal(calls, 1);
  await assert.rejects(() => publishOidc(pkg, manifest, Buffer.from('tampered'), archive, env, async () => { calls++; }));
  assert.equal(calls, 1);
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
