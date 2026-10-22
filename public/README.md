# public/

Workers Assets 靜態資源目錄。客戶端 JS／CSS／獨立 HTML 頁面放在此處，
由 wrangler 自動打包，並透過 ASSETS binding 提供根路徑底下的資源：

- `public/js/lib/*.js`  → 浏览器访问 `/js/lib/<name>.js`
- `public/js/pages/*.js` → 浏览器访问 `/js/pages/<name>.js`
- `public/css/*.css`    → 浏览器访问 `/css/<name>.css`

注意事項：

- 既有頁面（`adminPage.html` / `configPage.html` 等）由 `src/views/` 底下的
  text-import 提供，瀏覽器端無須修改。新功能的客戶端 JS 優先放入本目錄，
  避免污染既有 HTML。
- 不要將敏感資訊放入 `public/`（公開網路可讀）。
