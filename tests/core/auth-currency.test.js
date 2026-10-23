// @ts-check
/**
 * auth + currency 边界
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { generateJWT, verifyJWT } from '../../src/core/auth.js';
import { convertToTWD, getDynamicRates, calculateMonthlyExpense } from '../../src/core/currency.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('convertToTWD', () => {
  const rates = { CNY: 1, USD: 0.14, EUR: 0.125, TWD: 4.5 };

  it('TWD 原樣', () => {
    expect(convertToTWD(10, 'TWD', rates)).toBe(10);
  });

  it('USD 換算為新台幣', () => {
    expect(convertToTWD(14, 'USD', rates)).toBeCloseTo(450, 8);
  });

  it('未知幣別不拋錯，回傳原金額', () => {
    expect(convertToTWD(5, 'XYZ', rates)).toBe(5);
  });

  it('非正金額回傳 0', () => {
    expect(convertToTWD(0, 'USD', rates)).toBe(0);
    expect(convertToTWD(-1, 'USD', rates)).toBe(0);
  });

  it('數字字串會正確轉成數字，避免支出加總變成字串串接', () => {
    expect(convertToTWD('10', 'TWD', rates)).toBe(10);
    expect(convertToTWD('14', 'USD', rates)).toBeCloseTo(450, 8);
  });

  it('無效或非有限金額回傳 0', () => {
    expect(convertToTWD('not-a-number', 'TWD', rates)).toBe(0);
    expect(convertToTWD(Number.NaN, 'USD', rates)).toBe(0);
    expect(convertToTWD(Number.POSITIVE_INFINITY, 'USD', rates)).toBe(0);
  });
});

describe('calculateMonthlyExpense', () => {
  it('略過日期無效的付款紀錄，不把它誤算為本月支出', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));

    const subscriptions = [{
      currency: 'TWD',
      paymentHistory: [
        { amount: 100, date: '2026-10-10T12:00:00.000Z' },
        { amount: 500, date: 'not-a-date' }
      ]
    }];

    try {
      const result = calculateMonthlyExpense(subscriptions, 'Asia/Taipei', { TWD: 4.5 });
      expect(result.amount).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getDynamicRates', () => {
  it('API 失敗時回傳兜底匯率', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const rates = await getDynamicRates(env);
    expect(rates.CNY).toBe(1);
    expect(rates.USD).toBeTruthy();
  });

  it('API 成功時合併並快取', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ rates: { USD: 0.14, EUR: 0.125 } })
    }));
    const rates = await getDynamicRates(env);
    expect(rates.USD).toBe(0.14);
    // 第二次应走缓存，不再 fetch
    let called = 0;
    vi.stubGlobal('fetch', async () => {
      called++;
      return { ok: true, json: async () => ({ rates: { USD: 0.2 } }) };
    });
    const rates2 = await getDynamicRates(env);
    expect(called).toBe(0);
    expect(rates2.USD).toBe(0.14);
  });
});

describe('JWT 邊界', () => {
  it('空 token/secret → null', async () => {
    expect(await verifyJWT('', 's')).toBeNull();
    expect(await verifyJWT('a.b.c', '')).toBeNull();
  });

  it('格式错误 → null', async () => {
    expect(await verifyJWT('not-a-jwt', 's')).toBeNull();
  });
});
