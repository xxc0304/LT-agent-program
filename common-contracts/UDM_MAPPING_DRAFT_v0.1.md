# HA Device → UDM 字段映射草案 v0.1

状态：Agent 组讨论稿，供设备/协议/调度/安全小组评审；不是跨组冻结接口。当前只定义“本项目规范化 Device”与协议组 UDM 字段的建议映射，不声称 Home Assistant 已提供所有字段。

## 1. 映射原则

1. Home Assistant 的 `entity_id` 适合作为家庭实例内的 `device_id`，例如 `light.study_desk`；它不是跨家庭/跨 HA 实例的全局唯一 ID。跨家庭传输时需要由平台另外提供 `home_id` 或等价命名空间，不能把住户身份塞进设备 ID。
2. 未从 HA、设备注册表或明确配置取得的值保持未知（省略或 `null`，具体规则待统一），不根据设备名称、品牌猜测 `vendor`、`location`、固件版本或安全等级。
3. 区分设备静态描述、当前状态与事件流：设备对象描述身份/能力；动态值通过状态快照返回；发生的变化通过 Event 发布。不要把完整历史事件塞进 Device。
4. HA service 只是底层可调用接口，不代表 Agent 有权调用。输出给调度器的 `services` 必须经过设备 allow-list 和安全策略过滤。

## 2. 建议映射表

| UDM 字段（建议规范名） | Home Assistant 来源 | 规范化规则 / 当前限制 |
| --- | --- | --- |
| `device_id` | State `entity_id` | 原样保留 HA 实体 ID；实例内稳定标识。跨实例要加独立家庭命名空间。 |
| `name` | `attributes.friendly_name` | 缺失时回退 `entity_id`；显示名不用于鉴权或唯一识别。 |
| `domain` | `entity_id` 前缀 | 如 `light`、`climate`、`lock`，只作能力分类，不足以推导全部服务。 |
| `state` | State `state` | 保留规范化后的当前值；空调等复合状态可在 `properties` 中另带模式。 |
| `available` | `state` | `unavailable`、`unknown` → `false`；其他状态 → `true`（沿用当前 HA 适配器逻辑）。 |
| `vendor` | Device Registry `manufacturer` | 当前 REST State 适配器没有读取 Device Registry；暂不可填，禁止猜测。 |
| `location` | Area Registry / 明确房间配置 | 建议用稳定 `area_id`，可另带显示名称；当前 State 响应通常不含 area 信息，需要额外注册表接口或显式映射。 |
| `properties` | State `state` + `attributes` | 汇总动态属性；将 `brightness`、温控范围、窗帘位置等常用字段规范化，同时可保留经脱敏筛选后的原始属性。当前规范化对象名为 `attributes`，字段改名需和协议组确认。 |
| `events` | HA 状态事件 / Agent Event 流 | 表示设备可产生/订阅的事件类型或引用，不是事件历史数组；需要事件适配器提供。当前真实 HA 适配器尚未接入 WebSocket 事件流。 |
| `services` | HA Service Registry + 本项目工具白名单 | 仅声明经 allow-list 审核可用的动作；不能把 HA 全部服务暴露给 LLM。当前设备管家按支持的 action/domain 做固定映射，没有完整服务发现。 |
| `constraints` | `supported_features`、属性范围、设备策略 | 例如温度上下限、亮度范围、可控动作集合；数值范围需区分 HA 原始单位与统一单位。当前部分温控/窗帘约束在 `attributes` 中，尚未统一成独立对象。 |
| `security_level`（原材料写作 `securityLevel`） | 安全/隐私策略配置 | 建议保留策略来源与级别，不能单凭 `domain=lock/camera` 推断最终风险。字段命名（snake_case/camelCase）及枚举由协议/安全组确认。 |
| `version` | Device Registry `sw_version` / 固件信息 | 设备固件版本，不应与本契约的 `schema_version` 混淆；当前适配器未读取。 |
| `observed_at` | 本地采集时间 | 记录本次状态快照生成时间，使用 ISO 8601 UTC；它不一定等于设备上报时间。 |

## 3. 现有 Agent 组规范化视图

