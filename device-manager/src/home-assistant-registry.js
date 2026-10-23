function failure(code, message) {
  return { success: false, error: { code, message } };
}

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function decodeMessage(event) {
  const data = event?.data ?? event;
  if (typeof data === "string") return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  if (typeof data?.text === "function") return JSON.parse(await data.text());
  throw new Error("Home Assistant WebSocket 返回了无法解析的消息");
}

/**
 * Minimal Home Assistant WebSocket client for read-only registry queries.
 * It never persists or logs the access token, and closes the socket after the
 * three registries have been read.
 */
export class HomeAssistantRegistryClient {
  constructor({
    baseUrl,
    token,
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 8_000,
    cacheTtlMs = 30_000,
    failureCacheTtlMs = 3_000,
  } = {}) {
    if (!baseUrl) throw new Error("读取 HA 注册表时必须设置 HA_URL");
    if (!token) throw new Error("读取 HA 注册表时必须设置 HA_TOKEN");
    this.url = websocketUrl(baseUrl);
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.failureCacheTtlMs = failureCacheTtlMs;
    this.cache = null;
    this.inFlight = null;
  }

  async listRegistries() {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return structuredClone(this.cache.result);
    if (this.inFlight) return structuredClone(await this.inFlight);
    this.inFlight = this.#queryRegistries();
    try {
      const result = await this.inFlight;
      const ttlMs = result.success ? this.cacheTtlMs : this.failureCacheTtlMs;
      if (ttlMs > 0) this.cache = { result: structuredClone(result), expiresAt: Date.now() + ttlMs };
      return result;
    } finally {
      this.inFlight = null;
    }
  }

  async #queryRegistries() {
    if (typeof this.WebSocketImpl !== "function") {
      return failure("HA_WEBSOCKET_UNAVAILABLE", "当前 Node.js 环境没有可用的 WebSocket；将仅使用 HA REST 实体清单");
    }

    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch {
      return failure("HA_WEBSOCKET_UNAVAILABLE", "无法建立 Home Assistant 注册表连接；将仅使用 HA REST 实体清单");
    }

    return new Promise((resolve) => {
      let settled = false;
      let messageChain = Promise.resolve();
      let expectedId = null;
      let registryIndex = 0;
      const registries = [];
      const commands = [
        "config/device_registry/list",
        "config/entity_registry/list",
        "config/area_registry/list",
      ];
      const timeout = setTimeout(() => {
        finish(failure("HA_WEBSOCKET_TIMEOUT", "读取 Home Assistant 注册表超时；将仅使用 HA REST 实体清单"));
      }, this.timeoutMs);

      const close = () => {
        try {
          if (socket.readyState === undefined || socket.readyState < 2) socket.close();
        } catch {}
      };
      const removeListeners = () => {
        socket.removeEventListener?.("message", onMessage);
        socket.removeEventListener?.("error", onError);
        socket.removeEventListener?.("close", onClose);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeListeners();
        close();
        resolve(result);
      };
      const sendNextCommand = () => {
        expectedId = registryIndex + 1;
        try {
          socket.send(JSON.stringify({ id: expectedId, type: commands[registryIndex] }));
        } catch {
          finish(failure("HA_WEBSOCKET_UNAVAILABLE", "Home Assistant 注册表连接已中断；将仅使用 HA REST 实体清单"));
        }
      };
      const onError = () => finish(failure(
        "HA_WEBSOCKET_UNAVAILABLE",
        "Home Assistant 注册表连接失败；将仅使用 HA REST 实体清单",
      ));
      const onClose = () => {
        if (!settled) onError();
      };
      const onMessage = (event) => {
        messageChain = messageChain.then(async () => {
          if (settled) return;
          let message;
          try {
            message = await decodeMessage(event);
          } catch {
            finish(failure("HA_WEBSOCKET_INVALID_RESPONSE", "Home Assistant 注册表响应格式无效；将仅使用 HA REST 实体清单"));
            return;
          }

          if (message.type === "auth_required") {
            try {
              socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
            } catch {
              finish(failure("HA_WEBSOCKET_UNAVAILABLE", "Home Assistant 注册表连接已中断；将仅使用 HA REST 实体清单"));
            }
            return;
          }
          if (message.type === "auth_invalid") {
            finish(failure("HA_AUTHENTICATION_FAILED", "Home Assistant WebSocket 认证失败；将仅使用 HA REST 实体清单"));
            return;
          }
          if (message.type === "auth_ok") {
            sendNextCommand();
            return;
          }
          if (message.type !== "result" || message.id !== expectedId) return;
          if (message.success !== true || !Array.isArray(message.result)) {
            finish(failure("HA_REGISTRY_QUERY_FAILED", "Home Assistant 注册表查询失败；将仅使用 HA REST 实体清单"));
            return;
          }
          registries.push(message.result);
          registryIndex += 1;
          if (registryIndex < commands.length) {
            sendNextCommand();
          } else {
            finish({
              success: true,
              registries: {
                devices: registries[0],
                entities: registries[1],
                areas: registries[2],
              },
            });
          }
        }).catch(() => finish(failure(
          "HA_WEBSOCKET_INVALID_RESPONSE",
          "处理 Home Assistant 注册表响应失败；将仅使用 HA REST 实体清单",
        )));
      };

      socket.addEventListener?.("message", onMessage);
      socket.addEventListener?.("error", onError);
      socket.addEventListener?.("close", onClose);
    });
  }
}

/** Join HA REST state entities to their entity/device/area registry records. */
export function enrichEntitiesWithRegistries(entities, registries) {
  const deviceById = new Map((registries.devices ?? []).map((item) => [item.id, item]));
  const entityById = new Map((registries.entities ?? []).map((item) => [item.entity_id, item]));
  const areaById = new Map((registries.areas ?? []).map((item) => [item.area_id, item]));
  const enabledEntities = entities.filter((entity) => entityById.get(entity.entity_id)?.disabled_by == null);
  const devices = enabledEntities.map((entity) => {
    const entityRegistry = entityById.get(entity.entity_id);
    const device = entityRegistry?.device_id ? deviceById.get(entityRegistry.device_id) : null;
    // An entity-specific area assignment overrides the physical device area.
    const areaId = entityRegistry?.area_id || device?.area_id || null;
    const area = areaId ? areaById.get(areaId) : null;
    return {
      ...entity,
      ha_device_id: device?.id ?? entityRegistry?.device_id ?? null,
      ha_entity_unique_id: entityRegistry?.unique_id ?? null,
      ha_area_id: areaId,
      area_name: area?.name ?? null,
      source_device_name: device?.name_by_user || device?.name || null,
      manufacturer: device?.manufacturer ?? null,
      model: device?.model ?? null,
    };
  });
  return { devices, disabled_entity_count: entities.length - enabledEntities.length };
}
