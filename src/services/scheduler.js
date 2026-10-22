// 註：本檔案暫不啟用 // @ts-check，因 lunar 套件的回傳型別分支較多，型別整理延後處理。
/**
 * 定时任务调度器
 *
 * ── 修复的核心问题（#91 / #52 / #166 根因）─────────────────
 * 旧调度器把"当前 UTC 时刻的小时"当作"用户本地小时"来对比 NOTIFICATION_HOURS，
 * 配合"通知时段语义不一致"的文档表述，造成大量"不响 / 错时响"。
 *
 * 修复：
 * 1. 统一时区基准：通过 getNowInTimezone(config.TIMEZONE) 取用户 TZ 下的 hourString
 *    与 NOTIFICATION_HOURS（按用户 TZ 解释）比对，语义清晰。
 * 2. 多提醒规则：从 reminders.repo 加载每筆訂閱的规则数组，逐条调
 *    reminder-engine.shouldFire 判断（不再单点 reminderUnit/reminderValue）。
 * 3. 去重粒度细化：dedup key 改为 (subId × ruleId × ymdh-local)，避免一条订阅
 *    多规则相互打架。
 * 4. 结构化日志：每次执行写一条 sched_log；每条通知发送（成功/失败）写 notify_log。
 *
 * 数据流：
 *   Cron tick →
 *     ensureMigrations →
 *     load config + subs + rules →
 *     check window →
 *     for each (sub, rule):
 *       - daysDiff/hoursDiff 用 getDaysBetween（按用户 TZ）算
 *       - 自動續訂（针对 sub 整体，仅算一次）
 *       - shouldFire? → dedupe → dispatch.send → notify_log
 *     → sched_log
 *
 */

import { getConfig } from '../data/config.js';
import { getAllSubscriptions } from '../data/subscriptions.js';
import * as subRepo from '../data/subscriptions.repo.js';
import * as remindersRepo from '../data/reminders.repo.js';
import * as schedulerLogsRepo from '../data/scheduler-logs.repo.js';
import {
  MS_PER_HOUR,
  getNowInTimezone,
  getDaysBetween,
  getTimezoneDateParts,
  getTimezoneMidnightTimestamp,
  addCalendarPeriodInTimezone,
  getTimestampForTimezoneParts
} from '../core/time.js';
import { formatNotificationContent } from './notify/reminder.js';
import { dispatch } from './notify/dispatch.js';
import { shouldFire } from './notify/reminder-engine.js';
import { lunarCalendar, lunarBiz } from '../core/lunar.js';

const DEDUPE_TTL_SEC = 60 * 60 * 48; // 48h
const LAST_FIRE_TTL_SEC = 60 * 60 * 24 * 60; // 60 天

/**
 * 日级规则（before_expiry/days、on_expiry）按本地日期去重；小时级与 after_expiry 按本地小时。
 * @param {import('../data/reminders.repo.js').ReminderRule} rule
 * @param {{ year: number, month: number, day: number, hourString: string }} nowParts
 */
