#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { browserSessionToken } from './login.js';
import { decodeTicket, type PairingTicket } from './pairing.js';
import { MattermostApi, SessionStore } from './session.js';

async function freeLocalPort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('無法配置本機 SSH 連接埠。');
  return address.port;
}

async function checkReceiver(port: number, ticket: PairingTicket, signal: AbortSignal) {
  const deadline = Math.min(Date.now() + 60_000, Date.parse(ticket.expiresAt));
  while (!signal.aborted && Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/pairing`, {
      headers: { 'X-Mattermost-Pairing-Nonce': ticket.nonce }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    }).catch(() => undefined);
    if (response) {
      if (!response.ok) throw new Error('配對碼無效或已失效，未傳送任何 Token。');
      const data = await response.json() as Record<string, unknown>;
      if (data.serverUrl !== ticket.serverUrl || data.expiresAt !== ticket.expiresAt) {
        throw new Error('登入接收端與配對資料不符，未傳送任何 Token。');
      }
      return;
    }
    await sleep(500, undefined, { signal });
  }
  throw new Error('無法連線登入接收端，請確認 MCP、SSH 認證及 port forwarding 設定。');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'login') argv.shift();
  const { values } = parseArgs({
    args: argv, options: { ssh: { type: 'string' }, ticket: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('用法：mattermost-mcp-login [--ssh user@hostname] --ticket CODE\n先呼叫 mattermost_login 取得配對碼。瀏覽器必須在有桌面的本機執行。');
    return;
  }
  if (!values.ticket) throw new Error('缺少 --ticket，請先呼叫 mattermost_login。');
  if (values.ssh && !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/.test(values.ssh)) {
    throw new Error('SSH 目標格式無效，請使用 user@hostname 或 SSH alias。');
  }
  const ticket = decodeTicket(values.ticket);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const timer = setTimeout(abort, Math.max(1, Date.parse(ticket.expiresAt) - Date.now()));
  timer.unref();
  let ssh: ChildProcess | undefined;
  try {
    let port = ticket.port;
    if (values.ssh) {
      port = await freeLocalPort();
      ssh = spawn('ssh', [
        '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=20',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForkAfterAuthentication=no',
        '-L', `127.0.0.1:${port}:127.0.0.1:${ticket.port}`, '--', values.ssh,
      ], { shell: false, stdio: 'inherit' });
      ssh.once('error', abort);
      ssh.once('exit', abort);
    }
    await checkReceiver(port, ticket, controller.signal);
    console.log(`請在瀏覽器完成此站台的登入：${ticket.serverUrl}`);
    // verify(token) 一律使用顯式 Token，不讀取或保存本機 Session 檔案。
    const api = new MattermostApi(ticket.serverUrl, new SessionStore(ticket.serverUrl));
    const token = await browserSessionToken(api, controller.signal, Date.parse(ticket.expiresAt));
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Mattermost-Pairing-Nonce': ticket.nonce },
      body: JSON.stringify({ serverUrl: ticket.serverUrl, token }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error('接收端拒絕登入交接，請重新配對。');
    console.log('Mattermost Session Token 已交接，請回到 MCP 執行 mattermost_auth_status。');
  } finally {
    clearTimeout(timer);
    controller.abort();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (ssh?.exitCode === null) ssh.kill('SIGTERM');
  }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : '登入失敗，請重新配對。');
  process.exitCode = 1;
}
