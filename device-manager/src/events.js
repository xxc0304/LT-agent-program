function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function privacyLevelFor(dataLevel) {
  return {
    L0: "family",
    L1: "family",
    L2: "sensitive",
    L3: "restricted",
  }[dataLevel] ?? "family";
}

/** In-memory event ledger used by Mock HA and the local demo. */
export class DeviceEventLedger {
  constructor({ sourceType = "simulator", sourceId = "device-manager-mock" } = {}) {
    this.events = [];
    this.source = { type: sourceType, id: sourceId };
  }

  append({ event_type, device_id, payload = {}, severity = "info", data_level = "L0", trace_id = null } = {}) {
    const occurredAt = now();
    const sequence = this.events.length + 1;
    const event = {
      schema_version: "0.1",
      event_id: `evt_${String(sequence).padStart(6, "0")}`,
      source_agent: "device-manager",
      event_type,
      source: this.source,
      subject: { device_id },
      occurred_at: occurredAt,
      received_at: occurredAt,
      severity,
      data_level,
      privacy_level: privacyLevelFor(data_level),
      payload: clone(payload),
      dedup_key: `${device_id ?? "system"}:${event_type}:${sequence}`,
      trace_id,
    };
    this.events.push(event);
    return clone(event);
  }

  list({ device_id, event_type, trace_id, limit = 50 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return clone(this.events
      .filter((event) => !device_id || event.subject.device_id === device_id)
      .filter((event) => !event_type || event.event_type === event_type)
      .filter((event) => !trace_id || event.trace_id === trace_id)
      .slice(-safeLimit)
      .reverse());
  }

  get length() {
    return this.events.length;
  }
}
