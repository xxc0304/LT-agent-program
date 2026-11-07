import { createHash } from "node:crypto";
import { validateProfileSyncChange } from "./profile-sync-prototype.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARING_SCOPES = new Set(["personal", "household"]);
const VALIDATION_CHANGE_ID = "00000000-0000-4000-8000-000000000000";
const MAX_PAGE_SIZE = 100;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return structuredClone(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function validatePageEvent(event, sharingScope) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw codedError("INVALID_SYNC_EVENT", "同步事件必须是对象。");
  }
  const commonKeys = ["cursor", "preference_id", "operation", "revision", "changed_at"];
  const expectedKeys = event.operation === "upsert" ? [...commonKeys, "preference"] : commonKeys;
  if (Object.keys(event).sort().join("\0") !== [...expectedKeys].sort().join("\0")
    || !Number.isSafeInteger(event.cursor) || event.cursor < 1
    || !UUID_PATTERN.test(event.preference_id ?? "")
    || !Number.isSafeInteger(event.revision) || event.revision < 1
    || !["upsert", "delete"].includes(event.operation)
    || typeof event.changed_at !== "string" || !Number.isFinite(Date.parse(event.changed_at))) {
    throw codedError("INVALID_SYNC_EVENT", "同步事件字段或格式无效。");
  }

  const normalized = validateProfileSyncChange({
    schema_version: "0.1",
    change_id: VALIDATION_CHANGE_ID,
    preference_id: event.preference_id,
    operation: event.operation,
    sharing_scope: sharingScope,
    expected_revision: event.revision - 1,
    changed_at: event.changed_at,
    ...(event.operation === "upsert" ? { preference: event.preference } : {}),
  });
  return {
    cursor: event.cursor,
    preference_id: normalized.preference_id.toLowerCase(),
    operation: normalized.operation,
    revision: event.revision,
    changed_at: normalized.changed_at,
    ...(normalized.operation === "upsert" ? { preference: normalized.preference } : {}),
  };
}

/**
 * Apply one trusted, already-authenticated Profile API page to an isolated
 * local cache snapshot. The function is pure: it returns a new state and never
 * writes files or makes requests. A caller must bind the response to the same
 * authenticated principal/scope used to request the page and encrypt state
 * before persisting real preference values.
 */
