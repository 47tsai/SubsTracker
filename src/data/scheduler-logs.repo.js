// @ts-check
/**
 * 排程器執行記錄資料庫
 *
 * 用途：每次 Cron `scheduled` 觸發時，都會寫入一筆彙總記錄，包含本次執行的：
 *   - 起訖時間、使用者時區、是否位於通知時段
 *   - 檢查的訂閱總數 / 命中提醒規則數 / 去重略過數
 *   - 自動續訂筆數 / 通知傳送統計
 *   - 錯誤（如有）
 *
 * 配合 notification-logs（细粒度）形成"链路日志"：
 *   sched_log:{isoUtc}                  ← 一次调度的总览
 *   notify_log:{ymdh}:{sub}:{rule}:{ch} ← 該次排程發出的每筆通知
 *
 * Key 規則：sched_log:{ISO_UTC}（如 sched_log:2026-05-24T17:00:00.000Z）
 *   ISO 字典序等於時間順序，方便倒序讀取清單。
 *
 * 預設 TTL：30 天。
 *
 */

const PREFIX = 'sched_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {Object} SchedulerLogEntry
 * @property {string} key 完整 KV key
 * @property {string} startedAt ISO
 * @property {string} finishedAt ISO
 * @property {string} timezone 调度生效时区
 * @property {string} currentHour 使用者時區下的目前小時（"HH"）
 * @property {string[]} configuredHours 通知時段設定（使用者時區小時）
 * @property {boolean} inWindow 是否位於通知時段內
 * @property {number} checkedCount 检查订阅数
 * @property {number} matchedCount 命中規則的（訂閱 × 規則）組數
 * @property {number} dedupedCount 因去重略過數
 * @property {number} sentCount 實際傳送通知數
 * @property {number} autoRenewedCount 自动续订订阅数
 * @property {string} status 'ok' | 'skipped' | 'error'
 * @property {string} [reason] 略過原因或錯誤摘要
 * @property {any} [extra] 附加資訊（選填）
 */

/**
 * 写入一条调度日志。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Omit<SchedulerLogEntry, 'key'>} entry
 * @param {{ ttlSec?: number }} [opts]
 * @returns {Promise<SchedulerLogEntry>}
 */
export async function writeLog(env, entry, opts = {}) {
  const key = PREFIX + (entry.startedAt || new Date().toISOString());
  const stored = {
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    timezone: entry.timezone || 'UTC',
    currentHour: entry.currentHour || '00',
    configuredHours: entry.configuredHours || [],
    inWindow: !!entry.inWindow,
    checkedCount: entry.checkedCount || 0,
    matchedCount: entry.matchedCount || 0,
    dedupedCount: entry.dedupedCount || 0,
    sentCount: entry.sentCount || 0,
    autoRenewedCount: entry.autoRenewedCount || 0,
    status: entry.status || 'ok',
    reason: entry.reason,
    extra: entry.extra
  };
  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, opts.ttlSec || DEFAULT_TTL_SEC)
  });
  return { key, ...stored };
}

/**
 * 取得最近 N 筆排程記錄（依時間倒序）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {number} [limit=20]
 * @returns {Promise<SchedulerLogEntry[]>}
 */
export async function getRecent(env, limit = 20) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));

  // KV.list 預設升序；若要倒序，需先取得全部資料再排序
  const allKeys = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) allKeys.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && allKeys.length < 5000);

  allKeys.sort((a, b) => b.localeCompare(a));
  const top = allKeys.slice(0, safeLimit);
  const items = await Promise.all(
    top.map(async (key) => {
      const raw = await env.SUBSCRIPTIONS_KV.get(key);
      if (!raw) return null;
      try {
        return { key, ...JSON.parse(raw) };
      } catch {
        return null;
      }
    })
  );
  // @ts-ignore - 过滤 null
  return items.filter((x) => x != null);
}
