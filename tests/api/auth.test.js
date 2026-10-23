// @ts-check
/**
 * 认证相关测试
 * 覆盖：禁用本地密码登入、登出、JWT 签名与过期校验
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import { generateJWT, verifyJWT } from '../../src/core/auth.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function seedAdmin() {
  await env.SUBSCRIPTIONS_KV.put(
    'config',
    JSON.stringify({
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      JWT_SECRET: 'test-secret-key'
    })
  );
}

beforeEach(clearKv);
afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/login', () => {
  it('本地帳號密碼登入已永久停用', async () => {
    await seedAdmin();
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'password' })
    }, env);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('CHIAuth');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('GET /api/logout', () => {
  it('清除 cookie 并重定向', async () => {
    await seedAdmin();
    const res = await app.request('/api/logout', { method: 'GET' }, env);
    expect([302, 200].includes(res.status)).toBe(true);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toMatch(/Max-Age=0|token=;/);
  });
});

describe('JWT 单元', () => {
  it('签名正确可验证', async () => {
    const token = await generateJWT('admin', 'sec');
    const payload = await verifyJWT(token, 'sec');
    expect(payload).toBeTruthy();
    expect(payload.username).toBe('admin');
  });

  it('错误密钥验证失败', async () => {
    const token = await generateJWT('admin', 'sec');
    expect(await verifyJWT(token, 'other')).toBeNull();
  });

  it('过期 token 验证失败', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await generateJWT('admin', 'sec');
    // 推进超过 24h
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    expect(await verifyJWT(token, 'sec')).toBeNull();
  });

  it('篡改 payload 后签名失败', async () => {
    const token = await generateJWT('admin', 'sec');
    const parts = token.split('.');
    const fakePayload = btoa(JSON.stringify({ username: 'hacker', exp: 9999999999 }));
    const tampered = parts[0] + '.' + fakePayload + '.' + parts[2];
    expect(await verifyJWT(tampered, 'sec')).toBeNull();
  });
});

describe('受保护路由鉴权', () => {
  it('过期 cookie 访问 /api/config → 401', async () => {
    await seedAdmin();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await generateJWT('admin', 'test-secret-key');
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    const res = await app.request(
      '/api/config',
      { headers: { Cookie: 'token=' + token } },
      env
    );
    expect(res.status).toBe(401);
  });
});
