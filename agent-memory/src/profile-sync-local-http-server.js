import { createServer } from "node:http";

import { createProfileSyncHttpAdapter } from "./profile-sync-http-adapter.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 16 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

function jsonError(response, status, code) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(JSON.stringify({ code }));
}

async function readBody(request) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) return { error: { status: 400, code: "INVALID_CONTENT_LENGTH" } };
    if (Number(declaredLength) > MAX_REQUEST_BYTES) {
      request.resume();
      return { error: { status: 413, code: "REQUEST_TOO_LARGE" } };
    }
  }

  const chunks = [];
  let totalLength = 0;
  let tooLarge = false;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    totalLength += chunk.byteLength;
    if (totalLength > MAX_REQUEST_BYTES) {
      tooLarge = true;
      chunk.fill(0);
      for (const prior of chunks) prior.fill(0);
      chunks.length = 0;
      continue;
    }
    if (tooLarge) {
      chunk.fill(0);
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) return { error: { status: 413, code: "REQUEST_TOO_LARGE" } };
  return { body: Buffer.concat(chunks), hasBody: totalLength > 0 };
}

function toWebHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function handleNodeRequest(request, response, adapter) {
  let body;
  try {
    const parsedUrl = new URL(request.url ?? "", `http://${LOOPBACK_HOST}`);
    if (parsedUrl.origin !== `http://${LOOPBACK_HOST}` || !request.url?.startsWith("/")) {
      jsonError(response, 400, "INVALID_REQUEST_URL");
      request.resume();
      return;
    }

    const bodyResult = await readBody(request);
    if (bodyResult.error) {
      jsonError(response, bodyResult.error.status, bodyResult.error.code);
      return;
    }
    body = bodyResult.body;
    const method = request.method ?? "GET";
    const hasBody = bodyResult.hasBody;
    const webRequest = new Request(parsedUrl, {
      method,
      headers: toWebHeaders(request.headers),
      ...(hasBody && method !== "GET" && method !== "HEAD" ? { body } : {}),
      redirect: "error",
    });
    const webResponse = await adapter(webRequest);
    const responseHeaders = Object.fromEntries(webResponse.headers.entries());
    response.writeHead(webResponse.status, responseHeaders);
    const responseBytes = Buffer.from(await webResponse.arrayBuffer());
    response.once("close", () => responseBytes.fill(0));
    response.end(responseBytes, () => responseBytes.fill(0));
  } catch {
    jsonError(response, 400, "INVALID_REQUEST");
    request.resume();
  } finally {
    body?.fill(0);
  }
}

/**
 * Start an explicitly local-only HTTP transport for the Profile sync prototype.
 * Trusted identity and consent callbacks remain mandatory; this server does
 * not implement production identity, durable consent, TLS, or cloud deployment.
 */
export async function startLocalProfileSyncHttpServer({
  service,
  consentService,
  resolveBearerToken,
  hasCurrentConsent,
  host = LOOPBACK_HOST,
  port = 0,
} = {}) {
  if (host !== LOOPBACK_HOST) throw new TypeError(`The local prototype may bind only to ${LOOPBACK_HOST}.`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer from 0 to 65535.");

  const adapter = createProfileSyncHttpAdapter({
    service,
    consentService,
    resolveBearerToken,
    hasCurrentConsent,
  });
  const server = createServer({
    headersTimeout: 5000,
    requestTimeout: 10000,
    maxHeadersCount: 64,
  }, (request, response) => {
    void handleNodeRequest(request, response, adapter);
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Could not determine the loopback Profile API listener address.");
  }

  let closed = false;
  return Object.freeze({
    host: LOOPBACK_HOST,
    port: address.port,
    apiBaseUrl: `http://${LOOPBACK_HOST}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      const closePromise = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections?.();
      await closePromise;
    },
  });
}
