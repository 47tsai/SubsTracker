# SubsTracker

## 部署設定

| 項目 | 設定 |
| --- | --- |
| Worker | `subscription-manager` |
| 網域 | `sub.chi.qzz.io` |
| 平台 | Cloudflare Workers |
| KV | `SUBSCRIPTIONS_KV` |
| 排程 | 每小時整點 |
| 登入 | CHIAuth Passkey |

- 正式環境：`wrangler.toml`
- 開發環境：`wrangler.dev.toml`

## 維護指令

```bash
npm install
npm run lint
npm test
npx wrangler dev --config wrangler.dev.toml --local
npm run deploy:safe
```

## 注意事項

- 部署需使用有效的 Cloudflare API Token。
- API Token、KV ID、通知服務金鑰等機密資料不得提交至 Git。
- 修改部署設定或遷移資料前，先匯出並確認訂閱資料備份。
- 原始授權與版權聲明見 [LICENSE](./LICENSE)。
