# 能源管家 MVP 验收记录

日期：2026-09-30
范围：本地规则型能源管家与 Mock 设备执行链路

## 已实现

- 消费 `occupancy_changed`、`home_mode_changed`、`learning_behavior`、`user_device_override` 四类事件。
- 按区域无人持续时间、离家模式或同时有独立 HA 占用佐证的学习区离位事件，规划关闭灯、插座和空调的 `device_action` Task。
- 对事件字段/时间、置信度、待复核状态和运行配置做校验；事件过期、格式异常或区域不明确时不生成设备任务。
- 对 `annotation_scope: "classroom_scene"` 或 `target_child_specified: false` 的课堂整体事件执行范围硬拦截；即使事件错误地带有高置信度、离位状态和长持续时间，也不生成节能任务。
- 视觉离位缺少独立佐证时默认不动作；佐证需来自运行时显式白名单、同一区域且新鲜（默认 60 秒内），并拒绝已占用、来源不可信、时间过期或区域不符的佐证。
- 仅选择明确在线且状态可识别的可节能设备；不触碰门锁、传感器等保护设备。
- 尊重手动保持期、重复事件去重和设备冷却时间；任务附带 `trace_id`、幂等键、截止时间和触发原因。
- 能源管家只负责判断和规划；设备管家负责策略检查、实际控制、回执和状态回读。

## 验证结果

执行：

```powershell
Set-Location C:\Users\QVQ\Documents\ChatGPT\LT-agent-program\energy-saving
npm test
node src/demo.js
```

- 能源管家单元测试：23/23 通过。
- Mock 演示：客厅无人达到 10 分钟后生成客厅灯和插座关闭任务；设备管家回执为成功，回读状态为 `off`。
- 本次安全回归覆盖：缺少区域不扩大成全屋控制、课堂整体场景不会冒充目标儿童离位信号、视觉离位缺少独立佐证时失败关闭、拒绝不可信/已过期/区域不匹配佐证、无效配置拒绝启动、未知设备状态不推测为开启。

## 新增能耗优化能力（本地 Mock 验收）

- 新增分时电价低价窗口建议：只处理用户明确标记可延后的负载，按 15 分钟步长查找可行窗口，同时提供 UTC 与所选时区的时间结果。费用差额基于运行期间均匀耗能假设，不代表节电量。
- 新增明确待机负载候选：读数必须显式标记 `load_mode: "standby"`、高于功率阈值、时间新鲜且提供控制插座映射；设备管家重新核对设备登记、节能授权、房间、在线状态、当前状态和关断能力。
- 合格候选通过能源管家生成 Task，再由设备管家计划校验并等待用户确认；优化工具本身不执行设备控制，也不安装定时器。
- 验证：`npm --prefix energy-saving run demo:optimization` 成功完成低价时段建议、待机候选、待用户确认、Mock 关闭和状态回读；洗碗机建议 22:00–00:00，估算费用差为 1.08 CNY。演示报告写入 `tmp/energy-operations/optimization-demo-a606bac0-2530-40f8-93dd-7ad81bac29fe.json`。
- 回归测试：能源管家 46/46、设备管家 279/279、多 Agent 编排器 127/127 通过；设备管家插件注册测试也覆盖了 OpenClaw 工具定义与本地路由。
- OpenClaw 全局网页端仍未验收；本次另用仓库内隔离 profile 完成了 OpenClaw Gateway 自然语言联调，见下节。没有迁移或改写全局状态库。

## OpenClaw + DeepSeek 隔离 Gateway 自然语言验收（2026-10-25）

- 使用 OpenClaw `2026.7.1-2` 启动仓库内隔离 profile；Gateway 加载 `device-manager` 插件，并将项目 `energy-planning` Skill 放入该 profile 的工作区。
- 通过 OpenClaw Agent 对话入口发送自然语言请求：洗碗机预计耗电 1.2 kWh、运行 2 小时，最早 20:00，允许最晚在次日 00:00 结束；电价为 20:00–22:00 0.80 CNY/kWh、22:00–00:00 0.35 CNY/kWh。
- Agent 一次成功调用 `plan_energy_optimization`，工具建议 22:00–次日 00:00，估算费用 0.42 CNY；从最早可运行时间开始的估算费用为 0.96 CNY，差额 0.54 CNY。模型回复与工具返回一致。
- 工具回执显示未创建设备动作、未执行控制、未安装定时任务。此测试验证了 OpenClaw → DeepSeek → 设备管家工具 → 能源排程逻辑的对话链路。
- 初轮联调发现 tariff schema 缺少分段字段约束，模型出现多次格式修正，且一次回复改写了工具结果；已补充结构化 tariff schema、午夜时间说明和“按工具结果答复”指引。修订后定向测试 7/7 通过，最终联调只调用一次排程工具。
- 本次使用本地隔离 Gateway 的 Agent CLI 入口，没有在 OpenClaw 网页聊天界面验证；全局 Gateway、全局状态库和真实 HA 均未参与。

