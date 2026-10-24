// @ts-check
/**
 * 時區核心模組
 *
 * ── 設計原則 ────────────────────────────────────────────────
 * 1. 資料儲存層：所有日期一律使用 ISO 8601 UTC 字串（例如 "2026-05-24T17:30:00.000Z"）
 * 2. 業務邏輯層：判斷「通知時段」與「剩餘天數」前，先將 UTC 時刻轉換成使用者設定時區的日期分量
 *    年／月／日／時；本模組是此層的唯一可信來源
 * 3. 顯示層：所有顯示給使用者的日期都走 formatLocalDate / formatTimezoneDisplay
 *
 * ── 關鍵設計 ────────────────────────────────────────────
 * - 舊版 getCurrentTimeInTimezone() 只 `return new Date()`，把"目前的 UTC 時刻"
 *   偽裝成「使用者當地時間」物件回傳；呼叫端將它當成與時區相關的 Date 使用，導致
 *   嚴重誤用（#52／#91／#166）。本版本改為：
 *   - 保留 getCurrentTimeInTimezone(tz) 作為相容 wrapper（回傳原生 Date，也就是 UTC 時刻）
 *   - 新增 getNowInTimezone(tz)，回傳結構 {utc, parts, hourString, isoLocal}
 *     要求呼叫端明確選擇要使用 UTC 時刻，或使用者時區下的日期欄位
 * - 新增 getDaysBetween(fromIso, toIso, tz) 依「使用者時區各自的午夜」計算整天數差，
 *   修正「凌晨 0–8 點建立訂閱時，預設日期變成前一天」的 #166 問題
 * - 所有公開函式皆有 JSDoc 標註與中文用途說明，並由 // @ts-check 協助檢查
 *
 */

/** 一小時的毫秒數 */
export const MS_PER_HOUR = 1000 * 60 * 60;
/** 一天的毫秒數 */
export const MS_PER_DAY = MS_PER_HOUR * 24;

/**
 * @typedef {Object} TimezoneDateParts 指定時區下的日期分量
 * @property {number} year 年（4 位整數）
 * @property {number} month 月（1-12）
 * @property {number} day 日（1-31）
 * @property {number} hour 小時（0-23）
 * @property {number} minute 分（0-59）
 * @property {number} second 秒（0-59）
 */

/**
 * @typedef {Object} TimezoneNow 目前時刻在指定時區下的完整快照
 * @property {Date} utc 原生 Date（UTC 時刻，等同於 new Date()）
 * @property {TimezoneDateParts} parts 該時刻在 timezone 下的年、月、日、時、分、秒
 * @property {string} hourString parts.hour 的兩位數字字串（例如 "08"），排程器可直接用來比對通知時段
 * @property {string} isoLocal "YYYY-MM-DDTHH:mm:ss" 的當地時間表示（不含時區後綴，用於顯示）
 * @property {string} timezone 實際生效的時區（無效時回退至 'UTC'）
 */

/**
 * 判斷字串是否為有效的 IANA 時區。
 *
 * @param {string} timezone
 * @returns {boolean}
 */
export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 取得安全可用時區字串的備援函式。
 *
 * @param {string=} timezone 使用者傳入的時區
 * @returns {string} 合法的 IANA 時區；無效時回傳 'UTC'
 */
function safeTimezone(timezone) {
  if (timezone && isValidTimezone(timezone)) return timezone;
  return 'UTC';
}

/**
 * 將 Date／ISO 字串／時間戳記轉換為目標時區的年月日時分秒。
 *
 * 内部用 Intl.DateTimeFormat（en-US 12h=false）解析，無須手動處理 DST／夏令時間。
 *
 * @param {Date | string | number} date
 * @param {string} [timezone='UTC']
 * @returns {TimezoneDateParts}
 */
