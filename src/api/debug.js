// @ts-check
/**
 * 除錯頁面（登入後才可檢視）
 *
 * 用途：
 * - 檢查 KV 綁定、設定完整性與 JWT 金鑰狀態
 * - 新增「時區診斷」區塊，直觀顯示 UTC 與使用者時區的目前小時差異
 *   這是 #91／#52／#166 類問題的自助排查入口
 *
 */
import { getConfig } from '../data/config.js';
import {
  getNowInTimezone,
  formatTimezoneDisplay,
  getTimezoneOffset
} from '../core/time.js';
import * as schedLogs from '../data/scheduler-logs.repo.js';

/** 簡單的 HTML 跳脫，避免設定中的字串影響頁面 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
async function handleDebug(request, env) {
  try {
    const url = new URL(request.url);

    // 子路由：匯出最近 N 筆排程紀錄（JSON）
    if (url.searchParams.get('export') === 'sched_logs') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const logs = await schedLogs.getRecent(env, limit);
      return new Response(JSON.stringify(logs, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="scheduler-logs-${Date.now()}.json"`
        }
      });
    }

    const config = await getConfig(env);
    const tz = config.TIMEZONE || 'UTC';
    const now = getNowInTimezone(tz);

    const notificationHours = Array.isArray(config.NOTIFICATION_HOURS)
      ? config.NOTIFICATION_HOURS.map((h) => String(h).padStart(2, '0'))
      : [];
    const inWindow =
      notificationHours.length === 0 ||
      notificationHours.includes('*') ||
      notificationHours.includes('ALL') ||
      notificationHours.includes(now.hourString);

    const debugInfo = {
      timestamp: now.utc.toISOString(),
      pathname: url.pathname,
      kvBinding: !!env.SUBSCRIPTIONS_KV,
      configExists: !!config,
      adminUsername: config.ADMIN_USERNAME,
      hasJwtSecret: !!config.JWT_SECRET,
      jwtSecretLength: config.JWT_SECRET ? config.JWT_SECRET.length : 0,
      timezone: tz,
      timezoneDisplay: formatTimezoneDisplay(tz),
      timezoneOffsetHours: getTimezoneOffset(tz),
      utcIso: now.utc.toISOString(),
      localIso: now.isoLocal,
      currentHour: now.hourString,
      configuredHours: notificationHours,
      inNotificationWindow: inWindow
    };

    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>调试信息 - SubsTracker</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; padding: 20px; background: #f5f5f5; color: #333; }
    h1 { font-size: 22px; }
    .info { background: white; padding: 15px 20px; margin: 12px 0; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .info h3 { margin-top: 0; font-size: 16px; color: #555; border-bottom: 1px solid #eee; padding-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .row .k { color: #666; }
    .row .v { font-weight: 600; color: #1a1a1a; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
    .warn { color: #ca8a04; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>系统调试信息</h1>

  <div class="info">
    <h3>基本</h3>
    <div class="row"><span class="k">UTC 時間</span><span class="v">${esc(debugInfo.timestamp)}</span></div>
    <div class="row"><span class="k">存取路徑</span><span class="v">${esc(debugInfo.pathname)}</span></div>
    <div class="row"><span class="k">KV 绑定</span><span class="v ${debugInfo.kvBinding ? 'success' : 'error'}">${debugInfo.kvBinding ? '✓ 已绑定' : '✗ 未绑定'}</span></div>
    <div class="row"><span class="k">設定可讀</span><span class="v ${debugInfo.configExists ? 'success' : 'error'}">${debugInfo.configExists ? '✓' : '✗'}</span></div>
    <div class="row"><span class="k">管理員使用者名稱</span><span class="v">${esc(debugInfo.adminUsername || '（未設定）')}</span></div>
    <div class="row"><span class="k">JWT 密钥</span><span class="v ${debugInfo.hasJwtSecret ? 'success' : 'error'}">${debugInfo.hasJwtSecret ? `✓ 已設定 (${debugInfo.jwtSecretLength} 個字元)` : '✗ 缺失'}</span></div>
  </div>

  <div class="info">
    <h3>時區診斷</h3>
    <div class="row"><span class="k">設定的時區</span><span class="v">${esc(debugInfo.timezoneDisplay)}</span></div>
    <div class="row"><span class="k">時區偏移</span><span class="v">UTC${debugInfo.timezoneOffsetHours >= 0 ? '+' : ''}${debugInfo.timezoneOffsetHours} 小時</span></div>
    <div class="row"><span class="k">目前 UTC</span><span class="v">${esc(debugInfo.utcIso)}</span></div>
    <div class="row"><span class="k">目前使用者當地時間</span><span class="v">${esc(debugInfo.localIso)}</span></div>
    <div class="row"><span class="k">用于通知时段判断的小時</span><span class="v">${esc(debugInfo.currentHour)}</span></div>
    <div class="row"><span class="k">設定的通知小時（使用者時區）</span><span class="v">${notificationHours.length === 0 ? '<em class="warn">空白（預設全天允許傳送）</em>' : `<code>${esc(notificationHours.join(', '))}</code>`}</span></div>
    <div class="row"><span class="k">目前是否允許傳送</span><span class="v ${debugInfo.inNotificationWindow ? 'success' : 'warn'}">${debugInfo.inNotificationWindow ? '✓ 位於允許時段內' : '✗ 不在允許時段內'}</span></div>
  </div>

  <div class="info">
    <h3>提示</h3>
    <p>1. 如果時區診斷中的「目前小時」與預期不符，請檢查設定中的 <code>TIMEZONE</code> 是否與所在地相符。</p>
    <p>2. 本版本 <code>NOTIFICATION_HOURS</code> <strong>依照你設定的時區</strong>解讀（不再使用 UTC）。例如想在台灣時間上午 8 點收到通知，<code>TIMEZONE=Asia/Taipei</code> 時填 <code>08</code>。</p>
    <p>3. 詳細傳送紀錄請前往管理後台的「通知紀錄」頁面。</p>
    <p>4. <a href="/admin">返回管理後台</a></p>
    <p>5. <a href="/debug?export=sched_logs&limit=50">📥 匯出最近 50 筆排程執行紀錄（JSON）</a></p>
  </div>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  } catch (error) {
    return new Response(`除錯頁面錯誤：${error && error.message ? error.message : error}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

export { handleDebug };
