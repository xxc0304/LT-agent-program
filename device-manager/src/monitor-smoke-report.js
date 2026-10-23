const MONITOR_EVENT_TYPES = new Set([
  "diagnostic_alert",
  "diagnostic_transient",
  "diagnostic_recovered",
  "diagnostic_tracking_ended",
  "diagnostic_shared_infrastructure_suspected",
  "diagnostic_shared_infrastructure_cleared",
]);

function safeStateEvent(event) {
  if (!event || typeof event !== "object") return null;
  const safe = {};
  for (const key of ["device_id", "domain", "change_type", "occurred_at"]) {
    if (typeof event[key] === "string") safe[key] = event[key];
  }
  for (const key of ["state_changed", "availability_changed", "previous_available", "available"]) {
    if (typeof event[key] === "boolean" || event[key] === null) safe[key] = event[key];
  }
  return safe;
}

function safeLedgerEvent(event) {
  if (!MONITOR_EVENT_TYPES.has(event?.event_type)) return null;
  const safe = {
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    device_id: event.subject?.device_id,
  };
  for (const key of ["code", "previous_code", "reason"]) {
    if (typeof event.payload?.[key] === "string") {
      safe[key] = event.payload[key];
    }
  }
  if (Number.isSafeInteger(event.payload?.affected_device_count) && event.payload.affected_device_count >= 0) {
    safe.affected_device_count = event.payload.affected_device_count;
  }
  if (Number.isFinite(event.payload?.duration_ms)) safe.duration_ms = Math.max(0, Math.round(event.payload.duration_ms));
  if (["info", "warning", "critical"].includes(event.severity)) safe.severity = event.severity;
  return safe;
}

function safeOfflineSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const count = Number.isSafeInteger(summary.offline_device_count) && summary.offline_device_count >= 0
    ? summary.offline_device_count
    : 0;
  const confirmedCount = Number.isSafeInteger(summary.confirmed_offline_device_count)
    && summary.confirmed_offline_device_count >= 0
    ? summary.confirmed_offline_device_count
    : count;
  const suspected = summary.suspected_shared_infrastructure_issue === true && confirmedCount >= 3;
  return {
    offline_device_count: count,
    confirmed_offline_device_count: confirmedCount,
    pending_offline_device_count: Number.isSafeInteger(summary.pending_offline_device_count)
      ? Math.max(0, summary.pending_offline_device_count)
      : 0,
    deferred_offline_device_count: Number.isSafeInteger(summary.deferred_offline_device_count)
      ? Math.max(0, summary.deferred_offline_device_count)
      : 0,
    grouped_offline_device_count: Number.isSafeInteger(summary.grouped_offline_device_count)
      ? Math.max(0, summary.grouped_offline_device_count)
      : 0,
    grouped_offline_device_ids: Array.isArray(summary.grouped_offline_device_ids)
      ? summary.grouped_offline_device_ids.filter((deviceId) => typeof deviceId === "string").slice(0, 50)
      : [],
    suspected_shared_infrastructure_issue: suspected,
    shared_infrastructure_incident_active: summary.shared_infrastructure_incident_active === true,
    ...(suspected ? {
      summary: "多台设备同时离线，可能存在共同基础设施问题；尚未自动判定根因。",
    } : {}),
  };
}

function safeOfflinePolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  const safe = {};
  for (const key of ["ordinary_grace_ms", "critical_grace_ms", "explicitly_critical_entity_count"]) {
    if (Number.isSafeInteger(policy[key]) && policy[key] >= 0) safe[key] = policy[key];
  }
  return Object.keys(safe).length ? safe : null;
}

/** Build a console-safe, read-only summary; omit credentials, raw states, and attributes. */
export function buildMonitorSmokeReport({
  startResult,
  monitorStatus,
  events = [],
  durationMs = 0,
  interrupted = false,
} = {}) {
  const status = monitorStatus ?? {};
  const initialScan = startResult?.initial_scan ?? {};
  const initialHealthCheck = startResult?.initial_health_check ?? {};
  const lastRefresh = status.last_refresh ?? {};
  const lastDiagnosis = status.last_diagnosis ?? {};

  return {
    result: startResult?.success ? "CONNECTED" : "NOT_CONNECTED",
    backend: startResult?.backend_mode ?? status.backend_mode ?? "home-assistant",
    monitoring_started: startResult?.monitoring === true,
    duration_ms: durationMs,
    interrupted,
    connection_state: status.connection_state ?? startResult?.connection_state ?? "unknown",
    reconnect_attempts: status.reconnect_attempts ?? startResult?.reconnect_attempts ?? 0,
    last_error_code: status.last_error_code ?? startResult?.last_error_code ?? startResult?.error?.code ?? null,
    initial_scan: {
      success: initialScan.success === true,
      discovered_count: initialScan.discovered_count ?? 0,
    },
    initial_health_check: {
      success: initialHealthCheck.success === true,
      checked_count: initialHealthCheck.checked_count ?? 0,
      active_alert_count: initialHealthCheck.active_alert_count ?? 0,
      pending_offline_count: Array.isArray(initialHealthCheck.pending_offline) ? initialHealthCheck.pending_offline.length : 0,
    },
    observed_state_event_count: status.received_event_count ?? 0,
    last_state_event: safeStateEvent(status.last_event),
    last_refresh: {
      success: lastRefresh.success ?? null,
      trigger: lastRefresh.trigger ?? null,
      event_count: lastRefresh.event_count ?? 0,
      discovered_count: lastRefresh.discovered_count ?? 0,
      missing_count: lastRefresh.missing_count ?? 0,
    },
    active_alerts: (Array.isArray(lastDiagnosis.alerts) ? lastDiagnosis.alerts : []).map((alert) => ({
      device_id: alert.device_id,
      status: alert.status,
      code: alert.code,
      severity: alert.severity,
    })),
    pending_offline: (Array.isArray(status.pending_offline) ? status.pending_offline : []).map((item) => ({
      device_id: item.device_id,
      severity_after_grace: item.severity_after_grace,
      grace_ms: item.grace_ms,
      recheck_at: item.recheck_at,
    })),
    offline_policy: safeOfflinePolicy(status.offline_policy),
    offline_summary: safeOfflineSummary(status.offline_summary ?? lastDiagnosis.offline_summary),
    diagnostic_events: events.map(safeLedgerEvent).filter(Boolean),
  };
}
