// @ts-check
/**
 * 提醒規則觸發引擎
 *
 * 給定一條規則、目前距離到期的時間（天／小時）及上次觸發時間，
 * 判斷「目前這個小時是否應該發出提醒」。
 *
 * 設計為純函式，與 KV／網路解耦，方便單元測試涵蓋所有邊界。
 *
 * 三種規則類型的語意：
 * - before_expiry: value 表示"提前 N 天／小時"。當 daysDiff／hoursDiff 落在 [0, value] 區間內觸發。
 *   特別的是，value=0 等同于 on_expiry。
 * - on_expiry: 僅在到期日（daysDiff===0）觸發。
 * - after_expiry: 已過期的情境。每隔 repeatInterval 小時觸發一次，直到符合終止條件
 *   （renewed/acknowledged/never）。本引擎不處理終止條件判斷（由 scheduler 在載入規則前篩選），
 *   但會檢查"距離上次觸發是否超過 repeatInterval"。
 *
 */

/**
 * @typedef {import('../../data/reminders.repo.js').ReminderRule} ReminderRule
 */

/**
 * @typedef {Object} FireContext
 * @property {number} daysDiff 距離到期的天數（依使用者時區的午夜計算；可為負數，代表已過期天數）
 * @property {number} hoursDiff 距離到期的小時數（可為負數，代表已過期小時數）
 * @property {string} [lastFireAtIso] 同一規則上次觸發的 ISO 時間（用於 after_expiry 的重複間隔）
 * @property {string} [nowIso] 目前的 ISO 時間，預設 new Date().toISOString()
 */

/**
 * @typedef {Object} FireDecision
 * @property {boolean} fire 是否應該觸發
 * @property {string} [reason] 觸發或拒絕的原因（方便診斷記錄）
 */

/**
 * 判斷規則是否應在「本次排程」觸發。
 *
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
export function shouldFire(rule, ctx) {
  if (!rule || rule.isEnabled === false) {
    return { fire: false, reason: 'rule_disabled' };
  }

  const { daysDiff, hoursDiff } = ctx;
  if (!Number.isFinite(daysDiff) || !Number.isFinite(hoursDiff)) {
    return { fire: false, reason: 'invalid_diff' };
  }

  switch (rule.type) {
    case 'before_expiry':
      return decideBeforeExpiry(rule, ctx);
    case 'on_expiry':
      return decideOnExpiry(rule, ctx);
    case 'after_expiry':
      return decideAfterExpiry(rule, ctx);
    default:
      return { fire: false, reason: 'unknown_rule_type' };
  }
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideBeforeExpiry(rule, ctx) {
  const { daysDiff, hoursDiff } = ctx;

  if (rule.unit === 'hours') {
    // hours 模式：value=0 代表"到期當小時內"
    if (rule.value === 0) {
      return hoursDiff >= 0 && hoursDiff < 1
        ? { fire: true, reason: 'within_hour' }
        : { fire: false, reason: 'not_within_hour' };
    }
    // 其他情況：剩餘小時剛好等於規則 value（精準觸發）
    if (hoursDiff < 0) return { fire: false, reason: 'already_expired' };
    if (Math.round(hoursDiff) === rule.value) {
      return { fire: true, reason: `hours_diff_eq_${rule.value}` };
    }
    return { fire: false, reason: `hours_diff=${hoursDiff}_not_match_${rule.value}` };
  }

  // days 模式：value=0 等同 on_expiry
  if (rule.value === 0) {
    return daysDiff === 0
      ? { fire: true, reason: 'days_diff_zero' }
      : { fire: false, reason: `days_diff=${daysDiff}_not_zero` };
  }
  // 其他情況：精準比對剩餘天數
  if (daysDiff === rule.value) {
    return { fire: true, reason: `days_diff_eq_${rule.value}` };
  }
  return { fire: false, reason: `days_diff=${daysDiff}_not_match_${rule.value}` };
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideOnExpiry(rule, ctx) {
  void rule;
  return ctx.daysDiff === 0
    ? { fire: true, reason: 'on_expiry_day' }
    : { fire: false, reason: `days_diff=${ctx.daysDiff}_not_today` };
}

/**
 * @param {ReminderRule} rule
 * @param {FireContext} ctx
 * @returns {FireDecision}
 */
function decideAfterExpiry(rule, ctx) {
  if (ctx.daysDiff >= 0) return { fire: false, reason: 'not_expired_yet' };

  // 未設定 repeatInterval → 僅在到期當天／到期後某個時間點觸發一次（此處採每天一次）
  // 一般用法：repeatInterval > 0
  const interval = Number.isFinite(rule.repeatInterval) && rule.repeatInterval > 0
    ? rule.repeatInterval
    : 24;

  if (!ctx.lastFireAtIso) {
    return { fire: true, reason: 'after_expiry_first_fire' };
  }

  const last = new Date(ctx.lastFireAtIso).getTime();
  const now = ctx.nowIso ? new Date(ctx.nowIso).getTime() : Date.now();
  if (Number.isNaN(last) || Number.isNaN(now)) {
    return { fire: true, reason: 'invalid_last_fire_assume_due' };
  }

  const elapsedHours = (now - last) / (3600 * 1000);
  if (elapsedHours >= interval) {
    return { fire: true, reason: `after_expiry_interval_${interval}h_elapsed` };
  }
  return { fire: false, reason: `after_expiry_within_${interval}h_window` };
}

/**
 * 計算規則下次觸發的時間（ISO 字串）。
 *
 * @param {ReminderRule} rule
 * @param {string} expiryDateIso 訂閱到期日 ISO
 * @param {string} [nowIso] 目前時間 ISO（預設 now）
 * @returns {string|null} 下次觸發的 ISO 時間，或 null（規則已停用／不再觸發）
 */
export function getNextFireTime(rule, expiryDateIso, nowIso) {
  if (!rule || rule.isEnabled === false) return null;

  const expiry = new Date(expiryDateIso).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  // 無效的目前時間不可繼續計算，否則 after_expiry 可能產生 NaN 並在 toISOString 時拋錯。
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return null;

  const MS_HOUR = 3600_000;
  const MS_DAY = 86400_000;

  if (rule.type === 'before_expiry') {
    let fireAt;
    if (rule.unit === 'hours') {
      fireAt = expiry - rule.value * MS_HOUR;
    } else {
      fireAt = expiry - rule.value * MS_DAY;
    }
    return fireAt >= now ? new Date(fireAt).toISOString() : null;
  }

  if (rule.type === 'on_expiry') {
    return expiry >= now ? new Date(expiry).toISOString() : null;
  }

  if (rule.type === 'after_expiry') {
    if (now < expiry) return new Date(expiry).toISOString();
    const interval = (rule.repeatInterval && rule.repeatInterval > 0) ? rule.repeatInterval : 24;
    const elapsed = now - expiry;
    const periods = Math.ceil(elapsed / (interval * MS_HOUR));
    const nextFire = expiry + periods * interval * MS_HOUR;
    return new Date(nextFire).toISOString();
  }

  return null;
}
