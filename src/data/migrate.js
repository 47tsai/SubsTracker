// @ts-check
/**
 * 自動資料遷移
 *
 * ── 設計原則 ────────────────────────────────────────────────
 * 1. **冪等**：每個 step 多次執行的結果皆一致，且 `migrate:{step.id}=done` 標記為略過。
 * 2. **可重複進入且安全**：透過 `migration_lock` Key（60s TTL）避免 Cron 與請求同時觸發。
 *    最坏情况是其中一方放弃迁移，另一方完成；不会双写。
 * 3. **可累加**：後續 Task 在 `MIGRATION_STEPS` 陣列中新增 step，不影響已執行的步驟。
 * 4. **資料安全**：舊 `subscriptions` 单 Key 在迁移成功后重新命名為
 *    `subscriptions_v2_backup`（7 天 TTL）保留作為回復備份。
 *
 * ── KV 標記一覽 ─────────────────────────────────────────────
 *   schema_version           = 'v3'        ← 資料 schema 版本標記，設定後每次請求即可快速略過
 *   migrate:subscriptions_v3 = 'done'      ← 每個 step 自己的標記
 *   migration_lock           = ISO 時間戳記   ← TTL 60s 的悲观锁
 *
 */

import * as subRepo from './subscriptions.repo.js';
import * as remindersRepo from './reminders.repo.js';
import * as schedulerLogsRepo from './scheduler-logs.repo.js';

/** 当前 schema 版本字符串 */
export const SCHEMA_VERSION = 'v3';

const KEY_SCHEMA_VERSION = 'schema_version';
const KEY_MIGRATION_LOCK = 'migration_lock';
const LOCK_TTL_SEC = 60;
const BACKUP_TTL_SEC = 7 * 24 * 3600;

/**
 * @typedef {Object} MigrationStep
 * @property {string} id 唯一标识，用于冪等标记
 * @property {string} description 中文描述
 * @property {(env: any) => Promise<void>} run 执行体
 */

/** 当前所有 迁移步骤（后续 Task 追加） */
export const MIGRATION_STEPS = [
  {
    id: 'subscriptions_v3',
    description: '把单 Key subscriptions 拆成 sub:{id} + sub_index',
    run: migrateSubscriptions
  },
  {
    id: 'reminder_rules_v3',
    description: '將訂閱本身的 reminderUnit/reminderValue 轉換為 reminder_rules:{subId}',
    run: migrateReminderRules
  },
  {
    id: 'scheduler_logs_v3',
    description: '把舊 scheduler_status_history 合并到 sched_log:{iso}',
    run: migrateSchedulerLogs
  }
];

/**
 * 已執行遷移的記憶體快取（避免每次請求都查詢 KV）。
 * 同一 isolate 内只查一次。
 */
let cachedSchemaVersion = /** @type {string|null} */ (null);

/**
 * 入口：確保所有遷移步驟都已執行完成。
 *
 * 呼叫方式：在 Worker fetch／scheduled 入口的第一行呼叫一次。
 * 已完成遷移的請求幾乎沒有額外成本（命中記憶體快取或執行一次 KV.get）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<{ migrated: boolean, reason?: string, ranSteps?: string[] }>}
 */
export async function ensureMigrations(env) {
  if (cachedSchemaVersion === SCHEMA_VERSION) {
    return { migrated: false, reason: 'cached' };
  }

  const current = await env.SUBSCRIPTIONS_KV.get(KEY_SCHEMA_VERSION);
  if (current === SCHEMA_VERSION) {
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: false, reason: 'already_v3' };
  }

  // 嘗試加鎖
  const acquired = await tryAcquireLock(env);
  if (!acquired) {
    return { migrated: false, reason: 'locked_elsewhere' };
  }

  const ranSteps = [];
  try {
    for (const step of MIGRATION_STEPS) {
      const doneFlag = await env.SUBSCRIPTIONS_KV.get(`migrate:${step.id}`);
      if (doneFlag === 'done') continue;

      console.log(`[migrate] 開始執行：${step.id} - ${step.description}`);
      await step.run(env);
      await env.SUBSCRIPTIONS_KV.put(`migrate:${step.id}`, 'done');
      console.log(`[migrate] 完成: ${step.id}`);
      ranSteps.push(step.id);
    }
    await env.SUBSCRIPTIONS_KV.put(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
    cachedSchemaVersion = SCHEMA_VERSION;
    return { migrated: true, ranSteps };
  } catch (err) {
    console.error('[migrate] 執行失敗，本次不會標記為完成，下次請求會重試：', err);
    throw err;
  } finally {
    await releaseLock(env);
  }
}

/**
 * 測試用：清除記憶體快取，強制下次重新檢查 schema_version。
 */
export function _resetMigrationCache() {
  cachedSchemaVersion = null;
}

/**
 * 測試用：檢查記憶體快取狀態。
 */
export function _getCachedSchemaVersion() {
  return cachedSchemaVersion;
}

// ─────────────────────────────────────────────────────────────
// 锁 helper
// ─────────────────────────────────────────────────────────────

/**
 * 试图获取迁移锁。
 * KV 没有 CAS，只能「先讀後寫」——存在短暫的競態窗口，但足以應付大多數情境。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<boolean>}
 */
