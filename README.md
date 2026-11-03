# mattermost-mcp

本專案提供本機 MCP server，讓使用者透過 Mattermost 網頁登入（包含站台設定的 GitLab OAuth SSO），再使用登入後的 Mattermost Session 呼叫 API。

## 功能

目前提供：

- `mattermost_login`：開啟可見瀏覽器，前往 Mattermost 登入頁。工具會立即回傳，不會等待使用者登入而逾時。
- `mattermost_auth_status`：以 `GET /api/v4/users/me` 驗證登入狀態；不會把 Token 回傳給模型。
- `mattermost_get_current_user`：取得目前登入者。
- `mattermost_list_teams`：列出目前使用者可存取的 teams。
- `mattermost_list_channels`：列出指定 team 的 channels。
- `mattermost_search_posts`：搜尋 posts。

登入時會使用一次性的 Playwright browser context；只有通過 `GET /api/v4/users/me` 驗證的 Mattermost Session Token 會保存於：

```text
~/.config/mattermost-mcp/<server-hash>/session.json
```

後續 API 直接使用：

```http
Authorization: Bearer <mattermost-session-token>
```

GitLab Cookie、OAuth `code`、`state` 與瀏覽器 Cookie 不會保存。Token 不會回傳給 MCP 使用者，也不應提交到 Git。

## 安裝

需求：

- Node.js 22+
- Chromium（Playwright 會使用自己的瀏覽器安裝；若尚未安裝，執行 `npx playwright install chromium`）
- Pi 1.3+

```bash
npm install
npx playwright install chromium
npm run build
```

## 在 Pi 設定 MCP

本專案已提供 `.pi/mcp.json`：

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": ".",
      "exposure": "direct",
      "timeout": 30
    }
  }
}
```

Pi 也支援使用 CLI 加入本地 MCP：

```bash
pi mcp add -l mattermost --cwd "$PWD" -- node dist/server.js
```

專案設定需要 Pi 信任此專案；若 Pi 提示 project trust，請選擇信任。設定完成後，在目前 Pi session 執行：

```text
/reload
```

或重新啟動 Pi。接著可以呼叫 `mattermost_login`。

## 使用流程

1. 先執行 `mattermost_login`。
2. 瀏覽器會開啟 `https://chat.webpat.co/`。
3. 在瀏覽器完成 Mattermost / GitLab 登入。
4. 登入完成後呼叫 `mattermost_auth_status`。
5. 驗證成功後，再使用 `mattermost_get_current_user`、`mattermost_list_teams` 等 tools。

`mattermost_login` 不會等待瀏覽器操作完成，這是刻意設計，避免 MCP request 在你登入期間逾時。登入完成後，背景流程會嘗試從 Mattermost response header 或 `MMSID` Cookie 取得 Session Token，並先用 `/api/v4/users/me` 驗證；只有驗證成功才會保存。

## 自訂站台

```bash
MATTERMOST_URL=https://chat.example.com npm run build
```

或在 `.pi/mcp.json` 加入環境變數：

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": ".",
      "env": {
        "MATTERMOST_URL": "https://chat.webpat.co"
      }
    }
  }
}
```

## 無圖形桌面環境

MCP 需要在能開啟可見瀏覽器的本機執行。若 Pi 是透過 SSH 連到沒有 `DISPLAY` 或 Wayland 的主機，`mattermost_login` 會明確提示錯誤；這是刻意避免在無法操作的背景瀏覽器中卡住登入流程。

## 安全性

這個流程不需要 Mattermost OAuth Application，也不需要把 GitLab 密碼、OAuth secret 或 Session Token 貼給模型。Session 等同使用者權限，請勿把 `~/.config/mattermost-mcp` 分享給其他人。

若 API 回傳 `401`，請重新執行 `mattermost_login`；不要把錯誤訊息中的 Token 或 Cookie 貼到對話中。
