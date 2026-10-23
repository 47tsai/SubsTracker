import { getUserFromRequest } from './handlers/auth.js';
import { adminPage, configPage, dashboardPage, notifyLogsPage } from '../views/pages.js';

async function handleAdminRequest(request, env) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log('[管理页面] 访问路径:', pathname);

    const { user } = await getUserFromRequest(request, env);

    console.log('[管理页面] 用户验证结果:', !!user);

    if (!user) {
      console.log('[管理页面] 用户未登录，重定向到登录页面');
      return new Response('', {
        status: 302,
        headers: { 'Location': '/auth/login' }
      });
    }

    if (pathname === '/admin/config') {
      return new Response(configPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/dashboard') {
      return new Response(dashboardPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (pathname === '/admin/notify-logs') {
      return new Response(notifyLogsPage, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    return new Response(adminPage, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (error) {
    console.error('[管理页面] 处理请求时出错:', error);
    return new Response('伺服器內部錯誤', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

export { handleAdminRequest };
