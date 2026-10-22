// @ts-check
/**
 * auth + currency 边界
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import { generateJWT, verifyJWT } from '../../src/core/auth.js';
import { convertToTWD, getDynamicRates } from '../../src/core/currency.js';

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

  it('USD 按相對匯率換算為 TWD', () => {
    expect(convertToTWD(14, 'USD', rates)).toBeCloseTo(450, 8);
  });

  it('未知币种不抛错，返回原金额', () => {
    expect(convertToTWD(5, 'XYZ', rates)).toBe(5);
  });

  it('非正金额返回 0', () => {
    expect(convertToTWD(0, 'USD', rates)).toBe(0);
    expect(convertToTWD(-1, 'USD', rates)).toBe(0);
  });
});

describe('getDynamicRates', () => {
  it('API 失败时返回 FALLBACK', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const rates = await getDynamicRates(env);
    expect(rates.CNY).toBe(1);
    expect(rates.USD).toBeTruthy();
  });

  it('API 成功时合并并缓存', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ rates: { USD: 0.14, EUR: 0.12 } })
    }));
    const rates = await getDynamicRates(env);
    expect(rates.USD).toBe(0.14);
    // 第二次应走缓存，不再 fetch
    let called = 0;
    vi.stubGlobal('fetch', async () => {
      called++;
      return { ok: true, json: async () => ({ rates: { USD: 0.1 } }) };
    });
    const rates2 = await getDynamicRates(env);
    expect(called).toBe(0);
    expect(rates2.USD).toBe(0.14);
  });
});

describe('JWT 边界', () => {
  it('空 token/secret → null', async () => {
    expect(await verifyJWT('', 's')).toBeNull();
    expect(await verifyJWT('a.b.c', '')).toBeNull();
  });

  it('格式错误 → null', async () => {
    expect(await verifyJWT('not-a-jwt', 's')).toBeNull();
  });
});