export function getTimezoneDateParts(date, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    // 輸入無效時，回傳目前時間作為備援
    return getTimezoneDateParts(new Date(), tz);
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const pick = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? Number(part.value) : 0;
    };
    let hour = pick('hour');
    // Intl 在部分執行環境中對 24 與 0 的顯示不一致，統一正規化為 0–23
    if (hour === 24) hour = 0;
    return {
      year: pick('year'),
      month: pick('month'),
      day: pick('day'),
      hour,
      minute: pick('minute'),
      second: pick('second')
    };
  } catch {
    // 極少數 runtime 不支援該時區時，改用 UTC
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds()
    };
  }
}

/**
 * 取得「目前時刻」在指定時區下的完整快照。
 *
 * 業務程式碼請優先使用本函式，而非 `getCurrentTimeInTimezone`，
 * 本函式會明確提供以下資訊：
 * - utc：原生 UTC Date（用於儲存及計算時間差）
 * - parts.hour：你設定的時區下的目前小時（用於通知時段判斷）
 * - hourString：可直接與 NOTIFICATION_HOURS 字串陣列比對
 *
 * @param {string} [timezone='UTC']
 * @param {Date} [now] 可選擇注入目前時間（測試用）
 * @returns {TimezoneNow}
 */
export function getNowInTimezone(timezone = 'UTC', now) {
  const tz = safeTimezone(timezone);
  const utc = now instanceof Date ? new Date(utcMillis(now)) : new Date();
  const parts = getTimezoneDateParts(utc, tz);
  const hourString = String(parts.hour).padStart(2, '0');
  const isoLocal = formatPartsAsIsoLocal(parts);
  return { utc, parts, hourString, isoLocal, timezone: tz };
}

/**
 * 取得指定時刻在指定時區下的小時（兩位數字字串）。
 *
 * 專供排程器判斷「目前是否為允許傳送通知的時段」。
 *
 * @param {Date | string | number} [date]
 * @param {string} [timezone='UTC']
 * @returns {string} "00" – "23"
 */
export function getTimezoneHourString(date, timezone = 'UTC') {
  const d = date == null ? new Date() : date;
  const parts = getTimezoneDateParts(d, timezone);
  return String(parts.hour).padStart(2, '0');
}

/**
 * 計算 from → to 在指定時區下「跨過幾個當地午夜」的整天數。
 *
 * 例：
 *   from = "2026-05-24T16:00:00Z"  to = "2026-05-25T16:00:00Z"  tz=UTC
 *   → 1 天
 *
 *   from = "2026-05-24T16:00:00Z"  to = "2026-05-25T16:00:00Z"  tz=Asia/Shanghai
 *   → 1 天（當地 24:00 → 次日 00:00）
 *
 *   from = "2026-05-24T20:00:00Z"  to = "2026-05-24T22:00:00Z"  tz=Asia/Shanghai
 *   → 0 天（當地 04:00 → 同日 06:00）
 *
 * 若 to < from，則回傳負數。
 *
 * @param {Date | string | number} from
 * @param {Date | string | number} to
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getDaysBetween(from, to, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const fromMid = getTimezoneMidnightTimestamp(from, tz);
  const toMid = getTimezoneMidnightTimestamp(to, tz);
  return Math.round((toMid - fromMid) / MS_PER_DAY);
}

/**
 * 計算指定時刻在指定時區下「午夜」對應的 UTC 時間戳記。
 *
 * 例：date=2026-05-24T15:30:00Z、tz=Asia/Shanghai → 北京時間 2026-05-24 23:30
 *     → 當日北京零點 = 2026-05-24T16:00:00Z (因為北京 00:00 = UTC 前一天 16:00)
 *     → 回傳 1748015200000
 *
 * @param {Date | string | number} date
 * @param {string} [timezone='UTC']
 * @returns {number} UTC 毫秒時間戳記
 */
