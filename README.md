# SubsTracker

我的私人訂閱管理工具，基於 [wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker) 修改，僅供個人使用。

## 自用客製

- 台灣繁體中文介面
- 新增訂閱預設使用 TWD，儀表板支出統一換算為 TWD
- CHIAuth Passkey 登入，停用原專案的帳號密碼登入
- 部署於自己的 Cloudflare Workers 網域

## 部署環境

| 項目 | 設定 |
| --- | --- |
| Worker | `subscription-manager` |
| 正式網域 | `sub.chi.qzz.io` |
| 執行平台 | Cloudflare Workers |
| 資料儲存 | Cloudflare KV（`SUBSCRIPTIONS_KV`） |
| 排程 | 每小時整點執行 |
| 驗證 | CHIAuth Passkey |

正式環境設定：`wrangler.toml`  
本地開發設定：`wrangler.dev.toml`

## 維護指令

```bash
npm install
npm run lint
npm test
```

本地開發：

```bash
npx wrangler dev --config wrangler.dev.toml --local
```

部署正式環境：

```bash
npm run deploy:safe
```

部署需要有效的 Cloudflare API Token。Token、KV ID、通知服務金鑰等機密資料不得提交至 Git。

## 備份

定期從系統設定匯出訂閱資料備份。修改部署環境或進行資料遷移前，先確認備份可用。

## 上游與授權

- 上游專案：[wangwangit/SubsTracker](https://github.com/wangwangit/SubsTracker)
- 授權：MIT，原始授權與版權聲明見 [LICENSE](./LICENSE)
