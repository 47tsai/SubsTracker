// @ts-check
/**
 * WPUSH 通知管道
 *
 * 文档：https://wpush.cn/docs
 * 发送：POST https://api.wpush.cn/api/v1/send
 * 成功條件：回應 JSON 的 code === 0（注意：與 PushPlus 的 200 不同）
 *
 * 配置：
 * - WPUSH_APIKEY     API Key（必填，勿寫入紀錄）
 * - WPUSH_CHANNEL    可選推播管道（wechat/app/sms/mail/webhook/dingtalk/feishu/wechat_work/clawbot/qqbot）
 * - WPUSH_TOPIC_CODE 可选 Topic 广播编码
 */
import { ok, fail, errorMessage } from './channel.js';

/** @type {import('./channel.js').Channel} */
export const wpushChannel = {
  name: 'wpush',

  validateConfig(config) {
    if (!config.WPUSH_APIKEY || !String(config.WPUSH_APIKEY).trim()) {
      return { ok: false, error: '缺少 WPUSH_APIKEY' };
    }
    return { ok: true };
  },

  async send(payload, config) {
    const v = wpushChannel.validateConfig(config);
    if (!v.ok) return fail('wpush', v.error || '設定無效');

    /** @type {Record<string, any>} */
    const body = {
      apikey: String(config.WPUSH_APIKEY).trim(),
      title: payload.title || '訂閱提醒',
      content: payload.content || payload.title || '訂閱提醒'
    };
    if (config.WPUSH_CHANNEL && String(config.WPUSH_CHANNEL).trim()) {
      body.channel = String(config.WPUSH_CHANNEL).trim();
    }
    if (config.WPUSH_TOPIC_CODE && String(config.WPUSH_TOPIC_CODE).trim()) {
      body.topic_code = String(config.WPUSH_TOPIC_CODE).trim();
    }

    try {
      const r = await fetch('https://api.wpush.cn/api/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await r.json().catch(() => ({}));
      // 第三方回應可能回傳 apikey；dispatch 会把 raw/error 写入通知日志。
      const responseCode = typeof result?.code === 'number' ? result.code : null;
      const diagnostic = { httpStatus: r.status, code: responseCode };
      return r.ok && responseCode === 0
        ? ok('wpush', diagnostic)
        : fail('wpush', `WPUSH 回傳 HTTP ${r.status}，code=${responseCode ?? '未知'}`, diagnostic);
    } catch (err) {
      const apiKey = String(config.WPUSH_APIKEY).trim();
      return fail('wpush', errorMessage(err).replaceAll(apiKey, '[REDACTED]'));
    }
  },

  async test(config) {
    return wpushChannel.send(
      { title: '訂閱管理 - 測試通知', content: '這是一則 WPUSH 測試通知。' },
      config
    );
  }
};

/** @deprecated 舊版相容函式 */
export async function sendWPushNotification(title, content, config) {
  const r = await wpushChannel.send({ title, content }, config);
  if (!r.success) console.error('[WPUSH]', r.error);
  return r.success;
}
