import { Type } from "typebox";

export const DEVICE_MONITOR_TOOL_DEFINITIONS = [
  {
    name: "start_household_device_monitor",
    description: "在用户明确要求持续监测时，启动当前后端的只读状态变化订阅和每分钟健康巡检；真实 HA 使用 WebSocket，Mock 使用模拟事件。离线设备默认按普通 2 分钟/显式安全关键 15 秒宽限期复查；多台同时持续离线时将普通设备告警合并成一条共同基础设施风险提示，关键设备仍保留单独告警。宽限期恢复只记录瞬时事件。监测不控制设备、不保存原始状态值。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "stop_household_device_monitor",
    description: "停止本进程内的设备状态事件监测、周期健康巡检和重连；不会修改 HA 或设备。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_household_device_monitor_status",
    description: "读取家庭设备事件监测器的连接状态、离线待复查设备、最近事件摘要、清单刷新和最近一次周期巡检摘要；只读，不返回原始状态属性或令牌。宽限期内恢复只记脱敏瞬时事件；多台同时持续离线时普通设备合并成一条可能的 HA/网络/供电问题提示，明确配置的关键设备仍单独告警，系统不自动判断根因。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
];

function scanSummary(scan, eventCount, trigger) {
  if (!scan?.success) {
    return {
      success: false,
      event_count: eventCount,
      trigger,
      error_code: scan?.error?.code ?? "DEVICE_DISCOVERY_FAILED",
    };
  }
  return {
    success: true,
    event_count: eventCount,
    trigger,
    scanned_at: scan.scanned_at,
    discovered_count: scan.discovered_count,
    newly_discovered_count: scan.newly_discovered_count,
    missing_count: scan.missing_count,
    availability_changes: scan.availability_changes ?? [],
    capability_changes: scan.capability_changes ?? [],
  };
}

function safeEventSummary(event) {
  const safe = {};
  for (const key of ["device_id", "domain", "change_type", "occurred_at"]) {
    if (typeof event?.[key] === "string") safe[key] = event[key];
  }
  for (const key of ["state_changed", "availability_changed", "previous_available", "available"]) {
    if (typeof event?.[key] === "boolean" || event?.[key] === null) safe[key] = event[key];
  }
  if (Array.isArray(event?.capability_changes)) {
    safe.capability_changes = event.capability_changes.flatMap((item) => {
      if (typeof item?.action !== "string") return [];
      const change = { action: item.action };
      for (const key of ["previous", "current"]) {
        if (typeof item[key] === "boolean" || item[key] === null) change[key] = item[key];
      }
      return [change];
    });
  }
  return safe;
}

function safeDiagnosis(item) {
  const safe = {};
  for (const key of ["device_id", "status", "code", "summary"]) {
    if (typeof item?.[key] === "string") safe[key] = item[key];
  }
  if (Array.isArray(item?.recommendations)) {
    safe.recommendations = item.recommendations.filter((value) => typeof value === "string");
  }
  return safe;
}

/** Create opt-in monitor controls bound to one plugin process and inventory. */
export function createHouseholdDeviceMonitorTools({
  deviceInventory,
  createMonitor,
  prepareMonitor = async () => {},
  diagnoseDevice,
  recordDiagnosticAlert,
  recordDiagnosticSharedInfrastructure,
  recordDiagnosticSharedInfrastructureResolved,
  recordDiagnosticTransient,
  recordDiagnosticRecovery,
  recordDiagnosticTrackingEnded,
  debounceMs = 500,
  healthCheckIntervalMs = 60_000,
  offlineGraceMs = 120_000,
  criticalOfflineGraceMs = 15_000,
  criticalOfflineEntityIds = [],
  offlineRetryIntervalMs = 15_000,
  nowImpl = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setHealthTimeoutImpl = setTimeout,
  clearHealthTimeoutImpl = clearTimeout,
  setOfflineTimeoutImpl = setTimeout,
  clearOfflineTimeoutImpl = clearTimeout,
} = {}) {
  if (!deviceInventory || typeof deviceInventory.discover !== "function") {
    throw new Error("设备状态监测工具需要 DeviceInventory 实例");
  }

  if (!Number.isFinite(healthCheckIntervalMs) || healthCheckIntervalMs <= 0) {
    throw new Error("healthCheckIntervalMs 必须是正数");
  }
  for (const [name, value] of Object.entries({ offlineGraceMs, criticalOfflineGraceMs, offlineRetryIntervalMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} 必须是 1 到 2147483647 之间的整数毫秒`);
    }
  }

  const criticalEntities = new Set(criticalOfflineEntityIds);

  const state = {
    pending_events: 0,
    pending_device_ids: new Set(),
    active_alerts: new Map(),
    grouped_offline_alerts: new Map(),
    deferred_offline_alerts: new Map(),
    pending_offline: new Map(),
    shared_infrastructure_incident: null,
    recovered_device_ids: new Set(),
    last_event: null,
    last_refresh: null,
    last_diagnosis: null,
    last_health_check: null,
  };
  let refreshTimer = null;
  let healthCheckTimer = null;
  let healthCheckRunning = false;
  let lifecycleGeneration = 0;

  function clearOfflineTimer(deviceId) {
    const pending = state.pending_offline.get(deviceId);
    if (pending?.timer) clearOfflineTimeoutImpl(pending.timer);
    if (pending) pending.timer = null;
  }

  function offlineSummary() {
    const offlineDeviceIds = new Set(state.pending_offline.keys());
    for (const [deviceId, alert] of state.active_alerts) {
      if (alert.status === "offline") offlineDeviceIds.add(deviceId);
    }
    for (const deviceId of state.grouped_offline_alerts.keys()) offlineDeviceIds.add(deviceId);
    for (const deviceId of state.deferred_offline_alerts.keys()) offlineDeviceIds.add(deviceId);
    const confirmedOfflineDeviceCount = [...state.active_alerts.values()]
      .filter((alert) => alert.status === "offline").length
      + state.grouped_offline_alerts.size
      + state.deferred_offline_alerts.size;
    const count = offlineDeviceIds.size;
    return {
      offline_device_count: count,
      confirmed_offline_device_count: confirmedOfflineDeviceCount,
      pending_offline_device_count: state.pending_offline.size,
      deferred_offline_device_count: state.deferred_offline_alerts.size,
      grouped_offline_device_count: state.grouped_offline_alerts.size,
      grouped_offline_device_ids: [...state.grouped_offline_alerts.keys()],
      suspected_shared_infrastructure_issue: state.shared_infrastructure_incident !== null,
      shared_infrastructure_incident_active: state.shared_infrastructure_incident !== null,
      ...(state.shared_infrastructure_incident !== null ? {
        summary: "同时有 3 台及以上设备离线，可能与 Home Assistant、网络或供电等共同基础设施有关；普通设备已合并提示，当前未自动判定根因，请优先检查共同基础设施。",
      } : {}),
    };
  }

  function offlineDeviceCount() {
    return offlineSummary().confirmed_offline_device_count;
  }

  function pendingOfflineSnapshot() {
    return [...state.pending_offline.values()]
      .map(({ timer: _timer, first_seen_ms: _firstSeenMs, ...item }) => ({ ...item }));
  }

  function offlinePolicySnapshot() {
    return {
      ordinary_grace_ms: offlineGraceMs,
      critical_grace_ms: criticalOfflineGraceMs,
      explicitly_critical_entity_count: criticalEntities.size,
    };
  }

  function updateDiagnosisSnapshot(diagnosis) {
    const activeAlerts = [...state.active_alerts.values()].map(({ signature: _signature, ...item }) => item);
    state.last_diagnosis = {
      ...diagnosis,
      recovered_device_ids: [...state.recovered_device_ids],
      alerts: activeAlerts,
      grouped_offline_device_count: state.grouped_offline_alerts.size,
      shared_infrastructure_incident_active: state.shared_infrastructure_incident !== null,
      pending_offline: pendingOfflineSnapshot(),
      offline_summary: offlineSummary(),
    };
    return state.last_diagnosis;
  }

  async function reconcileSharedInfrastructureIncident() {
    const count = offlineDeviceCount();
    if (!state.shared_infrastructure_incident && count >= 3) {
      state.shared_infrastructure_incident = { opened_at: new Date(nowImpl()).toISOString() };
      for (const [deviceId, alert] of state.active_alerts) {
        if (alert.status !== "offline" || criticalEntities.has(deviceId)) continue;
        state.active_alerts.delete(deviceId);
        state.grouped_offline_alerts.set(deviceId, { ...alert, reported: true });
      }
      for (const [deviceId, alert] of state.deferred_offline_alerts) {
        if (criticalEntities.has(deviceId)) continue;
        state.deferred_offline_alerts.delete(deviceId);
        state.grouped_offline_alerts.set(deviceId, { ...alert, reported: false });
      }
      try {
        await recordDiagnosticSharedInfrastructure?.({
          affected_device_count: count,
          summary: "多台家庭设备同时持续离线，先按共同基础设施风险处理；请检查供电、家庭网络和 Home Assistant，不将每台设备分别判断为故障。",
        });
      } catch {}
      return;
    }

    if (state.shared_infrastructure_incident && count < 3) {
      state.shared_infrastructure_incident = null;
      try {
        await recordDiagnosticSharedInfrastructureResolved?.({
          affected_device_count: count,
          summary: "同时离线设备数量已低于共同基础设施提示阈值；仍离线的普通设备恢复为单设备跟踪。",
        });
      } catch {}
      for (const [deviceId, groupedAlert] of state.grouped_offline_alerts) {
        state.grouped_offline_alerts.delete(deviceId);
        const { reported: _reported, signature: _signature, ...alert } = groupedAlert;
        state.active_alerts.set(deviceId, { ...alert, severity: "warning", signature: `${alert.status}:${alert.code ?? "UNKNOWN"}:warning` });
        if (!groupedAlert.reported) {
          try { await recordDiagnosticAlert?.({ ...alert, severity: "warning" }); } catch {}
        }
      }
    }

    // Hold ordinary-device alerts while three or more devices are still being
    // checked; this prevents the first devices in a shared outage from emitting
    // individual alerts before the remaining grace-period checks finish.
    if (!state.shared_infrastructure_incident
      && offlineDeviceCount() < 3
      && offlineSummary().offline_device_count < 3) {
      for (const [deviceId, alert] of state.deferred_offline_alerts) {
        state.deferred_offline_alerts.delete(deviceId);
        state.active_alerts.set(deviceId, alert);
        try { await recordDiagnosticAlert?.({ ...alert, severity: alert.severity ?? "warning" }); } catch {}
      }
    }
  }

  function scheduleOfflineRecheck(deviceId, generation, delayMs) {
    const pending = state.pending_offline.get(deviceId);
    if (!pending || pending.timer || generation !== lifecycleGeneration) return;
    pending.timer = setOfflineTimeoutImpl(() => {
      pending.timer = null;
      void runOfflineRecheck(deviceId, generation);
    }, delayMs);
  }

  function beginOfflineGrace(item, generation) {
    if (state.active_alerts.has(item.device_id)
      || state.grouped_offline_alerts.has(item.device_id)
      || state.deferred_offline_alerts.has(item.device_id)
      || state.pending_offline.has(item.device_id)) return;
    const firstSeenMs = nowImpl();
    const isCritical = criticalEntities.has(item.device_id);
    const graceMs = isCritical ? criticalOfflineGraceMs : offlineGraceMs;
    const pending = {
      device_id: item.device_id,
      status: "offline_pending_recheck",
      code: typeof item.code === "string" ? item.code : "DEVICE_OFFLINE",
      severity_after_grace: isCritical ? "critical" : "warning",
      grace_ms: graceMs,
      first_seen_at: new Date(firstSeenMs).toISOString(),
      recheck_at: new Date(firstSeenMs + graceMs).toISOString(),
      first_seen_ms: firstSeenMs,
    };
    state.pending_offline.set(item.device_id, pending);
    scheduleOfflineRecheck(item.device_id, generation, graceMs);
  }

  function clearPendingOffline(deviceId) {
    clearOfflineTimer(deviceId);
    return state.pending_offline.get(deviceId) ?? null;
  }

  async function runOfflineRecheck(deviceId, generation) {
    if (generation !== lifecycleGeneration || !monitor?.status()?.monitoring) return;
    const pending = state.pending_offline.get(deviceId);
    if (!pending) return;

    let scan;
    try { scan = await deviceInventory.discover(); } catch { scan = null; }
    if (generation !== lifecycleGeneration) return;
    if (!scan?.success) {
      pending.last_check_error = scan?.error?.code ?? "DEVICE_DISCOVERY_FAILED";
      scheduleOfflineRecheck(deviceId, generation, offlineRetryIntervalMs);
      updateDiagnosisSnapshot({
        success: false,
        trigger: "offline_grace_recheck",
        checked_count: 0,
        failed_count: 1,
        error_code: pending.last_check_error,
      });
      return;
    }

    state.last_refresh = scanSummary(scan, 0, "offline_grace_recheck");
    await endTrackingForMissingDevices(scan, generation);
    if (generation !== lifecycleGeneration || !state.pending_offline.has(deviceId)) return;

    const missing = new Set(Array.isArray(scan.missing) ? scan.missing : []);
    if (missing.has(deviceId)) return;

    const diagnosis = await diagnoseTargets([deviceId], "offline_grace_recheck", generation, {
      promoteOfflineDeviceIds: new Set([deviceId]),
    });
    if (generation !== lifecycleGeneration) return;
    if ((!diagnosis?.success || diagnosis.checked_count === 0) && state.pending_offline.has(deviceId)) {
      const stillPending = state.pending_offline.get(deviceId);
      stillPending.last_check_error = diagnosis?.error_code ?? "DEVICE_DIAGNOSIS_INCOMPLETE";
      scheduleOfflineRecheck(deviceId, generation, offlineRetryIntervalMs);
      updateDiagnosisSnapshot({
        success: false,
        trigger: "offline_grace_recheck",
        checked_count: diagnosis?.checked_count ?? 0,
        failed_count: Math.max(1, diagnosis?.failed_count ?? 0),
        error_code: stillPending.last_check_error,
      });
    } else if (state.pending_offline.has(deviceId)) {
      // A successful diagnosis that did not return this device is inconclusive;
      // keep the grace-period state instead of treating omission as recovery.
      scheduleOfflineRecheck(deviceId, generation, offlineRetryIntervalMs);
    }
  }

  async function endTrackingForMissingDevices(scan, generation) {
    if (!scan?.success || !Array.isArray(scan.missing)) return [];
    const ended = [];
    let trackingChanged = false;
    for (const deviceId of scan.missing) {
      if (generation !== lifecycleGeneration) return ended;
      const pendingOffline = state.pending_offline.get(deviceId);
      if (pendingOffline) {
        clearPendingOffline(deviceId);
        state.pending_offline.delete(deviceId);
        trackingChanged = true;
      }
      const groupedAlert = state.grouped_offline_alerts.get(deviceId);
      if (groupedAlert) {
        state.grouped_offline_alerts.delete(deviceId);
        trackingChanged = true;
      }
      const deferredAlert = state.deferred_offline_alerts.get(deviceId);
      if (deferredAlert) {
        state.deferred_offline_alerts.delete(deviceId);
        trackingChanged = true;
      }
      const previousAlert = state.active_alerts.get(deviceId);
      if (!previousAlert && !groupedAlert) continue;
      state.active_alerts.delete(deviceId);
      state.recovered_device_ids.delete(deviceId);
      trackingChanged = true;
      ended.push(deviceId);
      try {
        await recordDiagnosticTrackingEnded?.({
          device_id: deviceId,
          previous_code: previousAlert?.code ?? groupedAlert?.code ?? "UNKNOWN",
        });
      } catch {}
    }
    await reconcileSharedInfrastructureIncident();
    if (trackingChanged) {
      updateDiagnosisSnapshot({
        success: true,
        trigger: "inventory_refresh",
        checked_count: 0,
        failed_count: 0,
      });
    }
    return ended;
  }

  async function diagnoseTargets(deviceIds, trigger, generation, { promoteOfflineDeviceIds = new Set() } = {}) {
    if (typeof diagnoseDevice !== "function") return null;
    const results = [];
    let failedCount = 0;
    let errorCode = null;
    const requests = deviceIds === null ? [undefined] : deviceIds;
    for (const deviceId of requests) {
      if (generation !== lifecycleGeneration) return null;
      let result;
      try {
        result = await diagnoseDevice({
          ...(deviceId ? { device_id: deviceId } : {}),
          emit_alert_events: false,
        });
      } catch { result = null; }
      if (generation !== lifecycleGeneration) return null;
      if (!result?.success || !Array.isArray(result.diagnoses)) {
        failedCount += 1;
        errorCode ??= result?.error?.code ?? "DEVICE_DIAGNOSIS_FAILED";
        continue;
      }
      results.push(...result.diagnoses);
    }

    for (const item of results) {
      if (typeof item?.device_id !== "string") continue;
      if (item.status === "healthy") {
        const pendingOffline = clearPendingOffline(item.device_id);
        if (pendingOffline) {
          state.pending_offline.delete(item.device_id);
          if (!state.active_alerts.has(item.device_id)) {
            try {
              await recordDiagnosticTransient?.({
                device_id: item.device_id,
                code: pendingOffline.code,
                duration_ms: Math.max(0, nowImpl() - pendingOffline.first_seen_ms),
                summary: "设备在离线宽限期内恢复可用，未生成故障告警。",
              });
            } catch {}
          }
        }
        state.deferred_offline_alerts.delete(item.device_id);
        const previousAlert = state.active_alerts.get(item.device_id);
        if (previousAlert) {
          state.active_alerts.delete(item.device_id);
          state.recovered_device_ids.add(item.device_id);
          try {
            await recordDiagnosticRecovery?.({
              device_id: item.device_id,
              previous_code: previousAlert.code ?? "UNKNOWN",
            });
          } catch {}
        }
        state.grouped_offline_alerts.delete(item.device_id);
        continue;
      }
      if (!["offline", "abnormal"].includes(item.status)) continue;
      state.recovered_device_ids.delete(item.device_id);
      const summary = safeDiagnosis(item);
      const signature = `${summary.status}:${summary.code ?? "UNKNOWN"}`;
      if (item.status === "offline") {
        const pendingOffline = state.pending_offline.get(item.device_id);
        if (pendingOffline && promoteOfflineDeviceIds.has(item.device_id)) {
          clearPendingOffline(item.device_id);
          state.pending_offline.delete(item.device_id);
          const shouldGroup = pendingOffline.severity_after_grace !== "critical"
            && (state.shared_infrastructure_incident !== null || offlineDeviceCount() >= 3);
          if (shouldGroup) {
            state.grouped_offline_alerts.set(item.device_id, {
              ...summary,
              severity: "warning",
              signature: `${summary.status}:${summary.code ?? "UNKNOWN"}:warning`,
              reported: false,
            });
            await reconcileSharedInfrastructureIncident();
          } else {
            const alertSignature = `${summary.status}:${summary.code ?? "UNKNOWN"}:${pendingOffline.severity_after_grace}`;
            if (!state.active_alerts.has(item.device_id) && !state.deferred_offline_alerts.has(item.device_id)) {
              const alert = { ...summary, severity: pendingOffline.severity_after_grace, signature: alertSignature };
              const possibleOfflineCount = offlineSummary().offline_device_count + 1;
              if (pendingOffline.severity_after_grace !== "critical" && possibleOfflineCount >= 3) {
                state.deferred_offline_alerts.set(item.device_id, alert);
              } else {
                state.active_alerts.set(item.device_id, alert);
                try { await recordDiagnosticAlert?.({ ...summary, severity: alert.severity }); } catch {}
              }
              await reconcileSharedInfrastructureIncident();
            }
          }
          continue;
        }
        beginOfflineGrace(item, generation);
        continue;
      }

      const pendingOffline = clearPendingOffline(item.device_id);
      if (pendingOffline) state.pending_offline.delete(item.device_id);
      state.grouped_offline_alerts.delete(item.device_id);
      state.deferred_offline_alerts.delete(item.device_id);
      if (state.active_alerts.get(item.device_id)?.signature !== signature) {
        state.active_alerts.set(item.device_id, { ...summary, severity: "warning", signature });
        try { await recordDiagnosticAlert?.({ ...summary, severity: "warning" }); } catch {}
      }
    }

    await reconcileSharedInfrastructureIncident();

    return updateDiagnosisSnapshot({
      success: failedCount === 0,
      trigger,
      checked_count: results.length,
      failed_count: failedCount,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  function scheduleHealthCheck(generation) {
    if (generation !== lifecycleGeneration || healthCheckTimer || !monitor?.status()?.monitoring) return;
    healthCheckTimer = setHealthTimeoutImpl(() => {
      healthCheckTimer = null;
      void runHealthCheck(generation);
    }, healthCheckIntervalMs);
  }

  async function runHealthCheck(generation) {
    if (generation !== lifecycleGeneration || healthCheckRunning || !monitor?.status()?.monitoring) return;
    healthCheckRunning = true;
    try {
      let scan;
      try { scan = await deviceInventory.discover(); } catch { scan = null; }
      if (generation !== lifecycleGeneration) return;
      state.last_refresh = scanSummary(scan, 0, "periodic_health_check");
      if (!scan?.success) {
        state.last_health_check = {
          success: false,
          trigger: "periodic_health_check",
          checked_at: new Date().toISOString(),
          checked_count: 0,
          error_code: scan?.error?.code ?? "DEVICE_DISCOVERY_FAILED",
        };
      } else {
        await endTrackingForMissingDevices(scan, generation);
        if (generation !== lifecycleGeneration) return;
        const diagnosis = await diagnoseTargets(null, "periodic_health_check", generation);
        if (generation !== lifecycleGeneration) return;
        state.last_health_check = {
          success: diagnosis?.success ?? false,
          trigger: "periodic_health_check",
          checked_at: new Date().toISOString(),
          checked_count: diagnosis?.checked_count ?? 0,
          ...(diagnosis?.error_code ? { error_code: diagnosis.error_code } : {}),
          active_alert_count: diagnosis?.alerts.length ?? state.active_alerts.size,
          pending_offline_count: diagnosis?.pending_offline.length ?? state.pending_offline.size,
          offline_summary: diagnosis?.offline_summary ?? offlineSummary(),
        };
      }
    } finally {
      healthCheckRunning = false;
      scheduleHealthCheck(generation);
    }
  }

  const monitor = typeof createMonitor === "function"
    ? createMonitor({
        onStateChange(event) {
          const generation = lifecycleGeneration;
          state.pending_events += 1;
          const summary = safeEventSummary(event);
          state.last_event = summary;
          if (typeof summary.device_id === "string") state.pending_device_ids.add(summary.device_id);
          if (refreshTimer) return;
          refreshTimer = setTimeoutImpl(async () => {
            refreshTimer = null;
            if (generation !== lifecycleGeneration) return;
            const eventCount = state.pending_events;
            const deviceIds = [...state.pending_device_ids];
            state.pending_events = 0;
            state.pending_device_ids.clear();
            let scan;
            try { scan = await deviceInventory.discover(); } catch { scan = null; }
            if (generation !== lifecycleGeneration) return;
            state.last_refresh = scanSummary(scan, eventCount, "state_change_event");
            const missingIds = new Set(scan?.success && Array.isArray(scan.missing) ? scan.missing : []);
            await endTrackingForMissingDevices(scan, generation);
            if (generation !== lifecycleGeneration) return;
            await diagnoseTargets(deviceIds.filter((deviceId) => !missingIds.has(deviceId)), "state_change_event", generation);
          }, debounceMs);
        },
      })
    : null;

  return {
    async start_household_device_monitor() {
      if (!monitor) {
        return {
          success: false,
          monitoring: false,
          error: {
            code: "MONITOR_BACKEND_UNAVAILABLE",
            message: "当前设备后端没有提供状态监测能力；未启动监测。",
          },
        };
      }
      if (monitor.status()?.monitoring) {
        return {
          success: true,
          already_running: true,
          ...monitor.status(),
          offline_policy: offlinePolicySnapshot(),
          pending_offline: pendingOfflineSnapshot(),
          offline_summary: offlineSummary(),
        };
      }
      const initialScan = await deviceInventory.discover();
      if (!initialScan.success) {
        return {
          success: false,
          monitoring: false,
          error: {
            code: initialScan.error?.code ?? "DEVICE_DISCOVERY_FAILED",
            message: "启动持续监测前的设备扫描失败；未启动监测。",
          },
        };
      }
      try {
        await prepareMonitor(monitor);
      } catch {
        return {
          success: false,
          monitoring: false,
          error: {
            code: "MONITOR_PREPARATION_FAILED",
            message: "监测启动前的观察授权检查失败；没有启动订阅。",
          },
        };
      }
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      if (healthCheckTimer) clearHealthTimeoutImpl(healthCheckTimer);
      healthCheckTimer = null;
      const started = await monitor.start();
      if (started.monitoring && typeof diagnoseDevice === "function") {
        const initialDiagnosis = await diagnoseTargets(
          initialScan.devices.map((device) => device.device_id),
          "startup",
          generation,
        );
        state.last_health_check = {
          success: initialDiagnosis?.success ?? false,
          trigger: "startup",
          checked_at: new Date().toISOString(),
          checked_count: initialDiagnosis?.checked_count ?? 0,
          ...(initialDiagnosis?.error_code ? { error_code: initialDiagnosis.error_code } : {}),
          active_alert_count: initialDiagnosis?.alerts.length ?? state.active_alerts.size,
          pending_offline_count: initialDiagnosis?.pending_offline.length ?? state.pending_offline.size,
          offline_summary: initialDiagnosis?.offline_summary ?? offlineSummary(),
        };
        scheduleHealthCheck(generation);
      }
      return {
        ...started,
        offline_policy: offlinePolicySnapshot(),
        pending_offline: pendingOfflineSnapshot(),
        offline_summary: offlineSummary(),
        initial_scan: scanSummary(initialScan, 0),
        ...(state.last_health_check ? { initial_health_check: structuredClone(state.last_health_check) } : {}),
        note: started.backend_mode === "mock"
          ? "当前为 Mock 模拟监测；事件来自模拟设备变化，不代表真实家庭传感器。周期巡检和事件诊断均只读，不会控制设备。"
          : "监测是只读的；HA 状态事件和每分钟巡检仅刷新清单与诊断，不自动控制设备。",
      };
    },

    stop_household_device_monitor() {
      lifecycleGeneration += 1;
      if (refreshTimer) clearTimeoutImpl(refreshTimer);
      refreshTimer = null;
      if (healthCheckTimer) clearHealthTimeoutImpl(healthCheckTimer);
      healthCheckTimer = null;
      state.pending_events = 0;
      state.pending_device_ids.clear();
      for (const deviceId of state.pending_offline.keys()) clearOfflineTimer(deviceId);
      state.pending_offline.clear();
      if (!monitor) return { success: true, monitoring: false, connection_state: "stopped" };
      return monitor.stop();
    },

    get_household_device_monitor_status() {
      return {
        success: true,
        ...(monitor ? monitor.status() : { monitoring: false, connection_state: "unavailable" }),
        pending_event_count: state.pending_events,
        offline_policy: offlinePolicySnapshot(),
        pending_offline: pendingOfflineSnapshot(),
        offline_summary: offlineSummary(),
        last_event: state.last_event ? structuredClone(state.last_event) : null,
        last_refresh: state.last_refresh ? structuredClone(state.last_refresh) : null,
        last_diagnosis: state.last_diagnosis ? structuredClone(state.last_diagnosis) : null,
        last_health_check: state.last_health_check ? structuredClone(state.last_health_check) : null,
      };
    },
  };
}
