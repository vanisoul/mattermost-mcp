#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'serve';

if (args.includes('--help') || args.includes('-h')) {
  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION}

用法：
  mattermost-mcp                         啟動 stdio MCP server
  mattermost-mcp serve                   啟動 stdio MCP server
  mattermost-mcp login --ticket CODE     在本機瀏覽器完成登入
  mattermost-mcp login --ssh HOST --ticket CODE
                                        登入並透過 SSH 交接至遠端
  mattermost-mcp install-browser         安裝此版本所需的 Chromium
  mattermost-mcp --version               顯示套件版本

MCP server 必須設定 MATTERMOST_URL=https://mattermost.example.com。
登入提供者由 Mattermost 站台設定決定。請先呼叫 mattermost_login 取得配對碼。`);
} else if (command === '--version' || command === '-v') {
  console.log(PACKAGE_VERSION);
} else if (command === 'serve' && args.length <= 1) {
  await import('./server.js');
} else if (command === 'login') {
  await import('./desktop-login.js');
} else if (command === 'install-browser' && args.length === 1) {
  const require = createRequire(import.meta.url);
  const playwrightCli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const child = spawn(process.execPath, [playwrightCli, 'install', 'chromium'], { shell: false, stdio: 'inherit' });
  child.once('error', () => { console.error('無法啟動瀏覽器安裝程序。'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  console.error('不支援此指令，請執行 mattermost-mcp --help 查看用法。');
  process.exitCode = 1;
}
