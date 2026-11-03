import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Session = {
  serverUrl: string;
  token: string;
  createdAt: string;
};

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Mattermost 網址必須使用 HTTPS；僅本機測試允許 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('請提供 Mattermost 站台原始網址，不含帳密、路徑或查詢參數。');
  }
  return url.origin;
}

export class SessionStore {
  readonly directory: string;
  readonly file: string;

  constructor(readonly serverUrl: string, root = process.env.MATTERMOST_MCP_DATA_DIR ?? join(homedir(), '.config', 'mattermost-mcp')) {
    const key = createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
    this.directory = join(root, key);
    this.file = join(this.directory, 'session.json');
  }

  async load(): Promise<Session | undefined> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('無法讀取登入憑證，請檢查檔案權限。');
    }
    try {
      const data = JSON.parse(raw) as Partial<Session>;
      if (data.serverUrl !== this.serverUrl || typeof data.token !== 'string' || !data.token || /[\r\n]/.test(data.token)) throw new Error();
      return data as Session;
    } catch { throw new Error('登入憑證格式錯誤或站台不符，請重新登入。'); }
  }

  async save(token: string): Promise<void> {
    if (!token || /[\r\n]/.test(token)) throw new Error('登入憑證無效。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.session-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ serverUrl: this.serverUrl, token, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  async clear(): Promise<void> { await rm(this.file, { force: true }); }
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? 'Mattermost Session 已失效，請重新執行 mattermost_login。'
      : status === 403 ? '目前使用者沒有此操作的權限。'
      : `Mattermost API 回傳 HTTP ${status}。`);
  }
}

export class MattermostApi {
  constructor(readonly serverUrl: string, readonly store: SessionStore) {}

  async request(path: string, token?: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const credential = token ?? (await this.store.load())?.token;
    if (!credential) throw new Error('尚未登入，請先執行 mattermost_login。');
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v4${path}`, {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(init.method === 'POST'
        ? 'Mattermost API 連線失敗或逾時；若為發訊息或回覆，可能已送出，請先查詢確認，不要直接重送。'
        : 'Mattermost API 連線失敗或逾時，請確認網路與站台。');
    }
    if (!response.ok) throw new ApiError(response.status);
    try { return await response.json(); }
    catch {
      throw new Error(init.method === 'POST'
        ? 'Mattermost API 回應無效；若為發訊息或回覆，可能已送出，請先查詢確認，不要直接重送。'
        : 'Mattermost API 未回傳有效 JSON。');
    }
  }

  async verify(token: string): Promise<{ id: string; username: string }> {
    const user = await this.request('/users/me', token) as Record<string, unknown>;
    if (!user || typeof user.id !== 'string' || typeof user.username !== 'string') throw new Error('Mattermost 使用者回應格式錯誤。');
    return { id: user.id, username: user.username };
  }
}
