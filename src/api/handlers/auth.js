import { verifyJWT } from '../../core/auth.js';
import { getConfig } from '../../data/config.js';
import { getCookieValue } from '../utils.js';

// SUB 只建立自己的工作階段；登入身分必須先由 CHIAuth 完成驗證。
function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/auth/login',
      'Set-Cookie': 'token=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store'
    }
  });
}

async function getUserFromRequest(request, env) {
  const token = getCookieValue(request.headers.get('Cookie'), 'token');
  const config = await getConfig(env);
  const user = token ? await verifyJWT(token, config.JWT_SECRET) : null;
  return { user, config };
}

export { handleLogout, getUserFromRequest };
