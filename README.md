<p align="center">
  <img src="docs/images/alice-full.png" alt="OpenAlice" width="88">
</p>

<h1 align="center">OpenAlice</h1>

> [!NOTE]
> **Fork notice / 分支聲明**: This repository (`ipass003482/OpenAliceflow`) is a personal, non-commercial fork of the original project [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice), created and maintained by the OpenAlice Contributors. All credit for the original design and implementation belongs to the upstream authors. This fork contains local modifications (see git history) and is distributed under the same [AGPL-3.0-only](LICENSE) license as the original. No profit is made from this fork.
> 本倉庫為 [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) 原始專案之個人非營利分支，僅供學習與開發使用。原始設計與實作之著作權歸原作者（OpenAlice Contributors）所有。本分支之修改內容詳見 git 歷史紀錄，並依原專案相同之 AGPL-3.0-only 授權條款散布，無任何營利行為。

<p align="center">
  <strong>一個人的華爾街。</strong><br>
  OpenAlice 為 coding agent 提供工作區、檔案、議題、市場工具與核准把關的交易原語，把它們變成在你本機運作的交易代理。
</p>

<p align="center">
  <a href="https://openalice.ai"><img src="https://img.shields.io/badge/Website-blue" alt="Website"></a> · <a href="https://openalice.ai/docs"><img src="https://img.shields.io/badge/Docs-green" alt="Docs"></a> · <a href="https://x.com/OpenAliceAI"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="X (Twitter)"></a> · <a href="https://discord.gg/zf4STmrQd8"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a> · <a href="https://qm.qq.com/q/iSg6O4FmrC"><img src="https://img.shields.io/badge/QQ-12B7F5" alt="QQ"></a>
</p>

<p align="center">
  <img src="docs/images/ask-alice.jpg" alt="OpenAlice Ask Alice composer" width="760">
</p>

> [!CAUTION]
> **OpenAlice 是仍在密集開發中的實驗性軟體。** 許多功能與介面尚未完成，隨時可能出現破壞性變更，交易層尤其處於 beta 階段。除非你完全理解並接受相關風險，否則請勿將 OpenAlice 用於真實資金的實盤交易。作者不對正確性、可靠性、獲利能力或損失防範提供任何保證。

## OpenAlice 是什麼？

OpenAlice 是一個給 coding agent 使用的本機交易工作區。

核心想法很簡單：coding agent 之所以能快速變得有用，是因為軟體開發工作本來就有一套協作基礎——程式碼有 git、議題追蹤、markdown 文件、審查流程、linter、終端機、日誌和可重現的專案資料夾。coding agent 進入這個世界後，立刻就知道該如何檢視、修改、審查與回報工作。

交易通常沒有這種形態。交易者會讀新聞、看圖表、持有券商部位、記私人筆記，但這些工作很少被組織成一個人類與多個 AI agent 可以共享的協作系統。

OpenAlice 試著把交易工作對應到 coding agent 已經理解的工具上，讓交易變得可被 agent 操作：

- **工作區（Workspaces）**——每項正式任務都有自己的目錄、git 儲存庫、終端機工作階段與原生 agent CLI。
- **議題（Issues）**——交易工作變成自我描述的 markdown 任務，類似 Linear 的工單。
- **追蹤實體（Tracked entities）**——資產、板塊、主題、論點與人物構成類似 Obsidian 的記憶圖譜。
- **收件匣（Inbox）**——完成的工作以持久化報告的形式送達，而不是消失在聊天紀錄裡。
- **市場工具（Market tools）**——行情資料、新聞、基本面、技術分析與交易帳戶狀態，都透過 CLI 與本機工具開放使用。
- **交易即 Git（Trading as Git）**——帳戶操作（可選）經過暫存、提交、審查，再透過核准關卡推送執行。

OpenAlice 不是要取代 Claude Code、Codex、opencode、Pi 或其他 coding agent，而是給它們一個為交易而生的工作場所。

## 核心迴圈

從唯讀研究開始。不需要券商帳戶也能從 OpenAlice 獲得價值。

1. **問 Alice**——市場問題、公司概覽、板塊掃描或論點檢驗。
2. **追蹤該保留的東西**——用實體與 `[[wikilinks]]` 記下來。
3. **建立議題**——當工作需要延續、重複執行或之後交給 agent 處理時。
4. **排程議題**——把時程與指示直接寫進同一份 markdown 檔案。
5. **在收件匣讀結果**——agent 有值得給你看的成果時會送到這裡。

