import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
import { MattermostApi, SessionStore } from './session.js';

export type LoginState = 'idle' | 'opening' | 'waiting' | 'authenticated' | 'cancelled' | 'expired' | 'failed';

/** 僅保留驗證通過的 Mattermost Token；GitLab Cookie 不寫入磁碟。 */
export class BrowserLogin {
  state: LoginState = 'idle';
  private browser?: Browser;
  private controller?: AbortController;
  private running?: Promise<void>;

  constructor(private api: MattermostApi, private store: SessionStore) {}

  async start(): Promise<{ state: LoginState; message: string }> {
    if (this.running) return { state: this.state, message: '登入程序已啟動，請完成瀏覽器登入後檢查 mattermost_auth_status。' };
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error('目前主機沒有圖形顯示環境。請在可操作瀏覽器的桌面執行 MCP，或使用 README 的本機登入指令搭配 SSH 傳送憑證檔案。');
    }
    const controller = new AbortController();
    this.controller = controller;
    this.state = 'opening';
    this.running = this.run(controller.signal).finally(() => {
      this.running = undefined;
    });
    return { state: 'opening', message: '正在開啟登入瀏覽器。請依站台指示完成 Mattermost／GitLab 登入，再呼叫 mattermost_auth_status。' };
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      this.browser = await chromium.launch({ headless: false, timeout: 20_000 });
      if (signal.aborted) return;
      const context = await this.browser.newContext();
      const candidates = new Set<string>();
      context.on('response', (response) => {
        if (new URL(response.url()).origin !== this.api.serverUrl) return;
        const token = response.headers()['token'];
        if (token && candidates.size < 8) candidates.add(token);
      });
      const page = await context.newPage();
      // 必須從站台開始，讓 Mattermost 產生本次登入的 state，不能重用 GitLab OAuth URL。
      await page.goto(this.api.serverUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      this.state = 'waiting';
      const deadline = Date.now() + 5 * 60_000;
      while (!signal.aborted && Date.now() < deadline && this.browser.isConnected()) {
        // Playwright 可讀取 HttpOnly Cookie；MMSID 本身就是待驗證的 Mattermost Session Token。
        const cookie = (await context.cookies(this.api.serverUrl)).find((item) => item.name === 'MMSID');
        const tokens = [...new Set([cookie?.value, ...candidates].filter((item): item is string => !!item))];
        for (const token of tokens) {
          try {
            await this.api.verify(token);
            if (signal.aborted) return;
            await this.store.save(token);
            this.state = 'authenticated';
            return;
          } catch { /* 尚未完成登入或網路暫時失敗，保留候選值等待下一輪 */ }
        }
        await sleep(1500, undefined, { signal });
      }
      this.state = signal.aborted || !this.browser.isConnected() ? 'cancelled' : 'expired';
    } catch {
      // 不把瀏覽器診斷、OAuth URL、code、state、Cookie 或 Token 交給模型。
      this.state = signal.aborted ? 'cancelled' : 'failed';
    } finally {
      await this.browser?.close().catch(() => undefined);
      this.browser = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.browser?.close().catch(() => undefined);
    await this.running;
  }
}
