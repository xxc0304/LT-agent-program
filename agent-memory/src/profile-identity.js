const IDENTITY_PART_MAX_LENGTH = 200;
const PRINCIPAL_ID_MAX_LENGTH = 128;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isOpaqueIdentifier(value, maxLength = IDENTITY_PART_MAX_LENGTH) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Extracts only the transport identity supplied by OpenClaw's trusted tool-factory
 * context. Never pass model/tool arguments to this function.
 *
 * The tuple is a channel alias, not a canonical user identity. A separate
 * trusted resolver must map it to a Profile principal before any profile access.
 */
export function getOpenClawRequesterIdentity(toolContext) {
  const context = toolContext && typeof toolContext === "object" ? toolContext : {};
  const delivery = context.deliveryContext && typeof context.deliveryContext === "object"
    ? context.deliveryContext
    : {};
  const channel_id = delivery.channel ?? context.messageChannel;
  const channel_account_id = delivery.accountId;
  const sender_id = context.requesterSenderId;

  if (![channel_id, channel_account_id, sender_id].every((part) => isOpaqueIdentifier(part))) {
    throw codedError(
      "PROFILE_IDENTITY_CONTEXT_REQUIRED",
      "缺少可信的 OpenClaw 渠道、渠道账号或发送者上下文；拒绝读取或更新个人偏好。",
    );
  }

  return Object.freeze({ channel_id, channel_account_id, sender_id });
}

/**
 * Resolve a runtime-supplied channel alias through a trusted identity service.
 * The callback must be a server-backed or administrator-managed identity map;
 * it must not simply copy sender_id into profile_id.
 */
export async function resolveOpenClawProfilePrincipal(toolContext, resolveIdentity) {
  if (typeof resolveIdentity !== "function") {
    throw codedError("PROFILE_IDENTITY_RESOLVER_REQUIRED", "未配置可信的用户身份映射服务。");
  }

  const requesterIdentity = getOpenClawRequesterIdentity(toolContext);
  let principal;
  try {
    principal = await resolveIdentity(requesterIdentity);
  } catch {
    throw codedError("PROFILE_IDENTITY_UNAVAILABLE", "用户身份映射服务暂不可用；拒绝读取或更新个人偏好。");
  }

  if (!principal
    || principal.active !== true
    || !isOpaqueIdentifier(principal.profile_id, PRINCIPAL_ID_MAX_LENGTH)
    || (principal.home_id !== undefined && !isOpaqueIdentifier(principal.home_id, PRINCIPAL_ID_MAX_LENGTH))) {
    throw codedError("PROFILE_PRINCIPAL_UNRESOLVED", "当前发送者没有有效的 Profile 身份映射；拒绝读取或更新个人偏好。");
  }

  return Object.freeze({
    profile_id: principal.profile_id,
    ...(principal.home_id === undefined ? {} : { home_id: principal.home_id }),
  });
}
