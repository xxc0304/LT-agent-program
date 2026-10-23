import { discoverHomeAssistantCapabilities } from "./ha-capabilities.js";
import { createHash } from "node:crypto";

const SUPPORTED_DOMAINS = new Set([
  "light", "switch", "climate", "cover", "lock", "sensor", "binary_sensor",
]);

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function supportsMap(state, entityId) {
  if (!state) return {};
  const capabilities = discoverHomeAssistantCapabilities({
    entity_id: entityId,
    state: state.state,
    attributes: state.attributes ?? {},
  });
  return Object.fromEntries(Object.entries(capabilities.actions ?? {})
    .map(([name, item]) => [name, item.supported ?? null]));
}

function capabilityDiff(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.flatMap((action) => before[action] === after[action]
    ? []
    : [{ action, previous: before[action] ?? null, current: after[action] ?? null }]);
}

function summarizeStateChanged(event) {
  const data = event?.data;
  const entityId = data?.entity_id;
  if (typeof entityId !== "string" || !entityId.includes(".")) return null;
  const domain = entityId.split(".", 1)[0];
  if (!SUPPORTED_DOMAINS.has(domain)) return null;

  const oldState = data.old_state ?? null;
  const newState = data.new_state ?? null;
  const oldAvailable = oldState ? !["unknown", "unavailable"].includes(oldState.state) : null;
  const newAvailable = newState ? !["unknown", "unavailable"].includes(newState.state) : false;
  const changedActions = capabilityDiff(
    supportsMap(oldState, entityId),
    supportsMap(newState, entityId),
  );
  return {
    device_id: entityId,
    domain,
    change_type: newState === null ? "entity_removed" : "state_changed",
    state_changed: !oldState || !newState || oldState.state !== newState.state,
    availability_changed: oldAvailable !== newAvailable,
    previous_available: oldAvailable,
    available: newAvailable,
    capability_changes: changedActions,
    occurred_at: typeof event.time_fired === "string" ? event.time_fired : new Date().toISOString(),
  };
}

function entityIdsFromServiceData(data) {
  const values = [data?.service_data?.entity_id, data?.target?.entity_id];
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === "string" && /^(?:climate|light)\.[a-z0-9_]+$/.test(value)))].slice(0, 20);
}

/**
 * Reduce HA call_service events to direct, authenticated user actions. The
 * user identity and raw service data are intentionally discarded. Requiring
 * a top-level HA user context excludes automation/agent child calls by
 * default; this is still an attribution signal, not an identity claim.
 */
export function summarizeDirectUserServiceActions(event, { trustedUserIds = [] } = {}) {
  const context = event?.context;
  const data = event?.data;
  const trustedUsers = trustedUserIds instanceof Set ? trustedUserIds : new Set(trustedUserIds);
  if (event?.event_type !== "call_service"
    || typeof context?.user_id !== "string"
    || !context.user_id
    || !trustedUsers.has(context.user_id)
    || (context.parent_id !== undefined && context.parent_id !== null)
    || typeof context.id !== "string"
    || !context.id
    || !data || typeof data !== "object") return [];

  const serviceData = data.service_data && typeof data.service_data === "object"
    ? data.service_data
    : {};
  const serviceKey = `${data.domain}.${data.service}`;
  let value;
  let normalizedAction;
  if (serviceKey === "climate.set_temperature") {
    value = serviceData.temperature;
    normalizedAction = "set_temperature";
    if (!Number.isFinite(value) || value < 16 || value > 30) return [];
  } else if (serviceKey === "light.turn_on") {
    if (Number.isFinite(serviceData.brightness_pct)) {
      value = Math.round(serviceData.brightness_pct);
    } else if (Number.isFinite(serviceData.brightness)) {
      value = Math.round((serviceData.brightness / 255) * 100);
    }
    normalizedAction = "set_brightness";
    if (!Number.isFinite(value) || value < 1 || value > 100) return [];
  } else {
    return [];
  }

  const occurredAt = event.time_fired;
  if (typeof occurredAt !== "string"
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)
    || !Number.isFinite(Date.parse(occurredAt))) return [];

  return entityIdsFromServiceData(data).flatMap((entityId) => {
    const domain = entityId.split(".", 1)[0];
    if ((serviceKey === "climate.set_temperature" && domain !== "climate")
      || (serviceKey === "light.turn_on" && domain !== "light")) return [];
    const eventId = createHash("sha256")
      .update(`${context.id}\u0000${entityId}\u0000${serviceKey}`)
      .digest("hex");
    return [{
      event_type: "ha_user_service_action",
      trusted_source: "ha_call_service_context",
      event_id: eventId,
      entity_id: entityId,
      domain,
      action: normalizedAction,
      value,
      occurred_at: occurredAt,
      actor_source: "user_manual",
    }];
  });
}

