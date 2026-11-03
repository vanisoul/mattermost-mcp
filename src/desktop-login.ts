import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { browserSessionToken } from './login.js';
import { decodeTicket, type PairingTicket } from './pairing.js';
import { MattermostApi } from './session.js';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`缺少參數 ${name}`);
  return value;
}

const sshTarget = arg('--ssh');
const ticket = decodeTicket(arg('--ticket'));
const serverUrl = ticket.serverUrl;
if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/.test(sshTarget)) throw new Error('SSH 目標格式無效，請使用 user@hostname 或 SSH alias。');

function sshArgs(localPort: number, remotePort: number) {
  return ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', sshTarget];
}

async function freeLocalPort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('無法建立本機 SSH port forwarding。');
  return address.port;
}

async function postToken(port: number, token: string) {
  const body = JSON.stringify({ serverUrl, token });
  const response = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-Mattermost-Pairing-Nonce': ticket.nonce },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('遠端拒絕登入交接；配對可能已失效。');
}

const localPort = await freeLocalPort();
const ssh = spawn('ssh', sshArgs(localPort, ticket.port), { shell: false, stdio: 'inherit' });
let sshReady = true;
ssh.once('exit', () => { sshReady = false; });
await sleep(1200);
if (!sshReady) throw new Error('SSH port forwarding 建立失敗，請確認 SSH 認證與 AllowTcpForwarding 設定。');

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const api = new MattermostApi(serverUrl, { load: async () => undefined } as never);
  const token = await browserSessionToken(api, controller.signal, Date.parse(ticket.expiresAt), () => chromium.launch({ headless: false, timeout: 20_000 }));
  await postToken(localPort, token);
  console.log('Mattermost 登入完成，Session Token 已透過 SSH 傳送並由遠端驗證。');
} finally {
  controller.abort();
  if (ssh.exitCode === null) ssh.kill('SIGTERM');
}
