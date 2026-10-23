// @ts-check
/**
 * 訂閱資料庫存取層
 *
 * ── 設計動機 ────────────────────────────────────────────────
 * 早期實作將所有訂閱存放在同一個 KV key（'subscriptions'）中，每次讀寫都要處理整個陣列，
 * 同時編輯可能造成資料遺失，資料量大時效能也會下降。
 *
 * 改为：
 *   sub_index = JSON 陣列 [id1, id2, ...]    ← 用於快速列舉
 *   sub:{id}  = JSON 物件                     ← 單筆訂閱的完整資料
 *
 * 單筆訂閱的 CRUD 不再操作整個陣列，只寫入 sub:{id}（修改）或 sub_index+sub:{id}（新增／刪除）。
 *
 * ── 並行安全說明 ────────────────────────────────────────────
 * KV 不支援交易，sub_index 的「讀取－修改－寫入」在並行操作下仍可能遺失更新。
 * 在實際使用情境（單一使用者、操作頻率低）下，風險可接受。
 * 資料本體位於 sub:{id}，即使索引未更新，也能透過 KV.list 修復。
 *
 */

const KEY_INDEX = 'sub_index';
const KEY_PREFIX = 'sub:';

/**
 * 讀取訂閱 ID 清單（索引）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<string[]>}
 */
export async function listIds(env) {
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_INDEX);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 写回订阅 ID 列表（索引）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string[]} ids
 */
async function writeIds(env, ids) {
  // 去重保序
  const seen = new Set();
  const deduped = [];
  for (const id of ids) {
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  await env.SUBSCRIPTIONS_KV.put(KEY_INDEX, JSON.stringify(deduped));
}

/**
 * 根据 ID 读取单条订阅。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getById(env, id) {
  if (!id) return null;
  const raw = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[sub-repo] 反序列化失敗：', id, err);
    return null;
  }
}

/**
 * 一次性读取所有订阅（按索引顺序）。
 *
 * 實作：先讀取索引，再透過 Promise.all 並行取得個別訂閱；缺少的項目會被過濾。
 * N 為數十筆時仍可在一秒內完成；若超過千筆，建議分批處理或改用分頁介面。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<Object[]>}
 */
export async function listAll(env) {
  const ids = await listIds(env);
  if (ids.length === 0) return [];
  const items = await Promise.all(ids.map((id) => getById(env, id)));
  // @ts-ignore — 过滤 null
  return items.filter((it) => it != null);
}

/**
 * 保存（创建或更新）一条订阅。
 *
 * - 若 ID 不在索引中：写 sub:{id} 并 append 到索引
 * - 若 ID 已存在：仅写 sub:{id}（不动索引，避免不必要的 RPC）
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object} subscription 必須包含字串型別的 id
 * @returns {Promise<Object>} 寫入後的物件
 */
export async function save(env, subscription) {
  if (!subscription || typeof subscription.id !== 'string' || subscription.id === '') {
    throw new Error('订阅缺少有效 id');
  }
  await env.SUBSCRIPTIONS_KV.put(
    KEY_PREFIX + subscription.id,
    JSON.stringify(subscription)
  );

  const ids = await listIds(env);
  if (!ids.includes(subscription.id)) {
    ids.push(subscription.id);
    await writeIds(env, ids);
  }
  return subscription;
}

/**
 * 批次儲存訂閱（用於自動續訂一次更新多筆等情境）。
 *
 * 保留原有順序；並行寫入各筆資料，最後統一更新索引。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object[]} subs
 */
export async function saveMany(env, subs) {
  if (!Array.isArray(subs) || subs.length === 0) return;
  await Promise.all(
    subs.map((s) => env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s)))
  );
  const idsExisting = await listIds(env);
  const set = new Set(idsExisting);
  for (const s of subs) {
    if (typeof s.id === 'string') set.add(s.id);
  }
  if (set.size !== idsExisting.length) {
    await writeIds(env, Array.from(set));
  }
}

/**
 * 刪除一筆訂閱（並同步從索引中移除）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} id
 * @returns {Promise<boolean>} true 表示确实存在并已删除
 */
export async function deleteById(env, id) {
  if (!id) return false;
  const before = await env.SUBSCRIPTIONS_KV.get(KEY_PREFIX + id);
  if (!before) {
    // 索引里可能仍有残留，顺手清掉
    const ids = await listIds(env);
    if (ids.includes(id)) {
      await writeIds(env, ids.filter((x) => x !== id));
    }
    return false;
  }
  await env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id);
  const ids = await listIds(env);
  if (ids.includes(id)) {
    await writeIds(env, ids.filter((x) => x !== id));
  }
  return true;
}

/**
 * 整个仓库覆盖（用于迁移、导入等场景）。
 *
 * 流程：先清除舊的 sub:{id}（依目前索引），再寫入新資料。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {Object[]} subs
 */
export async function replaceAll(env, subs) {
  const oldIds = await listIds(env);
  await Promise.all(
    oldIds.map((id) => env.SUBSCRIPTIONS_KV.delete(KEY_PREFIX + id))
  );
  if (Array.isArray(subs) && subs.length > 0) {
    await Promise.all(
      subs.map((s) =>
        env.SUBSCRIPTIONS_KV.put(KEY_PREFIX + s.id, JSON.stringify(s))
      )
    );
    await writeIds(env, subs.map((s) => s.id));
  } else {
    await writeIds(env, []);
  }
}
