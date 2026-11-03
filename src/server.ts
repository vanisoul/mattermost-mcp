#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MattermostApi, SessionStore, normalizeServerUrl } from './session.js';
import { PairingService, encodeTicket } from './pairing.js';
import { registerMessageTools } from './messages.js';
import { loginCommand, PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
const rawServerUrl = process.env.MATTERMOST_URL;
if (!rawServerUrl) throw new Error('請在 MCP 設定的 env 中指定 MATTERMOST_URL。');
const SERVER_URL = normalizeServerUrl(rawServerUrl);
const DATA_ROOT = process.env.MATTERMOST_MCP_DATA_DIR;
const store = new SessionStore(SERVER_URL, DATA_ROOT);
const api = new MattermostApi(SERVER_URL, store);
const pairing = new PairingService(api, store);

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });
server.server.onclose = () => { void pairing.stop(); };

server.registerTool('mattermost_login', {
  description: '建立一次性登入配對並回傳 npx 登入指令。MCP 在遠端時指定 sshTarget，讓本機 Login Helper 透過 SSH 交接 Session Token；同機則可省略。登入提供者由 Mattermost 站台設定決定。',
  inputSchema: { sshTarget: z.string().optional().describe('本機可使用的 SSH alias 或 user@example.com；MCP 與瀏覽器同機時省略') },
}, async ({ sshTarget }) => {
  try {
    if (sshTarget && !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/.test(sshTarget)) {
      throw new Error('SSH 目標格式無效，請使用 SSH alias 或 user@hostname。');
    }
    const info = await pairing.start();
    const command = loginCommand(encodeTicket(info), sshTarget);
    return textResult({ started: true, serverUrl: SERVER_URL, expiresAt: info.expiresAt, command, message: '請在可開啟瀏覽器的電腦執行 command。遠端 MCP 請指定 sshTarget；同機可直接交接。完成後執行 mattermost_auth_status。' });
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool('mattermost_auth_status', {
  description: '驗證已保存的 Mattermost Session Token；不回傳 Token 本身。',
  inputSchema: {},
}, async () => {
  try {
    const session = await store.load();
    if (!session) return textResult({ authenticated: false, pairing: pairing.status, reason: pairing.status.state !== 'idle' ? '等待本機 Login Helper 完成瀏覽器登入與 SSH 交接。' : '尚未取得 Mattermost Session Token，請先執行 mattermost_login。' });
    const user = await api.verify(session.token);
    return textResult({ authenticated: true, user, authType: 'mattermost_session_token' });
  } catch (error) {
    return textResult({ authenticated: false, reason: error instanceof Error ? error.message : String(error) });
  }
});

server.registerTool('mattermost_get_current_user', {
  description: '取得目前登入的 Mattermost 使用者。',
  inputSchema: {},
}, async () => {
  try { return textResult(await api.request('/users/me')); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool('mattermost_list_teams', {
  description: '列出目前使用者可存取的 Mattermost teams。',
  inputSchema: {},
}, async () => {
  try { return textResult(await api.request('/users/me/teams')); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool('mattermost_list_channels', {
  description: '列出指定 team 的 Mattermost channels。',
  inputSchema: { teamId: z.string().min(1).describe('Mattermost team ID') },
}, async ({ teamId }) => {
  try { return textResult(await api.request(`/users/me/teams/${encodeURIComponent(teamId)}/channels`)); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool('mattermost_search_posts', {
  description: '搜尋目前使用者有權限看到的 Mattermost posts。',
  inputSchema: { teamId: z.string().min(1).describe('Mattermost team ID'), terms: z.string().min(1).describe('搜尋文字'), isOrSearch: z.boolean().optional() },
}, async ({ teamId, terms, isOrSearch }) => {
  try {
    return textResult(await api.request(`/teams/${encodeURIComponent(teamId)}/posts/search`, undefined, { method: 'POST', body: { terms, is_or_search: isOrSearch ?? false } }));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

registerMessageTools(server, api);

await server.connect(new StdioServerTransport());
