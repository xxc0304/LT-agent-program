# 设备管家 Agent 与能源管家功能细化说明 v0.1

本文按当前仓库代码整理，目标是把“Agent 做什么、收到什么、按什么条件判断、输出什么、失败时如何处理”说清楚。状态标记：

- **已实现（Mock/本地）**：代码与自动化测试覆盖；不代表已连接真实家电。
- **待联调/待开发**：功能接口或本地规则已有，但真实数据源、设备或运行时链路尚未接入。

## 1. 两个 Agent 的职责边界

```text
用户自然语言 / HA 状态事件 / 学习行为事件
                 ↓
      OpenClaw + LLM（理解意图、选工具、提出计划）
                 ↓
       本地编排器（订阅路由、排队、冲突、超时、追踪）
          ├─ 能源管家：判断是否值得生成节能任务
          └─ 设备管家 Agent：校验并执行设备任务、读回结果
                                      ↓
                          Home Assistant → 家电
```

| 组件 | 接收什么 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| OpenClaw/LLM | 用户对话 | 识别设备俗称、动作、参数；选择查询、直控或候选计划工具；向用户澄清歧义 | 不拥有设备写权限；不能覆盖代码策略或把猜测当传感器证据 |
| 能源管家 | 标准 Event、当前设备快照或调用方明确提供的能耗数据 | 按占用/离家等事件规则生成节能 Task；分析用能、预算进度和低价时段，并提供节能建议 | 不读取未提供的电表数据；不直接调用 HA、不控制设备、不证明传感器来源身份 |
| 设备管家 Agent | 用户明确请求或目标为 `device-manager` 的 Task | 查设备、验证参数/风险/证据、执行允许动作、回读状态、返回回执和审计事件 | 不从不明设备 ID 猜目标；故障诊断不等于维修；不把能源管家的建议当作执行授权 |
| 调度器 | Event、Agent 产生的 Task | 按 `consumes` 路由 Event，校验 Task，检查幂等与同设备冲突，按优先级/截止时间调用 Agent，记录 Trace | 不替业务 Agent判断学习行为，不替策略层放行危险动作 |

当前 OpenClaw 插件把 Agent 作为进程内对象接入演示链路；这不是多个独立 OpenClaw 进程之间的远程 Agent 通信。

## 2. 设备管家 Agent：具体功能

### 2.1 设备发现与统一设备视图

**工具：** `list_devices(domain?, canonical?)`

- 返回 HA 后端当前支持且允许访问的设备；可按 `light`、`switch`、`climate`、`cover`、`lock`、`sensor`、`binary_sensor` 过滤。
- `canonical: true` 时返回稳定 `device_id`、外部实体 ID、availability、状态快照和能力，供跨 Agent 使用；不改变当前 HA 风格字段的兼容入口。
- Mock 目前装有客厅灯、卧室空调、客厅窗帘、入户门锁、温湿度/人体/门磁/烟雾传感器和客厅插座，共 10 个实体。
- **拒绝条件：** 不存在、未在允许清单或列表读取失败时，不构造实体 ID、不继续控制。真实 HA 可用 `HA_ENTITY_ALLOWLIST` 限制实体范围。

**工具：** `get_state(device_id, canonical?)`

- 读取当前状态、可用性及设备属性；传感器仅可读。
- 返回的是实时/当前后端快照，不从对话记忆推测状态。
- 查询失败、实体不存在或状态不可用时明确返回错误；不得把“最后一次记得的状态”当实时状态。

### 2.2 单设备即时控制

**入口：** OpenClaw 将用户明确的自然语言映射为 `control_device(device_id, action, parameters?)`；插件进入 `agent-plan-tools` 后先查库存与状态，再经过计划校验，底层 HA 适配器仍做最终门禁。

| 设备类型 | 当前支持动作 | 参数与校验 | 成功后的目标状态 |
| --- | --- | --- | --- |
| `light` | `turn_on`、`turn_off`、`set_brightness` | 亮度必须为 0–100 整数；0 表示关闭，1–100 表示开启 | `state` 及 `brightness` 与目标一致 |
| `switch`（插座/开关） | `turn_on`、`turn_off` | 无额外参数；当前模拟插座同时更新功率属性 | `state=on/off` |
| `climate`（空调） | `turn_on`、`turn_off`、`set_temperature` | 温度必须是数值且在该实体暴露的最小/最大温度范围内 | 运行状态或设定温度符合要求 |
| `cover`（窗帘） | `open`、`close`、`set_position` | 位置必须为 0–100 整数；0 关闭、100 打开 | `state` 与 `position` 回读一致 |
| `lock`（门锁） | `lock`、`unlock` | 上锁须有后续明确确认；解锁还须通过独立可信认证界面，签名授权绑定当前审批/计划/设备/动作；工具参数 `confirmed=true` 不能绕过策略 | `locked/unlocked` 回读一致 |