export function getTimezoneMidnightTimestamp(date, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const inputDate = date instanceof Date ? date : new Date(date);
  // 無效日期不可交給 getTimezoneDateParts，否則會被當成「現在」而產生錯誤的日期差。
  if (!Number.isFinite(inputDate.getTime())) return Number.NaN;
  const { year, month, day } = getTimezoneDateParts(inputDate, tz);
  // 透過反推：時區下 (year,month,day) 0:00 对应的 UTC 时刻
  // 演算法：建立一個暫時的 UTC 時刻 t0 = Date.UTC(y,m-1,d), 求它在 時區下的偏移分鐘數 offsetMin,
  //      则 時區下零点的 UTC ms = t0 - offsetMin*60_000
  const t0 = Date.UTC(year, month - 1, day, 0, 0, 0);
  const probeParts = getTimezoneDateParts(new Date(t0), tz);
  const probeAsUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    probeParts.second
  );
  const offsetMs = probeAsUtc - t0;
  return t0 - offsetMs;
}

/**
 * 把日期分量拼成 "YYYY-MM-DDTHH:mm:ss" 本地表示。
 *
 * @param {TimezoneDateParts} parts
 * @returns {string}
 */
function formatPartsAsIsoLocal(parts) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/**
 * 把日期分量拼成 "YYYY-MM-DD"。
 *
 * @param {{ year: number, month: number, day: number }} parts
 * @returns {string}
 */
function formatPartsAsDateOnly(parts) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * 將 Date 轉換為 UTC 毫秒整數（相容 Date 與時間戳記）。
 *
 * @param {Date | number} d
 * @returns {number}
 */
function utcMillis(d) {
  return d instanceof Date ? d.getTime() : Number(d);
}

/**
 * 依目標時區的當地日期欄位，反推出對應的 UTC 時間戳記。
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} parts
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getTimestampForTimezoneParts(parts, timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour || 0);
  const minute = Number(parts.minute || 0);
  const second = Number(parts.second || 0);

  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return Number.NaN;
  }

  const t0 = probe.getTime();
  const probeParts = getTimezoneDateParts(probe, tz);
  const probeAsUtc = Date.UTC(
    probeParts.year,
    probeParts.month - 1,
    probeParts.day,
    probeParts.hour,
    probeParts.minute,
    probeParts.second
  );
  const offsetMs = probeAsUtc - t0;
  return t0 - offsetMs;
}

/**
 * 將 "YYYY-MM-DD" 日期輸入解讀為指定時區的當地午夜。
 *
 * 若輸入為完整 ISO／時間戳記，則保留其絕對時刻語意並直接解析。
 *
 * @param {Date | string | number} value
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function parseDateInputInTimezone(value, timezone = 'UTC') {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const ts = getTimestampForTimezoneParts(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: 0,
          minute: 0,
          second: 0
        },
        timezone
      );
      return new Date(ts);
    }
  }
  return new Date(value);
}

/**
 * 將指定時刻格式化為指定時區的日期輸入值 "YYYY-MM-DD"。
 *
 * @param {Date | string | number} value
 * @param {string} [timezone='UTC']
 * @returns {string}
 */
export function formatDateInputInTimezone(value, timezone = 'UTC') {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return formatPartsAsDateOnly(getTimezoneDateParts(d, timezone));
}

/**
 * 取得指定時區的「今天」（YYYY-MM-DD）。
 *
 * @param {string} [timezone='UTC']
 * @param {Date} [now]
 * @returns {string}
 */
export function getTodayDateStringInTimezone(timezone = 'UTC', now) {
  const current = getNowInTimezone(timezone, now);
  return formatPartsAsDateOnly(current.parts);
}

/**
 * 依指定時區的當地日期語意增加日／月／年週期，並回傳新時刻（當地午夜）。
 *
 * @param {Date | string | number} value
 * @param {number} amount
 * @param {'day'|'month'|'year'} unit
 * @param {string} [timezone='UTC']
 * @param {{ endOfMonth?: boolean }} [options] endOfMonth=true 時（僅限國曆 month）落在目標月份的最後一天
 * @returns {Date}
 */
