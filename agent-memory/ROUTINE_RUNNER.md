# 本地作息提醒轮询器

`src/routine-trigger.js` 负责判断已确认的睡觉/起床偏好是否到期；`src/routine-runner.js` 提供可启动和停止的进程内轮询器，把生成的 `routine_due` Event 交给调用方注入的 `onDueEvent` 接收器。

运行器默认 `scheduleAuthorized: false`，默认不会创建定时器。可同时注入 `authorizationProvider` 读取家庭记忆中单独保存的 `routine_reminder_schedule_enabled` 用户授权；每轮开始前都会重查，授权撤回或读取失败后运行器会停止。只有可信本地开关和持久化用户授权均开启时才可启动；家庭时区和事件接收器也必须明确提供。它不读取任何默认家庭记忆路径、不发送系统通知、不调用 OpenClaw，也不控制设备。

调用方接线示意：

```js
const evaluator = createRoutineDueEvaluator({ store, scheduleAuthorized: true });
const runner = createRoutineReminderRunner({
  evaluator,
  time_zone: "Asia/Shanghai",
  scheduleAuthorized: true, // 必须来自可信本地授权配置，不应由模型自行设置
  authorizationProvider: () => store.getRoutineReminderConsent(), // 独立的持久化用户同意
  onDueEvent: async (event, { idempotencyKey }) => notificationAdapter.enqueue(event, { idempotencyKey }),
});

await runner.start(); // 立即检查一次，并开始周期轮询
// 进程关闭时：runner.stop();
```

其中 `notificationAdapter` 是调用方需要提供的适配器；本仓库目前没有系统通知、OpenClaw 消息或其他真实通知实现。`set_household_routine_reminder_consent` 只记录用户同意，不能代替可信本地运行开关，也不会单独启动服务。

交付语义是“进程内去重 + 跨重启至少一次”：同一进程不会重复交付同一 `dedup_key`；进程重启后可能再次交付，所以接收器必须用稳定的 `idempotencyKey` 做持久化去重。接收器拒绝或异常时不标记为成功，下一次轮询可重试。

本地验证使用临时测试数据和注入的假时钟/定时器；没有开启当前电脑上的长期定时任务，也没有读取个人记忆或实际发送提醒。接入真实通知渠道前，需单独实现并授权通知适配器，选择记忆文件所在家庭配置，并在服务启动/退出生命周期中管理运行器。