## 2026-10-25 低谷排程独立 Agent 委派与隔离 Gateway 运行验收

- 将 `plan_energy_optimization` 的设备管家入口改为通过 OpenClaw 公开的 `runtime.subagent` 适配器委派给独立 `energy-saving` Agent，不再在设备管家入口直接调用本地排程函数。
- 能源管家会话仅开放只读 `calculate_energy_optimization` 工具；其输出再由适配器按同一评估时刻重新计算并逐字段比对，任何差异或工具错误都会拒绝进入后续流程。
- 报告通过校验后，待机候选仍由设备管家检查设备登记、节能授权、区域、在线状态、当前状态和关断能力；合格动作只进入既有待确认计划，不会由能源管家控制设备。
- Linux 与 Windows 两套部署安装器均把 `plan_energy_optimization` 和内部 `calculate_energy_optimization` 加入能源管家的最小工具白名单；插件 manifest 与能源管家工作区说明也已同步。
- **代码回归：**能源管家 46/46、设备管家 279/279、多 Agent 编排器 129/129、部署安装器 13/13；设备管家 Mock acceptance 11/11；OpenClaw `device-manager` 插件静态校验通过。覆盖独立 Agent 调用 envelope、报告逐字段校验、篡改拒绝、会话工具隔离、设备计划确认边界及安装器最小工具白名单。
- **隔离 profile：**已备份原配置至 `~/.openclaw-2026.7.1-2/openclaw.json.pre-energy-optimization-20261025-200004.bak`，为 `device-manager` 追加 `plan_energy_optimization`，为 `energy-saving` 追加 `plan_energy_optimization` 与 `calculate_energy_optimization`；OpenClaw 配置校验通过。
- **Gateway 状态更正与重启：**初次排查曾误判 PID 97064 不存在。后续通过进程表、端口监听和锁文件确认它是运行中的 OpenClaw `2026.7.1-2` Node Gateway，监听 `127.0.0.1:18789`，锁记录配置路径指向隔离 profile。经用户同意后向旧实例发送控制台中断信号使其正常退出，再从隔离 profile 启动 Gateway。新实例状态探测显示配置有效、版本 `2026.7.1-2`、无插件版本漂移；`device-manager` 插件已加载，Gateway 已就绪并监听 18789。启动日志有 iMessage/Telegram bundled channel 路径警告，本次 CLI Agent 验收不使用这两个渠道。
- **真实 OpenClaw Agent 委派验收：**使用专用会话 `agent:device-manager:energy-optimization-e2e-20261025` 发送完整的自然语言低谷排程请求。DeepSeek V4 Flash 的 `device-manager` 会话实际调用 `plan_energy_optimization`；OpenClaw `runtime.subagent` 创建独立 `energy-saving` 会话，后者实际调用 `calculate_energy_optimization`。设备管家的工具回执 `success=true`、`delegated_to=energy-saving`，且能源管家返回值通过 `OpenClawAgentClient` 的契约与确定性重算校验。
- **结果与安全边界：**建议洗碗机于北京时间 2026-10-25 22:00 至 2026-10-26 00:00 运行；预计费用 0.42 CNY，按 20:15 最早启动估算为 0.89 CNY，估算差额 0.47 CNY。`action_taken=false`，`device_action_workflow.status=NO_ACTION_CANDIDATE`，`execution_performed=false`；没有调用设备控制工具、查询 HA、启动设备或安装定时任务。结果是用户提供电价和负载参数下的均匀耗能估算，不代表实测节省。
- 本轮使用隔离 Gateway 的 OpenClaw Agent CLI 会话，不是网页聊天界面验收；不代表真实 HA 或家电接入验收。Gateway 当前由本机隐藏进程手动运行，Windows 计划任务状态为停止；系统重启后是否自动恢复尚未验证。

## 2026-10-25 OpenClaw 主对话入口再次联调

