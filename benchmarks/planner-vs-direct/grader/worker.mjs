/**
 * Per-case solve worker. Module import completes before "ready"; timer starts
 * only after parent sends a case (enforced by parent).
 */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const { schedulerPath } = workerData;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let solveFn = null;

async function boot() {
  const mod = await import(pathToFileURL(schedulerPath).href);
  if (typeof mod.solve !== "function") {
    throw new Error("src/scheduler.mjs must export solve(instance)");
  }
  solveFn = mod.solve;
  parentPort.postMessage({ type: "ready" });
}

parentPort.on("message", (msg) => {
  if (msg.type !== "solve") return;

  const t0 = performance.now();
  const instance = msg.instance;

  try {
    const input1 = deepClone(instance);
    const snap = JSON.stringify(input1);
    const schedule1 = solveFn(input1);
    const inputMutated = JSON.stringify(input1) !== snap;
    const schedule2 = solveFn(deepClone(instance));
    const elapsedMs = performance.now() - t0;

    parentPort.postMessage({
      type: "result",
      ok: true,
      schedule1,
      schedule2,
      inputMutated,
      elapsedMs,
    });
  } catch (err) {
    parentPort.postMessage({
      type: "result",
      ok: false,
      error: err?.message ?? String(err),
      elapsedMs: performance.now() - t0,
    });
  }
});

boot().catch((err) => {
  parentPort.postMessage({
    type: "fatal",
    error: err?.message ?? String(err),
  });
});
