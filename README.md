<p align="center">
  <img src="docs/images/alice-full.png" alt="OpenAlice" width="88">
</p>

<h1 align="center">OpenAlice</h1>

> [!NOTE]
> **Fork notice / 分支聲明**: This repository (`ipass003482/OpenAliceflow`) is a personal, non-commercial fork of the original project [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice), created and maintained by the OpenAlice Contributors. All credit for the original design and implementation belongs to the upstream authors. This fork contains local modifications (see git history) and is distributed under the same [AGPL-3.0-only](LICENSE) license as the original. No profit is made from this fork.
> 本倉庫為 [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) 原始專案之個人非營利分支，僅供學習與開發使用。原始設計與實作之著作權歸原作者（OpenAlice Contributors）所有。本分支之修改內容詳見 git 歷史紀錄，並依原專案相同之 AGPL-3.0-only 授權條款散布，無任何營利行為。

<p align="center">
  <strong>OpenAlice 個人開發分支——富途（Futu）券商串接實驗</strong>
</p>

> [!CAUTION]
> 本分支與上游同為實驗性軟體，交易層屬於 beta。本分支新增的富途串接**從未在真實 FutuOpenD 閘道與真實帳戶上驗證過**，所有測試皆基於 mock。未經模擬盤充分測試前，請勿用於真實資金。

## 這個分支是什麼

[OpenAlice](https://github.com/TraderAlice/OpenAlice) 是一個給 coding agent（Claude Code、Codex、opencode、Pi 等）使用的本機交易工作區：工作區、議題看板、追蹤實體、收件匣、市場工具，以及「交易即 Git」的核准把關下單流程。完整的產品介紹與文件請看上游的 [README](https://github.com/TraderAlice/OpenAlice#readme) 與[官方文件](https://openalice.ai/docs)——這裡不重複翻譯，只記錄本分支實際改了什麼。

本分支是個人學習與開發用途，主要工作是把富途（Futu/moomoo）券商接進 OpenAlice 的統一交易帳戶（UTA）層。

## 本分支新增的內容

工作集中在 `feat/uta-broker-futu` 分支：透過本機執行的 FutuOpenD 閘道串接富途（官方 `futu-api` SDK，protobuf over WebSocket）。

| 增量 | 內容 |
| --- | --- |
| 唯讀 Broker Pack | 帳戶資金、持倉、快照報價、市場時鐘、合約靜態資訊；註冊為正式 `futu` 引擎 |
| 即時報價推送（5 層） | FutuOpenD 訂閱 → `IBroker` 契約 → UTA SSE 端點 → Alice 轉發 → Market 頁與持倉頁的即時價格疊加（Live 徽章） |
| 下單功能 | 市價／限價／停損／停損限價單的下單、改單、撤單、平倉；交易解鎖（密碼經 MD5 後才上 wire）；UI 券商精靈可直接新增 Futu 帳戶 |
| 強化修正 | 訂單查詢回看一個月（`Trd_GetHistoryOrderList`）、訂單狀態即時推送（`Trd_SubAccPush`）、斷線通報與自動重連後的訂閱重建 |
| 其他 | README 改為本分支自述 |

**誠實聲明**：以上全部只以 mock 驗證（typecheck 與單元測試皆綠），尚未接過真實的 FutuOpenD 閘道或富途帳戶。實測時請一律從 `simulate`（模擬盤，設定預設值）開始。

## 快速開始

```bash
git clone https://github.com/ipass003482/OpenAliceflow.git
cd OpenAliceflow
git checkout feat/uta-broker-futu
pnpm install
pnpm dev
```

打開終端機印出的 UI 網址（通常是 `http://localhost:5173`）。需要主機上有至少一個 agent CLI（`claude`、`codex` 等），並在 Settings → AI Provider 設定模型憑證或使用 CLI 自身的訂閱登入。

要使用富途功能，需另行安裝並登入 [FutuOpenD](https://openapi.futunn.com/)（富途官方閘道程式，憑證由它保管），再於「交易」頁面的新增帳戶精靈選擇 Futu（預設連線 `127.0.0.1:33333`）。

## 上游資源

- 原始專案：[TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice)
- 官方網站與文件：[openalice.ai](https://openalice.ai) · [openalice.ai/docs](https://openalice.ai/docs)
- 社群：[Discord](https://discord.gg/zf4STmrQd8) · [QQ 群](https://qm.qq.com/q/iSg6O4FmrC)
- 上游貢獻者名單：[CONTRIBUTORS.md](./CONTRIBUTORS.md)

## 授權

與上游相同：[AGPL-3.0](LICENSE)
