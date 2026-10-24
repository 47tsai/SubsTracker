const CryptoJS = {
  HmacSHA256: function(message, key) {
    const keyData = new TextEncoder().encode(key);
    const messageData = new TextEncoder().encode(message);

    return Promise.resolve().then(() => {
      return crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: {name: "SHA-256"} },
        false,
        ["sign"]
      );
    }).then(cryptoKey => {
      return crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        messageData
      );
    }).then(buffer => {
      const hashArray = Array.from(new Uint8Array(buffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    });
  }
};

async function generateJWT(username, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { username, exp: Math.floor(Date.now() / 1000) + 86400 };

  const base64Header = btoa(JSON.stringify(header));
  const base64Payload = btoa(JSON.stringify(payload));
  const signatureInput = base64Header + '.' + base64Payload;
  const signature = await CryptoJS.HmacSHA256(signatureInput, secret);

  return signatureInput + '.' + signature;
}

async function verifyJWT(token, secret) {
  try {
    if (!token || !secret) {
      console.log('[JWT] Token 或 Secret 為空');
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      console.log('[JWT] Token 格式錯誤，分段數量：', parts.length);
      return null;
    }

    const [headerBase64, payloadBase64, signature] = parts;
    const signatureInput = headerBase64 + '.' + payloadBase64;
    const expectedSignature = await CryptoJS.HmacSHA256(signatureInput, secret);

    if (signature !== expectedSignature) {
      console.log('[JWT] 簽章驗證失敗');
      return null;
    }

    const payload = JSON.parse(atob(payloadBase64));
    // 必須驗證 exp，否則過期的 token 仍可能長期有效
    if (payload.exp != null) {
      const exp = Number(payload.exp);
      if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        console.log('[JWT] Token 已過期');
        return null;
      }
    }
    console.log('[JWT] 驗證成功，使用者：', payload.username);
    return payload;
  } catch (error) {
    console.error('[JWT] 驗證過程發生錯誤：', error);
    return null;
  }
}

export { generateJWT, verifyJWT };
