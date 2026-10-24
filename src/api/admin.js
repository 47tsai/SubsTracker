import { getUserFromRequest } from './handlers/auth.js';
import { adminPage, configPage, dashboardPage, notifyLogsPage } from '../views/pages.js';

async function handleAdminRequest(request, env) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log('[管理页面] 存取路徑:', pathname);

    const { user } = await getUserFromRequest(request, env);

    console.log('[管理页面] 使用者驗證結果:', !!user);

    if (!user) {
      console.log('[管理页面] 使用者未登入，重新導向至登入頁面');
      return new Response('', {
        status: 302,
        headers: { 'Location': '/login' }
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
    console.error('[管理页面] 處理請求時發生錯誤:', error);
    return new Response('伺服器內部錯誤', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

export { handleAdminRequest };