- **实际链路：**隔离 Gateway 的 `dev` 主会话调用 `talk_to_device_manager`（1 次成功、0 次失败）；设备管家调用 `plan_energy_optimization` 并委派给独立 `energy-saving` Agent；能源管家调用 `calculate_energy_optimization` 完成计算。三段会话均正常结束，工具轨迹没有设备控制工具调用。
- **请求与结果：**用户给出洗碗机预计耗电 1.2 kWh、运行 2 小时、10 月 26 日 08:00 后可启动、须在 10 月 27 日 00:00 前结束，以及分时电价。能源管家建议北京时间 10 月 26 日 20:00–22:00，预计费用 0.42 CNY；按白天电价估算为 0.96 CNY，差额 0.54 CNY。费用按运行期间均匀耗能估算，不是实测账单或实测节电量。
- **动作边界：**工具结果标记 `action_taken=false`、`execution_performed=false`、`device_action_workflow.status=NO_ACTION_CANDIDATE`；没有启动设备、创建设备动作或安装定时任务。设备管家只读查询了 Mock 设备清单；其中未显示洗碗机实体，因此这次结果是按用户提供的负载参数做排程测算，不证明系统已发现或可控制真实洗碗机。
- **入口证据范围：**OpenClaw 会话轨迹中的 `messageProvider` / `messageChannel` 标记为 `webchat`；本次依据隔离 Gateway 轨迹核对工具调用，没有通过浏览器自动化核验页面呈现。该链路使用当前 Gateway 上的 `talk_to_device_manager` 固定转接入口，不能作为平台工具 `orchestrate_household_agents` 已接入或通过验收的证据。

## 2026-10-25 预算进度估算主对话编排验收

- **实际链路：**隔离 Gateway 的 `dev` 主对话调用 `orchestrate_household_agents`；Trace ID `budget-forecast-frontdoor-20261025` 的运行结果记录 `agent_calls_performed=true`，包含一个状态为 `COMPLETED` 的 `energy-saving` Agent 步骤。对应的能源管家会话实际调用 `forecast_energy_budget`，并成功返回预算估算报告。
- **输入与结果：**预算周期为 2026-10-01 至 2026-10-31，月预算 100 kWh；输入 10 月 1 日、2 日、3 日分别为 2、3、4 kWh，并确认数据完整。能源管家算出日均 3 kWh，按 31 天线性外推约 93 kWh，预测余量约 7 kWh，状态为 `PACE_WITHIN_BUDGET`。主对话按工具结果向用户解释了估算依据和线性估算边界。
- **动作边界：**这是只读计算；编排结果标记 `device_action_agent_invoked=false`，没有调用设备动作 Agent 或设备控制工具。
- **验收结论：**主对话→平台编排器→能源管家→预算估算工具的调用链已在隔离 Gateway 上验证；不是仅由 `dev` 主会话直接调用预算工具。此次验证仍使用明确提供的完整逐日数据，不代表真实电表自动采集。

## 2026-10-25 能耗分析工具归属调整

- 将 `analyze_energy_usage` 与 `evaluate_energy_effect` 的 OpenClaw 工具工厂限制为 `energy-saving` 会话；Windows/Linux 安装器授予能源管家这两项工具，并拒绝设备管家会话直接使用能耗分析、前后比较、预算预测和内部计算工具。
- 设备管家保留 `plan_energy_optimization` 委派入口和设备动作职责，能源管家负责调用能耗分析/预算/优化只读工具；相应 Skill、部署说明与功能说明已同步。
- 隔离 profile 已先备份为 `openclaw.json.pre-energy-tool-scope-20261025-222512.bak`，再将 `analyze_energy_usage`、`evaluate_energy_effect` 放入能源管家 allowlist，并从设备管家 allowlist 移除且加入 deny；`forecast_energy_budget` 与 `calculate_energy_optimization` 也明确拒绝设备管家直接调用。OpenClaw 配置校验通过。
- 隔离 Gateway 已重启；`127.0.0.1:18789` 重新监听，CLI/Gateway 均报告版本 `2026.7.1-2`。状态命令同时报告 Scheduled Task 缺失及 `schtasks` 不可用，因此 Windows 服务管理状态仍未确认。
- 当时未发起 OpenClaw Agent/模型工具调用，因此这条记录本身不含运行验收；后续主对话平台编排验收见下节。

## 2026-10-25 主对话平台编排能源能力联调