<table>
  <tr>
    <td><img src="docs/images/issue-board.jpg" alt="OpenAlice Issue Board"></td>
    <td><img src="docs/images/tracked.jpg" alt="OpenAlice Tracked Entities"></td>
  </tr>
  <tr>
    <td align="center"><strong>議題看板</strong></td>
    <td align="center"><strong>追蹤實體</strong></td>
  </tr>
  <tr>
    <td><img src="docs/images/inbox.jpg" alt="OpenAlice Inbox"></td>
    <td><img src="docs/images/market.jpg" alt="OpenAlice Market tools"></td>
  </tr>
  <tr>
    <td align="center"><strong>收件匣</strong></td>
    <td align="center"><strong>市場工具</strong></td>
  </tr>
</table>

這個迴圈就是今天的主要產品介面。排程器不會呼叫什麼神奇的交易端點——它針對一份自我描述的工作區議題啟動 agent，使用的檔案、工具、記憶與回報路徑，跟你親自坐在旁邊時完全相同。

## 你會得到什麼

| 介面 | 功能 |
| --- | --- |
| **工作區** | 以任務為單位的 git 儲存庫，附一個持續運行 `claude`、`codex`、`grok`、`opencode`、`pi` 或 `shell` 的終端機。 |
| **議題看板** | 以 markdown 為後端的工作項目，含狀態、優先級、負責人、留言、連結與可選的排程設定。 |
| **追蹤實體** | 為股票代號、主題、板塊、人物、風險與論點建立的持久化圖譜。 |
| **收件匣** | 報告、排程執行結果與 agent 狀態更新的送達介面。 |
| **市場資料** | 股票、加密貨幣、總經、基本面、代號搜尋、技術指標、新聞與 RSS 工具。 |
| **統一交易帳戶（UTA）** | 可選的 beta 帳戶抽象層，支援 Alpaca、IBKR、Longbridge、Futu（富途）與 CCXT 交易所等券商。 |
| **交易即 Git** | 帳戶操作先暫存、提交、審查再推送執行，而不是讓 agent 直接下單。 |

## 為什麼要本機執行？

交易涉及私人筆記、帳戶狀態、憑證、策略與真金白銀。OpenAlice 預設在你自己的機器上執行，狀態以檔案形式存放在 `~/.openalice` 之下，券商憑證在靜態儲存時保持密封（sealed）。

不需要架設 Postgres 或 Redis。設定、工作階段、議題、收件匣項目、工作區產物、新聞封存與交易歷史，全都是普通的檔案和 git 儲存庫——這讓整個系統更容易檢視、備份、除錯、修補與推理。

## 快速開始

依照你的機器選擇執行方式：

