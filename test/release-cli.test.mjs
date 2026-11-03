import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('release CLI 真正呼叫 npm publish，隔離憑證並拒絕遭竄改 artifact', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mattermost-release-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['scripts', '.release', 'bin'].map((name) => mkdir(join(root, name))));
  const pkg = {
    name: 'mattermost-mcp', version: '1.0.0', type: 'module', publishConfig: { access: 'public' },
    repository: { url: 'git+https://github.com/vanisoul/mattermost-mcp.git' },
  };
  const script = join(root, 'scripts', 'release.mjs');
  await copyFile(new URL('../scripts/release.mjs', import.meta.url), script);
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  const bytes = Buffer.from('test-only archive, never sent to npm');
  const filename = 'mattermost-mcp-1.0.0.tgz';
  const archive = join(root, '.release', filename);
  await writeFile(archive, bytes);
  await writeFile(join(root, '.release', 'manifest.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, repository: pkg.repository.url, filename,
    sourceSha: 'a'.repeat(40), sha512: createHash('sha512').update(bytes).digest('hex'),
  }));
  const capture = join(root, 'capture.json');
  // 可執行的 Node.js 測試替身；不會執行真的 npm 或建立網路連線。
  await writeFile(join(root, 'bin', 'npm'), `#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  hasLongToken: Boolean(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN),
  hasOidc: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
  userConfig: readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8'),
  globalConfig: readFileSync(process.env.NPM_CONFIG_GLOBALCONFIG, 'utf8'),
}));
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, TEST_CAPTURE: capture,
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'vanisoul/mattermost-mcp', GITHUB_REF: 'refs/tags/v1.0.0',
    GITHUB_SHA: 'a'.repeat(40), RUNNER_ENVIRONMENT: 'github-hosted',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only-oidc',
    NPM_TOKEN: 'test-only-long-token', NODE_AUTH_TOKEN: 'test-only-long-token',
  };
  await exec(process.execPath, [script, 'publish-oidc'], { cwd: root, env });
  const result = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(result.args, ['publish', archive, '--access=public', '--registry=https://registry.npmjs.org/', '--ignore-scripts', '--provenance=true', '--json']);
  assert.equal(result.hasLongToken, false);
  assert.equal(result.hasOidc, true);
  assert.equal(result.userConfig, 'registry=https://registry.npmjs.org/\n');
  assert.equal(result.globalConfig, '');
  assert.notEqual(result.cwd, root);
  await assert.rejects(() => readFile(join(result.cwd, 'user.npmrc')), { code: 'ENOENT' });

  await rm(capture);
  await writeFile(archive, 'tampered');
  await assert.rejects(() => exec(process.execPath, [script, 'publish-oidc'], { cwd: root, env }), /SHA-512/);
  await assert.rejects(() => readFile(capture), { code: 'ENOENT' });
});
