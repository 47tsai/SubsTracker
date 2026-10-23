// @ts-check
/**
 * 通知管道統一介接協定
 *
 * 所有管道實作皆遵循此結構：
 *
 *   export const xxxChannel = {
 *     name: 'xxx',                        // 管道名稱（必須與 ENABLED_NOTIFIERS／設定 key 一致）
 *     validateConfig(config) { ... },     // 回傳 { ok: true } 或 { ok: false, error: '...' }
 *     async send(payload, config) { ... },// 實際傳送
 *     async test(config) { ... }          // 使用設定傳送一則測試通知
 *   };
 *
 * 如此 dispatch／通知紀錄／設定頁的測試按鈕便可共用同一份程式碼處理 9 種管道。
 *
 */

/**
 * @typedef {Object} ChannelPayload 通知內容
 * @property {string} title 標題
 * @property {string} content 正文（Markdown 格式，由各管道依需求轉換）
 * @property {Object} [metadata] 中繼資料（tags、subscriptionId 等）
 */

/**
 * @typedef {Object} ChannelResult 管道傳送結果
 * @property {boolean} success 是否成功
 * @property {string} channel 管道名稱
 * @property {string} [error] 失敗原因（HTTP 錯誤、API 拒絕等）
 * @property {any} [raw] 第三方介面的原始回應，方便排查問題
 */

/**
 * @typedef {Object} ValidateResult
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * @typedef {Object} Channel
 * @property {string} name
 * @property {(config: any) => ValidateResult} validateConfig
 * @property {(payload: ChannelPayload, config: any) => Promise<ChannelResult>} send
 * @property {(config: any) => Promise<ChannelResult>} test
 */

/**
 * Telegram MarkdownV2 转义。
 *
 * 修正 #81：訂閱名稱包含 `_*[]()~`>#+-=|{}.!\\` 時，Telegram 會拒絕訊息。
 * 注意：此函式僅用於傳送至 Telegram 的內容，不應影響其他管道。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdownV2(text = '') {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * 移除 commonContent 中的 Markdown 標記（用于纯文本渠道）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text = '') {
  return String(text).replace(/(\*\*|\*|##|#|`)/g, '');
}

/**
 * 建立統一的成功結果。
 *
 * @param {string} name
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function ok(name, raw) {
  return { success: true, channel: name, raw };
}

/**
 * 建立統一的失敗結果。
 *
 * @param {string} name
 * @param {string} error
 * @param {any} [raw]
 * @returns {ChannelResult}
 */
export function fail(name, error, raw) {
  return { success: false, channel: name, error, raw };
}

/**
 * 將任意 error 轉成字串（相容 fetch 拋出的 TypeError、Response 等）。
 *
 * @param {any} err
 * @returns {string}
 */
export function errorMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
