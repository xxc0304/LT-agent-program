import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const INVENTORY_SCHEMA_VERSION = "0.2";
const SUPPORTED_INVENTORY_SCHEMA_VERSIONS = new Set(["0.1", INVENTORY_SCHEMA_VERSION]);
const CONTROLLABLE_DOMAINS = new Set(["light", "switch", "climate", "cover", "lock"]);
const ENERGY_DOMAINS = new Set(["light", "switch", "climate"]);

function failure(code, message, details = {}) {
  return { success: false, error: { code, message, ...details } };
}

function clone(value) {
  return structuredClone(value);
}

function currentIso(clock) {
  return new Date(clock()).toISOString();
}

function normalizeArea(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized || null;
}

function capabilitySupportChanges(previous, current) {
  if (!previous?.actions || !current?.actions) return [];
  const actionNames = [...new Set([
    ...Object.keys(previous.actions),
    ...Object.keys(current.actions),
  ])].sort();
  return actionNames.flatMap((action) => {
    const before = previous.actions[action]?.supported ?? null;
    const after = current.actions[action]?.supported ?? null;
    return before === after ? [] : [{ action, previous: before, current: after }];
  });
}

function normalizeDiscoveredDevice(device) {
  if (!device || typeof device !== "object"
    || typeof device.device_id !== "string" || !device.device_id
    || typeof device.name !== "string" || !device.name
    || typeof device.domain !== "string" || !device.domain
    || typeof device.available !== "boolean") {
    return null;
  }
  return device;
}

function validateLoadedInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !SUPPORTED_INVENTORY_SCHEMA_VERSIONS.has(value.schema_version)
    || !Array.isArray(value.devices)) {
    throw new Error("家庭设备清单文件格式无效；为避免覆盖数据，已停止加载");
  }

  for (const record of value.devices) {
    if (!record || typeof record !== "object"
      || typeof record.device_id !== "string"
      || !["pending_review", "approved", "excluded"].includes(record.approval_status)
      || typeof record.energy_opt_in !== "boolean") {
      throw new Error("家庭设备清单包含无效记录；为避免覆盖数据，已停止加载");
    }
  }
  return value.devices.map((record) => ({
    ...record,
    // Older inventories did not distinguish a HA room suggestion from a
    // user-confirmed room. Require a fresh explicit room review before energy use.
    area_confirmed: typeof record.area_confirmed === "boolean" ? record.area_confirmed : false,
  }));
}

function groupPhysicalDevices(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.ha_device_id ? `ha:${record.ha_device_id}` : `entity:${record.device_id}`;
    const group = groups.get(key) ?? {
      ha_device_id: record.ha_device_id ?? null,
      device_name: record.source_device_name ?? null,
      manufacturer: record.manufacturer ?? null,
      model: record.model ?? null,
      areas: [],
      entities: [],
    };
    const area = {
      ha_area_id: record.ha_area_id ?? null,
      area_name: record.area_name ?? null,
      area_id: record.area_id ?? null,
      area_confirmed: record.area_confirmed === true,
    };
    const areaKey = JSON.stringify(area);
    if (!group.areas.some((item) => item.key === areaKey)) group.areas.push({ key: areaKey, ...area });
    group.entities.push({
      device_id: record.device_id,
      name: record.name,
      domain: record.domain,
      ...area,
      approval_status: record.approval_status,
      energy_opt_in: record.energy_opt_in,
      present_in_latest_scan: record.present_in_latest_scan === true,
    });
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const areas = group.areas.map(({ key: _key, ...area }) => area);
    const singleArea = areas.length === 1 ? areas[0] : null;
    return {
      ...group,
      areas,
      ha_area_id: singleArea?.ha_area_id ?? null,
      area_name: singleArea?.area_name ?? null,
      area_id: singleArea?.area_id ?? null,
      area_confirmed: singleArea?.area_confirmed ?? false,
      area_conflict: areas.length > 1,
      entity_count: group.entities.length,
    };
  });
}

