import { generateJWT, verifyJWT } from '../../core/auth.js';
import { getConfig } from '../../data/config.js';
import { getCookieValue } from '../utils.js';

const CHIAUTH_ORIGIN = 'https://auth.chi.qzz.io';
const CHIAUTH_CLIENT_ID = 'j2xhKF7JXweeTSjVToQwcL8tckJ4VC-q';
const CALLBACK_PATH = '/auth/callback';
const STATE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function randomBase64Url(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function callbackUrl(request) {
  const url = new URL(request.url);
  return `${url.origin}${CALLBACK_PATH}`;
}

async function handleChiAuthLogin(request, env) {
  const clientId = env.CHI_AUTH_CLIENT_ID || CHIAUTH_CLIENT_ID;
  if (!clientId || !/^[A-Za-z0-9_-]{20,80}$/.test(clientId)) {
    return new Response('CHIAuth 尚未設定完成：缺少有效的 CHI_AUTH_CLIENT_ID。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  const redirectUri = callbackUrl(request);
  await env.SUBSCRIPTIONS_KV.put(
    `chiauth_oauth_state:${state}`,
    JSON.stringify({ verifier, redirectUri }),
    { expirationTtl: STATE_TTL_SECONDS }
  );

  const authorize = new URL('/api/authorize', CHIAUTH_ORIGIN);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', await sha256Base64Url(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

async function handleChiAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const oauthError = url.searchParams.get('error');

  if (oauthError) return jsonError('CHIAuth 未完成登入，請重新嘗試。', 401);
  if (!code || code.length > 256 || !/^[A-Za-z0-9_-]{20,80}$/.test(state)) {
    return jsonError('CHIAuth 回呼參數無效，請重新登入。', 400);
  }

  const stateKey = `chiauth_oauth_state:${state}`;
  const stored = await env.SUBSCRIPTIONS_KV.get(stateKey);
  await env.SUBSCRIPTIONS_KV.delete(stateKey);
  if (!stored) return jsonError('登入驗證已過期或已使用，請重新登入。', 400);

  let transaction;
  try {
    transaction = JSON.parse(stored);
  } catch {
    return jsonError('登入驗證資料無效，請重新登入。', 400);
  }

  const clientId = env.CHI_AUTH_CLIENT_ID || CHIAUTH_CLIENT_ID;
  if (!clientId) return jsonError('CHIAuth 尚未設定完成。', 503);

  const redirectUri = callbackUrl(request);
  if (transaction.redirectUri !== redirectUri) {
    return jsonError('登入回呼網址不一致，請重新登入。', 400);
  }

  let tokenResponse;
  try {
    tokenResponse = await fetch(`${CHIAUTH_ORIGIN}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: transaction.verifier
      })
    });
  } catch (error) {
    console.error('[CHIAuth] Token 交換連線失敗:', error);
    return jsonError('目前無法連線至 CHIAuth，請稍後再試。', 502);
  }

  if (!tokenResponse.ok) {
    console.error('[CHIAuth] Token 交換失敗，HTTP 狀態:', tokenResponse.status);
    return jsonError('CHIAuth 登入驗證失敗，請重新登入。', 401);
  }

  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenData || typeof tokenData.access_token !== 'string' ||
      tokenData.token_type !== 'Bearer') {
    return jsonError('CHIAuth 回傳的授權資料無效。', 502);
  }

  let identityResponse;
  try {
    identityResponse = await fetch(
      `${CHIAUTH_ORIGIN}/api/userinfo?client_id=${encodeURIComponent(clientId)}`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
  } catch (error) {
    console.error('[CHIAuth] UserInfo 連線失敗:', error);
    return jsonError('目前無法確認 CHIAuth 身分，請稍後再試。', 502);
  }

  if (!identityResponse.ok) {
    console.error('[CHIAuth] UserInfo 驗證失敗，HTTP 狀態:', identityResponse.status);
    return jsonError('無法確認 CHIAuth 身分，請重新登入。', 401);
  }

  const identity = await identityResponse.json().catch(() => null);
  if (!identity || identity.sub !== 'chi-owner' || identity.aud !== clientId) {
    return jsonError('CHIAuth 身分或應用受眾驗證不符。', 403);
  }

  const config = await getConfig(env);
  const sessionToken = await generateJWT('chi-owner', config.JWT_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin',
      'Set-Cookie': `token=${sessionToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

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

export {
  handleChiAuthLogin,
  handleChiAuthCallback,
  handleLogout,
  getUserFromRequest
};
