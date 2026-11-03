import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org/';
export const repository = 'vanisoul/mattermost-mcp';
const artifactDir = join(root, '.release');
const manifestFile = join(artifactDir, 'manifest.json');

export function assertOidcContext(pkg, env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository) throw new Error('OIDC 僅允許正式 GitHub repository。');
  if (env.GITHUB_REF !== `refs/tags/v${pkg.version}`) throw new Error('OIDC 發布 Tag 必須與 package.json 版本完全一致。');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('缺少有效的來源 commit SHA。');
  if (pkg.repository?.url !== `git+https://github.com/${repository}.git`) throw new Error('package.json repository.url 不符。');
  if (pkg.private || pkg.publishConfig?.access !== 'public') throw new Error('必須是明確允許公開發布的套件。');
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('OIDC 必須使用 GitHub-hosted runner。');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('缺少 OIDC 權限，請設定 id-token: write。');
}

export function assertManifest(pkg, manifest, bytes, sourceSha) {
  const filename = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
  if (manifest.filename !== filename || manifest.name !== pkg.name || manifest.version !== pkg.version
    || manifest.repository !== pkg.repository?.url) throw new Error('Artifact 中繼資料不符。');
  if (manifest.sha512 !== createHash('sha512').update(bytes).digest('hex')) throw new Error('Artifact SHA-512 不符，拒絕發布。');
  if (manifest.sourceSha !== sourceSha) throw new Error('Artifact 來源 commit 與目前 workflow 不符。');
}

export function cleanOidcEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key) && !/^(npm_token|node_auth_token)$/i.test(key)));
}

export async function withOidcEnvironment(env, action) {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-npm-oidc-'));
  try {
    const userconfig = join(directory, 'user.npmrc');
    const globalconfig = join(directory, 'global.npmrc');
    await writeFile(userconfig, `registry=${registry}\n`, { mode: 0o600 });
    await writeFile(globalconfig, '', { mode: 0o600 });
    return await action({ ...cleanOidcEnvironment(env), NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig }, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('npm 發布程序失敗。')));
  });
}

export async function publishOidc(pkg, manifest, bytes, archive, env = process.env, execute = run) {
  assertOidcContext(pkg, env);
  assertManifest(pkg, manifest, bytes, env.GITHUB_SHA);
  await withOidcEnvironment(env, (clean, cwd) => execute('npm', [
    'publish', archive, '--access=public', `--registry=${registry}`, '--ignore-scripts', '--provenance=true', '--json',
  ], { env: clean, cwd }));
}

async function main(mode) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const filename = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
  const archive = join(artifactDir, filename);
  if (mode === 'pack') {
    await mkdir(artifactDir, { recursive: true });
    await run('npm', ['pack', '--ignore-scripts', '--pack-destination', artifactDir]);
    await writeFile(manifestFile, JSON.stringify({
      name: pkg.name, version: pkg.version, repository: pkg.repository?.url, filename,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sha512: createHash('sha512').update(await readFile(archive)).digest('hex'),
    }, null, 2) + '\n');
  } else if (mode === 'publish-oidc') {
    assertOidcContext(pkg, process.env);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await publishOidc(pkg, manifest, await readFile(archive), archive);
  } else throw new Error('請指定 pack 或 publish-oidc。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
