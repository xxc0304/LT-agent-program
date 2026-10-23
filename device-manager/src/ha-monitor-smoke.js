import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceInventory } from "./device-inventory.js";
import { createHouseholdDeviceMonitorTools } from "./device-monitor-tools.js";
import { buildMonitorSmokeReport } from "./monitor-smoke-report.js";
import { RealHomeAssistant } from "./real-ha.js";

const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 300_000;

function parseEntityAllowlist(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseDuration(value) {
  const duration = value === undefined ? 30_000 : Number(value);
  return Number.isInteger(duration) && duration >= MIN_DURATION_MS && duration <= MAX_DURATION_MS
    ? duration
    : null;
}

function waitOrInterrupt(durationMs, signal) {
  return new Promise((resolve) => {
    const finish = (interrupted) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(interrupted);
    };
    const onAbort = () => finish(true);
    const timer = setTimeout(() => finish(false), durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main() {
  if (!process.env.HA_URL || !process.env.HA_TOKEN) {
    console.error("配置缺失：请在当前 PowerShell 会话设置 HA_URL 和 HA_TOKEN；脚本不会输出令牌。");
    process.exitCode = 1;
    return;
  }

  const durationMs = parseDuration(process.env.HA_MONITOR_SMOKE_DURATION_MS);
  if (durationMs === null) {
    console.error(`HA_MONITOR_SMOKE_DURATION_MS 必须是 ${MIN_DURATION_MS} 到 ${MAX_DURATION_MS} 之间的整数。`);
    process.exitCode = 1;
    return;
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "lt-ha-monitor-smoke-"));
  const abortController = new AbortController();
  const handleInterrupt = () => abortController.abort();
  let monitorTools;

  try {
    const homeAssistant = new RealHomeAssistant({
      baseUrl: process.env.HA_URL,
      token: process.env.HA_TOKEN,
      entityAllowlist: parseEntityAllowlist(process.env.HA_ENTITY_ALLOWLIST),
      confirmationRequiredEntityIds: parseEntityAllowlist(process.env.HA_CONFIRMATION_REQUIRED_ENTITIES),
    });
    const deviceInventory = new DeviceInventory({
      deviceClient: { listDevices: () => homeAssistant.listDevices() },
      filePath: join(tempDirectory, "device-inventory.json"),
    });
    monitorTools = createHouseholdDeviceMonitorTools({
      deviceInventory,
      createMonitor: (options) => homeAssistant.createStateMonitor(options),
      diagnoseDevice: (params) => homeAssistant.diagnoseDevice(params),
      recordDiagnosticAlert: (diagnosis) => homeAssistant.recordDiagnosticAlert(diagnosis),
      recordDiagnosticSharedInfrastructure: (incident) => homeAssistant.recordDiagnosticSharedInfrastructure(incident),
      recordDiagnosticSharedInfrastructureResolved: (resolution) => homeAssistant.recordDiagnosticSharedInfrastructureResolved(resolution),
      recordDiagnosticRecovery: (recovery) => homeAssistant.recordDiagnosticRecovery(recovery),
      recordDiagnosticTrackingEnded: (resolution) => homeAssistant.recordDiagnosticTrackingEnded(resolution),
    });

    const started = await monitorTools.start_household_device_monitor();
    if (!started.success) {
      console.log(JSON.stringify(buildMonitorSmokeReport({
        startResult: started,
        monitorStatus: monitorTools.get_household_device_monitor_status(),
      }), null, 2));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({
      status: "LISTENING",
      connection_state: started.connection_state,
      duration_ms: durationMs,
      note: "只读监测中。可在此期间通过 HA 界面或实体原有控制方式改变测试设备；本脚本不会控制设备。按 Ctrl+C 可提前结束。",
    }, null, 2));

    process.once("SIGINT", handleInterrupt);
    const listeningStartedAt = Date.now();
    const interrupted = await waitOrInterrupt(durationMs, abortController.signal);
    process.off("SIGINT", handleInterrupt);

    const report = buildMonitorSmokeReport({
      startResult: started,
      monitorStatus: monitorTools.get_household_device_monitor_status(),
      events: homeAssistant.getEvents({ limit: 200 }),
      durationMs: Date.now() - listeningStartedAt,
      interrupted,
    });
    console.log(JSON.stringify(report, null, 2));
    if (interrupted) process.exitCode = 130;
  } catch {
    console.error("监测检查失败（HA 凭据和原始设备属性不会输出）。请检查 HA 连通性、令牌权限和 WebSocket 支持。");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleInterrupt);
    monitorTools?.stop_household_device_monitor();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

await main();