export function addCalendarPeriodInTimezone(value, amount, unit, timezone = 'UTC', options = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date(Number.NaN);

  const parts = getTimezoneDateParts(d, timezone);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;

  if (unit === 'day') {
    const temp = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    temp.setUTCDate(temp.getUTCDate() + amount);
    year = temp.getUTCFullYear();
    month = temp.getUTCMonth() + 1;
    day = temp.getUTCDate();
  } else if (unit === 'month') {
    // 先移至目標月份，再用 day=0 取月末，或保留原日期（JS overflow 行为）
    const targetMonthIndex = month - 1 + amount;
    if (options && options.endOfMonth) {
      // 目標月份的最後一天：下個月的第 0 天
      const last = new Date(Date.UTC(year, targetMonthIndex + 1, 0));
      year = last.getUTCFullYear();
      month = last.getUTCMonth() + 1;
      day = last.getUTCDate();
    } else {
      const temp = new Date(Date.UTC(year, targetMonthIndex, day, 0, 0, 0));
      // 若溢出到下月（如 1/31 + 1 月），限制為目標月份的最後一天，更符合「同日續訂」的預期
      // 此處維持與舊版 JS setUTCMonth 一致：允許日期溢位，避免改變既有使用者行為
      year = temp.getUTCFullYear();
      month = temp.getUTCMonth() + 1;
      day = temp.getUTCDate();
    }
  } else if (unit === 'year') {
    if (options && options.endOfMonth && month === 2 && day >= 28) {
      // 年末月份的情境較少見；仍先推進年份，再取得該月最後一天
      const last = new Date(Date.UTC(year + amount, month, 0));
      year = last.getUTCFullYear();
      month = last.getUTCMonth() + 1;
      day = last.getUTCDate();
    } else {
      const temp = new Date(Date.UTC(year + amount, month - 1, day, 0, 0, 0));
      year = temp.getUTCFullYear();
      month = temp.getUTCMonth() + 1;
      day = temp.getUTCDate();
    }
  }

  const ts = getTimestampForTimezoneParts(
    {
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0
    },
    timezone
  );
  return new Date(ts);
}

/**
 * 依指定時區格式化日期。
 *
 * 不同 fmt 的用途：
 * - 'date'      → "2026/05/24"
 * - 'datetime'  → "2026/05/24 17:30:00"
 * - 'full'（預設）→ 包含星期等資訊的完整在地化字串
 * - 'isoLocal' → "2026-05-24T17:30:00"（不含時區後綴）
 *
 * @param {Date | string | number} time
 * @param {string} [timezone='UTC']
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatLocalDate(time, timezone = 'UTC', format = 'full') {
  const tz = safeTimezone(timezone);
  const d = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(d.getTime())) return '';

  if (format === 'isoLocal') {
    return formatPartsAsIsoLocal(getTimezoneDateParts(d, tz));
  }

  try {
    if (format === 'date') {
      return d.toLocaleDateString('zh-TW', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }
    if (format === 'datetime') {
      return d.toLocaleString('zh-TW', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    }
    return d.toLocaleString('zh-TW', { timeZone: tz });
  } catch {
    return d.toISOString();
  }
}

/**
 * 同 formatLocalDate，保留原命名以相容舊呼叫端。
 *
 * @param {Date | string | number} time
 * @param {string} [timezone='UTC']
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatTimeInTimezone(time, timezone = 'UTC', format = 'full') {
  return formatLocalDate(time, timezone, format);
}

/**
 * 計算時區相對 UTC 的整數小時偏移（夏令時間以目前時刻的偏移為準）。
 *
 * @param {string} [timezone='UTC']
 * @returns {number} 偏移小時數（例如 +8 表示 UTC+8）
 */
export function getTimezoneOffset(timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  try {
    const now = new Date();
    const parts = getTimezoneDateParts(now, tz);
    const zoned = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    // 使用 `+ 0` 正規化 -0 为 +0，避免 Object.is 比較時產生問題
    return Math.round((zoned - now.getTime()) / MS_PER_HOUR) + 0;
  } catch {
    return 0;
  }
}

/**
 * 產生時區顯示文字。
 *
 * 例：formatTimezoneDisplay('Asia/Shanghai') → "中國標準時間 (UTC+8)"
 *
 * @param {string} [timezone='UTC']
 * @returns {string}
 */
