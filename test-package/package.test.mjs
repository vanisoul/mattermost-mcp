import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('npm package manifest is publishable', async () => {
  assert.equal(manifest.name, 'mattermost-mcp');
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.bin['mattermost-mcp'], 'dist/cli.js');
  assert.equal(manifest.bin['mattermost-mcp-login'], 'dist/desktop-login.js');
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'examples']);
  const version = await exec(process.execPath, ['dist/cli.js', '--version'], { cwd: root });
  assert.equal(version.stdout.trim(), manifest.version);
});

test('CLI does not embed a private Mattermost URL', async () => {
  const help = await exec(process.execPath, ['dist/cli.js', '--help'], { cwd: root });
  assert.match(help.stdout, /MATTERMOST_URL/);
  assert.match(help.stdout, /https:\/\/mattermost\.example\.com/);
});
