// @ts-check
/**
 * 通知紀錄儲存庫
 *
 * 用途：每次傳送通知（成功／失敗）都會記錄一筆；用於「通知歷史」頁面及
 * 「為什麼沒收到通知」自助排查。
 *
 * Key 規則：
 *   notify_log:{ymdh}:{subId}:{ruleId}:{channel}
 *     ymdh    = "YYYYMMDDHH"（UTC，方便依時間區間列出）
 *     subId   = 訂閱 ID
 *     ruleId  = 觸發的規則 ID（手動觸發可填 'manual'，第三方 API 可填 'thirdparty'）
 *     channel = 通知管道（telegram, bark, ...）
 *
 *   一筆 KV 同時也會將資料存入 metadata ymdhmsRand，避免同一小時內重複 key 覆蓋。
 *
 * 預設 TTL：30 天，到期後自動清理。失敗紀錄可單獨設定更長的 TTL（这里统一 30 天即可，
 * 後續如有需要可改為 writeLog 接受 ttl 參數）。
 *
 */

const PREFIX = 'notify_log:';
const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/**
 * @typedef {Object} NotifyLogEntry
 * @property {string} key 完整 KV key
 * @property {string} timestamp ISO 時間
 * @property {string} subId
 * @property {string|null} ruleId 觸發規則；手動／第三方為佔位字串
 * @property {string} channel
 * @property {'success'|'failed'} status
 * @property {string} [title]
 * @property {string} [content]
 * @property {string} [error] 失敗原因
 * @property {any} [raw] 第三方原始回應，方便排查
 */

/**
 * 把 Date 转成 'YYYYMMDDHH' UTC 字符串。
 *
 * @param {Date | string | number} date
 * @returns {string}
 */
export function ymdhUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return ymdhUtc(new Date());
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

/**
 * 寫入一筆通知紀錄。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {{
 *   subId: string,
 *   ruleId?: string|null,
 *   channel: string,
 *   status: 'success'|'failed',
 *   title?: string,
 *   content?: string,
 *   error?: string,
 *   raw?: any,
 *   timestamp?: string|Date|number,
 *   ttlSec?: number
 * }} entry
 * @returns {Promise<NotifyLogEntry>}
 */
export async function writeLog(env, entry) {
  const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
  // 使用隨機後綴，避免同一毫秒內相同訂閱／規則／管道的紀錄互相覆蓋。
  // 只用時間戳記取餘數會在同一毫秒重複，導致紀錄遺失。
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const ruleId = entry.ruleId || 'none';
  const key = `${PREFIX}${ymdhUtc(ts)}:${entry.subId}:${ruleId}:${entry.channel}:${rand}`;

  const stored = {
    timestamp: ts.toISOString(),
    subId: entry.subId,
    ruleId,
    channel: entry.channel,
    status: entry.status,
    title: entry.title,
    content: entry.content,
    error: entry.error,
    raw: entry.raw
  };

  await env.SUBSCRIPTIONS_KV.put(key, JSON.stringify(stored), {
    expirationTtl: Math.max(60, entry.ttlSec || DEFAULT_TTL_SEC)
  });

  return { key, ...stored };
}

/**
 * 查詢通知紀錄。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {{
 *   subId?: string,
 *   channel?: string,
 *   status?: 'success'|'failed',
 *   since?: string|Date|number,
 *   until?: string|Date|number,
 *   limit?: number
 * }} [filter]
 * @returns {Promise<NotifyLogEntry[]>}
 */
export async function query(env, filter = {}) {
  const limit = Math.min(500, Math.max(1, filter.limit || 100));

  // KV.list 僅支援前綴，無法依多個欄位篩選，因此先載入記憶體再篩選
  const all = [];
  let cursor;
  do {
    const res = await env.SUBSCRIPTIONS_KV.list({
      prefix: PREFIX,
      cursor,
      limit: 1000
    });
    for (const k of res.keys) all.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && all.length < 5000);

  // 依 key 字典序倒序，即時間倒序（因为 ymdh 在前缀后）
  all.sort((a, b) => b.localeCompare(a));

  const sinceTs = filter.since ? new Date(filter.since).getTime() : 0;
  const untilTs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY;

  const out = [];
  for (const key of all) {
    if (out.length >= limit) break;
    const raw = await env.SUBSCRIPTIONS_KV.get(key);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (filter.subId && obj.subId !== filter.subId) continue;
      if (filter.channel && obj.channel !== filter.channel) continue;
      if (filter.status && obj.status !== filter.status) continue;
      const tsMs = new Date(obj.timestamp).getTime();
      if (tsMs < sinceTs || tsMs > untilTs) continue;
      out.push({ key, ...obj });
    } catch {
      /* skip */
    }
  }

  return out;
}

/**
 * 取得某筆訂閱最近 N 筆記錄（儀表板／詳情頁使用）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {number} [limit=20]
 */
export async function recentForSubscription(env, subId, limit = 20) {
  return query(env, { subId, limit });
}
