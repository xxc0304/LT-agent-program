import { createPublicKey, verify as verifySignature } from "node:crypto";

const DEFAULT_AUDIENCE = "lt-agent-device-manager";
const DEFAULT_MAX_LIFETIME_MS = 60_000;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const DEFAULT_REPLAY_CACHE_SIZE = 4_096;

function failure(code, message) {
  return { success: false, error: { code, message } };
}

function decodeSegment(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    return Buffer.from(segment, "base64url");
  } catch {
    return null;
  }
}

function validString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Verify a short-lived Ed25519-signed lock authorization assertion.
 * The assertion is an internal service-to-service value; it is never part of
 * an OpenClaw tool schema. The verifier consumes each jti once per Gateway
 * process and fails closed when its replay cache is full.
 */
export function createEd25519LockAuthorizationVerifier({
  publicKey,
  issuer,
  audience = DEFAULT_AUDIENCE,
  clock = () => Date.now(),
  maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
  replayCacheSize = DEFAULT_REPLAY_CACHE_SIZE,
} = {}) {
  if (!validString(publicKey)) throw new TypeError("门锁授权校验必须配置 Ed25519 公钥");
  if (!validString(issuer)) throw new TypeError("门锁授权校验必须配置 issuer");
  if (!validString(audience)) throw new TypeError("门锁授权校验必须配置 audience");
  if (typeof clock !== "function") throw new TypeError("门锁授权校验 clock 必须是函数");
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 5 * 60_000) {
    throw new TypeError("门锁授权有效期必须在 1 毫秒到 5 分钟之间");
  }
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 60_000) {
    throw new TypeError("门锁授权 clockSkewMs 必须在 0 到 60000 之间");
  }
  if (!Number.isSafeInteger(replayCacheSize) || replayCacheSize < 1 || replayCacheSize > 100_000) {
    throw new TypeError("门锁授权 replayCacheSize 必须在 1 到 100000 之间");
  }

  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new TypeError("门锁授权公钥无法解析");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("门锁授权公钥必须是 Ed25519 类型");
  }

  const usedAssertions = new Map();

  return Object.freeze({
    verifyLockAuthorization({ proof, expected } = {}) {
      if (typeof proof !== "string" || proof.length > 16_384) {
        return failure("TRUSTED_AUTHENTICATION_REQUIRED", "开锁需要来自可信认证界面的短时授权；普通聊天确认不能代替认证。");
      }
      if (!expected || !["approval_id", "plan_id", "plan_fingerprint", "device_id", "action"]
        .every((field) => validString(expected[field]))) {
        return failure("LOCK_AUTHORIZATION_CONTEXT_INVALID", "无法建立完整的门锁授权上下文；没有执行开锁。");
      }

      const parts = proof.split(".");
      if (parts.length !== 3) return failure("LOCK_AUTHORIZATION_INVALID", "门锁授权凭据格式无效；没有执行开锁。");
      const [headerPart, claimsPart, signaturePart] = parts;
      const headerBytes = decodeSegment(headerPart);
      const claimsBytes = decodeSegment(claimsPart);
      const signature = decodeSegment(signaturePart);
      if (!headerBytes || !claimsBytes || !signature) {
        return failure("LOCK_AUTHORIZATION_INVALID", "门锁授权凭据格式无效；没有执行开锁。");
      }

      let header;
      let claims;
      try {
        header = JSON.parse(headerBytes.toString("utf8"));
        claims = JSON.parse(claimsBytes.toString("utf8"));
      } catch {
        return failure("LOCK_AUTHORIZATION_INVALID", "门锁授权凭据内容无效；没有执行开锁。");
      }
      if (!header || header.alg !== "EdDSA" || (header.typ !== undefined && header.typ !== "JWT")
        || Object.keys(header).some((field) => !["alg", "typ"].includes(field))) {
        return failure("LOCK_AUTHORIZATION_INVALID", "门锁授权凭据算法不受支持；没有执行开锁。");
      }

      let signatureValid = false;
      try {
        signatureValid = verifySignature(null, Buffer.from(`${headerPart}.${claimsPart}`), key, signature);
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) return failure("LOCK_AUTHORIZATION_INVALID", "门锁授权签名校验失败；没有执行开锁。");

      const nowMs = clock();
      const nowSeconds = Math.floor(nowMs / 1_000);
      const audienceMatches = claims?.aud === audience
        || (Array.isArray(claims?.aud) && claims.aud.includes(audience));
      const issuedAtMs = Number.isSafeInteger(claims?.iat) ? claims.iat * 1_000 : NaN;
      const expiresAtMs = Number.isSafeInteger(claims?.exp) ? claims.exp * 1_000 : NaN;
      if (claims?.iss !== issuer || !audienceMatches
        || !validString(claims?.sub) || !validString(claims?.jti)
        || !Number.isSafeInteger(claims?.iat) || !Number.isSafeInteger(claims?.exp)
        || issuedAtMs > nowMs + clockSkewMs
        || expiresAtMs <= nowMs
        || claims.exp <= claims.iat
        || expiresAtMs - issuedAtMs > maxLifetimeMs
        || claims.iat > nowSeconds + Math.ceil(clockSkewMs / 1_000)) {
        return failure("LOCK_AUTHORIZATION_EXPIRED_OR_INVALID", "门锁授权已过期或缺少有效身份、时效信息；没有执行开锁。");
      }

      for (const [jti, expiresAt] of usedAssertions) {
        if (expiresAt <= nowMs) usedAssertions.delete(jti);
      }
      if (usedAssertions.has(claims.jti)) {
        return failure("LOCK_AUTHORIZATION_REPLAYED", "这份门锁授权已经使用过；没有重复执行开锁。");
      }
      if (usedAssertions.size >= replayCacheSize) {
        return failure("LOCK_AUTHORIZATION_REPLAY_CACHE_FULL", "门锁授权防重放状态暂不可用；没有执行开锁。");
      }

      const binding = ["approval_id", "plan_id", "plan_fingerprint", "device_id", "action"];
      if (binding.some((field) => claims[field] !== expected[field]) || expected.action !== "unlock") {
        return failure("LOCK_AUTHORIZATION_SCOPE_MISMATCH", "门锁授权与当前审批、计划、设备或动作不匹配；没有执行开锁。");
      }

      usedAssertions.set(claims.jti, expiresAtMs);
      return {
        success: true,
        subject: claims.sub,
        expires_at: new Date(expiresAtMs).toISOString(),
      };
    },
  });
}

