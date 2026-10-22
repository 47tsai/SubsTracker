// @ts-check
/**
 * 通知管道統一介接協定
 *
 * 所有管道實作皆遵循此結構：
 *
 *   export const xxxChannel = {
 *     name: 'xxx',                        // 管道名稱（必須與 ENABLED_NOTIFIERS／設定 key 一致）
 *     validateConfig(config) { ... },     // 返回 { ok: true } 或 { ok: false, error: '...' }
 *     async send(payload, config) { ... },// 實際傳送
 *     async test(config) { ... }          // 使用設定傳送一則測試通知
 *   };
 *
 * 这样 dispatch / 通知紀錄 / 設定頁的測試按鈕可以用同一份代码处理 9 种渠道。
 *
 */

/**
 * @typedef {Object} ChannelPayload 通知内容载荷
 * @property {string} title 标题
 * @property {string} content 正文（Markdown 风格，由各渠道按需转换）
 * @property {Object} [metadata] 元数据（tags、subscriptionId 等）
 */

/**
 * @typedef {Object} ChannelResult 渠道发送结果
 * @property {boolean} success 是否成功
 * @property {string} channel 渠道名
 * @property {string} [error] 失败原因（HTTP 错误、API 拒绝等）
 * @property {any} [raw] 三方接口原始返回，便于排查
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
 * 修复 #81：订阅名包含 `_*[]()~`>#+-=|{}.!\\` 时 Telegram 会拒绝消息。
 * 注意：这个函数只僅用於傳送至 Telegram 的內容，不要影響其他管道。
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
 * 把任意 error 转字符串（兼容 fetch 抛出的 TypeError、Response 等）。
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
