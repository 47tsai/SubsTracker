// @ts-check
/**
 * CHIAuth OAuth integration-handler tests.
 * Covers PKCE redirect creation, one-time state validation, and local session issuance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((key) => env.SUBSCRIPTIONS_KV.delete(key.name)));
}

async function seedConfig() {
  await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify({
    JWT_SECRET: 'test-secret-key'
  }));
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await clearKv();
  await seedConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SubsTracker login page', () => {
  it('renders the branded login page without immediately redirecting to CHIAuth', async () => {
    const response = await app.fetch(new Request('https://sub.chi.qzz.io/login'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('SubsTracker');
    expect(html).toContain('使用 CHIAuth 登入');
    expect(html).toContain('href="/auth/login"');
  });

  it('sends unauthenticated root visits to the local login page', async () => {
    const response = await app.fetch(new Request('https://sub.chi.qzz.io/'), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });
});

describe('GET /auth/login', () => {
  it('redirects to CHIAuth with Authorization Code + PKCE S256 and stores state', async () => {
    const response = await app.fetch(new Request('https://sub.chi.qzz.io/auth/login'), env);
    expect(response.status).toBe(302);

    const location = response.headers.get('Location');
    expect(location).toBeTruthy();
    const authorizeUrl = new URL(location);
    expect(authorizeUrl.origin).toBe('https://auth.chi.qzz.io');
    expect(authorizeUrl.pathname).toBe('/api/authorize');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://sub.chi.qzz.io/auth/callback');

    const state = authorizeUrl.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await env.SUBSCRIPTIONS_KV.get(`chiauth_oauth_state:${state}`)).toBeTruthy();
  });
});

describe('GET /auth/callback', () => {
  it('rejects an unknown or expired state without calling CHIAuth', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.fetch(
      new Request('https://sub.chi.qzz.io/auth/callback?code=sample-code&state=unknown_state_value_12345'),
      env
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges the code, validates CHIAuth identity, and issues an HttpOnly local session', async () => {
    const state = 'state_for_test_transaction_123456';
    const verifier = 'verifier_value_for_pkce_test_0123456789abcdefghijklmnop';
    const redirectUri = 'https://sub.chi.qzz.io/auth/callback';
    await env.SUBSCRIPTIONS_KV.put(
      `chiauth_oauth_state:${state}`,
      JSON.stringify({ verifier, redirectUri }),
      { expirationTtl: 300 }
    );

    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/token')) {
        return new Response(JSON.stringify({
          access_token: 'test_access_token_1234567890123456789012345678901234567890',
          token_type: 'Bearer',
          expires_in: 600
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/userinfo?client_id=')) {
        return new Response(JSON.stringify({
          sub: 'chi-owner',
          aud: 'j2xhKF7JXweeTSjVToQwcL8tckJ4VC-q'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected CHIAuth request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.fetch(
      new Request(`https://sub.chi.qzz.io/auth/callback?code=sample_authorization_code&state=${state}`),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin');
    expect(response.headers.get('Set-Cookie')).toMatch(/token=.*HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=43200/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await env.SUBSCRIPTIONS_KV.get(`chiauth_oauth_state:${state}`)).toBeNull();
  });

  it('rejects a validly shaped state when the callback URI differs from the stored URI', async () => {
    const state = 'state_for_uri_mismatch_test_12345';
    await env.SUBSCRIPTIONS_KV.put(
      `chiauth_oauth_state:${state}`,
      JSON.stringify({ verifier: 'verifier_value_for_pkce_test_0123456789abcdefghijklmnop', redirectUri: 'https://wrong.example/auth/callback' }),
      { expirationTtl: 300 }
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.fetch(
      new Request(`https://sub.chi.qzz.io/auth/callback?code=sample_authorization_code&state=${state}`),
      env
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
