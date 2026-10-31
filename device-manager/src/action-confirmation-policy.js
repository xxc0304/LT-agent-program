const HIGH_RISK_LEVELS = new Set(["high", "critical"]);

function normalizedRiskLevel(device) {
  const value = device?.risk_level ?? device?.attributes?.risk_level;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getDeviceActionConfirmationPolicy(device, action) {
  if (action === "lock" || action === "unlock") {
    return {
      required: true,
      ...(action === "unlock" ? { strong_auth_required: true } : {}),
      reason_code: action === "unlock" ? "HIGH_RISK_UNLOCK" : "HIGH_RISK_LOCK_ACTION",
      message: action === "unlock"
        ? "开锁属于高风险动作，需先取得用户明确确认，再通过可信认证界面完成强认证；聊天确认本身不能授权开锁。"
        : "上锁属于高风险动作，必须取得用户明确确认。",
    };
  }

  if (device?.requires_confirmation === true || device?.attributes?.requires_confirmation === true
    || HIGH_RISK_LEVELS.has(normalizedRiskLevel(device))) {
    return {
      required: true,
      reason_code: "HIGH_RISK_DEVICE_ACTION",
      message: "该设备被标记为高风险，必须取得用户明确确认。",
    };
  }

  return { required: false, reason_code: "LOW_RISK_DIRECT_ACTION", message: "" };
}
