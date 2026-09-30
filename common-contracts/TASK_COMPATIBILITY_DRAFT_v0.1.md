# Task 字段与兼容迁移草案 v0.1

状态：Agent 组的本地兼容提案，供调度、设备管家、算力和安全小组评审；不是最终跨组规范。目标是让现有代码能联调，同时明确重复字段、语义不同字段和迁移边界。

## 1. 两种 Task 形态

| 形态 | 用途 | 主要字段 | 处理方式 |
| --- | --- | --- | --- |
| 旧版设备管家 Task | 已有工具运行时的兼容入口 | `task_type` 为 `control_device/get_state/run_scene/diagnose_device`，参数放在 `payload`，目标为 `target_agent`，优先级为文字枚举 | 由设备管家旧任务入口处理；不作为新 Agent 的首选格式。 |
| canonical `device_action` Task | 调度器生成的跨 Agent 动作请求 | `target_ref`、`action`、`parameters`、`idempotency_key`、`trace_id`，优先级 `P0`–`P4` | 经策略检查后，当前适配器转换成旧设备管家任务；适配发生在 Agent 边界，不应让业务 Agent 各自猜字段。 |

## 2. canonical 形态建议

当前 v0.1 继续兼容已有消费者；后续 v1 建议保留以下单一规范字段：

```json
{
  "schema_version": "0.1",
  "task_id": "task-001",
  "source_agent": "energy-saving",
  "target_agent": "device-manager",
  "task_type": "device_action",
  "target_ref": { "device_id": "light.study_desk" },
  "action": "turn_off",
  "parameters": {},
  "priority": "P3",
  "deadline_ms": 30000,
  "resource_requirement": {
    "execution_mode": "local",
    "capabilities": ["home_assistant", "device_control"]
  },
  "compute_requirement": { "class": "switch", "gpu_required": false },
  "data_level": "L0",
  "privacy_level": "family",
  "idempotency_key": "energy:evt-001:light.study_desk:turn_off",
  "trace_id": "trace-evt-001",
  "status": "POLICY_PENDING"
}
```

## 3. 字段语义与别名处理

| 字段 | 建议语义 | 是否别名 / 注意点 |
| --- | --- | --- |
| `source_agent` | 发起任务的 Agent 标识 | canonical 字段。`source` 是当前 canonical helper 的兼容别名；v1 建议只对外保留 `source_agent`。 |
| `target_agent` | 目标 Agent 标识 | canonical 字段。`target` 是调度器/设备管家适配器仍读取的兼容别名；v1 建议只对外保留 `target_agent`，边界适配器再转成内部 target。 |
| `resource_requirement` | 执行位置与所需能力，如 local/edge/cloud、device_control | `compute_requirement` 不是严格别名：前者描述部署/资源路由，后者描述任务对算力类别或 GPU/NPU 的需求。设备管家适配旧任务时保留 `resource_requirement`，不从 `compute_requirement.class` 推断执行位置。 |
| `data_level` | 数据敏感度/数据可离开本地的等级标签 | 不能与 `privacy_level` 当作同一枚举直接替换。当前代码的 `data_level → privacy_level` 是粗粒度策略派生。 |
| `privacy_level` | 面向策略的语义隐私分类（family/sensitive/restricted） | 当前 Device Manager 旧入口必需；canonical v1 可保留，或由明确且经安全组批准的规则派生。不能未经讨论就删除。兼容旧入口时保留两个 canonical 字段，并对旧策略类取显式 `privacy_level` 与本地 `data_level` 派生类中更严格者，避免转换时意外降级。 |
| `task_id` | 一次业务任务的唯一 ID | 不等同于 `trace_id`；同一条跨组件调用链可包含多个 Task。 |
| `trace_id` | 跨事件、策略、执行与回执的关联 ID | 必须沿链路原样传递；不是幂等键。 |
| `idempotency_key` | 防止同一设备副作用重复执行的操作键 | 按相同业务动作稳定生成；不能用每次重试都会变化的随机 ID。 |
| `deadline_ms` | 从本系统首次接收/入队开始计算的相对时限（毫秒） | 当前调度器按首次入队时间判断过期；它不是 Unix 时间戳。跨系统转发是否重新计时仍需确认。 |
| `status` | Task 生命周期状态 | 与 `TaskReceipt.status` 分开；`CHALLENGE/TIMEOUT/RETRYABLE` 是回执结果，不是 Task 状态。v0.1 状态值统一用大写，待确认完整状态机。 |

### v0.1 兼容规则

- 同一条 Task 若同时带别名，值必须一致；出现 `source_agent != source` 或 `target_agent != target` 时拒绝，不静默选一个值。
- 外部生产者优先发送 canonical 字段。调度器入口兼容只带旧别名的输入，但会校验双字段一致并规范化成 `source_agent`/`target_agent` 后再分发；设备管家直连接口也会拒绝冲突别名。只有边界适配器负责生成旧版 `payload` 任务；不要让多个 Agent 各写一套映射。
- `device_action` 进入设备执行前仍需有效 `PolicyDecision`；`DENY` 不执行，`CHALLENGE` 暂停并等待与同一 `task_id/trace_id` 关联的明确确认。
- canonical 到旧版优先级的当前映射为 `P0→critical`、`P1→high`、`P2→normal`、`P3→low`、`P4→low`。`P3/P4` 在旧字段中不可区分；调度器在转换前仍按 `P0` 最急、`P4` 最低排队。设备管家的标准动作回执通过 `result.action_result.task_priority` 保留原始 canonical 等级，不能声称旧字段转换无损。

## 4. 数据级别与隐私级别

当前代码本地映射为：

| `data_level` | 当前派生 `privacy_level` | 含义边界 |
| --- | --- | --- |
| `L0` | `family` | 普通家庭控制数据； |
| `L1` | `family` | 与 L0 合并为同一旧策略类，代码无法表达二者差异； |
| `L2` | `sensitive` | 受限家庭/成员相关信息； |
| `L3` | `restricted` | 高敏感数据，当前 Mock 策略要求留在 `home_local`。 |

飞书任务材料另用 `L1–L4`。目前没有经过项目组确认的逐级定义或映射，**不得机械做 `L0→L1`、`L1→L2` 这样的编号平移**。在确认前，样例里保留各自的源字段并标记为本地实验值；涉及跨组策略时以更严格的本地限制 fail closed，不把未映射等级降级。

## 5. 优先级建议与未决问题

- 本组实现可暂按 `P0` 最高、`P4` 最低；截止时限相同时优先级先排序，再以 `deadline_ms` 作为同优先级的次排序。
- 旧枚举 `critical/high/normal/low` 只做兼容输入，不应继续扩散到新的 Agent 接口。
- 调度组需确认五级优先级的业务定义、是否存在“安全告警优先于用户控制”的抢占规则，以及 P3/P4 映射到旧执行器时是否需要携带原值。
- 各组需确认 `deadline_ms` 的起算点、跨服务转发是否保留剩余时限、超时重试是否共用原始预算。
- 安全/协议组需确认 `data_level` 与 `privacy_level` 是否并存，以及最终枚举和 L1–L4 与 L0–L3 的正式映射。