function decodeMessage(event) {
  const data = event?.data ?? event;
  if (typeof data === "string") return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data)) return JSON.parse(new TextDecoder().decode(data));
  throw new Error("Home Assistant WebSocket 返回了无法解析的消息");
}

/**
 * Opt-in, read-only HA state_changed subscription with bounded reconnects.
 * call_service is subscribed only while an explicit user-action observer is
 * enabled; that callback receives a strict, sanitized summary. Raw state,
 * attributes, user IDs, service data, and credentials never enter status.
 */
export class HomeAssistantStateMonitor {
  constructor({
    baseUrl,
    token,
    WebSocketImpl = globalThis.WebSocket,
    onStateChange = () => {},
    onUserAction = null,
    trustedUserIds = [],
    timeoutMs = 8_000,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    if (!baseUrl) throw new Error("启动 HA 状态监测时必须设置 HA_URL");
    if (!token) throw new Error("启动 HA 状态监测时必须设置 HA_TOKEN");
    if (typeof onStateChange !== "function") throw new Error("onStateChange 必须是函数");
    if (onUserAction !== null && typeof onUserAction !== "function") throw new Error("onUserAction 必须是函数");
    this.url = websocketUrl(baseUrl);
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.onStateChange = onStateChange;
    this.onUserAction = onUserAction;
    const userIds = trustedUserIds instanceof Set ? [...trustedUserIds] : trustedUserIds;
    this.trustedUserIds = new Set((Array.isArray(userIds) ? userIds : [])
      .filter((value) => typeof value === "string" && value.trim()));
    this.timeoutMs = timeoutMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.running = false;
    this.connectionState = "stopped";
    this.reconnectAttempts = 0;
    this.lastErrorCode = null;
    this.lastEventAt = null;
    this.socket = null;
    this.socketCleanup = null;
    this.reconnectTimer = null;
    this.generation = 0;
    this.activeSubscriptions = null;
    this.subscriptionResults = null;
    this.callServiceSubscriptionId = null;
    this.nextCommandId = 1;
  }

  setUserActionObserver(callback) {
    if (callback !== null && typeof callback !== "function") {
      throw new Error("onUserAction 必须是函数或 null");
    }
    this.onUserAction = callback;
    if (!this.running || this.connectionState !== "connected" || !this.socket || !this.activeSubscriptions) return;

    const actionSubscription = [...this.activeSubscriptions]
      .find(([, eventType]) => eventType === "call_service")?.[0];
    if (!callback && actionSubscription !== undefined) {
      this.activeSubscriptions.delete(actionSubscription);
      this.subscriptionResults?.delete(actionSubscription);
      this.callServiceSubscriptionId = null;
      try {
        this.socket.send(JSON.stringify({
          id: this.nextCommandId++,
          type: "unsubscribe_events",
          subscription: actionSubscription,
        }));
      } catch {
        this.lastErrorCode = "HA_EVENT_UNSUBSCRIBE_FAILED";
      }
      return;
    }
    if (callback && this.trustedUserIds.size > 0 && actionSubscription === undefined) {
      const id = this.nextCommandId++;
      this.activeSubscriptions.set(id, "call_service");
      try {
        this.socket.send(JSON.stringify({ id, type: "subscribe_events", event_type: "call_service" }));
      } catch {
        this.activeSubscriptions.delete(id);
        this.lastErrorCode = "HA_EVENT_SUBSCRIPTION_FAILED";
      }
    }
  }

  status() {
    return {
      monitoring: this.running,
      connection_state: this.connectionState,
      backend_mode: "home-assistant",
      reconnect_attempts: this.reconnectAttempts,
      last_error_code: this.lastErrorCode,
      last_event_at: this.lastEventAt,
    };
  }

  async start() {
    if (this.running) return { success: true, already_running: true, ...this.status() };
    if (typeof this.WebSocketImpl !== "function") {
      return { success: false, ...this.status(), error: { code: "HA_WEBSOCKET_UNAVAILABLE", message: "当前 Node.js 环境没有可用的 WebSocket；未启动持续监测。" } };
    }
    this.running = true;
    this.connectionState = "connecting";
    this.lastErrorCode = null;
    this.generation += 1;
    const generation = this.generation;
    const connected = await this.#connect(generation);
    if (!connected && this.running) this.#scheduleReconnect(generation);
    return {
      success: connected,
      ...this.status(),
      ...(connected ? {} : { note: "监测器已启动并会有限速重连；当前连接尚未建立。" }),
    };
  }

  stop() {
    this.running = false;
    this.connectionState = "stopped";
    this.generation += 1;
    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#closeSocket();
    return { success: true, ...this.status() };
  }

  #closeSocket() {
    this.socketCleanup?.();
    this.socketCleanup = null;
    const socket = this.socket;
    this.socket = null;
    try {
      if (socket && (socket.readyState === undefined || socket.readyState < 2)) socket.close();
    } catch {}
  }

