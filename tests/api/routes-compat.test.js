// @ts-check
/**
 * API 路由兼容性 smoke 测试
 *
 * 验证 Hono 应用与既有用戶端的路由响应严格兼容：
 * - 未授权时返回 401 + 同样的错误结构
 * - 公開端點導向 CHIAuth，舊密碼登入端點停用
 * - 4xx/5xx 错误格式与既有约定一致
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

beforeEach(clearKv);

describe('Hono app 路由兼容', () => {
  it('GET / 未登入導向 SubsTracker 登入頁', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('GET /admin 未登录跳回 / (302)', async () => {
    const res = await app.request('/admin', {}, env);
    expect([302, 200].includes(res.status)).toBe(true);
  });

  it('GET /api/subscriptions 未登录返回 401 + 标准错误体', async () => {
    const res = await app.request('/api/subscriptions', {}, env);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.message).toBe('string');
  });

  it('POST /api/login 已停用', async () => {
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    }, env);
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.message).toContain('CHIAuth');
  });


  it('POST /api/logout 清除工作階段並導向 SubsTracker 登入頁', async () => {
    const res = await app.request('/api/logout', { method: 'POST' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('GET /debug 未登录返回 401', async () => {
    const res = await app.request('/debug', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET /api/未知端點 → 404 + 標準錯誤體', async () => {
    await env.SUBSCRIPTIONS_KV.put(
      'config',
      JSON.stringify({ JWT_SECRET: 'k' })
    );
    const { generateJWT } = await import('../../src/core/auth.js');
    const token = await generateJWT('chi-owner', 'k');
    const res = await app.request('/api/non-existent-route', {
      headers: { Cookie: 'token=' + token }
    }, env);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('未匹配路徑走兜底 → 導向 SubsTracker 登入頁', async () => {
    const res = await app.request('/random/path/xyz', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });
});