export function formatTimezoneDisplay(timezone = 'UTC') {
  const tz = safeTimezone(timezone);
  try {
    const offset = getTimezoneOffset(tz);
    const offsetStr = offset >= 0 ? `+${offset}` : `${offset}`;
    const names = {
      UTC: '世界標準時間',
      'Asia/Shanghai': '中國標準時間',
      'Asia/Hong_Kong': '香港時間',
      'Asia/Taipei': '台灣時間',
      'Asia/Singapore': '新加坡時間',
      'Asia/Tokyo': '日本時間',
      'Asia/Seoul': '韓國時間',
      'America/New_York': '美國東部時間',
      'America/Los_Angeles': '美國太平洋時間',
      'America/Chicago': '美國中部時間',
      'America/Denver': '美國山地時間',
      'Europe/London': '英國時間',
      'Europe/Paris': '巴黎時間',
      'Europe/Berlin': '柏林時間',
      'Europe/Moscow': '莫斯科時間',
      'Australia/Sydney': '雪梨時間',
      'Australia/Melbourne': '墨爾本時間',
      'Pacific/Auckland': '奧克蘭時間'
    };
    const cn = names[tz] || tz;
    return `${cn} (UTC${offsetStr})`;
  } catch {
    return tz;
  }
}

/**
 * 北京時間快捷格式化函式。
 *
 * @param {Date | string | number} [date=new Date()]
 * @param {'date'|'datetime'|'full'|'isoLocal'} [format='full']
 * @returns {string}
 */
export function formatBeijingTime(date = new Date(), format = 'full') {
  return formatLocalDate(date, 'Asia/Shanghai', format);
}

/**
 * 從請求中推斷時區：query > Header > Accept-Language。
 *
 * 注意：本版本前端展示用的是 config.TIMEZONE（使用者設定的時區），
 * 此函式主要用於 API 相容情境。
 *
 * @param {Request} request
 * @returns {string}
 */
export function extractTimezone(request) {
  try {
    const url = new URL(request.url);
    const tzParam = url.searchParams.get('timezone');
    if (tzParam && isValidTimezone(tzParam)) return tzParam;

    const tzHeader = request.headers.get('X-Timezone');
    if (tzHeader && isValidTimezone(tzHeader)) return tzHeader;

    const accept = request.headers.get('Accept-Language') || '';
    if (accept.includes('zh')) return 'Asia/Shanghai';
    if (accept.includes('en-US')) return 'America/New_York';
    if (accept.includes('en-GB')) return 'Europe/London';
  } catch {
    /* noop */
  }
  return 'UTC';
}

// ─────────────────────────────────────────────────────────────
// 相容層（僅供舊呼叫端使用，新程式碼請使用上方的 getNowInTimezone）
// ─────────────────────────────────────────────────────────────

/**
 * 相容舊呼叫：回傳目前 UTC 時刻的 Date。
 *
 * 舊 API 名稱容易誤導（"InTimezone"），實際語意是「目前時刻」。
 * 後續 Task 會將所有呼叫端遷移至 getNowInTimezone。
 *
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function getCurrentTimeInTimezone(timezone = 'UTC') {
  void timezone; // 僅作為佔位以維持函式簽章；Date 本身就是 UTC 时刻
  return new Date();
}

/**
 * 相容舊呼叫：回傳目前 UTC 毫秒時間戳記。
 *
 * @param {string} [timezone='UTC']
 * @returns {number}
 */
export function getTimestampInTimezone(timezone = 'UTC') {
  void timezone;
  return Date.now();
}

/**
 * 相容舊呼叫：將 UTC 時刻「轉換至」目標時區。
 *
 * 注意：這是個語意陷阱——Date 本身永遠代表 UTC 時刻（絕對時刻），
 * 「轉換至」另一個時區只影響顯示，不影響 Date 實例。本函式僅回傳原 Date 的複本。
 *
 * @param {Date | string | number} utcTime
 * @param {string} [timezone='UTC']
 * @returns {Date}
 */
export function convertUTCToTimezone(utcTime, timezone = 'UTC') {
  void timezone;
  return utcTime instanceof Date ? new Date(utcTime.getTime()) : new Date(utcTime);
}