- **入口与分析：**隔离 Gateway 的 `dev` 主对话通过 `orchestrate_household_agents` 将自然语言读数分析路由给 `energy-saving:analyze_energy_usage`。三条合成读数得到 1.00 kWh 的汇总，平台和 Agent 步骤均完成；无设备操作 Agent 调用。
- **预算估算：**已通过 trace `budget-forecast-frontdoor-20261025` 验证 `energy-saving:forecast_energy_budget`，仅使用用户提供且确认完整的逐日电量，输出线性进度估算。
- **前后效果比较：**trace `energy-effect-20261025-2341` 使用同一插座、等长完整窗口，工具返回 `COMPARABLE`，观察到 0.15 kWh、25% 的差异。回复明确说明这不是因果证明。trace `energy-effect-20261025-2343` 缺少调整后的读数，工具返回 `INSUFFICIENT_OR_MISMATCHED_DATA`，能源管家返回 `NEEDS_CLARIFICATION` 并询问所需读数，没有自行估算。
- **电价排程：**trace `dishwasher-20261026-2346` 通过主对话平台编排直接调用 `energy-saving:plan_energy_optimization`，建议北京时间 2026-10-26 22:00–次日 00:00，估算费用 0.42 元。没有调用设备操作 Agent、启动设备或设置定时。
- **结论：**已通过隔离 OpenClaw Gateway 和 DeepSeek V4 Flash，验证能源管家登记的能耗分析、预算估算、前后效果比较、电价排程四项能力可从用户主对话经平台编排到达。以上使用调用中明确提供的合成数据，不代表自动采集真实计量数据或验证真实设备控制。

## 2026-10-26 预算数据不足时的主对话澄清验收

- **路由规则：**主对话入口已补充预算估算前置条件：预算和账期日期明确、从账期开始到统计截止日的逐日数据连续、至少 3 个完整日，并明确确认覆盖完整。条件不足时只提交澄清，不得同时派发能源管家。
- **确定性拦截：**多 Agent 调度器新增派发前校验；即使 OpenClaw 错误提交派发计划，只要结构化输入缺字段、样本少于 3 天、逐日数据有重复/缺口或未确认覆盖完整，都会返回 `NEEDS_CLARIFICATION` 和 `ENERGY_BUDGET_DATA_INCOMPLETE`，且 `agent_calls_performed=false`。有效三天数据可以正常派发；发现 OpenClaw 使用 `kwh` 而工具要求 `energy_kwh` 后，调度器增加了别名归一化。
- **运行验证：**隔离 OpenClaw `2026.7.1-2` Gateway 经安全重启后，DeepSeek V4 Flash 主对话收到 2026-10-01 至 10-31、100 kWh 月预算和仅 10 月 1–2 日（2、3 kWh）的合成数据。主对话只调用一次 `orchestrate_household_agents`，计划为 `decision=clarify`、`steps=0`；编排回执为 `NEEDS_CLARIFICATION`、`agent_calls_performed=false`、`results=0`。没有调用能源管家或 `forecast_energy_budget`。
- **完整数据正样本：**提供 10 月 1–3 日连续完整数据（2、3、4 kWh），并明确确认没有漏数后，在线计划包含一个 `energy-saving:forecast_energy_budget` 步骤，能源管家工具实际返回 `PACE_WITHIN_BUDGET`，线性估算约 93 kWh、预算余量约 7 kWh。设备操作 Agent 未调用。
- **用户反馈：**主对话用自然语言说明仅有两天记录不足以估算，并询问补充后续逐日电量和是否有缺漏。没有生成预算结果或设备动作。
- **回归检查：**多 Agent 调度器全套自动化测试 136/136 通过；包括两天样本、缺少完整性声明、逐日数据缺口的零派发、常见 `kwh` 字段归一，以及满足条件的完整数据正常派发。

## 尚未验收 / 外部依赖

- 未连接真实 Home Assistant 或真实家庭设备；当前执行结果来自 Mock。
- 需要设备/协议组提供真实 HA 地址、实体清单及区域映射、实体可用状态和读写接口约定；接入前还要确定设备白名单、空调离家策略和用户手动覆盖的事件来源。
- 需要和其他 Agent 组共同确认公共 Event/Task 契约草案 v0.1 的字段、命名和阈值；当前实现与仓库草案对齐，不代表跨组最终版。
- 真实占用事件的持续时间、来源可信度及手动设备覆盖事件，仍需由传感器/平台侧提供并联调。没有可靠信号时，Agent 应保持不动作。
- 本验收不评价节能率。若要证明节电效果，还需真实功率/能耗数据、对照时段和具体评估指标。

## 验收结论

**能源管家的本地功能型 MVP 已完成并通过 Mock 验证，可以用于课堂演示规则判断与任务交接。** 真实 HA 控制、实测节电率和跨组契约冻结不在本次完成范围内，不能据此宣称真实家庭设备已接入或已经实现量化节能。
