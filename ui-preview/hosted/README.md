# 酒館網站與 Mac 模型連接器

這套程式讓你在酒館網站登入、選模型、送出使用請求和聊天。Discord 只用來私訊指定批准者。朋友按 OK 後，Mac 的連接器從網站領取工作，再呼叫本機 llama-server。Mac 只需向網站建立 HTTPS 出站連線。聊天室依網站登入帳號存放，兩個帳號可共用一台模型主機。

每間聊天室可在右上角「聊天設定」編輯世界觀、對話需求和系統提示詞。輸入框旁的工具選單可直達系統提示詞，也可調整回覆語氣與生成參數。下一則回覆只使用該聊天室的設定和對話紀錄。新聊天室從空白開始。

左下角的「帳號設定」可更換頭貼與顯示名稱，「外觀設定」提供白天、黑夜和自訂主色。登入時，各帳號分別保存自己的頭貼、名稱和外觀。

## 先在自己電腦測整套流程

使用 Node.js 24 以上。在專案根目錄執行：

```sh
node ui-preview/hosted/test.mjs
node ui-preview/hosted/dev.mjs
```

開啟 http://127.0.0.1:8121/，從左下角帳號選單選「測試登入」，再選 Alice。點「模型 → 送出使用請求 → 模擬朋友按 OK」，等顯示可以聊天後，送一句話。再從帳號選單切換 Bob，確認 Alice 的聊天室不在清單裡。這個本機測試會模擬 Discord、模型啟動和回覆，重新啟動測試站會清空資料。

## 給朋友與他的 Agent

正式網站完成部署並提供配對金鑰後，在朋友的 Mac 下載這個 GitHub 專案。先確認目前的模型 ID、本機埠、GGUF 檔案和既有啟動方式。以下是依原有部署填入的範例值，請現場驗證。

1. 進入 `ui-preview/hosted`。把 `connector.example.json` 複製成 `connector.local.json`，填正式網站 HTTPS 網址和配對金鑰。若目前是 `f451-writer` 與 `127.0.0.1:8787`，沿用範例的模型設定。把設定檔權限設為 `chmod 600 connector.local.json`。真實金鑰只放本機設定檔與網站秘密設定。
2. `startScript` 填主機主人核准的本機啟動腳本絕對路徑，`modelFile` 可填外接碟上的 GGUF 檔路徑，讓程式在啟動前確認檔案可讀。請確認腳本能在背景執行且不需要互動輸入。模型服務正在執行或只是在休眠時，連接器會直接沿用原服務。
3. 先執行 `node connector.mjs connector.local.json --check` 檢查本機模型狀態。確認網站已配對，再執行 `node connector.mjs connector.local.json`，從網站送一筆試用請求。確認 Discord 私訊能收到、指定的朋友按 OK 才會批准、模型有回覆。
4. 驗收後可執行 `node install-macos.mjs connector.local.json`，讓連接器在登入 Mac 後常駐。資料夾請放在穩定的位置。如果 Mac 睡眠、關機或離線，已批准的工作要等 Mac 重新連上才有機會執行。批准與工作都有期限。

## 閒置退位與共用模型

原生 `llama-server` 支援 `--sleep-idle-seconds 600`，可在全服務沒有生成工作的時候卸載模型。健康檢查不會讓模型重新載入。啟動參數的改動請先由主機主人核准，再由他的 Agent 選合適時機調整原腳本。這個版本的連接器不會自動停止、重啟現有服務或動到 Mia。已睡眠的模型會在批准後的第一個生成請求重新載入。

[llama.cpp 閒置文件](https://github.com/ggml-org/llama.cpp/blob/5266f24da/tools/server/README.md#sleeping-on-idle)

## 網站端正式部署所需資料

- 網站後端入口在 `worker.mjs`。需要部署到能提供可信登入身分、`DB` 資料庫與 `ASSETS` 靜態資源的執行環境。首次部署與既有資料庫升級都可套用 `schema.sql`，它只新增缺少的資料表和索引。只有可信網站入口才能提供 `oai-authenticated-user-id` 和 `oai-authenticated-user-email`。公開上線前要用兩個普通帳號驗證，並確認入口會攔截外來偽造身分標頭。
- 伺服器環境需要 `TAVERN_ALLOWED_EMAILS`（逗號分隔的獲准網站帳號）與 `TAVERN_CONNECTOR_TOKEN`（至少 32 字元的隨機金鑰）。可用 `TAVERN_MODEL_ID` 指定模型。原版 SillyTavern 的登入和舊聊天資料仍在朋友的原系統。
- Discord Bot 需要 `DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`DISCORD_APPROVER_ID`，並將 Bot 的 Interactions Endpoint 設為網站的 `/api/discord/interactions`。用獲准的 Discord 帳號測試可接收 Bot 私訊。通知只包含使用請求。
- 此階段的測試站使用新的網站測試帳號。正式網站的登入、資料庫、Bot 和 Mac 配對需要部署後實地驗收。測試路由 `/_test/*` 只由本機 `dev.mjs` 提供。
