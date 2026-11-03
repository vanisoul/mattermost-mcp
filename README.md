# mattermost-mcp

本專案提供本機 MCP server，讓使用者透過 Mattermost 網頁登入（包含站台設定的 GitLab OAuth SSO），再使用登入後的 Mattermost Session 呼叫 API。

## 功能

目前提供：

- `mattermost_login`：在遠端建立一次性 nonce callback，供本機 Login Helper 透過 SSH port forwarding 交接 Token。
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

## SSH 遠端初始化流程（B 方案）

MCP 可以留在 server 上，瀏覽器則在你的本機開啟。請先在 Pi 呼叫 `mattermost_login`，並將你的 SSH 目標填入，例如 `bevis@server.example`：

```text
mattermost_login({"sshTarget":"bevis@server.example"})
```

工具會回傳一個包含 5 分鐘一次性配對碼的 command，例如：

```bash
node dist/desktop-login.js --ssh bevis@server.example --ticket <一次性配對碼>
```

請在**你的本機**執行該 command（不是遠端 server）：

```bash
npm install
npx playwright install chromium
npm run build
node dist/desktop-login.js --ssh bevis@server.example --ticket <工具回傳的配對碼>
```

本機 Login Helper 會：

1. 建立 SSH `-L` local port forwarding；本機與遠端 callback listener 都只綁定 `127.0.0.1`。
2. 開啟 `https://chat.webpat.co/`，讓 Mattermost 自己導向 GitLab OAuth。
3. 等你完成正常登入。
4. 只取 Mattermost 的 `MMSID` 或驗證過的 `Token` header。
5. 透過 SSH 加密通道 POST 到遠端一次性 callback。
6. 遠端以 `/api/v4/users/me` 驗證，成功後才保存 Bearer Token。
7. callback 接受一次後立即關閉；nonce 5 分鐘後失效。

完成後回到 Pi 呼叫：

```text
mattermost_auth_status
```

注意：配對碼可以出現在本機 command line，因為它是短期配對值，不是 Session Token；真正的 Token 不會出現在 URL、SSH log 或 MCP 回應中。

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

遠端 MCP 不需要 `DISPLAY`；只有本機 Login Helper 需要可操作的桌面瀏覽器。這個設計適合 Pi 透過 SSH 執行的情境。

## 安全性

這個流程不需要 Mattermost OAuth Application，也不需要把 GitLab 密碼、OAuth secret 或 Session Token 貼給模型。Session 等同使用者權限，請勿把 `~/.config/mattermost-mcp` 分享給其他人。

若 API 回傳 `401`，請重新執行 `mattermost_login`；不要把錯誤訊息中的 Token 或 Cookie 貼到對話中。
