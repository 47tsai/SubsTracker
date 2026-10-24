// @ts-check
/**
 * PushPlus 通知管道
 */
import { ok, fail, errorMessage } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const pushplusChannel = {
  name: 'pushplus',

  validateConfig(config) {
    if (!config.PUSHPLUS_TOKEN) return { ok: false, error: '缺少 PUSHPLUS_TOKEN' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = pushplusChannel.validateConfig(config);
    if (!v.ok) return fail('pushplus', v.error || '設定無效');

    /** @type {Record<string, any>} */
    const body = {
      token: config.PUSHPLUS_TOKEN,
      title: payload.title || '訂閱提醒',
      content: `## ${payload.title || '訂閱提醒'}\n\n${payload.content || ''}`,
      template: 'markdown'
    };
    if (config.PUSHPLUS_TOPIC) body.topic = config.PUSHPLUS_TOPIC;
    if (config.PUSHPLUS_CHANNEL) body.channel = config.PUSHPLUS_CHANNEL;

    try {
      const r = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await r.json().catch(() => ({}));
      return result && result.code === 200
        ? ok('pushplus', result)
        : fail('pushplus', `PushPlus 回傳 code=${result?.code} ${result?.msg || ''}`, result);
    } catch (err) {
      return fail('pushplus', errorMessage(err));
    }
  },

  async test(config) {
    return pushplusChannel.send(
      { title: '訂閱管理 - 測試通知', content: '這是一則 PushPlus 測試通知。' },
      config
    );
  }
};

/** @deprecated 舊版相容函式 */
export async function sendPushPlusNotification(title, content, config) {
  const r = await pushplusChannel.send({ title, content }, config);
  if (!r.success) console.error('[PushPlus]', r.error);
  return r.success;
}
