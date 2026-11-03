import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { normalizeServerUrl } from './session.js';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`缺少參數 ${name}`);
  return value;
}

const serverUrl = normalizeServerUrl(process.env.MATTERMOST_URL ?? 'https://chat.webpat.co');
const sshTarget = arg('--ssh');
const remotePort = Number(arg('--remote-port'));
const nonce = arg('--nonce');
if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('remote-port 無效');

const callbackServer = createServer();
await new Promise<void>((resolve, reject) => {
  callbackServer.once('error', reject);
  callbackServer.listen(0, '127.0.0.1', resolve);
});
const address = callbackServer.address();
if (!address || typeof address === 'string') throw new Error('無法建立本機 callback port');
const localPort = address.port;

const ssh = spawn('ssh', ['-o', 'ExitOnForwardFailure=yes', '-o', 'LogLevel=ERROR', '-N', '-R', `${remotePort}:127.0.0.1:${localPort}`, sshTarget], { stdio: ['ignore', 'ignore', 'pipe'] });
let sshError = '';
ssh.stderr.on('data', (chunk) => { sshError += String(chunk); });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, 1500);
  ssh.once('error', reject);
  ssh.once('exit', (code) => { if (code !== null && code !== 0) reject(new Error(sshError || `ssh exited with ${code}`)); });
  timer.unref();
});

const context: BrowserContext = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'mattermost-login-')), { headless: false, viewport: { width: 1440, height: 900 } });
const candidates = new Set<string>();
context.on('response', (response) => {
  if (new URL(response.url()).origin !== serverUrl) return;
  const token = response.headers()['token'];
  if (token) candidates.add(token);
});
const page = await context.newPage();
await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

let sent = false;
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline && !sent) {
  const cookie = (await context.cookies(serverUrl)).find((item) => item.name === 'MMSID');
  const token = cookie?.value ?? [...candidates][0];
  if (token) {
    const response = await fetch(`http://127.0.0.1:${localPort}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mattermost-Pairing-Nonce': nonce },
      body: JSON.stringify({ token }),
    });
    if (response.ok) sent = true;
  }
  if (!sent) await new Promise((resolve) => setTimeout(resolve, 1500));
}
await context.close();
ssh.kill('SIGTERM');
callbackServer.close();
if (!sent) throw new Error('登入逾時，未能完成 Session Token 交接。');
console.log('Mattermost 登入完成，Session Token 已透過 SSH 傳送並由遠端驗證。');
