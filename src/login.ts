import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';
import { MattermostApi } from './session.js';

/** 使用暫存瀏覽器 Context，僅回傳已通過 Mattermost API 驗證的 Token。 */
export async function browserSessionToken(
  api: MattermostApi,
  signal: AbortSignal,
  deadline: number,
  launch: () => Promise<Browser> = () => chromium.launch({ headless: false, timeout: 20_000 }),
): Promise<string> {
  let browser: Browser | undefined;
  const cancel = () => { void browser?.close().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new Error();
    browser = await launch();
    if (signal.aborted) throw new Error();
    const context = await browser.newContext();
    const candidates = new Set<string>();
    context.on('response', (response) => {
      if (new URL(response.url()).origin !== api.serverUrl) return;
      const token = response.headers()['token'];
      if (token && candidates.size < 8) candidates.add(token);
    });
    const page = await context.newPage();
    await page.goto(api.serverUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    while (!signal.aborted && browser.isConnected() && Date.now() < deadline) {
      const cookies = await context.cookies(api.serverUrl);
      const cookieToken = cookies.find((item) => item.name === 'MMSID')?.value;
      const tokens = new Set([cookieToken, ...candidates].filter((token): token is string => !!token));
      for (const token of tokens) {
        try {
          await api.verify(token);
          if (!signal.aborted && Date.now() < deadline) return token;
        } catch { /* 只有驗證成功的候選值才能交接。 */ }
      }
      await sleep(1000, undefined, { signal });
    }
    throw new Error();
  } catch {
    throw new Error(signal.aborted ? '登入已取消。' : '瀏覽器登入失敗或逾時。請確認已安裝 Playwright Chromium、可使用圖形桌面，再重新配對。');
  } finally {
    signal.removeEventListener('abort', cancel);
    await browser?.close().catch(() => undefined);
  }
}
