# 酒館新版 UI 預覽

包含網站帳號、Discord 批准和 Mac 模型連接器的版本，請看 [整合測試與 Mac 部署說明](hosted/README.md)。

這個資料夾保存已發布展示站的獨立介面原型，用來確認資訊架構與互動後，再逐步映射回 SillyTavern 現有功能。

## 本機啟動

在專案根目錄執行 `node ui-preview/server.mjs`（Node.js 22 以上），再開啟 [本機酒館](http://127.0.0.1:8120/)。不用安裝套件。初次啟動預設使用測試回覆，可以從「模型 → 測試連線」檢查 UI 到本機後端。

拿到模型資料後，將 `ui-preview/.env.example` 複製成 `ui-preview/.env`，填寫 Base URL、模型 ID 和選用的 Bearer Token。執行：

```powershell
node --env-file=ui-preview/.env ui-preview/server.mjs
```

Base URL 填到 API 前綴（例如 `http://<TAILSCALE_IP>:<PORT>/v1`），程式會追加 `/models` 和 `/chat/completions`。這版先支援 OpenAI 相容 API 的純文字、非串流回覆。金鑰由本機後端讀取，`.env` 已被 Git 忽略。聊天和回覆版本保留在目前頁面，重新整理會開啟新的工作階段。

選用的 `TAVERN_DISCORD_WEBHOOK_URL` 需填雙方同意使用的私人頻道 Webhook。填寫後，只有送出聊天時遇到無法連線的錯誤才會通知。測試模式、連線檢查、驗證錯誤或單純生成逾時均不觸發。每次離線成功通知一次，且兩次嘗試至少相隔 30 分鐘。通知不包含聊天內容。

輸入框左邊的工具箱會向上展開。選「語氣與生成參數」可調整回覆風格、Temperature、Top P、回覆 token 上限及兩種懲罰值。留白欄位會沿用模型服務的預設。設定保存在目前瀏覽器，下一次送出或重新回覆時套用。測試模式可以調整設定，測試回覆仍是固定回顯。

## 靜態預覽

從專案根目錄啟動任一靜態伺服器，開啟 `ui-preview/index.html`。預覽會使用 `public/` 內既有的字型與 Font Awesome 資源，不需要額外安裝套件。

## 目前包含

- ChatGPT／Claude／Open WebUI 類型的聊天側欄與分組記錄
- 可收合的桌面側欄與窄視窗浮動側欄
- 小型浮動視窗，統一承載角色、模型、工具與聊天設定，關閉後可繼續操作背景
- 複製、編輯、重新回覆與歷史版本切換
- 單一輸入框、附件入口與模型選擇器

靜態預覽使用展示回覆。本機啟動版可以測試或連接上面設定的模型。模型閒置卸載待確認朋友端的服務類型後設定。
