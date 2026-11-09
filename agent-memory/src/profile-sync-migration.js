import { buildPreferenceUpsertChange, inspectLocalPreferenceForSync } from "./profile-sync-payload.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_TYPES = Object.freeze([
  "comfort_temperature_c",
  "comfort_brightness_pct",
  "sleep_time",
  "wake_time",
]);
const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const STATUSES = new Set(["confirmed", "pending_confirmation", "observing"]);
const SHARING_SCOPES = new Set(["personal", "household"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Build a read-only migration preview. Item rows contain only opaque local IDs,
 * allow-listed memory types, normalized statuses, eligibility and error codes.
 * Preference values, scope, local subject, timestamps, evidence and consent
 * details are never returned.
 */
export function buildPreferenceMigrationPreview({ memories, clock = () => Date.now() } = {}) {
  if (!Array.isArray(memories)) {
    throw codedError("MIGRATION_MEMORIES_REQUIRED", "迁移预览需要本地偏好记录列表。");
  }
  if (typeof clock !== "function") {
    throw codedError("MIGRATION_CLOCK_INVALID", "迁移预览时钟必须是函数。");
  }

  const idCounts = new Map();
  for (const memory of memories) {
    if (isUuid(memory?.memory_id)) {
      const id = memory.memory_id.toLowerCase();
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }

  const items = memories.map((memory) => {
    const memoryId = isUuid(memory?.memory_id) ? memory.memory_id : null;
    const memoryType = MEMORY_TYPE_SET.has(memory?.memory_type) ? memory.memory_type : "unsupported";
    const status = STATUSES.has(memory?.status) ? memory.status : "invalid";
    let reasonCode = null;

    if (!memoryId) {
      reasonCode = "INVALID_PREFERENCE_ID";
    } else if (idCounts.get(memoryId.toLowerCase()) > 1) {
      reasonCode = "DUPLICATE_MEMORY_ID";
    } else {
      try {
        inspectLocalPreferenceForSync(memory, { clock });
      } catch (error) {
        reasonCode = typeof error?.code === "string" ? error.code : "INVALID_LOCAL_PREFERENCE";
      }
    }

    return {
      memory_id: memoryId,
      memory_type: memoryType,
      status,
      eligible: reasonCode === null,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    };
  });

  const byMemoryType = Object.fromEntries(
    [...MEMORY_TYPES, "unsupported"].map((memoryType) => [memoryType, { total: 0, eligible: 0, excluded: 0 }]),
  );
  for (const item of items) {
    const counts = byMemoryType[item.memory_type];
    counts.total += 1;
    counts[item.eligible ? "eligible" : "excluded"] += 1;
  }

  const eligibleCount = items.filter((item) => item.eligible).length;
  return {
    schema_version: "0.1",
    total_count: items.length,
    eligible_count: eligibleCount,
    excluded_count: items.length - eligibleCount,
    by_memory_type: byMemoryType,
    items,
  };
}

/**
 * Prepare selected migration changes after explicit global sync consent and a
 * separate per-item confirmation. `selections` must come from a trusted user
 * flow, never model-controlled arguments. Each selection supplies a stable
 * change_id retained by that flow so a retry can reuse the exact operation.
 * The result contains preference values; never print or log it.
 */
export function buildPreferenceMigrationChanges({
  memories,
  selections,
  remote_sync_confirmed = false,
  clock = () => Date.now(),
} = {}) {
  if (remote_sync_confirmed !== true) {
    throw codedError("REMOTE_SYNC_CONSENT_REQUIRED", "开始迁移前必须获得用户对跨端同步的明确同意。");
  }
  if (!Array.isArray(memories) || !Array.isArray(selections)) {
    throw codedError("MIGRATION_INPUT_INVALID", "迁移需要本地偏好列表和逐项确认列表。");
  }
  if (typeof clock !== "function") {
    throw codedError("MIGRATION_CLOCK_INVALID", "迁移时钟必须是函数。");
  }

  const records = new Map();
  const duplicateIds = new Set();
  for (const memory of memories) {
    if (!isUuid(memory?.memory_id)) continue;
    const id = memory.memory_id.toLowerCase();
    if (records.has(id)) duplicateIds.add(id);
    else records.set(id, memory);
  }

  const selectedIds = new Set();
  const changeIds = new Set();
  return selections.map((selection) => {
    if (!selection || typeof selection !== "object" || !isUuid(selection.memory_id)) {
      throw codedError("MIGRATION_SELECTION_INVALID", "逐项确认必须引用有效的本地偏好 ID。");
    }
    const selectedId = selection.memory_id.toLowerCase();
    if (selectedIds.has(selectedId)) {
      throw codedError("MIGRATION_SELECTION_DUPLICATE", "同一偏好不能在一次迁移中重复选择。");
    }
    selectedIds.add(selectedId);
    if (selection.item_consent_confirmed !== true) {
      throw codedError("MIGRATION_ITEM_CONSENT_REQUIRED", "每条迁移偏好都需要单独确认。");
    }
    if (!SHARING_SCOPES.has(selection.sharing_scope)) {
      throw codedError("SHARING_SCOPE_REQUIRED", "每条偏好都必须明确选择 personal 或 household 范围。");
    }
    if (duplicateIds.has(selectedId)) {
      throw codedError("DUPLICATE_MEMORY_ID", "本地偏好 ID 重复，无法安全选择该记录。");
    }
    const memory = records.get(selectedId);
    if (!memory) throw codedError("MIGRATION_MEMORY_NOT_FOUND", "选择的本地偏好不存在。");
    const changeId = selection.change_id;
    if (!isUuid(changeId)) throw codedError("INVALID_CHANGE_ID", "每条迁移变更都需要由可信流程生成并保留的 UUID。");
    if (changeIds.has(changeId.toLowerCase())) {
      throw codedError("MIGRATION_CHANGE_ID_DUPLICATE", "每条迁移偏好必须使用不同的 change_id。");
    }
    changeIds.add(changeId.toLowerCase());

    return buildPreferenceUpsertChange({
      memory,
      change_id: changeId,
      expected_revision: 0,
      sharing_scope: selection.sharing_scope,
      remote_sync_confirmed: true,
      clock,
    });
  });
}

/**
 * Atomically store the selected changes in an already-open encrypted outbox.
 * The outbox only persists them locally; this helper never dispatches network
 * requests. The returned receipt contains metadata only, never preference data.
 */
export async function enqueuePreferenceMigration({
  outbox,
  memories,
  selections,
  remote_sync_confirmed = false,
  clock = () => Date.now(),
} = {}) {
  if (!outbox || typeof outbox.enqueueChangesAtomically !== "function") {
    throw codedError("MIGRATION_OUTBOX_REQUIRED", "迁移需要已配置的加密 outbox。");
  }
  const changes = buildPreferenceMigrationChanges({
    memories,
    selections,
    remote_sync_confirmed,
    clock,
  });
  const receipts = await outbox.enqueueChangesAtomically({
    changes,
    consentConfirmed: remote_sync_confirmed,
  });
  return {
    queued_count: receipts.filter((receipt) => receipt.queued).length,
    duplicate_count: receipts.filter((receipt) => receipt.duplicate).length,
    items: receipts,
  };
}