**控制前的逐项检查：**

1. 目标设备能从实际清单中唯一找到；用户用“书桌那个”“门打开”等含糊说法时先澄清。
2. 该设备 domain 支持请求动作；所有必需参数明确且在设备能力范围内。
3. 设备可用、状态读取成功；写动作证据默认不超过 5 秒。
4. 单设备、明确、普通低风险指令可走免二次确认路径；门锁、被标记为 `risk_level: high/critical` 或 `requires_confirmation: true` 的设备仍要确认。
5. 执行一次后读回状态。只有真实读回满足目标才返回 `verified: true`；HA 服务返回成功但状态未变时返回 `POST_ACTION_VERIFICATION_FAILED`，不能报告成功。

**确认策略差别：** 一个明确的单设备即时请求与模型/Agent 提交的候选计划不是一回事。直控路径可按设备风险免二次确认；场景、多设备、跨 Agent、未授权自动化候选计划中的设备写操作仍要求先展示方案并确认。策略细节以 `docs/agent-action-confirmation-policy-v0.1.md` 为准。

### 2.3 场景预览与执行

**预定义场景当前动作：**

| 场景 ID | 设备动作 | 执行前检查 / 用户体验 |
| --- | --- | --- |
| `home` 回家 | 客厅灯亮度默认 70（可在灯具在线且明确支持调光时使用已确认的客厅舒适亮度）；打开客厅窗帘；开启卧室空调并设为 26℃（可使用已确认的卧室舒适温度） | 对用户先生成计划预览；多设备写操作要确认；任一目标离线则整场景不开始 |
| `sleep` 睡眠 | 关闭客厅灯和窗帘；开启卧室空调并设为 26℃（可用已确认的舒适温度替换预览温度） | 已确认的温度只可用于预定义场景的空调温度步骤；不自动增加其他动作 |
| `away` 离家 | 关闭客厅灯、客厅插座、客厅窗帘和卧室空调 | 逐设备预检；执行后逐项读取预期状态 |

- `plan_scene` 是只读预览；`execute_scene_plan` 只接受后续独立消息里的明确同意，并在执行前重读偏好/设备、检查计划未过期且内容未变化。偏好只能修改预定义场景中对应设备已有的温度/亮度参数，不新增设备动作。
- 计划默认最多有效 10 分钟、一次性；确认前设备或温度条件变化则丢弃旧计划重新规划。
- 固定底层 `run_scene` 不应被对话层直接用来跳过预览/确认。
- **部分成功边界：** Mock 场景执行前做全目标可用性预检，避免预检时已离线导致部分执行；真实 HA 执行中途断线仍可能有部分副作用，后续必须按每一步回执和回读报告，不能声称事务回滚。

### 2.4 只读故障诊断与运行审计

**工具：** `diagnose_device(device_id?)`，不改变状态；传设备 ID 查一个，不传则查全部。

| 检查对象 | 检查项（当前 Mock 规则） | 结果类别 |
| --- | --- | --- |
| 任意设备 | `available` | 不可用 → `offline / DEVICE_OFFLINE`，建议检查供电、网络及 HA 实体 |
| 灯 | 亮度是 0–100 整数；`off` 时亮度应为 0，`on` 时不能为 0 | 不一致 → `abnormal / STATE_INCONSISTENT` |
| 插座 | 状态应为 `on/off` | 其他值 → `abnormal` |
| 空调 | 当前设定温度是数值且不超出实体提供的 `min_temperature/max_temperature` 范围 | 温度非数值或越界 → `abnormal`；当前实现没有单独把缺失的温控上下限识别成诊断异常 |
| 窗帘 | 位置为 0–100 整数；完全 `closed` 对应 0，`open` 对应 100 | 不一致 → `abnormal` |
| 门锁 | 状态只允许 `locked/unlocked` | 其他值 → `abnormal` |
| 数值/二值传感器 | 数值在配置上下限内；二值状态为 `on/off` | 越界/非法值 → `abnormal` |

诊断返回 `status`、证据和建议；异常/离线会产生 `diagnostic_alert`。`get_device_events` 可按实体、事件类型、trace 查询控制成功/失败和诊断事件。事件账本默认在进程内存；真实 HA 后端只有显式设置 `DEVICE_MANAGER_EVENT_LEDGER_PATH` 才使用脱敏本地 JSON 跨重启保存最近 200 条事件。Mock 账本和动作审计仍在进程内存。诊断建议不能说成已修复。

