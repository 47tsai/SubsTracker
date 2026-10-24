// @ts-check
/**
 * Hono 應用組裝
 *
 * 設計目標：
 * - 使用 Hono 實作路由分派與中介軟體管線
 * - 引入中介層：遷移檢查／日誌／驗證／錯誤處理
 * - 路由路径、方法、响应结构与既有客户端严格兼容
 *   現有前端程式碼無須修改即可繼續運作
 *
 * 落地策略：
 * - 現階段（Task 7）：Hono 充當「外層路由器」，將請求轉發給現有 handler
 *   後續 Task 可逐步將 handler 改寫為 Hono 原生寫法，但目前優先確保相容性。
 *
 */

import { Hono } from 'hono';

import { handleApiRequest } from './api/router.js';
import { handleAdminRequest } from './api/admin.js';
import { handleDebug } from './api/debug.js';
import { getUserFromRequest } from './api/handlers/auth.js';
import { loginPage } from './views/pages.js';
import { handleChiAuthLogin, handleChiAuthCallback } from './api/handlers/chiauth.js';
import { ensureMigrations } from './data/migrate.js';

/**
 * @typedef {{ SUBSCRIPTIONS_KV: KVNamespace }} Bindings
 */

/** @type {Hono<{ Bindings: Bindings }>} */
const app = new Hono();

// ─────────────────────────────────────────────────────────────
// 全域中介軟體：迁移检查（首次访问透明触发）
// ─────────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  try {
    await ensureMigrations(c.env);
  } catch (err) {
    console.error('[app] 遷移失敗，回退並繼續處理請求:', err);
  }
  await next();
});

// ─────────────────────────────────────────────────────────────
// 全域錯誤處理備援
// ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[app] 未捕捉例外:', err && err.stack ? err.stack : err);
  // 統一的錯誤格式
  return c.json(
    {
      success: false,
      message: err && err.message ? err.message : '服務異常',
      code: 'internal_error'
    },
    500
  );
});

// ─────────────────────────────────────────────────────────────
 // CHIAuth OAuth Authorization Code + PKCE
 // ─────────────────────────────────────────────────────────────
 app.get('/login', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (user) return c.redirect('/admin');
  return c.html(loginPage, 200, { 'Cache-Control': 'no-store' });
});
app.get('/auth/login', async (c) => handleChiAuthLogin(c.req.raw, c.env));
 app.get('/auth/callback', async (c) => handleChiAuthCallback(c.req.raw, c.env));

 // ─────────────────────────────────────────────────────────────
 // 路由：根路径
// 已登录跳 /admin；未登录显示 SubsTracker 自有登录页面
// ─────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (user) return c.redirect('/admin');
  return c.redirect('/login');
});

// ─────────────────────────────────────────────────────────────
// 路由：/debug（必须登录）
// ─────────────────────────────────────────────────────────────
app.all('/debug', async (c) => {
  const { user } = await getUserFromRequest(c.req.raw, c.env);
  if (!user) {
    return new Response('未授权访问', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  return handleDebug(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/api/*（认证由 handler 内部处理，與既有用戶端約定一致）
// ─────────────────────────────────────────────────────────────
app.all('/api/*', async (c) => {
  return handleApiRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 路由：/admin/*
// ─────────────────────────────────────────────────────────────
app.all('/admin/*', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

app.get('/admin', async (c) => {
  return handleAdminRequest(c.req.raw, c.env);
});

// ─────────────────────────────────────────────────────────────
// 兜底：其他路径返回 SubsTracker 登录页面
// ─────────────────────────────────────────────────────────────
app.all('*', async (c) => {
  return c.redirect('/login');
});

export default app;
