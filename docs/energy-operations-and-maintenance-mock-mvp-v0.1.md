# 节能分析与设备维护 Mock MVP v0.1

## 1. 本次实现范围

本地增加了两类可运行能力：

1. **节能 Agent 能耗分析**：按输入的区间电量统计总量、设备/区域/小时画像；按明确的基线或“设备报告关闭但仍有功率”证据标记待复核异常；计算已覆盖的分时电费、峰时段用电和预算状态，并给出人工建议。
2. **设备管家维护计划**：按明确的安装/上次维护日期、维护周期及可选使用量阈值生成近期/到期/逾期计划；对新鲜的离线或异常诊断生成只读排查步骤。
3. **前后效果比较**：仅在同一设备集合、同样时长、完整且间隔对齐的输入读数下，计算观察到的前后电量差值。

## 2. 责任与安全边界

```text
Mock/真实计量读数 ──> 节能 Agent 分析与建议（不生成控制 Task）
                               │
                               └──> 人工核验后，另走既有调度/设备管家控制链路

维护周期 + 最新诊断快照 ──> 设备管家生成提醒和排查清单
                               └──> 物理维护/复位仍由用户或维护人员完成
```

本次新增分析和维护函数不直接控制 HA，也不自动重启、复位、换滤网或发送外部通知。维护日程可持久化；维护到期的周期检查由用户显式启动后写入本地收件箱，不是系统推送。

## 3. 能耗输入与口径

读数使用区间电量，而非瞬时功率：

```json
{
  "device_id": "plug.living_room",
  "area": "living_room",
  "recorded_at": "2026-10-17T12:30:00+08:00",
  "interval_kwh": 0.8,
  "expected_kwh": 0.3,
  "device_state": "on",
  "power_w": 480
}
```

- 瞬时 `power_w` 不会被换算成 kWh；区间电量由读数源提供。
- 时区使用显式 IANA 名称；分时电价按读数时间所在时段归类，不把一条跨时段区间读数拆分。
- 重复 `(device_id, recorded_at)` 读数会拒绝并计入数据质量报告。输入电表应选同一层级，避免将总表与子表相加。
- 报告指出“输入覆盖未知”。因此预算是基于已提交读数的临时状态，不预测账期，也不能证明全部用电均已覆盖。
- 缺少电价、时段未覆盖或读数不足时，费用/峰段指标显示不可用或部分覆盖，不补零。
- 异常只依据显式证据：读数至少达到基线的 1.5 倍且高出不少于 0.05 kWh；或设备报告关闭但功率高于 5 W。此类结果只是待复核候选，不等于已确认浪费/故障。
- 预算用量达到 80% 提醒，达到 100% 标记超限；只看本次提交窗口，不做外推。低谷价差仅生成“人工评估可延迟负载”的建议，不识别负载类型、不操作设备。

## 4. 前后效果比较口径

`EnergySavingAgent.evaluateEnergyEffect(input)` 接收 baseline/follow-up 两个区间、相同的显式设备 ID 清单和采样间隔。每个设备的每个区间终点都必须有一条读数；任一窗口缺失/重复/越界，或时长不同，就返回不可比较而不填补数据。输出 `baseline - follow_up` 的观察差值与百分比（基线为 0 时百分比为空）。

比较没有控制占用、天气、时段、电价及其他并发变化，结果标记 `NOT_ESTABLISHED_BY_BEFORE_AFTER_COMPARISON`。这只能用于工程验证流程，不能声称差值由某个动作造成，更不能据 Mock 数值宣称实际节电效果。

## 5. 维护计划输入和判定

维护记录至少需要 `schedule_id`、`device_id`、`maintenance_type`，以及明确的下次到期日，或“安装/上次完成日期 + `interval_days`”。也可提供成对的 `usage_since_service`、`usage_limit` 和 `usage_unit`：超过使用上限为逾期，达到上限为到期，达到 90% 为近期提醒。日期维护周期按经过的 24 小时天数计算；默认 7 天内为近期提醒。

没有日期与用量依据时返回 `SCHEDULE_INCOMPLETE`，不会推测滤网寿命。异常/离线诊断必须包含最近 5 分钟内的 `checked_at`；过期或缺失则降级为未知。离线告警文案区分连接问题与硬件损坏，并提供检查供电/网络/HA 状态的步骤；不自动重放命令或修复。

## 6. 本地 Mock 验证

在项目根目录 PowerShell 运行：

```powershell
npm --prefix energy-saving run demo:operations
```

生成的完整示例报告位于 `tmp/energy-operations/operations-report.json`。报告包含合成的区间电量、费用/预算建议、候选异常、一小时样本的前后差值、滤网逾期、维护近期提醒和设备异常/离线的只读排查步骤。所有样例都是代码内置的 Mock 数据。

测试命令：

```powershell
node --test energy-saving/test/energy-analysis.test.js energy-saving/test/energy-strategy.test.js energy-saving/test/energy-effectiveness.test.js energy-saving/test/operations-demo.test.js
node --test energy-saving/test/energy-agent.test.js
node --test device-manager/test/maintenance-planner.test.js
```

## 7. OpenClaw 接入与维护记录

能耗分析、前后窗口比较、维护周期保存/查询和显式完成记录现已注册为 OpenClaw 工具；维护日程写入本地状态文件，可在 Gateway 重启后重新读取。细节、工具名和边界见 [`energy-operations-openclaw-tools-and-maintenance-store-v0.1.md`](./energy-operations-openclaw-tools-and-maintenance-store-v0.1.md)。

工具只使用调用时明确传入的区间读数和诊断快照，不会自动读取 HA/电表。维护完成操作必须以用户明确报告为依据；它只更新台账，不执行物理维护。自动化插件测试证明工具已由插件注册并路由到本地逻辑，不等同于本机 OpenClaw Gateway 已重新加载并完成对话实测。

## 8. 尚未完成的真实接入事项

- 真实电表/HA 能耗实体适配、设备实体到计量通道映射、读数完整性和计量周期校验；
- 经用户/设备组确认的分时电价、预算周期、用电异常阈值和设备维护周期；
- 将 HA/电表实时数据源适配到上述工具输入，并验证真实设备映射及读数质量；
- 外部手机/系统/消息渠道通知仍未接入；当前只支持显式启用后周期检查并写入 OpenClaw 本机维护提醒收件箱；
- 在目标 Gateway 上部署新版插件并做一次实际对话调用验收；插件级自动化测试不代替本机运行验收；
- 真实 HA/设备联调及真实节能效果评估。需要真实计量基线和足够完整的前后窗口后才能开展。
