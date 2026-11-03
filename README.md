# mattermost-mcp

通用的 Mattermost [MCP](https://modelcontextprotocol.io/) server。使用者在瀏覽器完成站台既有的登入流程後，以 Mattermost 核發的 Session Token 呼叫 REST API v4。

**不綁定身份提供者，不需要額外註冊 OAuth Application，也不需要把帳密或 Token 貼給模型。** 原生登入與 SSO 的導向由 Mattermost 站台處理；MCP 只接受通過 `GET /api/v4/users/me` 驗證的 Mattermost Token。

> 本文件的 registry `npx` 範例需等 `mattermost-mcp@0.1.0` 實際發布到 npm 後才能使用。原始碼開發與 tarball 驗證不需要先發布。

## 快速開始：npx 設定 MCP

需求：Node.js **22 或更新版本**，以及支援 stdio 的 MCP Client。

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "npx",
      "args": ["--yes", "mattermost-mcp@0.1.0"],
      "env": {
        "MATTERMOST_URL": "https://mattermost.example.com"
      }
    }
  }
}
```

- `MATTERMOST_URL` **必填**，沒有預設站台。
- 使用站台原始網址，不附加 `/api/v4`、其他路徑、帳密或查詢參數。
- 正式站台必須使用 HTTPS；僅 loopback 本機測試允許 HTTP。
- MCP 不需要 checkout repository、執行 TypeScript build 或安裝圖形桌面。
- 使用固定版本方便重現；升級時同步更新 MCP 與登入小幫手。
- 完整設定範例位於 [`examples/mcp.json`](examples/mcp.json)。

### Pi

把設定放在使用者的 `~/.pi/agent/mcp.json`，或受信任專案的 `.pi/mcp.json`。也可以執行：

```bash
pi mcp add mattermost \
  --env MATTERMOST_URL=https://mattermost.example.com \
  -- npx --yes mattermost-mcp@0.1.0
```

專案限定設定使用 `pi mcp add -l`。設定完成後執行 `/reload` 或重新啟動 Pi。

### 其他 MCP Client

使用相同的 `command`、`args` 與 `env`。設定檔路徑與重新載入方式依 Client 而定。Windows Client 若無法直接找到 `npx`，可依該 Client 的程序啟動方式改用 `npx.cmd`。

## 初始化登入

### 先在有桌面的電腦安裝瀏覽器

只需要在**操作瀏覽器的電腦**執行，不需要在無桌面的遠端 MCP server 執行：

```bash
npx --yes mattermost-mcp@0.1.0 install-browser
```

這會安裝套件所使用的 Playwright Chromium，不會在一般 `npx` 啟動 MCP 時自動下載瀏覽器。Linux 若缺少 Chromium 所需的系統函式庫，請依 Playwright 提示由管理員安裝。

### MCP 與瀏覽器在同一台電腦

1. 在 MCP Client 呼叫 `mattermost_login({})`。
2. 它會回傳一次性 `npx` command。
3. 在同一台電腦的終端機執行 command，例如：

```bash
npx --yes mattermost-mcp@0.1.0 login --ticket PAIRING_CODE
```

完成瀏覽器登入後，執行 `mattermost_auth_status` 驗證。同機模式不需要 SSH。

### MCP 在遠端 server，瀏覽器在本機電腦

遠端 MCP 不需要圖形桌面。先在 MCP Client 呼叫：

```text
mattermost_login({"sshTarget":"my-server"})
```

`my-server` 是**本機**可使用的 SSH alias，也可以填 `user@example.com`。SSH port forwarding 必須連到執行 MCP 的同一台主機、相同網路命名空間；容器內的 loopback 不一定等於 SSH 主機的 loopback。

工具會回傳有效期 **5 分鐘**的 command，例如：

```bash
npx --yes mattermost-mcp@0.1.0 login \
  --ssh my-server \
  --ticket PAIRING_CODE
