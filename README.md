# SubsTracker

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

部署：

```bash
npm run deploy:safe
```

## 注意事項

- 部署所需的憑證與設定值應透過安全方式管理，不得提交至 Git。
- 修改部署設定或遷移資料前，先匯出並確認資料備份。
- 原始授權與版權聲明見 [LICENSE](./LICENSE)。