export function applyProfileSyncPage({
  state = { schema_version: "0.1", feeds: [] },
  principalBinding,
  sharingScope,
  page,
} = {}) {
  if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
    throw codedError("PROFILE_PRINCIPAL_REQUIRED", "应用同步页需要可信的本地 principal binding。");
  }
  if (!SHARING_SCOPES.has(sharingScope)) {
    throw codedError("INVALID_SHARING_SCOPE", "同步页必须明确属于 personal 或 household 范围。");
  }
  if (!hasExactKeys(state, ["schema_version", "feeds"])
    || state.schema_version !== "0.1" || !Array.isArray(state.feeds)) {
    throw codedError("INVALID_CLIENT_CACHE", "本地同步缓存版本或结构无效。");
  }
  if (!hasExactKeys(page, ["changes", "next_cursor", "has_more"])
    || !Array.isArray(page.changes)
    || page.changes.length > MAX_PAGE_SIZE
    || !Number.isSafeInteger(page.next_cursor) || page.next_cursor < 0
    || typeof page.has_more !== "boolean") {
    throw codedError("INVALID_SYNC_PAGE", "服务端同步页格式或大小无效。");
  }

  const principalBindingHash = createHash("sha256").update(principalBinding, "utf8").digest("hex");
  const nextState = clone(state);
  const partitionKeys = new Set();
  for (const existingFeed of nextState.feeds) {
    if (!hasExactKeys(existingFeed, ["principal_binding_hash", "sharing_scope", "cursor", "records"])
      || !/^[a-f0-9]{64}$/.test(existingFeed.principal_binding_hash ?? "")
      || !SHARING_SCOPES.has(existingFeed.sharing_scope)
      || !Number.isSafeInteger(existingFeed.cursor) || existingFeed.cursor < 0
      || !Array.isArray(existingFeed.records)) {
      throw codedError("INVALID_CLIENT_FEED", "本地身份/范围分区结构无效。");
    }
    const partitionKey = `${existingFeed.principal_binding_hash}:${existingFeed.sharing_scope}`;
    if (partitionKeys.has(partitionKey)) throw codedError("DUPLICATE_CLIENT_FEED", "本地缓存中存在重复的身份/范围分区。");
    partitionKeys.add(partitionKey);
    const recordIds = new Set();
    for (const record of existingFeed.records) {
      const expectedKeys = record?.deleted === true
        ? ["preference_id", "revision", "deleted", "changed_at"]
        : ["preference_id", "revision", "deleted", "changed_at", "preference"];
      if (!hasExactKeys(record, expectedKeys) || typeof record.deleted !== "boolean"
        || !UUID_PATTERN.test(record.preference_id ?? "") || !Number.isSafeInteger(record.revision) || record.revision < 1) {
        throw codedError("INVALID_CLIENT_FEED", "本地缓存记录无效。");
      }
      const recordId = record.preference_id.toLowerCase();
      if (recordIds.has(recordId)) throw codedError("INVALID_CLIENT_FEED", "本地缓存记录 ID 重复。");
      recordIds.add(recordId);
      validatePageEvent({
        cursor: 1,
        preference_id: record.preference_id,
        operation: record.deleted ? "delete" : "upsert",
        revision: record.revision,
        changed_at: record.changed_at,
        ...(!record.deleted ? { preference: record.preference } : {}),
      }, existingFeed.sharing_scope);
    }
  }
  const matchingFeeds = nextState.feeds.filter((feed) => feed.principal_binding_hash === principalBindingHash
    && feed.sharing_scope === sharingScope);
  if (matchingFeeds.length > 1) throw codedError("DUPLICATE_CLIENT_FEED", "本地缓存中存在重复的身份/范围分区。");
  let feed = matchingFeeds[0];
  if (!feed) {
    feed = { principal_binding_hash: principalBindingHash, sharing_scope: sharingScope, cursor: 0, records: [] };
    nextState.feeds.push(feed);
  }
  if (!Number.isSafeInteger(feed.cursor) || feed.cursor < 0 || !Array.isArray(feed.records)) {
    throw codedError("INVALID_CLIENT_FEED", "本地身份/范围分区结构无效。");
  }
  const events = page.changes.map((event) => validatePageEvent(event, sharingScope));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].cursor <= events[index - 1].cursor) {
      throw codedError("SYNC_CURSOR_ORDER_INVALID", "同步事件游标必须严格递增。");
    }
  }
  if (events.some((event) => event.cursor > page.next_cursor)) {
    throw codedError("SYNC_CURSOR_RANGE_INVALID", "同步事件游标超出 next_cursor。");
  }
  const replayOnlyPage = events.length > 0 && events.every((event) => event.cursor <= feed.cursor);
  if (page.has_more && page.next_cursor <= feed.cursor && !replayOnlyPage) {
    throw codedError("SYNC_CURSOR_STALLED", "has_more 为 true 时 next_cursor 必须前进。");
  }

  const records = new Map(feed.records.map((record) => [record.preference_id.toLowerCase(), {
    ...clone(record),
    preference_id: record.preference_id.toLowerCase(),
  }]));
  let appliedCount = 0;
  let ignoredStaleCount = 0;
  let ignoredReplayCount = 0;
  for (const event of events) {
    if (event.cursor <= feed.cursor) {
      ignoredReplayCount += 1;
      continue;
    }
    const current = records.get(event.preference_id);
    const incomingRecord = event.operation === "delete"
      ? {
        preference_id: event.preference_id,
        revision: event.revision,
        deleted: true,
        changed_at: event.changed_at,
      }
      : {
        preference_id: event.preference_id,
        revision: event.revision,
        deleted: false,
        changed_at: event.changed_at,
        preference: clone(event.preference),
      };

    if (current && event.revision < current.revision) {
      ignoredStaleCount += 1;
      continue;
    }
    if (current && event.revision === current.revision) {
      if (stableStringify(current) !== stableStringify(incomingRecord)) {
        throw codedError("SYNC_REVISION_COLLISION", "同一 revision 对应了不同的偏好状态。");
      }
      ignoredReplayCount += 1;
      continue;
    }
    records.set(event.preference_id, incomingRecord);
    appliedCount += 1;
  }

  feed.records = [...records.values()].sort((left, right) => left.preference_id.localeCompare(right.preference_id));
  feed.cursor = Math.max(feed.cursor, page.next_cursor);
  return {
    state: nextState,
    summary: {
      sharing_scope: sharingScope,
      next_cursor: feed.cursor,
      has_more: page.has_more,
      applied_count: appliedCount,
      ignored_stale_count: ignoredStaleCount,
      ignored_replay_count: ignoredReplayCount,
      record_count: feed.records.length,
      live_preference_count: feed.records.filter((record) => !record.deleted).length,
      tombstone_count: feed.records.filter((record) => record.deleted).length,
    },
  };
}
