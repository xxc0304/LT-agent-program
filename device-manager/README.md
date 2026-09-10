# 设备管家 Agent（第一阶段）

这是家庭微脑项目的设备管理基础模块。当前版本不连接真实家具，而是用 Mock Home Assistant
模拟设备，并提供三个可以被 Agent 调用的结构化工具。

## 当前包含的设备

| 设备 | device_id | 类型 |
| --- | --- | --- |
| 客厅灯 | `light.living_room` | `light` |
| 卧室空调 | `climate.bedroom` | `climate` |
| 客厅窗帘 | `cover.living_room_curtain` | `cover` |
| 入户门锁 | `lock.front_door` | `lock` |

设备初始状态位于 `config/devices.json`，后续可以直接增加其他模拟设备。

## 三个基础工具

- `list_devices`：获取设备列表，可按 `domain` 过滤。
- `get_state`：查询一个设备的当前状态。
- `control_device`：执行控制并返回控制前后的状态。

工具定义在 `src/tools.js`，模拟 Home Assistant 的行为在 `src/mock-ha.js`。

`src/openclaw-plugin.js` 是 OpenClaw 适配层，插件清单位于
`openclaw.plugin.json`。三个工具按顺序执行并共享同一个 Mock HA 状态，
因此 Agent 控制设备后能再次读取并验证变化。

## 安全规则

第一版已经在工具代码中强制实施以下规则：

- 不存在的设备不能控制。
- 离线设备不能控制。
- 参数超出范围时拒绝执行。
- 入户门锁的 `unlock` 操作必须传入 `confirmed: true`。
- 成功的控制操作写入内存审计日志。
- 控制结果带有 `verification_required: true`，提醒 Agent 再调用 `get_state` 验证。

## 运行演示

本项目只使用 Node.js 标准库，不需要下载依赖。

```powershell
cd device-manager
npm run demo
```

演示依次执行：列出设备、打开客厅灯、验证状态、拦截未经确认的开锁操作。

## 打开设备管家对话

确保 OpenClaw Gateway 正在运行，然后双击 `Start-Device-Manager.cmd`。也可以在终端执行：

```powershell
openclaw tui --session agent:device-manager:main
```

这个会话会自动选择独立的 `device-manager` Agent，而不是默认的 `main` Agent。

## 运行测试

```powershell
cd device-manager
npm test
```

## 安装到本机 OpenClaw（开发模式）

在本目录执行：

```powershell
openclaw plugins install --link .
openclaw plugins enable device-manager
openclaw plugins inspect device-manager --runtime
```

本地链接方式便于开发：修改仓库中的工具代码后，不需要重新复制插件包。

## 下一阶段

下一步将创建独立的 `device-manager` Agent，并加入
“接收 → 理解 → 规划 → 审批 → 执行 → 验证 → 总结”的 Agent 行为规则。