- **macOS**——使用已簽章的 Apple Silicon 或 Intel 桌面版：[macOS 安裝](https://openalice.ai/docs/getting-started/install-macos)。
- **Windows**——選擇自帶依賴的未簽章桌面 beta 版，或走原始碼路徑：[Windows 安裝](https://openalice.ai/docs/getting-started/install-windows)。
- **Linux、貢獻者、除錯**——走原始碼路徑：[原始碼與開發](https://openalice.ai/docs/getting-started/developer-setup)。
- **私有 SSH 主機或旅行配置**——瀏覽器留在本機、Runtime 跑在遠端：[遠端快速開始](docs/remote-quickstart.md)。
- **伺服器或常開機器**——使用 Docker Compose：[Docker 部署](https://openalice.ai/docs/deployment/docker)。

原始碼路徑仍然是早期使用者的最佳選擇，因為你能拿到日誌和本地程式碼：

```bash
git clone https://github.com/TraderAlice/OpenAlice.git
cd OpenAlice
pnpm install
pnpm dev
```

打開終端機印出的 UI 網址，通常是 `http://localhost:5173`。

打包的桌面版內建 managed Pi；Docker 映像釘選了 Claude Code、Codex、
opencode 與 Pi 的版本。兩者仍需要一組模型憑證或支援的 CLI 登入。原始碼
安裝則至少需要主機上有一個 agent CLI。OpenAlice 把模型迴圈放在那個原生
執行環境裡跑，所以它的對話狀態、供應商登入與工具行為都得以保留。

## 文件

README 刻意保持簡短，完整文件在 [openalice.ai/docs](https://openalice.ai/docs)。

- [OpenAlice 是什麼](https://openalice.ai/docs/getting-started/what-is-openalice)——產品模型與目前的邊界。
- [快速開始](https://openalice.ai/docs/getting-started/quick-start)——你的第一輪研究、追蹤、議題、排程與收件匣迴圈。
- [安裝總覽](https://openalice.ai/docs/getting-started/installation)——選擇 macOS、Windows、原始碼、Docker 或遠端存取。
- [工作區](https://openalice.ai/docs/workspaces/workspaces)——目錄、git、CLI 與檔案後端的基礎。
- [工作階段與協作](https://openalice.ai/docs/workspaces/sessions-and-collaboration)——持久的 Session 身分、簽名、溯源與可歸責的後續追問。
- [生命週期與離站](https://openalice.ai/docs/workspaces/lifecycle)——交接、離站桌面、還原、清除與 Session 退役。
- [工作區自動化](https://openalice.ai/docs/workspaces/automation)——透過自我描述的議題排程執行。
- [統一交易帳戶](https://openalice.ai/docs/core-concepts/unified-trading-account)——beta 帳戶層與安全警告。
- [交易即 Git](https://openalice.ai/docs/core-concepts/trading-as-git)——暫存、提交、核准把關的交易操作。
- [資料與憑證](https://openalice.ai/docs/deployment/data-and-credentials)——狀態佈局、密封憑證、連接埠與備份。

## 專案現況

OpenAlice 今天已可用於研究、議題式工作、追蹤記憶、排程報告與收件匣送達。

請把券商下單視為 beta 基礎設施。從模擬器、paper、demo 或 testnet 帳戶開始。若遇到 UTA 錯誤、券商連線失敗或令人困惑的執行行為，請把錯誤帶到 Discord 或開 GitHub issue，讓我們能重現問題。

## 尋求協助

卡住了？最快的路徑通常是：

1. **請 AI coding agent 檢查這個儲存庫**——OpenAlice 刻意採用檔案後端、對 agent 友善可讀的設計。
2. **閱讀文件**——[openalice.ai/docs](https://openalice.ai/docs)。
3. **問 DeepWiki**——[deepwiki.com/TraderAlice/OpenAlice](https://deepwiki.com/TraderAlice/OpenAlice)。
4. **加入社群**——英文使用者請上 [Discord](https://discord.gg/zf4STmrQd8)，中文開發者請加 [QQ 群](https://qm.qq.com/q/iSg6O4FmrC)。

## Star 歷史

<p align="center">
  <a href="https://github.com/TraderAlice/OpenAlice">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/star-history-dark.svg">
      <img src="docs/images/star-history.svg" alt="OpenAlice GitHub star history" width="900">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/TraderAlice/OpenAlice"><img src="https://img.shields.io/github/stars/TraderAlice/OpenAlice?style=flat-square&logo=github&label=Current%20stars" alt="Current GitHub stars"></a>
</p>

## 貢獻者

OpenAlice 因為那些跟我們一起深入鑽研的人而變得更鋒利：他們抓到的 bug、
推動的想法、注意到的 UX 邊角、帶來的設計與審查。高訊號的 issue 和 PR
提案都算在內——只要一份報告、建議或實作提案改變了產品，就會被記上一筆。

<!-- Standouts first. Avatars come free from https://github.com/<handle>.png -->
<p>
  <a href="https://github.com/bakabird"><img src="https://github.com/bakabird.png" width="56" height="56" alt="@bakabird" /></a>
  <a href="https://github.com/2233admin"><img src="https://github.com/2233admin.png" width="56" height="56" alt="@2233admin" /></a>
  <a href="https://github.com/lvysssss"><img src="https://github.com/lvysssss.png" width="56" height="56" alt="@lvysssss" /></a>
  <a href="https://github.com/walkonbothsides"><img src="https://github.com/walkonbothsides.png" width="56" height="56" alt="@walkonbothsides" /></a>
  <a href="https://github.com/bakabaka0613"><img src="https://github.com/bakabaka0613.png" width="56" height="56" alt="@bakabaka0613" /></a>
  <a href="https://github.com/JasonWang1124"><img src="https://github.com/JasonWang1124.png" width="56" height="56" alt="@JasonWang1124" /></a>
  <a href="https://github.com/rudyll"><img src="https://github.com/rudyll.png" width="56" height="56" alt="@rudyll" /></a>
  <a href="https://github.com/jalilsedna"><img src="https://github.com/jalilsedna.png" width="56" height="56" alt="@jalilsedna" /></a>
  <a href="https://github.com/dbydd"><img src="https://github.com/dbydd.png" width="56" height="56" alt="@dbydd" /></a>
  <a href="https://github.com/enderzcx"><img src="https://github.com/enderzcx.png" width="56" height="56" alt="@enderzcx" /></a>
</p>

**完整名單與每個人的貢獻**：[CONTRIBUTORS.md](./CONTRIBUTORS.md)

## 授權

[AGPL-3.0](LICENSE)
