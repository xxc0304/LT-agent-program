import fs from "node:fs/promises";

const resultPath = process.argv[2];
if (!resultPath) {
  console.error("Usage: node src/print-summary.js <result.json>");
  process.exitCode = 1;
} else {
  try {
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    console.log("--- Evaluation summary ---");
    console.log(`Model: ${result.model}`);
    console.log(`Samples: ${result.count}`);
    console.log(`Parsed successfully: ${result.evaluated}`);
    console.log(`Accuracy: ${result.accuracy === null ? "n/a" : `${(result.accuracy * 100).toFixed(2)}%`}`);
    console.log(`Mean latency: ${result.meanLatencyMs === null ? "n/a" : `${Math.round(result.meanLatencyMs)} ms`}`);
    console.log("Per-label F1:");
    for (const [label, metrics] of Object.entries(result.perLabelMetrics ?? {})) {
      console.log(`  ${label}: ${metrics.f1 === null ? "n/a" : `${(metrics.f1 * 100).toFixed(2)}%`} (support=${metrics.support})`);
    }
    console.log(`Result file: ${resultPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
