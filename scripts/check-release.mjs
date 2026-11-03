import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function assertReleaseSource(pkg, source) {
  if (pkg.private === true) throw new Error('package.json 不得是 private package。');
  if (pkg.name !== 'mattermost-mcp') throw new Error('套件名稱與預期不符。');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) throw new Error('發布版本必須是穩定的 semver，例如 1.0.0。');
  if (pkg.repository?.url !== 'git+https://github.com/vanisoul/mattermost-mcp.git') throw new Error('repository.url 必須指向正式 GitHub repository。');
  if (source.ref) {
    if (source.ref !== `refs/tags/v${pkg.version}`) throw new Error('發布 Tag 必須為 v 加上 package.json 的版本。');
    if (source.head !== source.sha) throw new Error('Checkout commit 與 workflow 來源 SHA 不符。');
    if (!source.onMain) throw new Error('發布 Tag 的 commit 必須已合併至 origin/main。');
  } else if (source.branch !== 'main') throw new Error('本機發布必須先切換至 main。');
}

async function main() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const ref = process.env.GITHUB_REF;
  const head = git('rev-parse', 'HEAD');
  let onMain = false;
  if (ref) {
    try {
      git('merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main');
      onMain = true;
    } catch { /* fetch-depth: 0 必須取得 main 歷史，否則拒絕發布。 */ }
  }
  assertReleaseSource(pkg, { ref, branch: git('branch', '--show-current'), head, sha: process.env.GITHUB_SHA, onMain });
  console.log(`發布來源驗證通過：${pkg.name}@${pkg.version}，來源 ${ref ?? 'main'}。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