export function createLockAuthorizationVerifierFromEnv(env = process.env) {
  const publicKey = env.DEVICE_MANAGER_LOCK_AUTH_PUBLIC_KEY?.trim();
  if (!publicKey) return null;
  const issuer = env.DEVICE_MANAGER_LOCK_AUTH_ISSUER?.trim();
  return createEd25519LockAuthorizationVerifier({
    publicKey,
    issuer,
    audience: env.DEVICE_MANAGER_LOCK_AUTH_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
  });
}

/**
 * Optional HTTP bridge to a trusted external authentication service. The
 * service performs its own user verification and returns a signed assertion;
 * PINs or biometric data must stay inside that service's trusted UI.
 */
export function createHttpLockAuthorizationProvider({
  url = process.env.DEVICE_MANAGER_LOCK_AUTH_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!url?.trim()) return null;
  if (typeof fetchImpl !== "function") throw new TypeError("当前 Node.js 环境不支持 fetch");
  const endpoint = new URL(url);
  const localHttp = endpoint.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) {
    throw new TypeError("门锁认证服务必须使用 HTTPS；仅本机回环地址允许 HTTP");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("门锁认证服务 URL 不能包含账号、密码、查询参数或片段");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError("门锁认证服务 timeoutMs 必须在 1 到 120000 之间");
  }

  return async function requestLockAuthorization(context) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({
          approval_id: context.approval_id,
          plan_id: context.plan_id,
          plan_fingerprint: context.plan_fingerprint,
          device_id: context.device_id,
          action: "unlock",
          expires_at: context.expires_at,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (text.length > 16_384) throw new Error("响应超出允许大小");
      if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
      let result;
      try { result = JSON.parse(text); } catch { throw new Error("响应不是有效 JSON"); }
      if (typeof result?.proof !== "string" || !result.proof) {
        throw new Error("认证服务没有返回签名授权凭据");
      }
      return result.proof;
    } finally {
      clearTimeout(timeout);
    }
  };
}