```

請在有桌面瀏覽器的**本機電腦**執行，不是在遠端 SSH shell 執行。小幫手會：

1. 以 SSH `-L` 建立本機到遠端 callback 的加密通道。
2. 驗證 callback 與配對資料相符。
3. 開啟配對中的 Mattermost 網址，由站台處理登入與導向。
4. 讀取 Mattermost response 的 `Token` header 或 `MMSID` Cookie。
5. 以 `Authorization: Bearer <token>` 呼叫 `/api/v4/users/me` 驗證。
6. 透過通道交接；遠端再次驗證成功後才保存 Token。

callback 僅綁定 `127.0.0.1`，不需要開公開 HTTP port。配對碼包含短期 nonce，不是 Session Token，但仍應保密；一次憑證交接嘗試後失效。逾時、MCP 重啟或重新載入後，請重新呼叫 `mattermost_login`。

完成後呼叫 `mattermost_auth_status`，確認 `authenticated: true`。之後 API 不需要保持瀏覽器或 SSH 通道開啟。

## CLI

```bash
npx --yes mattermost-mcp@0.1.0 --help
npx --yes mattermost-mcp@0.1.0 --version
npx --yes mattermost-mcp@0.1.0 install-browser
npx --yes mattermost-mcp@0.1.0 login --ticket PAIRING_CODE
```

`mattermost-mcp` 不帶參數或使用 `serve` 都會啟動 stdio MCP server；站台由 `MATTERMOST_URL` 指定。套件也提供 `mattermost-mcp-login` 執行檔作為登入指令的別名。

## Tools

| Tool | 用途 | 主要參數 |
|---|---|---|
| `mattermost_login` | 建立一次性配對並回傳登入指令 | `sshTarget`（選填） |
| `mattermost_auth_status` | 驗證保存的 Session，不回傳 Token | 無 |
| `mattermost_get_current_user` | 取得目前使用者 | 無 |
| `mattermost_list_teams` | 列出所屬團隊 | 無 |
| `mattermost_list_channels` | 列出加入的頻道，可能包含私訊 | `teamId` |
| `mattermost_search_posts` | 搜尋有權限查看的訊息 | `teamId`、`terms`、`isOrSearch`（選填） |
| `mattermost_get_channel` | 查詢頻道及封存狀態 | `channelId` |
| `mattermost_get_post` | 取得單則訊息 | `postId` |
| `mattermost_get_thread` | 取得討論串 | `postId` |
| `mattermost_create_post` | 實際發送訊息 | `channelId`、`message` |
| `mattermost_reply_to_thread` | 實際回覆討論串 | `channelId`、`postId`、`message` |

### 發送與回覆：TL;DR 限制

兩個寫入 tools 都強制驗證：

- 每則最多 **5 行**，每行最多 **50 個 Unicode code points**。
- 空白、標點、Markdown、網址都計入字數；組合 emoji 可能包含多個 code points。
- 空白行、結尾換行計入行數；支援 LF、CRLF、CR。
- 超限或全空白內容直接拒絕，不呼叫 API，不截斷，也不自動拆成多則。
- Tool 描述會要求以 TL;DR 點出結論與重點；語意摘要由呼叫端負責。
- 讀取歷史訊息不受這些發送限制影響。

工具會檢查封存頻道、討論串歸屬與已刪除訊息。`postId` 可指向根訊息或回覆，工具會解析真正的 `root_id`。

寫入需先取得使用者授權；MCP annotations 是提示，不是額外的權限攔截機制。若寫入連線中斷，訊息可能已送出；工具不自動重試，請先查詢確認。

## 設定與安全性

| 環境變數 | 說明 |
|---|---|
| `MATTERMOST_URL` | 必填，Mattermost 站台原始網址 |
| `MATTERMOST_MCP_DATA_DIR` | 選填，覆寫憑證保存根目錄 |

預設憑證位置：

```text
~/.config/mattermost-mcp/<server-hash>/session.json
```

不同站台分開保存；MCP 重啟後可沿用，直到 Session 過期或被撤銷。所有 API 權限等同登入者，MCP 不會提升權限。

- POSIX 站台目錄權限 `0700`，憑證檔案 `0600`；Windows 請另行確認 ACL。
- Token 是明文檔案搭配權限保護，**不是加密儲存**。
- 一般 tool 輸出不含 Token；小幫手不保存身份提供者 Cookie 或 OAuth 授權碼。
- 同一 OS 使用者、系統管理員，以及具備相同檔案讀取權限的 AI tools 仍可能讀取憑證。
- 不要讓不同使用者共用同一個 MCP OS 帳號，不要把憑證提交 Git 或分享備份。
- 刪除本機憑證只會移除本機副本；若需撤銷，請在 Mattermost 的 Session／安全性設定操作。

## 相容性與限制

使用 Mattermost REST API v4，已在 Mattermost 10.12.4 驗證登入及主要 tools。其他站台必須提供相容的 API、Session 與權限；不宣稱已測試所有版本或身份提供者。

目前支援站台部署於原始網址根目錄；不支援子路徑部署。若站台無法提供可作 Bearer Token 使用的 Session，本版本會拒絕保存，不會自行改用未驗證的 Cookie 認證。搜尋目前未提供分頁參數，大量結果請縮小時間範圍。

## 原始碼開發與發布

```bash
npm ci
npm run check
npm run test:package
```

開發時可使用 `node dist/cli.js` 啟動 MCP，並在 Client 的 `env` 明確設定 `MATTERMOST_URL`。`examples/mcp.json` 是可公開的設定範例；`.pi/mcp.json` 是不納入版本控制的個人開發設定。

npm 只打包 `dist/`、`examples/`、README 與 LICENSE 等明確允許的檔案。`prepack` 會建置，`prepublishOnly` 會執行測試；使用者安裝 registry 套件時不需要 TypeScript 開發依賴。

發布前請確認：套件名稱擁有權、版本、LICENSE，以及 GitHub repository 的 `repository`／`homepage`／`bugs` 中繼資料。GitHub 位置由維護者決定，本專案不內建私人 repository URL。

```bash
npm pack --dry-run
npm login
npm publish --access public
```

執行 `npm publish` 才會真的發布；這不是安裝或測試步驟。若套件改名，請同步調整 README 與設定範例；tool 產生的登入指令會自動使用 `package.json` 的名稱與版本。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
