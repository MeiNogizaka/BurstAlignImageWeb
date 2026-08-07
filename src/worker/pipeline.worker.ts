/// <reference lib="webworker" />
// Dedicated worker hosting the entire OpenCV.js + onnxruntime-web pipeline.
// Replaces main.py's job-queue/progress-polling with a direct postMessage
// push protocol: no server round-trip, no polling interval.
import { zipSync, type Zippable } from "fflate";
import { loadCv } from "../cv/cvRuntime";
import { runPipeline } from "../cv/pipeline";
import type { PipelineResult, WorkerRequest, WorkerResponse } from "../shared";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse) {
  ctx.postMessage(message);
}

async function buildZip(result: PipelineResult): Promise<Blob | null> {
  const entries: Zippable = {};
  let any = false;

  for (const frame of result.aligned) {
    if (frame.outputName && frame.blob) {
      entries[frame.outputName] = new Uint8Array(await frame.blob.arrayBuffer());
      any = true;
    }
  }
  if (result.merged) {
    entries[result.merged.outputName] = new Uint8Array(await result.merged.blob.arrayBuffer());
    any = true;
  }
  if (result.compositeAll) {
    entries[result.compositeAll.outputName] = new Uint8Array(await result.compositeAll.blob.arrayBuffer());
    any = true;
  }

  if (!any) return null;
  const zipped = zipSync(entries, { level: 6 });
  return new Blob([zipped], { type: "application/zip" });
}

ctx.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "run") return;

  try {
    const cv = await loadCv();

    const result = await runPipeline(
      cv,
      msg.files,
      msg.options,
      (stage, current, total, percent) => {
        post({ type: "progress", stage, current, total, percent });
      },
      (loadedBytes, totalBytes) => {
        post({ type: "model-progress", loadedBytes, totalBytes });
      },
    );

    result.zipBlob = await buildZip(result);

    post({ type: "result", result });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});
