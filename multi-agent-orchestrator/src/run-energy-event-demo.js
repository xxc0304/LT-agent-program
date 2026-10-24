import { runEnergyEventDemo } from "./energy-event-demo.js";

const result = await runEnergyEventDemo();
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