### 2.5 接收标准 Task 与返回结果

- 支持旧版 `control_device/get_state/run_scene/diagnose_device` Task 和 canonical `device_action` Task；规范化后要求 `target_agent=device-manager`、目标设备、动作、优先级、期限、资源/隐私字段、`trace_id` 和幂等键等满足契约。
- 通过后由设备工具执行；重复幂等键不得重复控制；不支持动作、目标错误、策略拒绝、需要确认、HA 超时或回读不一致分别返回 `FAILED`、`DENIED`、`CHALLENGE`、`TIMEOUT` 或可重试状态，附 `error.code` 和 `trace_id`。
- 成功回执应至少可追到 task/trace、实体、动作、前后状态和验证结果。控制层不因“调用函数没有抛异常”就报告成功。

## 3. 能源管家：具体功能

### 3.1 输入事件与通用门槛

Manifest 当前消费 `occupancy_changed`、`home_mode_changed`、`learning_behavior`、`user_device_override`，产出 `device_action`。事件基础字段包括 `schema_version=0.1`、`event_id`、`source_agent`、`event_type`、`occurred_at`、`privacy_level`、`payload`；学习事件可带 `confidence` 与 `needs_review`。

- 事件必须是合法 JSON、schema 与枚举有效；过旧超过 5 分钟的事件返回 `STALE_EVENT`，时间超前超过 1 分钟返回 `EVENT_FROM_FUTURE`。
- 重复 `event_id` 返回 `DEDUPLICATED`；同一事件 ID 携带不同内容由调度器拒绝。
- 设备状态读取失败返回 `FAILED / DEVICE_STATE_UNAVAILABLE`，不猜测设备当前是否开启。
- 灯/插座仅在明确 `on` 时可规划关闭；空调仅在状态为 `on/heat/cool/heat_cool/auto/dry/fan_only` 等已知运行模式时可选中；未知状态、离线设备跳过。
- 仅处理 `light/switch/climate`；门锁、传感器和二值传感器是保护对象，绝不生成关闭任务。
- 区域触发必须带非空 `area`，不能因缺房间扩大成全屋控制。区域按显式 `device.area/attributes.area` 优先匹配，另有少量实体 ID 命名回退映射。

### 3.2 四类触发规则

| 事件 | 生成任务的精确条件 | 不动作/拒绝情况 | 可能生成的对象 |
| --- | --- | --- | --- |
| `occupancy_changed` | `payload.area` 存在、`occupied=false`，且 `observed_for_ms` 或 `duration_ms` ≥ 默认 10 分钟；再查同区域当前设备快照 | 有人 → `NO_ACTION/OCCUPIED_NO_SHUTDOWN`；不足 10 分钟 → `NO_ACTION/WAITING`；缺区域、占用非布尔、时间异常则拒绝；没有符合状态的设备则 `NO_ELIGIBLE_ON_DEVICE` | 同一区域处于运行状态的灯、插座、空调各生成独立关闭 Task |
| `home_mode_changed` | `mode=away` 时对所有当前处于运行状态的可节能设备规划关闭，不限制单一区域 | `home`、`sleep` → `NO_ACTION/ENERGY_SHUTDOWN_ONLY_FOR_AWAY_MODE`；mode 非 `home/away/sleep` 拒绝 | 全屋范围中可节能的灯、插座、空调，各一条关闭 Task |
| `learning_behavior` | 目标儿童的明确离位事件；`behavior` 为 `leaving_desk/away_from_desk/no_occupancy` 之一，或 `presence=away_from_desk`；置信度 ≥ 0.8；不需复核；离位持续 ≥ 默认 10 分钟；并且本 Agent 进程此前 60 秒内实际收到同区域、`occupied=false`、来自可信适配器白名单的独立 HA 事件 | `classroom_scene` 或 `target_child_specified=false` → 忽略；阅读、写字、站立等非离位行为 → 忽略；低置信度/待复核 → 等复核；无独立佐证、区域不符、传感器仍报有人、过期/不可信 → `NO_ACTION` | 仅在上述门槛全部通过后，才为同区域正在运行的可节能设备规划关闭 Task；学习模型不能在 payload 自称传感器已确认 |
| `user_device_override` | 事件提供有效 `device_id`，可选 `hold_ms`；默认保持时长等于 30 分钟冷却时间 | 缺设备 ID → `REJECTED/INVALID_DEVICE_ID` | 不产生设备动作；在内存中记录该设备保持至 `hold_until`，其间能源管家不对该设备生成关闭 Task |