/**
 * Resolve a per-OpenClaw household inventory path. Only user-reviewed metadata
 * is persisted here; HA credentials and volatile device states are never saved.
 */
export function resolveDeviceInventoryPath(env = process.env) {
  if (typeof env.DEVICE_MANAGER_INVENTORY_PATH === "string"
    && env.DEVICE_MANAGER_INVENTORY_PATH.trim()) {
    return resolve(env.DEVICE_MANAGER_INVENTORY_PATH.trim());
  }
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? resolve(env.OPENCLAW_STATE_DIR.trim())
    : join(homedir(), ".openclaw");
  return join(stateDir, "device-manager", "device-inventory.json");
}

/** Add an execution-time enrollment check in front of device writes. */
export function createInventoryGuardedDeviceRuntime(baseRuntime, inventory, { scenes = {} } = {}) {
  if (!baseRuntime || typeof baseRuntime.invoke !== "function") {
    throw new Error("设备清单运行时需要一个可调用 invoke() 的基础运行时");
  }
  if (!inventory || typeof inventory.discover !== "function"
    || typeof inventory.isControlApproved !== "function") {
    throw new Error("设备清单运行时需要 DeviceInventory 实例");
  }

  return {
    ...baseRuntime,
    async invoke(toolName, params = {}) {
      const targetIds = toolName === "control_device"
        ? [params.device_id]
        : toolName === "run_scene"
          ? (scenes[params.scene_id]?.steps ?? []).map((step) => step.device_id)
          : [];
      if (targetIds.length > 0) {
        const scan = await inventory.discover();
        if (!scan.success) return scan;
        const unapproved = [...new Set(targetIds)].filter((deviceId) => !inventory.isControlApproved(deviceId));
        if (unapproved.length > 0) {
          return {
            success: false,
            execution_performed: false,
            error: {
              code: "DEVICE_APPROVAL_REQUIRED",
              message: "目标设备尚未完成家庭设备登记；请先扫描、核对名称/房间并登记批准后再控制。",
              device_ids: unapproved,
            },
          };
        }
      }
      return baseRuntime.invoke(toolName, params);
    },
  };
}

/**
 * Local household inventory built from Home Assistant entities.
 * Discovery is read-only. New entities remain pending until reviewed, and
 * energy control is opt-in per entity.
 */