function buildDedupeBucket(rule, nowParts) {
  const ymd = `${nowParts.year}${String(nowParts.month).padStart(2, '0')}${String(nowParts.day).padStart(2, '0')}`;
  const isDayRule =
    rule.type === 'on_expiry' ||
    (rule.type === 'before_expiry' && rule.unit !== 'hours');
  return isDayRule ? ymd : `${ymd}${nowParts.hourString}`;
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {string} ruleId
 */
async function readLastFireAt(env, subId, ruleId) {
  return env.SUBSCRIPTIONS_KV.get(`notify_lastfire:${subId}:${ruleId}`);
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} subId
 * @param {string} ruleId
 * @param {string} iso
 */
async function writeLastFireAt(env, subId, ruleId, iso) {
  await env.SUBSCRIPTIONS_KV.put(`notify_lastfire:${subId}:${ruleId}`, iso, {
    expirationTtl: LAST_FIRE_TTL_SEC
  });
}

/**
 * 入口：被 Cron 触发的 scheduled() 调用。
 *
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @returns {Promise<import('../data/scheduler-logs.repo.js').SchedulerLogEntry|null>}
 */
export async function checkExpiringSubscriptions(env) {
  const startedAtIso = new Date().toISOString();
  try {
    const config = await getConfig(env);
    const timezone = config.TIMEZONE || 'UTC';
    const now = getNowInTimezone(timezone);

    const normalizedHours = Array.isArray(config.NOTIFICATION_HOURS)
      ? config.NOTIFICATION_HOURS
          .map((h) => String(h).trim())
          .filter((h) => h.length > 0)
          .map((h) => {
            const up = h.toUpperCase();
            if (up === '*' || up === 'ALL') return '*';
            // 仅对纯数字做两位补齐；'*' 之类通配符保持原样
            return /^\d+$/.test(h) ? h.padStart(2, '0') : up;
          })
      : [];
    const inWindow =
      normalizedHours.length === 0 ||
      normalizedHours.includes('*') ||
      normalizedHours.includes('ALL') ||
      normalizedHours.includes(now.hourString);

    const subscriptions = await getAllSubscriptions(env);
    let activeCount = 0;
    let matchedCount = 0;
    let dedupedCount = 0;
    let sentCount = 0;
    let autoRenewedCount = 0;

    // 不在通知时段：不发送但仍跑自動續訂（业务上希望续订总能发生）
    /** @type {Array<{ sub: any, rule: any, daysDiff: number, hoursDiff: number }>} */
    const candidates = [];

    /** @type {Array<any>} */
    const updatedSubsToSave = [];

    for (const subscription of subscriptions) {
      if (!subscription.isActive) continue;
      activeCount++;

      // 計算到期天數（按用户 TZ）
      let expiryDate = new Date(subscription.expiryDate);
      let daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
      let hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;

      // 自動續訂：已过期 + autoRenew=true → 推进到期日并写支付记录
      if (subscription.autoRenew && daysDiff < 0) {
        const renewed = autoRenew(subscription, now.utc, timezone, config);
        if (renewed) {
          updatedSubsToSave.push(renewed.next);
          autoRenewedCount++;
          // 续订后重算 diff
          expiryDate = new Date(renewed.next.expiryDate);
          daysDiff = getDaysBetween(now.utc, expiryDate, timezone);
          hoursDiff = (expiryDate.getTime() - now.utc.getTime()) / MS_PER_HOUR;
          // 用续订后的对象作后续判断
          subscription.expiryDate = renewed.next.expiryDate;
          subscription.startDate = renewed.next.startDate;
          subscription.lastPaymentDate = renewed.next.lastPaymentDate;
          subscription.paymentHistory = renewed.next.paymentHistory;
        }
      }

      // 載入規則；舊訂閱沒有規則時，使用穩定 ID 的 legacy 規則（避免每次 tick 產生新 UUID 而破壞去重）
      let rules = await remindersRepo.listForSubscription(env, subscription.id);
      if (rules.length === 0) {
        const legacy = remindersRepo.legacyFieldToRule(subscription);
        legacy.id = `legacy:${subscription.id}`;
        rules = [legacy];
      }

      for (const rule of rules) {
        const lastFireAtIso =
          rule.type === 'after_expiry'
            ? (await readLastFireAt(env, subscription.id, rule.id)) || undefined
            : undefined;
        const decision = shouldFire(rule, {
          daysDiff,
          hoursDiff,
          nowIso: now.utc.toISOString(),
          lastFireAtIso
        });
        if (!decision.fire) continue;
        matchedCount++;
        candidates.push({ sub: subscription, rule, daysDiff, hoursDiff });
      }
    }

    // 持久化自動續訂結果
    if (updatedSubsToSave.length > 0) {
      await subRepo.saveMany(env, updatedSubsToSave);
      console.log(`[定时任务] 已自動續訂 ${updatedSubsToSave.length} 筆訂閱`);
    }

    // 不在通知時段 → 寫入紀錄後返回
    if (!inWindow) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: false,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount: 0,
        sentCount: 0,
        autoRenewedCount,
        status: 'skipped',
        reason: `目前 ${timezone} ${now.hourString} 點不在允許傳送的時段 [${normalizedHours.join(',') || '未限制=每小时'}] 内（正常跳过，不会发通知）`
      });
      return entry;
    }

    // 在允許時段內：先檢查是否重複（不預先佔用），傳送成功後再寫入 dedupe／lastFire
    /** @type {Array<{ sub: any, rule: any, daysDiff: number, hoursDiff: number, dedupeKey: string }>} */
    const ready = [];
    const nowParts = {
      year: now.parts.year,
      month: now.parts.month,
      day: now.parts.day,
      hourString: now.hourString
    };
    for (const c of candidates) {
      const bucket = buildDedupeBucket(c.rule, nowParts);
      const dedupeKey = `notify_dedupe:${c.sub.id}:${c.rule.id}:${bucket}`;
      const exists = await env.SUBSCRIPTIONS_KV.get(dedupeKey);
      if (exists) {
        dedupedCount++;
        continue;
      }
      ready.push({ ...c, dedupeKey });
    }

    if (ready.length === 0) {
      const entry = await schedulerLogsRepo.writeLog(env, {
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        timezone,
        currentHour: now.hourString,
        configuredHours: normalizedHours,
        inWindow: true,
        checkedCount: activeCount,
        matchedCount,
        dedupedCount,
        sentCount: 0,
        autoRenewedCount,
        status: matchedCount > 0 ? 'skipped' : 'ok',
        reason:
          matchedCount > 0
            ? `符合 ${matchedCount} 條規則，但全部位於去重時間窗內（略過 ${dedupedCount} 條）`
            : '本次未符合任何提醒規則'
      });
      return entry;
    }

    // 排序：按剩余天数升序，更紧迫的在前
    ready.sort((a, b) => a.daysDiff - b.daysDiff);

    // 將所有訂閱彙整成一則通知（符合既有管道的介接規範）
    // notify_log 按 (subId, ruleId, channel) 维度落，仍可细粒度查询
    const enrichedSubs = ready.map((c) => ({
      ...c.sub,
      daysRemaining: c.daysDiff,
      hoursRemaining: Math.round(c.hoursDiff),
      matchedReminderRule: c.rule
    }));
    const content = formatNotificationContent(enrichedSubs, config);
    const title = '訂閱到期／續訂提醒';

    // 给 dispatch 提供主 subId+ruleId（聚合通知用第一条做归属）
    const primary = ready[0];
    const dispatchResult = await dispatch(
      { title, content },
      config,
      {
        env,
        subId: primary.sub.id,
        ruleId: primary.rule.id,
        logPrefix: '[定时任务]',
        metadata: {
          tags: enrichedSubs.map((s) => s.name),
          daysRemaining: primary.daysDiff,
          ruleType: primary.rule.type,
          ruleValue: primary.rule.value
        }
      }
    );
    sentCount = dispatchResult.successCount;

    // 至少有一個管道傳送成功時，才寫入去重資料與 lastFire；失敗時可在後續 tick 重試
    if (dispatchResult.successCount > 0) {
      const firedAt = now.utc.toISOString();
      await Promise.all(
        ready.map(async (c) => {
          await env.SUBSCRIPTIONS_KV.put(c.dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SEC });
          if (c.rule.type === 'after_expiry') {
            await writeLastFireAt(env, c.sub.id, c.rule.id, firedAt);
          }
        })
      );
    }

    const entry = await schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone,
      currentHour: now.hourString,
      configuredHours: normalizedHours,
      inWindow: true,
      checkedCount: activeCount,
      matchedCount,
      dedupedCount,
      sentCount,
      autoRenewedCount,
      status: dispatchResult.failedCount > 0 && sentCount === 0 ? 'error' : 'ok',
      reason:
        dispatchResult.attempted > 0
          ? `傳送至 ${dispatchResult.attempted} 個管道，成功 ${dispatchResult.successCount}／失敗 ${dispatchResult.failedCount}`
          : '尚未啟用任何通知管道',
      extra: {
        candidates: ready.map((c) => ({
          subId: c.sub.id,
          subName: c.sub.name,
          ruleId: c.rule.id,
          ruleType: c.rule.type,
          ruleValue: c.rule.value,
          daysDiff: c.daysDiff
        })),
        channelResults: dispatchResult.channelResults
      }
    });
    return entry;
  } catch (error) {
    console.error('[排程任務] 執行失敗：', error);
    return schedulerLogsRepo.writeLog(env, {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      timezone: 'UTC',
      currentHour: '00',
      configuredHours: [],
      inWindow: false,
      checkedCount: 0,
      matchedCount: 0,
      dedupedCount: 0,
      sentCount: 0,
      autoRenewedCount: 0,
      status: 'error',
      reason: '執行時發生例外：' + (error && error.message ? error.message : String(error)),
      extra: { stack: error && error.stack }
    });
  }
}