**一个容易误解的实现细节：** Agent 自己不会启动 10 分钟计时器。它在收到事件时读取 `observed_for_ms/duration_ms` 并判断是否已到阈值。因此真实环境必须由 HA/事件适配器或上游占用服务负责持续计时，并在合适时机发出带持续时长的事件；不能只接一次人体传感器 `off` 就期待 Agent 十分钟后自动再运行。

### 3.3 节能 Task 内容及防重复

每个设备单独生成 canonical Task，关键字段为：

```json
{
  "schema_version": "0.1",
  "source_agent": "energy-saving",
  "target_agent": "device-manager",
  "task_type": "device_action",
  "target_ref": { "device_id": "light.living_room" },
  "action": "turn_off",
  "priority": "P3",
  "deadline_ms": 30000,
  "data_level": "L0",
  "privacy_level": "family",
  "idempotency_key": "energy:<event>:<device>:turn_off",
  "trace_id": "<沿用事件 trace>",
  "metadata": {
    "reason_code": "AREA_UNOCCUPIED",
    "trigger_event_type": "occupancy_changed"
  }
}
```

- 当前默认优先级 `P3`、期限 30 秒、执行模式 `local`、数据级别 `L0`；这些是配置而不是模型临时推断。
- `reason_code` 为 `AREA_UNOCCUPIED`、`HOME_AWAY` 或 `STANDBY_LOAD_REVIEW`；Trace 关联输入 Event、能源管家决策、每条 Task、设备管家回执。
- 同一设备最近生成过节能任务的 30 分钟内触发冷却；用户手动覆盖也会建立设备级保持期。二者计时及 Seen Event、占用佐证目前都只在进程内存，重启后不保留。
- 能源管家输出的是“建议关某个设备”的 Task，不等于设备已关。最终执行、确认、读回和失败审计都由设备管家负责。

### 3.4 电价优化与明确待机负载

**OpenClaw 工具：** `plan_energy_optimization` 在设备管家会话中经 OpenClaw 适配器委派给独立 `energy-saving` Agent；Agent 使用内部 `calculate_energy_optimization` 工具。算法位于 `energy-saving/src/energy-optimization.js`，适配器校验结果后，设备管家仍负责待机候选的设备复查、确认和计划流程。

| 功能 | 输入与判断 | 输出/动作边界 |
| --- | --- | --- |
| 分时电价与可延后负载 | 本次调用提供分时电价、负载估计 kWh、运行分钟数、最早启动时间和截止时间；只有 `user_marked_flexible=true` 才参与排程。候选起点每 15 分钟扫描，时间窗最多 7 天，费用估算假设运行期间均匀耗能 | 返回最低费用窗口、最早可行窗口费用及估算差额；这是电价导致的费用差异，不是节电量。当前只给建议，不写入计时器或启动设备 |
| 明确待机负载 | 读数必须明确标记 `load_mode=standby`，含带时区的近期时间、功率和 `control_device_id`；默认阈值 5 W、读数最多 5 分钟。能源管家重新读取当前已授权设备，只接受房间映射一致、已登记、已授权、在线、处于 `on` 且明确支持 `turn_off` 的 `switch` | 能源管家生成标准 `device_action` Task，作为 `energy-saving.plan_event` 计划步骤输出；设备管家匹配并执行该 Task。公开对话请求仍需用户确认，执行后回读状态。能力/授权/状态缺失、房间不符、数据过期时跳过 |

数据来自本次调用方输入，工具不读取 HA/电表。只凭功率数值不会推断“待机”；必须有明确的负载模式和控制插座映射。关闭智能插座可能切断其后连接的设备，计划会显示具体目标并等待用户确认。低谷排程没有设备定时能力时只提供时间建议，不表示已经安排。

## 4. 当前可逐条验收的场景

