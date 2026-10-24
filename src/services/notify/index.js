// @ts-check
/**
 * 通知排程入口
 *
 * 旧 sendNotificationToAllChannels 现在是 dispatch.dispatch 的薄壳，
 * 保留簽章以維持向後相容。新程式碼請直接使用 dispatch / testChannel。
 *
 */
import { dispatch } from './dispatch.js';

/**
 * @param {string} title
 * @param {string} commonContent
 * @param {any} config
 * @param {string} [logPrefix='[排程工作]']
 * @param {{ env?: any, subId?: string, ruleId?: string, metadata?: Object }} [options]
 */
export async function sendNotificationToAllChannels(
  title,
  commonContent,
  config,
  logPrefix = '[排程工作]',
  options = {}
) {
  const result = await dispatch(
    { title, content: commonContent },
    config,
    {
      logPrefix,
      env: options.env,
      subId: options.subId,
      ruleId: options.ruleId,
      metadata: options.metadata
    }
  );

  // 舊呼叫端預期的欄位名稱
  return {
    attempted: result.attempted,
    successCount: result.successCount,
    failedCount: result.failedCount,
    channelResults: result.channelResults
  };
}

export { dispatch, testChannel } from './dispatch.js';
