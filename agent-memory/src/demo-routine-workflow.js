import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PreferenceMemoryStore } from "./memory-store.js";
import { createRoutineMemoryWorkflow } from "./routine-workflow.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lt-routine-demo-"));

try {
  const store = new PreferenceMemoryStore({ filePath: path.join(directory, "memory.json") });
  const workflow = createRoutineMemoryWorkflow({ store });
  const observations = [
    { event_id: "demo-sleep-2026-09-21", occurred_at: "2026-09-21T14:30:00Z" },
    { event_id: "demo-sleep-2026-09-22", occurred_at: "2026-09-22T14:34:00Z", observed_time: "22:34" },
    { event_id: "demo-sleep-2026-09-23", occurred_at: "2026-09-23T14:37:00Z", observed_time: "22:37" },
  ];
  const observationResults = [];
  for (const observation of observations) {
    observationResults.push(await workflow.observe({
      event_type: "routine_observation",
      ...observation,
      routine_type: "sleep_time",
      observed_time: observation.observed_time ?? "22:30",
      confidence: 0.9,
      time_zone: "Asia/Shanghai",
      consent_to_observe: true,
    }));
  }

  const candidate = (await store.listMemories({ includePending: true }))
    .find((memory) => memory.memory_type === "sleep_time" && memory.status === "pending_confirmation");
  const confirmation = await workflow.confirm(candidate.memory_id, { user_confirmed: true });
  const routinePreview = await workflow.previewRoutine({
    routine_type: "sleep_time",
    day_type: "weekday",
    time_zone: "Asia/Shanghai",
  });

  console.log(JSON.stringify({
    demo: "authorized routine observations -> pending candidate -> explicit confirmation -> preview only",
    observation_dates: observationResults.map((result) => result.observation_date),
    observation_counts: observationResults.map((result) => result.memory.observation_count),
    candidate_status: candidate.status,
    confirmation_status: confirmation.memory.status,
    routine_preview: routinePreview,
    timer_created: false,
    device_action_executed: false,
    storage: "temporary test directory; removed on exit",
  }, null, 2));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
