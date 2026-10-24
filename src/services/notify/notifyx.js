// @ts-check
/**
 * NotifyX 通知管道（https://www.notifyx.cn）
 */
import { ok, fail, errorMessage } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const notifyxChannel = {
  name: 'notifyx',

  validateConfig(config) {
    if (!config.NOTIFYX_API_KEY) return { ok: false, error: '缺少 NOTIFYX_API_KEY' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = notifyxChannel.validateConfig(config);
    if (!v.ok) return fail('notifyx', v.error || '設定無效');

    const url = `https://www.notifyx.cn/api/v1/send/${config.NOTIFYX_API_KEY}`;
    const body = JSON.stringify({
      title: payload.title || '訂閱提醒',
      content: `## ${payload.title || '訂閱提醒'}\n\n${payload.content || ''}`,
      description: '訂閱提醒'
    });

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const result = await r.json();
      return result.status === 'queued'
        ? ok('notifyx', result)
        : fail('notifyx', `NotifyX 回傳 ${result.status || 'unknown'}`, result);
    } catch (err) {
      return fail('notifyx', errorMessage(err));
    }
  },

  async test(config) {
    return notifyxChannel.send(
      { title: '訂閱管理 - 測試通知', content: '這是一則 NotifyX 測試通知。' },
      config
    );
  }
};

/** @deprecated 舊版相容函式 */
export async function sendNotifyXNotification(title, content, _description, config) {
  // 早期介面簽章帶有 description 參數；新介面已棄用此欄位
  void _description;
  const r = await notifyxChannel.send({ title, content }, config);
  if (!r.success) console.error('[NotifyX]', r.error);
  return r.success;
}