  #scheduleReconnect(generation) {
    if (!this.running || generation !== this.generation || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempts, 10)),
    );
    this.reconnectAttempts += 1;
    this.connectionState = "reconnecting";
    this.reconnectTimer = this.setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.running || generation !== this.generation) return;
      const connected = await this.#connect(generation);
      if (!connected) this.#scheduleReconnect(generation);
    }, delay);
  }

  #connect(generation) {
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch {
      this.lastErrorCode = "HA_WEBSOCKET_UNAVAILABLE";
      this.connectionState = "reconnecting";
      return Promise.resolve(false);
    }
    this.socket = socket;
    this.connectionState = "connecting";
    const subscriptions = new Map([[this.nextCommandId++, "state_changed"]]);
    if (this.onUserAction && this.trustedUserIds.size > 0) subscriptions.set(this.nextCommandId++, "call_service");
    const subscriptionResults = new Set();
    this.activeSubscriptions = subscriptions;
    this.subscriptionResults = subscriptionResults;

    return new Promise((resolve) => {
      let handshakeFinished = false;
      let settled = false;
      let messageChain = Promise.resolve();
      const finishReady = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const detach = () => {
        this.clearTimeout(timeout);
        socket.removeEventListener?.("message", onMessage);
        socket.removeEventListener?.("error", onError);
        socket.removeEventListener?.("close", onClose);
      };
      const disconnect = (code, fatal = false) => {
        if (this.socket === socket) this.socket = null;
        if (this.activeSubscriptions === subscriptions) {
          this.activeSubscriptions = null;
          this.subscriptionResults = null;
          this.callServiceSubscriptionId = null;
        }
        detach();
        try { if (socket.readyState === undefined || socket.readyState < 2) socket.close(); } catch {}
        if (generation === this.generation && this.running) {
          this.lastErrorCode = code;
          this.connectionState = fatal ? "error" : "reconnecting";
          if (fatal) this.running = false;
          else this.#scheduleReconnect(generation);
        }
        finishReady(false);
      };
      const timeout = this.setTimeout(() => disconnect("HA_WEBSOCKET_TIMEOUT"), this.timeoutMs);
      const onError = () => disconnect("HA_WEBSOCKET_UNAVAILABLE");
      const onClose = () => disconnect("HA_WEBSOCKET_CLOSED");
      const onMessage = (rawEvent) => {
        messageChain = messageChain.then(() => {
          if (!this.running || generation !== this.generation || this.socket !== socket) return;
          let message;
          try { message = decodeMessage(rawEvent); } catch {
            disconnect("HA_WEBSOCKET_INVALID_RESPONSE");
            return;
          }
          if (message.type === "auth_required") {
            try { socket.send(JSON.stringify({ type: "auth", access_token: this.token })); } catch { disconnect("HA_WEBSOCKET_UNAVAILABLE"); }
            return;
          }
          if (message.type === "auth_invalid") {
            disconnect("HA_AUTHENTICATION_FAILED", true);
            return;
          }
          if (message.type === "auth_ok") {
            if (this.onUserAction && this.trustedUserIds.size > 0
              && ![...subscriptions.values()].includes("call_service")) {
              subscriptions.set(this.nextCommandId++, "call_service");
            }
            if (!this.onUserAction || this.trustedUserIds.size === 0) {
              for (const [id, eventType] of subscriptions) {
                if (eventType === "call_service") subscriptions.delete(id);
              }
            }
            try {
              for (const [id, eventType] of subscriptions) {
                socket.send(JSON.stringify({ id, type: "subscribe_events", event_type: eventType }));
              }
            } catch { disconnect("HA_WEBSOCKET_UNAVAILABLE"); }
            return;
          }
          if (message.type === "result" && subscriptions.has(message.id)) {
            if (message.success !== true) {
              disconnect("HA_EVENT_SUBSCRIPTION_FAILED");
              return;
            }
            subscriptionResults.add(message.id);
            if (subscriptions.get(message.id) === "call_service") {
              if (this.onUserAction) {
                this.callServiceSubscriptionId = message.id;
              } else {
                this.activeSubscriptions?.delete(message.id);
                this.subscriptionResults?.delete(message.id);
                try {
                  socket.send(JSON.stringify({
                    id: this.nextCommandId++,
                    type: "unsubscribe_events",
                    subscription: message.id,
                  }));
                } catch {}
                return;
              }
            }
            if (subscriptionResults.size === subscriptions.size) {
              handshakeFinished = true;
              this.connectionState = "connected";
              this.lastErrorCode = null;
              this.reconnectAttempts = 0;
              this.clearTimeout(timeout);
              finishReady(true);
            }
            return;
          }
          if (message.type !== "event" || !subscriptions.has(message.id) || !handshakeFinished) return;
          const eventType = subscriptions.get(message.id);
          if (eventType === "call_service") {
            if (!this.onUserAction) return;
            for (const action of summarizeDirectUserServiceActions(message.event, { trustedUserIds: this.trustedUserIds })) {
              this.lastEventAt = action.occurred_at;
              try {
                const callbackResult = this.onUserAction(structuredClone(action));
                if (callbackResult && typeof callbackResult.catch === "function") callbackResult.catch(() => {});
              } catch {}
            }
            return;
          }
          const summarized = summarizeStateChanged(message.event);
          if (!summarized) return;
          this.lastEventAt = summarized.occurred_at;
          try {
            const callbackResult = this.onStateChange(structuredClone(summarized));
            if (callbackResult && typeof callbackResult.catch === "function") callbackResult.catch(() => {});
          } catch {}
        }).catch(() => disconnect("HA_WEBSOCKET_INVALID_RESPONSE"));
      };

      socket.addEventListener?.("message", onMessage);
      socket.addEventListener?.("error", onError);
      socket.addEventListener?.("close", onClose);
      this.socketCleanup = detach;
    });
  }
}