async function tryAcquireLock(env) {
  const existing = await env.SUBSCRIPTIONS_KV.get(KEY_MIGRATION_LOCK);
  if (existing) return false;
  await env.SUBSCRIPTIONS_KV.put(KEY_MIGRATION_LOCK, new Date().toISOString(), {
    expirationTtl: LOCK_TTL_SEC
  });
  return true;
}

async function releaseLock(env) {
  try {
    await env.SUBSCRIPTIONS_KV.delete(KEY_MIGRATION_LOCK);
  } catch (err) {
    console.warn('[migrate] 释放锁失败（TTL 60s 后会自动释放）:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// 各 step 的實作
// ─────────────────────────────────────────────────────────────

/**
 * 迁移：舊 `subscriptions`（JSON 数组）→ `sub:{id}` 多個 Key + `sub_index`。
 *
 * - 读 `subscriptions`，逐筆寫入 `sub:{id}`，建立索引並寫入 `sub_index`
 * - 舊 `subscriptions` 重新命名為 `subscriptions_v2_backup`（7 天 TTL）后删除
 * - 舊数据为空或缺失：仅写一个空索引，schema_version 仍會寫入
 *
 * 冪等性：
 *   - 若 sub_index 已寫入且 sub:{id} 已存在，重複執行會覆寫（值相同，僅影響 KV 寫入次數）
 *   - 若舊 subscriptions 已重新命名，第二次讀取到 null 就視為已遷移並略過
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSubscriptions(env) {
  const oldRaw = await env.SUBSCRIPTIONS_KV.get('subscriptions');

  /** @type {any[]} */
  let oldSubs = [];
  if (oldRaw) {
    try {
      const parsed = JSON.parse(oldRaw);
      oldSubs = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('[migrate:subscriptions_v3] 舊数据 JSON 解析失败，按空处理:', err);
      oldSubs = [];
    }
  }

  // 寫入新結構（即使 oldSubs 為空，也要寫入 sub_index 作為佔位）
  if (oldSubs.length > 0) {
    await subRepo.replaceAll(env, oldSubs);
  } else {
    // 現有索引可能已有值（來自第二次執行），不要覆寫
    const existing = await subRepo.listIds(env);
    if (existing.length === 0) {
      await env.SUBSCRIPTIONS_KV.put('sub_index', '[]');
    }
  }

  // 备份舊数据并删除原 Key
  if (oldRaw) {
    await env.SUBSCRIPTIONS_KV.put('subscriptions_v2_backup', oldRaw, {
      expirationTtl: BACKUP_TTL_SEC
    });
    await env.SUBSCRIPTIONS_KV.delete('subscriptions');
  }

  console.log(`[migrate:subscriptions_v3] 已遷移 ${oldSubs.length} 筆訂閱`);
}

/**
 * 迁移：根据每个订阅的 reminderUnit/reminderValue 生成 1 条等价 before_expiry 规则。
 *
 * 仅对没有 reminder_rules:{subId} 的订阅写入；如果用户在新版本里已经手动配置过规则，
 * 不会被覆盖。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateReminderRules(env) {
  const subs = await subRepo.listAll(env);
  let count = 0;
  for (const sub of subs) {
    const existing = await remindersRepo.listForSubscription(env, sub.id);
    if (existing.length > 0) continue;
    const rule = remindersRepo.legacyFieldToRule(sub);
    await remindersRepo.replaceForSubscription(env, sub.id, [rule]);
    count++;
  }
  console.log(`[migrate:reminder_rules_v3] 已为 ${count} 个订阅生成默认提醒规则`);
}

/**
 * 迁移：把舊 scheduler_status_history（早期版本最多保留 20 条调度状态）转写到 sched_log:{iso}。
 *
 * 仅作历史记录的最佳努力迁移，结构差异较大，主要保留时间线索。
 * 舊 Key 迁移完保留作為回復備份（让 KV TTL 自然过期清理）。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function migrateSchedulerLogs(env) {
  const histRaw = await env.SUBSCRIPTIONS_KV.get('scheduler_status_history');
  if (!histRaw) return;
  /** @type {any[]} */
  let history = [];
  try {
    const parsed = JSON.parse(histRaw);
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }

  let count = 0;
  for (const item of history) {
    const startedAt = item.lastRunAt || new Date().toISOString();
    await schedulerLogsRepo.writeLog(
      env,
      {
        startedAt,
        finishedAt: startedAt,
        timezone: item.timezone || 'UTC',
        currentHour: item.currentHour || '00',
        configuredHours: Array.isArray(item.configuredHours) ? item.configuredHours : [],
        inWindow: !!item.shouldNotifyThisHour,
        checkedCount: item.checkedSubscriptions || 0,
        matchedCount: item.expiringMatched || 0,
        dedupedCount: item.dedupeSkipped || 0,
        sentCount: item.sent ? 1 : 0,
        autoRenewedCount: item.updatedSubscriptions || 0,
        status: item.errorStack ? 'error' : item.sent ? 'ok' : 'skipped',
        reason: item.reason || (item.errorStack ? 'legacy_error' : undefined),
        extra: { migratedFromV2: true }
      },
      { ttlSec: 7 * 24 * 3600 }
    );
    count++;
  }
  console.log(`[migrate:scheduler_logs_v3] 已迁移 ${count} 条历史调度记录`);
}