export class DeviceInventory {
  constructor({ deviceClient, filePath = resolveDeviceInventoryPath(), clock = () => Date.now() } = {}) {
    if (!deviceClient || typeof deviceClient.listDevices !== "function") {
      throw new Error("DeviceInventory 需要提供 listDevices() 的设备客户端");
    }
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("DeviceInventory 需要有效的 filePath");
    }
    this.deviceClient = deviceClient;
    this.filePath = resolve(filePath);
    this.clock = clock;
    this.records = new Map();
    this.lastScanIds = new Set();
    this.lastScanAvailability = new Map();
    this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("家庭设备清单无法解析；为避免覆盖原文件，已停止加载");
    }
    for (const record of validateLoadedInventory(parsed)) {
      this.records.set(record.device_id, clone(record));
    }
  }

  #save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const contents = `${JSON.stringify({
      schema_version: INVENTORY_SCHEMA_VERSION,
      updated_at: currentIso(this.clock),
      devices: [...this.records.values()],
    }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      // Windows may reject replacing an existing file with rename(). Preserve
      // the data by copying the complete temporary file before removing it.
      try {
        if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
        copyFileSync(temporaryPath, this.filePath);
        unlinkSync(temporaryPath);
      } catch (writeError) {
        try { unlinkSync(temporaryPath); } catch {}
        throw writeError;
      }
    }
  }

  async discover() {
    let result;
    try {
      result = await this.deviceClient.listDevices();
    } catch {
      return failure("DEVICE_DISCOVERY_FAILED", "读取 Home Assistant 设备清单失败；原清单未修改");
    }
    if (!result?.success || !Array.isArray(result.devices)) {
      return failure(
        result?.error?.code ?? "DEVICE_DISCOVERY_FAILED",
        result?.error?.message ?? "Home Assistant 未返回有效设备清单；原清单未修改",
      );
    }

    const devices = result.devices.map(normalizeDiscoveredDevice);
    if (devices.some((device) => device === null)) {
      return failure("INVALID_DISCOVERY_DEVICE", "Home Assistant 返回了字段不完整的实体；原清单未修改");
    }

    const now = currentIso(this.clock);
    const registryStatus = result.registry_enrichment?.status ?? "not_provided";
    const discoveredIds = new Set(devices.map((device) => device.device_id));
    const newlyDiscovered = [];
    const missing = [];
    const capabilityChanges = [];
    const availabilityChanges = [];
    const previousRecords = this.records;
    const previousScanIds = this.lastScanIds;
    this.records = new Map([...this.records].map(([deviceId, record]) => [deviceId, clone(record)]));
    this.lastScanIds = discoveredIds;

    for (const device of devices) {
      const previous = this.records.get(device.device_id);
      const sourceAreaName = device.area_name ?? device.area ?? device.attributes?.area ?? null;
      const areaFromSource = normalizeArea(sourceAreaName);
      const haMetadata = registryStatus === "available"
        ? {
          ha_device_id: device.ha_device_id ?? null,
          ha_entity_unique_id: device.ha_entity_unique_id ?? null,
          ha_area_id: device.ha_area_id ?? null,
          area_name: device.area_name ?? null,
          source_device_name: device.source_device_name ?? null,
          manufacturer: device.manufacturer ?? null,
          model: device.model ?? null,
          registry_enrichment_status: "available",
          registry_metadata_last_seen_at: now,
        }
        : {};
      if (!previous) {
        const record = {
          device_id: device.device_id,
          name: device.name,
          name_override: null,
          domain: device.domain,
          area_id: areaFromSource,
          area_name: device.area_name ?? null,
          area_confirmed: false,
          area_source: sourceAreaName ? (registryStatus === "available" ? "home_assistant" : "source") : null,
          ...haMetadata,
          ...(device.capabilities ? { capability_snapshot: clone(device.capabilities), capabilities_last_seen_at: now } : {}),
          approval_status: "pending_review",
          energy_opt_in: false,
          controllable: CONTROLLABLE_DOMAINS.has(device.domain),
          source_platform: "home_assistant",
          first_seen_at: now,
          last_seen_at: now,
          reviewed_at: null,
          review_reason: null,
        };
        this.records.set(device.device_id, record);
        newlyDiscovered.push(device.device_id);
        continue;
      }

      const domainChanged = previous.domain !== device.domain;
      const changedActions = capabilitySupportChanges(previous.capability_snapshot, device.capabilities);
      if (changedActions.length > 0) {
        const change = {
          device_id: device.device_id,
          name: previous.name_override ?? device.name,
          changed_actions: changedActions,
          changed_at: now,
        };
        capabilityChanges.push(change);
      }
      const previousAvailability = this.lastScanAvailability.get(device.device_id);
      if (previousAvailability !== undefined && previousAvailability !== device.available) {
        availabilityChanges.push({
          device_id: device.device_id,
          name: previous.name_override ?? device.name,
          previous_available: previousAvailability,
          available: device.available,
          observed_at: now,
        });
      }
      const next = {
        ...previous,
        ...haMetadata,
        ...(device.capabilities ? { capability_snapshot: clone(device.capabilities), capabilities_last_seen_at: now } : {}),
        name: previous.name_override ?? device.name,
        domain: device.domain,
        controllable: CONTROLLABLE_DOMAINS.has(device.domain),
        area_id: previous.area_confirmed === true
          ? previous.area_id
          : registryStatus === "unavailable" ? (previous.area_id ?? areaFromSource) : areaFromSource,
        area_name: registryStatus === "available"
          ? (device.area_name ?? null)
          : registryStatus === "unavailable" ? (previous.area_name ?? device.area_name ?? null) : (device.area_name ?? null),
        area_source: previous.area_confirmed === true
          ? "user_review"
          : registryStatus === "unavailable"
            ? (previous.area_source ?? (sourceAreaName ? "source" : null))
            : sourceAreaName ? (registryStatus === "available" ? "home_assistant" : "source") : null,
        last_seen_at: now,
        ...(changedActions.length > 0 ? {
          last_capability_change: {
            changed_at: now,
            changed_actions: changedActions,
          },
        } : {}),
      };
      if (domainChanged || previous.presence_status === "not_found") {
        next.approval_status = "pending_review";
        next.energy_opt_in = false;
        next.reviewed_at = null;
        next.review_reason = null;
      }
      delete next.presence_status;
      this.records.set(device.device_id, next);
    }

    for (const [deviceId, record] of this.records) {
      if (discoveredIds.has(deviceId)) continue;
      if (record.presence_status === "not_found") continue;
      this.records.set(deviceId, {
        ...record,
        presence_status: "not_found",
        approval_status: "pending_review",
        energy_opt_in: false,
        reviewed_at: null,
        review_reason: "HA_ENTITY_NOT_FOUND_DURING_DISCOVERY",
      });
      missing.push(deviceId);
    }

    try {
      this.#save();
    } catch {
      this.records = previousRecords;
      this.lastScanIds = previousScanIds;
      return failure("INVENTORY_PERSIST_FAILED", "设备扫描结果无法安全写入本地清单；原清单保持不变");
    }
    const inventory = devices.map((device) => this.#enrich(device));
    this.lastScanAvailability = new Map(devices.map((device) => [device.device_id, device.available]));
    const groups = groupPhysicalDevices(inventory);
    return {
      success: true,
      scanned_at: now,
      registry_enrichment: result.registry_enrichment ?? { status: "not_provided" },
      ...(result.disabled_entity_count !== undefined ? { disabled_entity_count: result.disabled_entity_count } : {}),
      discovered_count: devices.length,
      newly_discovered_count: newlyDiscovered.length,
      missing_count: missing.length,
      pending_review_count: inventory.filter((record) => record.approval_status === "pending_review").length,
      newly_discovered: newlyDiscovered,
      missing,
      capability_changes: capabilityChanges,
      availability_changes: availabilityChanges,
      devices: inventory,
      physical_devices: groups,
      note: "发现过程只读取 HA 实体；新设备默认待核对，不会因此获得自动控制权限。",
    };
  }

  list() {
    const devices = [...this.records.values()].map((record) => ({
      ...clone(record),
      present_in_latest_scan: this.lastScanIds.has(record.device_id),
    }));
    return {
      success: true,
      count: devices.length,
      devices,
      physical_devices: groupPhysicalDevices(devices),
    };
  }

  review({ device_id, name, area_id, approval_status, energy_opt_in, reason } = {}) {
    if (typeof device_id !== "string" || !device_id.trim()) {
      return failure("INVALID_DEVICE_ID", "device_id 必须是非空字符串");
    }
    const existing = this.records.get(device_id);
    if (!existing) return failure("DEVICE_NOT_IN_INVENTORY", "请先扫描发现该设备，再登记核对");
    if (!this.lastScanIds.has(device_id) || existing.presence_status === "not_found") {
      return failure("DEVICE_NOT_PRESENT", "设备未出现在最近一次成功扫描中；请先重新扫描，不进行授权");
    }
    if (approval_status !== "approved" && approval_status !== "excluded") {
      return failure("INVALID_APPROVAL_STATUS", "approval_status 只能是 approved 或 excluded");
    }
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return failure("INVALID_NAME", "name 必须是非空字符串");
    }
    if (area_id !== undefined && normalizeArea(area_id) === null) {
      return failure("INVALID_AREA", "area_id 必须是非空房间标识");
    }
    if (energy_opt_in !== undefined && typeof energy_opt_in !== "boolean") {
      return failure("INVALID_ENERGY_OPT_IN", "energy_opt_in 必须是布尔值");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      return failure("REVIEW_REASON_REQUIRED", "登记或授权时必须记录 reason");
    }

    const energyOptIn = energy_opt_in === undefined
      ? approval_status === "approved"
        && existing.approval_status === "approved"
        && existing.energy_opt_in
      : energy_opt_in === true;
    if (energyOptIn && approval_status !== "approved") {
      return failure("ENERGY_REQUIRES_APPROVAL", "只有已确认设备才能纳入节能 Agent");
    }
    if (energyOptIn && !ENERGY_DOMAINS.has(existing.domain)) {
      return failure("ENERGY_DOMAIN_NOT_SUPPORTED", "节能 Agent 当前只接受灯、开关/插座和空调实体");
    }
    if (energyOptIn && !normalizeArea(area_id ?? existing.area_id)) {
      return failure("ENERGY_AREA_REQUIRED", "纳入节能前必须确认设备所属房间");
    }
    if (energyOptIn && existing.area_confirmed !== true && area_id === undefined) {
      return failure("ENERGY_AREA_CONFIRMATION_REQUIRED", "HA 房间信息只是待核对建议；纳入节能前请明确提交核对后的 area_id");
    }

    const updated = {
      ...existing,
      ...(name !== undefined ? { name: name.trim(), name_override: name.trim() } : {}),
      ...(area_id !== undefined ? { area_id: normalizeArea(area_id) } : {}),
      ...(area_id !== undefined ? { area_confirmed: true, area_source: "user_review" } : {}),
      approval_status,
      energy_opt_in: energyOptIn,
      reviewed_at: currentIso(this.clock),
      review_reason: reason.trim(),
    };
    this.records.set(device_id, updated);
    try {
      this.#save();
    } catch {
      this.records.set(device_id, existing);
      return failure("INVENTORY_PERSIST_FAILED", "登记信息无法安全写入本地清单；原登记保持不变");
    }
    return { success: true, device: { ...clone(updated), present_in_latest_scan: true } };
  }

  isControlApproved(deviceId) {
    const record = this.records.get(deviceId);
    return Boolean(record
      && this.lastScanIds.has(deviceId)
      && record.presence_status !== "not_found"
      && record.approval_status === "approved"
      && record.controllable);
  }

  async listEnergyEligibleDevices() {
    let result;
    try {
      result = await this.deviceClient.listDevices();
    } catch {
      return failure("DEVICE_STATE_UNAVAILABLE", "无法读取当前设备状态；节能 Agent 不会生成任务");
    }
    if (!result?.success || !Array.isArray(result.devices)) {
      return failure(
        result?.error?.code ?? "DEVICE_STATE_UNAVAILABLE",
        result?.error?.message ?? "无法读取当前设备状态；节能 Agent 不会生成任务",
      );
    }

    const devices = result.devices.flatMap((device) => {
      const record = this.records.get(device.device_id);
      if (!record || record.approval_status !== "approved" || !record.energy_opt_in
        || record.area_confirmed !== true
        || !ENERGY_DOMAINS.has(record.domain) || record.domain !== device.domain) return [];
      return [{
        ...clone(device),
        name: record.name,
        area: record.area_id,
        inventory_approval_status: record.approval_status,
        energy_opt_in: true,
      }];
    });
    return { success: true, count: devices.length, devices };
  }

  #enrich(device) {
    const record = this.records.get(device.device_id);
    return {
      ...clone(record),
      name: record.name,
      current_state: device.state,
      available: device.available,
      current_area_id: record.area_id,
      ...(device.capabilities ? { current_capabilities: clone(device.capabilities) } : {}),
      present_in_latest_scan: this.lastScanIds.has(device.device_id),
    };
  }
}

