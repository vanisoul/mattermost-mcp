import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserLogin } from './login.js';
import { MattermostApi, SessionStore, normalizeServerUrl } from './session.js';

const SERVER_URL = normalizeServerUrl(process.env.MATTERMOST_URL ?? 'https://chat.webpat.co');
const DATA_ROOT = process.env.MATTERMOST_MCP_DATA_DIR;
const store = new SessionStore(SERVER_URL, DATA_ROOT);
const api = new MattermostApi(SERVER_URL, store);
const login = new BrowserLogin(api, store);

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({ name: 'mattermost-mcp', version: '0.1.0' });

server.registerTool('mattermost_login', {
  description: '開啟可見瀏覽器，使用 Mattermost 設定的登入方式（例如 GitLab SSO）登入；工具會立即回傳，請完成登入後使用 mattermost_auth_status。',
  inputSchema: {},
}, async () => {
  try { return textResult(await login.start()); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool('mattermost_auth_status', {
  description: '驗證已保存的 Mattermost Session Token；不回傳 Token 本身。',
  inputSchema: {},
}, async () => {
  try {
    const session = await store.load();
    if (!session) return textResult({ authenticated: false, reason: '尚未取得 Mattermost Session Token，請先執行 mattermost_login。' });
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

await server.connect(new StdioServerTransport());
