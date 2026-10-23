import { Type } from "typebox";

export const DEVICE_INVENTORY_TOOL_DEFINITIONS = [
  {
    name: "discover_household_devices",
    description: "只读扫描 Home Assistant 当前暴露的受支持实体，并与本地家庭清单对账；若 HA WebSocket Registry 可用，还会按物理设备合并实体并带入房间建议。新发现实体默认待核对，导入房间不等于用户核对，也不会获得控制或节能权限；HA 未接入的实体无法被扫描。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "list_household_device_inventory",
    description: "列出已发现的家庭设备/实体登记状态、HA 房间建议、用户确认房间、物理设备分组、在线状态及节能授权。HA 提供的房间只是建议；若清单尚未扫描或需要刷新，应先调用 discover_household_devices。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "review_household_device",
    description: "根据用户明确提供的信息登记/排除一台最近扫描到的设备，可设置名称、房间和节能授权。仅设备确认后才能纳入节能；节能授权还要求受支持设备类型、已确认房间和非空 reason。不得替用户猜房间或授权节能。",
    inputSchema: Type.Object({
      device_id: Type.String({ minLength: 1 }),
      approval_status: Type.Union([
        Type.Literal("approved"),
        Type.Literal("excluded"),
      ]),
      area_id: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1 })),
      energy_opt_in: Type.Optional(Type.Boolean()),
      reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  },
];

