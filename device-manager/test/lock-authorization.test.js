import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  createEd25519LockAuthorizationVerifier,
  createHttpLockAuthorizationProvider,
} from "../src/lock-authorization.js";

const NOW = Date.parse("2026-10-30T08:00:00.000Z");
const ISSUER = "trusted-household-auth";
const AUDIENCE = "lt-agent-device-manager";
const EXPECTED = {
  approval_id: "approval-1",
  plan_id: "plan-1",
  plan_fingerprint: "a".repeat(64),
  device_id: "lock.front_door",
  action: "unlock",
};

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

function signAssertion(overrides = {}) {
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "household-user-1",
    jti: `assertion-${Math.random().toString(16).slice(2)}`,
    iat: Math.floor(NOW / 1_000),
    exp: Math.floor(NOW / 1_000) + 45,
    ...EXPECTED,
    ...overrides,
  };
  const headerPart = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const claimsPart = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `${headerPart}.${claimsPart}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

function verifierOptions(overrides = {}) {
  return {
    publicKey: publicKeyPem,
    issuer: ISSUER,
    audience: AUDIENCE,
    clock: () => NOW,
    ...overrides,
  };
}

test("Ed25519 授权校验通过，并拒绝同一授权标识重放", () => {
  const verifier = createEd25519LockAuthorizationVerifier(verifierOptions());
  const proof = signAssertion({ jti: "one-time-assertion" });

  assert.equal(verifier.verifyLockAuthorization({ proof, expected: EXPECTED }).success, true);
  assert.equal(
    verifier.verifyLockAuthorization({ proof, expected: EXPECTED }).error.code,
    "LOCK_AUTHORIZATION_REPLAYED",
  );
});

test("授权必须绑定当前审批、计划、设备和 unlock 动作", () => {
  const verifier = createEd25519LockAuthorizationVerifier(verifierOptions());
  const proof = signAssertion({ device_id: "lock.back_door" });

  assert.equal(
    verifier.verifyLockAuthorization({ proof, expected: EXPECTED }).error.code,
    "LOCK_AUTHORIZATION_SCOPE_MISMATCH",
  );
  assert.equal(verifier.verifyLockAuthorization({
    proof,
    expected: { ...EXPECTED, device_id: "lock.back_door" },
  }).success, true);
  assert.equal(verifier.verifyLockAuthorization({
    proof: signAssertion(),
    expected: { ...EXPECTED, action: "lock" },
  }).error.code, "LOCK_AUTHORIZATION_SCOPE_MISMATCH");
});

test("授权签名无效、过期或超出有效期上限时拒绝", () => {
  const verifier = createEd25519LockAuthorizationVerifier(verifierOptions());
  const proof = signAssertion();
  const [header, payload, signature] = proof.split(".");
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), device_id: "lock.back_door" })).toString("base64url")}.${signature}`;

  assert.equal(verifier.verifyLockAuthorization({ proof: tampered, expected: EXPECTED }).error.code, "LOCK_AUTHORIZATION_INVALID");
  assert.equal(verifier.verifyLockAuthorization({
    proof: signAssertion({ exp: Math.floor(NOW / 1_000) }),
    expected: EXPECTED,
  }).error.code, "LOCK_AUTHORIZATION_EXPIRED_OR_INVALID");
  assert.equal(verifier.verifyLockAuthorization({
    proof: signAssertion({ exp: Math.floor(NOW / 1_000) + 90 }),
    expected: EXPECTED,
  }).error.code, "LOCK_AUTHORIZATION_EXPIRED_OR_INVALID");
});

test("未提供凭据或不完整授权上下文时 fail-closed", () => {
  const verifier = createEd25519LockAuthorizationVerifier(verifierOptions());

  assert.equal(verifier.verifyLockAuthorization({ expected: EXPECTED }).error.code, "TRUSTED_AUTHENTICATION_REQUIRED");
  assert.equal(verifier.verifyLockAuthorization({ proof: signAssertion(), expected: { device_id: "lock.front_door" } }).error.code, "LOCK_AUTHORIZATION_CONTEXT_INVALID");
});

test("HTTP 认证适配器只发送审批范围字段，不转发聊天凭据", async () => {
  let request;
  const provider = createHttpLockAuthorizationProvider({
    url: "https://auth.example.test/v1/lock/authorize",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ proof: "signed-proof" }) };
    },
  });
  const context = {
    ...EXPECTED,
    expires_at: "2026-10-30T08:01:00.000Z",
    chat_message: "开门",
    pin: "must-not-be-forwarded",
  };

  assert.equal(await provider(context), "signed-proof");
  assert.equal(request.url, "https://auth.example.test/v1/lock/authorize");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    approval_id: EXPECTED.approval_id,
    plan_id: EXPECTED.plan_id,
    plan_fingerprint: EXPECTED.plan_fingerprint,
    device_id: EXPECTED.device_id,
    action: "unlock",
    expires_at: context.expires_at,
  });
  assert.equal(request.options.signal instanceof AbortSignal, true);
});

test("HTTP 认证适配器只允许 HTTPS 或本机回环 HTTP", () => {
  assert.doesNotThrow(() => createHttpLockAuthorizationProvider({ url: "https://auth.example.test/authorize", fetchImpl: async () => {} }));
  assert.doesNotThrow(() => createHttpLockAuthorizationProvider({ url: "http://127.0.0.1:8124/authorize", fetchImpl: async () => {} }));
  assert.throws(() => createHttpLockAuthorizationProvider({ url: "http://auth.example.test/authorize" }), /HTTPS/);
  assert.throws(() => createHttpLockAuthorizationProvider({ url: "https://user:pass@auth.example.test/authorize" }), /不能包含账号/);
  assert.throws(() => createHttpLockAuthorizationProvider({ url: "https://auth.example.test/authorize?token=x" }), /查询参数/);
  assert.throws(() => createHttpLockAuthorizationProvider({ url: "file:///tmp/auth" }), /HTTPS/);
});

test("HTTP 认证适配器拒绝错误状态、无效 JSON、超大响应和缺失签名", async () => {
  const responses = [
    { ok: false, status: 403, text: async () => "forbidden" },
    { ok: true, status: 200, text: async () => "not-json" },
    { ok: true, status: 200, text: async () => "x".repeat(16_385) },
    { ok: true, status: 200, text: async () => JSON.stringify({ proof: "" }) },
  ];

  for (const response of responses) {
    const provider = createHttpLockAuthorizationProvider({
      url: "https://auth.example.test/authorize",
      fetchImpl: async () => response,
    });
    await assert.rejects(provider(EXPECTED));
  }
});

test("HTTP 认证适配器请求超时会中止连接", async () => {
  const provider = createHttpLockAuthorizationProvider({
    url: "https://auth.example.test/authorize",
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });

  await assert.rejects(provider(EXPECTED), /aborted/);
});
