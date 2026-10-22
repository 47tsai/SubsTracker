// @ts-check
/**
 * 貨幣格式化共用工具
 *
 * 早期版本曾在不同程式路徑（新增表單／清單／通知內容／歷史／第三方觸發）
 * 中重複定義 currencySymbols，且偶爾預設回退 ¥（人民幣符號），造成幣別與顯示不一致。
 *
 * 統一使用本模組：
 *   formatAmount(123.45, 'USD')   → '$123.45'
 *   formatAmount(123.45, 'JPY')   → 'JP¥123.45'   （JPY 與 CNY 使用相同符號，因此加上前綴避免混淆）
 *   formatAmount(null, 'USD')     → ''
 *
 */

/**
 * 幣別 → 符號（前綴）對照表。
 * JPY 刻意使用 'JP¥' 前綴，避免與 CNY 的 ¥ 混淆。
 */
export const CURRENCY_SYMBOLS = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  TWD: 'NT$',
  JPY: 'JP¥',
  EUR: '€',
  GBP: '£',
  KRW: '₩',
  TRY: '₺'
};

/**
 * 取得幣別符號，未知幣別則回傳幣別代碼。
 *
 * @param {string} [currency='TWD']
 * @returns {string}
 */
export function getCurrencySymbol(currency = 'TWD') {
  const code = String(currency || 'TWD').toUpperCase();
  return CURRENCY_SYMBOLS[code] || code + ' ';
}

/**
 * 格式化金額字串；amount 為空時回傳空字串。
 *
 * @param {number|string|null|undefined} amount
 * @param {string} [currency='TWD']
 * @param {{ withDecimal?: boolean }} [opts]
 * @returns {string}
 */
export function formatAmount(amount, currency = 'TWD', opts = {}) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  if (Number.isNaN(n)) return '';
  const sym = getCurrencySymbol(currency);
  const fixed = opts.withDecimal === false ? String(Math.round(n)) : n.toFixed(2);
  return sym + fixed;
}