1. **区域无人不足阈值：** 输入客厅 `occupied=false, observed_for_ms=5分钟`，预期 `NO_ACTION`，明确返回阈值 10 分钟和已观察时长；没有设备动作。
2. **区域无人达到阈值：** 将灯和插座置为 on，输入客厅无人 10 分钟；预期只为已开启且同区域的灯/插座生成 `turn_off` Tasks，关闭状态由设备管家回读确认。
3. **区域仍有人：** 输入 `occupied=true`，预期 `NO_ACTION`，绝不生成关闭 Task。
4. **离家：** 客厅灯、插座与卧室空调处于运行状态，输入 `home_mode_changed(mode=away)`；预期只计划这些设备，不计划门锁、传感器；每个动作都可追溯到同一 `trace_id`。
5. **学习行为低置信度/待复核：** 提供 `confidence<0.8` 或 `needs_review=true` 的离位事件，预期 `NO_ACTION` 并注明 waiting review。
6. **学习行为无独立传感器佐证：** 即使视觉置信度高且离位足够久，只给学习事件或自报传感器佐证，预期不生成 Task；再伪造课堂整体画面也不得触发。
7. **用户手动重新开灯：** 写入该灯 `user_device_override`，保持期内再次收到无人事件，预期该灯被跳过；保持期结束后才允许重新规划。
8. **设备离线/空调状态未知：** 预期不针对该设备生成动作；其他合格设备可独立规划，但不得把失败设备伪报成功。
9. **设备管家执行回读不一致：** 模拟 HA 服务调用成功但设备仍为 on，预期返回验证失败和失败事件，不应向用户说已关灯，也不自动盲目重放。
10. **同设备冲突 Task：** 同一队列中同时有开灯、关灯任务时，同优先级则两个冲突任务都拒绝执行；优先级不同时只保留高优先级任务。候选多步骤计划内的互斥动作不会让用户“批准冲突”，而是返回 `CLARIFICATION_REQUIRED`，要求修改计划后重提。

## 5. 已实现与当前边界

| 项目 | 当前代码状态 | 不能据此声称 |
| --- | --- | --- |
| 设备工具、风险门禁、场景审批、Task 接口、设备读回与审计 | 已实现；有 Mock 测试，真实 HA REST 适配代码存在 | 不能声称真实 HA 实体、协议、家电已经连通 |
| 节能四类事件规则、Task 生成、阈值/可信证据/冷却逻辑 | 已实现；规则型 MVP，不调用 LLM 做能耗优化 | 不能声称已通过真实无人传感器自动触发 |
| 用户提供数据的能耗优化 | 能耗分析、前后用量比较、预算进度估算及分时电价建议均由能源管家会话调用只读工具；显式待机候选通过能源管家 Task → 设备管家计划审批链 | 不能声称已从真实电表自动采集、自动排程或实现实测节能 |
| 账期预算进度估算 | 新增 `forecast_energy_budget`：至少 3 个完整日、连续逐日 kWh 且明确确认覆盖完整时，按平均日用电速度估算账期末用量；本地回归通过，并已通过 `dev → orchestrate_household_agents → energy-saving → forecast_energy_budget` 的 OpenClaw 主对话运行验收 | 不是统计模型预测；工具无法独立证明调用方提供的数据完整，也不代表已连接真实电表或自动预算预警 |
| 公开 OpenClaw `dispatch_agent_event` 自动执行 | 代码会把此入口标成未认证来源；如产生设备写 Task，设备管家要求用户确认 | 不能将工具参数里的 `source_agent` 当成 HA 身份认证 |
| 内部可信事件自动节能 | 代码路径仅可能对可信入口、能源管家产出的合格 `light.turn_off` 自动放行；学习事件另须带独立占用事件佐证 | 当前插件默认没有接真实 HA 可信事件适配器和来源白名单，不能演示成传感器自动闭环已接通 |
| OpenClaw 调用本地工具，和能源管家→设备管家本地 Task 链路 | 有本地插件与 Mock 验证 | 不能声称独立 OpenClaw Agents 间远程协作或消息总线已完成 |
| 真实事件源与运行时可信身份、HA 区域映射、实际用户操作覆盖事件 | 待接入/跨组联调 | Event 中写了 `source_agent` 就不等于真实身份已认证 |
| 节能效果评估 | 可按调用方提供的电价和读数估算窗口费用；缺少真实计量基线、天气/舒适度约束与对照实验 | 不能声称已量化家庭节省电量或因果节能率 |
| Trace、审批、冷却、去重等存储 | 审批/计划幂等摘要写入 OpenClaw state 文件；活动工作流、调度队列及部分运行态仍在进程内存；记忆偏好使用 JSON/SQLite 后端 | 不能声称事件队列、Trace、冷却和所有 Agent 运行态都可跨重启恢复 |

## 6. 本项工作的结论

当前本地版本已经有明确职责和可执行的具体规则：设备管家做“查—校验—控—回读—审计”，能源管家做“收事件/分析能耗—核门槛—生成 Task”，调度器负责“路由—排队—冲突—追踪”。本地电价优化目前依赖显式输入数据；低谷排程只建议，不启动设备。后续接入真实电表/分时电价来源与具备安全约束的设备排程能力后，才能扩大为自动采集和定时运行。
