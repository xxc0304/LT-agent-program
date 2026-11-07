const SHARING_SCOPES = new Set(["personal", "household"]);
const DEFAULT_MAX_PUSHES = 10;
const DEFAULT_MAX_PULL_PAGES = 20;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : "PROFILE_SYNC_FAILED";
}

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError(`${name} must be an integer between 1 and 100.`);
  }
}

/**
 * Build a one-shot sync coordinator from the existing encrypted outbox,
 * authenticated HTTP client, and encrypted cache. It never starts a timer or
 * background worker. Call syncOnce() from a host-controlled, user-authorized
 * flow; all result objects contain metadata only, never preference values.
 */
export function createProfileSyncEngine({
  outbox,
  client,
  cache,
  principalBinding,
  isConsentCurrent,
  sharingScopes = ["personal"],
} = {}) {
  if (!outbox || typeof outbox.dispatchOne !== "function") {
    throw new TypeError("An encrypted Profile outbox is required.");
  }
  if (!client || typeof client.sendChange !== "function" || typeof client.pullPage !== "function") {
    throw new TypeError("An authenticated Profile HTTP client is required.");
  }
  if (!cache || typeof cache.readFeed !== "function" || typeof cache.applyPage !== "function") {
    throw new TypeError("An encrypted Profile client cache is required.");
  }
  if (typeof principalBinding !== "string" || !principalBinding.trim() || principalBinding.length > 256) {
    throw new TypeError("A trusted local principal binding is required.");
  }
  if (typeof isConsentCurrent !== "function") {
    throw new TypeError("A current-consent callback is required.");
  }
  if (!Array.isArray(sharingScopes) || sharingScopes.length === 0
    || sharingScopes.some((scope) => !SHARING_SCOPES.has(scope))
    || new Set(sharingScopes).size !== sharingScopes.length) {
    throw new TypeError("sharingScopes must contain unique personal and/or household values.");
  }

  let running = false;

  async function syncOnce({ maxPushes = DEFAULT_MAX_PUSHES, maxPullPages = DEFAULT_MAX_PULL_PAGES } = {}) {
    validateLimit(maxPushes, "maxPushes");
    validateLimit(maxPullPages, "maxPullPages");
    if (running) throw codedError("PROFILE_SYNC_ALREADY_RUNNING");
    running = true;

    const pushCounts = {
      acknowledged: 0,
      cancelled: 0,
      needs_review: 0,
      blocked: 0,
      retry_scheduled: 0,
      idle: 0,
    };
    let pushLimitReached = false;
    const pulls = [];

    try {
      for (let index = 0; index < maxPushes; index += 1) {
        const result = await outbox.dispatchOne({
          send: (change) => client.sendChange(change),
          isConsentCurrent,
        });
        if (!Object.hasOwn(pushCounts, result?.status)) {
          pushCounts.blocked += 1;
          break;
        }
        pushCounts[result.status] += 1;
        if (result.status === "idle" || result.status === "retry_scheduled") break;
        if (index === maxPushes - 1) pushLimitReached = true;
      }

      for (const sharingScope of sharingScopes) {
        let consentGranted;
        try {
          consentGranted = await isConsentCurrent({
            principal_binding: principalBinding,
            sharing_scope: sharingScope,
            permission: "profile:read",
            purpose: "preference_sync",
          });
        } catch {
          pulls.push({ sharing_scope: sharingScope, status: "consent_check_unavailable" });
          continue;
        }
        if (consentGranted !== true) {
          pulls.push({ sharing_scope: sharingScope, status: "consent_required" });
          continue;
        }

        let pages = 0;
        let appliedCount = 0;
        let ignoredStaleCount = 0;
        let ignoredReplayCount = 0;
        let cursor;
        let hasMore = false;
        let failureCode;

        try {
          const feed = await cache.readFeed({
            sharingScope,
            authenticatedPrincipalBinding: principalBinding,
          });
          cursor = feed.cursor;

          do {
            const page = await client.pullPage({ sharing_scope: sharingScope, cursor });
            const applied = await cache.applyPage({
              sharingScope,
              page,
              authenticatedPrincipalBinding: principalBinding,
            });
            pages += 1;
            appliedCount += applied.applied_count;
            ignoredStaleCount += applied.ignored_stale_count;
            ignoredReplayCount += applied.ignored_replay_count;
            cursor = applied.next_cursor;
            hasMore = applied.has_more;
          } while (hasMore && pages < maxPullPages);
        } catch (error) {
          failureCode = safeCode(error);
        }

        const pullStatus = failureCode === "PROFILE_CONSENT_REQUIRED"
          ? "consent_required"
          : failureCode === "PROFILE_CONSENT_CHECK_UNAVAILABLE"
            ? "consent_check_unavailable"
            : failureCode ? "failed" : hasMore ? "more_available" : "complete";

        pulls.push({
          sharing_scope: sharingScope,
          status: pullStatus,
          ...(failureCode ? { error_code: failureCode } : {}),
          pages,
          ...(Number.isSafeInteger(cursor) ? { cursor } : {}),
          applied_count: appliedCount,
          ignored_stale_count: ignoredStaleCount,
          ignored_replay_count: ignoredReplayCount,
        });
      }

      const hasFailure = pulls.some((result) => ["failed", "consent_check_unavailable"].includes(result.status));
      const hasPending = pushLimitReached || pushCounts.retry_scheduled > 0
        || pulls.some((result) => ["consent_required", "more_available"].includes(result.status));
      return {
        status: hasFailure ? "partial_failure" : hasPending ? "partial" : "complete",
        push: { ...pushCounts, limit_reached: pushLimitReached },
        pull: pulls,
      };
    } finally {
      running = false;
    }
  }

  return Object.freeze({ syncOnce });
}