/**
 * 自動續訂：依週期推進已到期的訂閱，並建立 auto 類型的付款紀錄。
 *
 * 按"cycle / reset 模式 + 公历 / 农历分支。
 *
 * @param {any} sub
 * @param {Date} now UTC 时刻
 * @param {string} timezone
 * @param {any} config
 * @returns {{ next: any } | null}
 */
function autoRenew(sub, now, timezone, config) {
  const mode = sub.subscriptionMode || 'cycle';
  const tz = timezone || 'UTC';
  let expiryDate = new Date(sub.expiryDate);
  let periodsAdded = 0;
  const nowMidnight = getTimezoneMidnightTimestamp(now, tz);

  /**
   * @param {number} y
   * @param {number} m
   * @param {number} d
   */
  function atTimezoneMidnight(y, m, d) {
    const ts = getTimestampForTimezoneParts(
      { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
      tz
    );
    return new Date(ts);
  }

  if (sub.useLunar) {
    let parts = getTimezoneDateParts(expiryDate, tz);
    let lunar = lunarCalendar.solar2lunar(parts.year, parts.month, parts.day);
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (!lunar) break;
      lunar = lunarBiz.addLunarPeriod(lunar, sub.periodValue, sub.periodUnit);
      const solar = lunarBiz.lunar2solar(lunar);
      if (!solar) break;
      expiryDate = atTimezoneMidnight(solar.year, solar.month, solar.day);
      periodsAdded++;
      if (periodsAdded > 60) break;
    }
  } else {
    while (getTimezoneMidnightTimestamp(expiryDate, tz) <= nowMidnight) {
      if (mode === 'reset') {
        // 重置：从「现在」所在本地日重新起算一个周期
        const p = getTimezoneDateParts(now, tz);
        expiryDate = atTimezoneMidnight(p.year, p.month, p.day);
      }
      expiryDate = addCalendarPeriodInTimezone(
        expiryDate,
        sub.periodValue || 1,
        sub.periodUnit || 'month',
        tz,
        { endOfMonth: !!sub.endOfMonth }
      );
      periodsAdded++;
      if (periodsAdded > 120) break;
    }
  }

  if (periodsAdded === 0) return null;

  const newStartDate = mode === 'reset' ? new Date(now) : new Date(sub.expiryDate);
  const newExpiryDate = expiryDate;

  const paymentRecord = {
    id: Date.now().toString(),
    date: now.toISOString(),
    amount: sub.amount || 0,
    type: 'auto',
    note: `自動續訂 (${mode === 'reset' ? '重置模式' : '接续模式'}${
      periodsAdded > 1 ? ', 补齐' + periodsAdded + '周期' : ''
    })`,
    periodStart: newStartDate.toISOString(),
    periodEnd: newExpiryDate.toISOString()
  };

  const paymentHistoryLimit = Number(config.PAYMENT_HISTORY_LIMIT) || 100;
  const ph = [...(sub.paymentHistory || []), paymentRecord];
  const trimmed = ph.length > paymentHistoryLimit ? ph.slice(-paymentHistoryLimit) : ph;

  return {
    next: {
      ...sub,
      startDate: newStartDate.toISOString(),
      expiryDate: newExpiryDate.toISOString(),
      lastPaymentDate: now.toISOString(),
      paymentHistory: trimmed
    }
  };
}