当前 `common-contracts/schemas/device.schema.json` 的基本字段为 `device_id`、`name`、`domain`、`state`、`available`、`attributes` 和 `observed_at`。这足以支持现有 Mock/设备管家读状态，但不等于完整 UDM。建议跨组确认后采用以下兼容演进方式：

- 第一阶段继续消费上述最小只读视图，避免强迫当前 HA 接口伪造不存在的注册表元数据；
- 第二阶段为 `vendor`、`location`、`properties`、`events`、`services`、`constraints`、`security_level`、`version` 逐步增加可选字段或独立扩展对象；
- 只有字段来源、空值语义和安全边界确认后，才把字段改为必填；新增字段不应改变 `device_id` 或既有 `attributes` 含义；
- 若 UDM 以 camelCase 固定字段（例如 `securityLevel`）发布，应由适配器做明确的双向转换，不在不同模块里混用两套拼写。

## 4. 与其他契约对象的边界

- Device 是设备身份/能力的相对稳定描述；`get_state` 返回的是时间点快照，不要把一个快照误当 Device 注册信息。
- Event 表示发生了什么；`occurred_at` 是来源事件时间，`received_at` 是本系统收到时间；`trace_id` 用于跨阶段追踪，`event_id` 用于标识单个事件，二者不可互换。
- Task 是执行请求；只有经策略和权限检查后才可执行。`PolicyDecision=CHALLENGE` 表示暂停等待明确确认，不等于允许；`DENY` 不应继续派发设备动作。
- TaskReceipt 是执行结果，不是 Task 生命周期状态。超时且无法确定外部副作用时，应显式标记“副作用未知”，不能伪装为失败后自动重试。
- 原始图片/视频、API Key、令牌和密码不得进入跨 Agent Device/Event/Task payload；视觉结果只传经过最小化的标签、置信度、范围与复核状态。

## 5. 联调前必须评审的差异

当前本地 Schema 与部分 Mock 消费者尚未完全对齐，以下内容应在冻结 v1 前处理，而不是假装已统一：

1. 本轮把 `ResourceStatus` Schema/样例对齐到本组 Mock 消费者使用的 `node_id/observed_at/online/supported_compute/data_zone` 等字段；这只是 Agent 组提出的边缘节点草案，仍需调度/算力组确认最终对象、TTL 和字段来源。
2. 本轮把 `PolicyDecision` Schema、Mock 输出和消费者校验对齐为带 `decision_id/task_id/trace_id/decided_at/reason_code/reason_message/confirmation_required` 的形态；安全组仍需确认字段命名、策略责任方与确认回传机制。
3. canonical Task Schema 已覆盖当前 Mock 任务并保留 `source`/`source_agent`、`target`/`target_agent`、`compute_requirement`/`resource_requirement`、`data_level`/`privacy_level` 等兼容字段；当前 helper 会同时给出两套别名，需跨组选定唯一规范字段，并把别名转换限制在边界适配器。
4. 代码中的优先级映射暂为 `P0→critical`、`P1→high`、`P2→normal`、`P3/P4→low`。`P3` 和 `P4` 因此在旧接口丢失区分；最终保留一套枚举或明确有损映射需由调度组确认。
5. 代码把 `L0/L1` 映射为 `family`、`L2` 映射为 `sensitive`、`L3` 映射为 `restricted`；飞书材料另有 `L1–L4` 编号。在含义未核准前，不能做简单加一或声称两套分级等价。

## 6. 会议确认清单

- HA/协议组：`device_id` 采用 entity ID 还是 UDM 独立 ID；`area_id`、manufacturer、固件版本从哪个接口/注册表取得。
- 协议组：UDM 字段正式拼写、必填/可选、null/未知/不适用的区别、版本兼容规则。
- 调度/算力组：ResourceStatus 的节点标识、在线状态、算力能力、数据域、TTL 和过期行为。
- 安全组：PolicyDecision 的责任 Agent、依据/理由字段、CHALLENGE 的确认对象和一次性关联方式。
- 各 Agent 组：Task 类型、优先级、数据级别、超时/重试/幂等语义及 trace 传播要求。
