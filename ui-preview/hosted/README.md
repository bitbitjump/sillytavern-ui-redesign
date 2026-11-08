# 酒館網站與 Mac 模型連接器

你和朋友可從不同網段登入同一個酒館網站。你在「模型與連線」送出申請，朋友在同一個面板同意，Mac 上的酒館連接器再透過 HTTPS 從網站領取工作。生成在朋友的 Mac 上執行，llama-server 繼續只監聽 Mac 的 `127.0.0.1`。兩台電腦各自連網站，不需要 Tailscale，也不需要在朋友的路由器開放模型連接埠。聊天室依網站登入帳號存放。

每間聊天室可在右上角「聊天設定」編輯世界觀、對話需求和系統提示詞。輸入框旁的工具選單可直達系統提示詞，也可調整回覆語氣與生成參數。下一則回覆只使用該聊天室的設定和對話紀錄。新聊天室從空白開始。

左下角的「帳號設定」可更換頭貼與顯示名稱，「外觀設定」提供白天、黑夜和自訂主色。登入時，各帳號分別保存自己的頭貼、名稱和外觀。

長篇對話每次顯示最近 24 則訊息。往上找到「載入更早的訊息」可繼續往前翻。完整原文和重新回覆都存放在網站的資料庫，既有聊天室會在開啟時自動轉換。單間聊天室可以超過原先的 200 則與 512 KiB，總容量依網站資料庫方案而定。

模型回覆前，Mac 連接器用 llama-server 回報的上下文大小和 tokenizer 選取近期原文，保留聊天室設定和回覆空間。舊對話放不下時，每次批准中的聊天最多多跑一次摘要，最多生成 512 tokens，並以 45 秒為限。摘要保存在網站資料庫。大量既有對話會隨後續聊天分批整理。摘要失敗時會繼續正常回覆，重要人物設定可放進「世界觀」。

Mac 不需要額外模型、向量資料庫或聊天備份，也不用加大 llama-server 的上下文。主機主人可在 `connector.local.json` 設定 `"summarizeHistory": false` 並重啟連接器，停用新的摘要生成。已存的摘要仍可供回覆使用。

## 先在自己電腦測整套流程

使用 Node.js 24 以上。在專案根目錄執行：

```sh
node ui-preview/hosted/test.mjs
node ui-preview/hosted/dev.mjs
```

開啟 http://127.0.0.1:8121/，用 Alice 測試帳號在「模型與連線」送出使用請求。從左下角帳號選單切換到模型管理員 Bob，在同一面板點「同意使用」。切回 Alice，等顯示可以聊天後送一句話。本機預覽只使用模擬模型，正式跨網段連線須使用兩邊都能存取的 HTTPS 網址。預設將資料存在記憶體，設定 `TAVERN_DEV_DB` 為 SQLite 檔案路徑可在重啟後繼續使用原測試資料。

## 給朋友與他的 Agent

正式網站完成部署並提供配對金鑰後，在朋友的 Mac 下載這個 GitHub 專案。先確認目前的模型 ID、本機埠、GGUF 檔案和既有啟動方式。以下是依原有部署填入的範例值，請現場驗證。

1. 進入 `ui-preview/hosted`。把 `connector.example.json` 複製成 `connector.local.json`，填正式網站 HTTPS 網址和配對金鑰。若目前是 `f451-writer` 與 `127.0.0.1:8787`，沿用範例的模型設定。把設定檔權限設為 `chmod 600 connector.local.json`。真實金鑰只放本機設定檔與網站秘密設定。
2. `startScript` 填主機主人核准的本機啟動腳本絕對路徑，`modelFile` 可填外接碟上的 GGUF 檔路徑，讓程式在啟動前確認檔案可讀。請確認腳本能在背景執行且不需要互動輸入。模型服務正在執行或只是在休眠時，連接器會直接沿用原服務。
3. 先執行 `node connector.mjs connector.local.json --check` 檢查本機模型狀態，再執行 `node connector.mjs connector.local.json`。你和朋友分別登入網站，在「模型與連線」申請與批准一次，確認回覆確實由朋友 Mac 上的模型產生。
4. 驗收後可執行 `node install-macos.mjs connector.local.json`，讓連接器在登入 Mac 後常駐。資料夾請放在穩定的位置。如果 Mac 睡眠、關機或離線，已批准的工作要等 Mac 重新連上才有機會執行。批准與工作都有期限。

## 閒置退位與共用模型

原生 `llama-server` 支援 `--sleep-idle-seconds 600`，可在全服務沒有生成工作的時候卸載模型。健康檢查不會讓模型重新載入。啟動參數的改動請先由主機主人核准，再由他的 Agent 選合適時機調整原腳本。這個版本的連接器不會自動停止、重啟現有服務或動到 Mia。已睡眠的模型會在批准後的第一個生成請求重新載入。

[llama.cpp 閒置文件](https://github.com/ggml-org/llama.cpp/blob/5266f24da/tools/server/README.md#sleeping-on-idle)

## 網站端正式部署所需資料

- 網站後端入口在 `worker.mjs`。需要部署到能提供可信登入身分、`DB` 資料庫與 `ASSETS` 靜態資源的執行環境。首次部署和更新網站後端前都先套用 `schema.sql`，它只新增缺少的資料表和索引。自動摘要需一起更新 Mac 的 `connector.mjs` 與 `memory.mjs`。只有可信網站入口才能提供 `oai-authenticated-user-id` 和 `oai-authenticated-user-email`。公開上線前要用兩個普通帳號驗證，並確認入口會攔截外來偽造身分標頭。
- 伺服器環境需要 `TAVERN_ALLOWED_EMAILS`（逗號分隔的獲准網站帳號）與 `TAVERN_CONNECTOR_TOKEN`（至少 32 字元的隨機金鑰）。可用 `TAVERN_MODEL_ID` 指定模型。原版 SillyTavern 的登入和舊聊天資料仍在朋友的原系統。
- 將 `TAVERN_APPROVER_EMAIL` 設為朋友的酒館登入信箱，並將你和朋友的信箱都放入 `TAVERN_ALLOWED_EMAILS`。設定後，朋友可從酒館直接同意或拒絕申請。尚未設定此變數的既有部署仍可使用已設定的 Discord 批准流程。
- 兩台電腦都必須能連到同一個正式 HTTPS 網址。正式網站的登入、資料庫與 Mac 配對需要部署後實地驗收。測試路由 `/_test/*` 只由本機 `dev.mjs` 提供。
