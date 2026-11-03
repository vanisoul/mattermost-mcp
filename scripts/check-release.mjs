import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const ref = process.env.GITHUB_REF;
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const onMain = ref ? ref === 'refs/heads/main' : branch === 'main';
if (!onMain) throw new Error(`發布只能從 main 執行，目前 ref=${ref ?? '(local)'} branch=${branch || '(detached)'}`);
if (manifest.private === true) throw new Error('package.json 不得是 private package。');
if (manifest.name !== 'mattermost-mcp') throw new Error('套件名稱與預期不符。');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('發布版本必須是穩定的 semver，例如 0.1.0。');
if (manifest.repository?.url !== 'git+https://github.com/vanisoul/mattermost-mcp.git') throw new Error('repository.url 必須指向正式 GitHub repository。');
console.log(`release check passed: ${manifest.name}@${manifest.version} from main`);
