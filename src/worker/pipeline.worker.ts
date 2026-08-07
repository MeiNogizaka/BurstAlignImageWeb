/// <reference lib="webworker" />
// Dedicated worker hosting the entire OpenCV.js + onnxruntime-web pipeline.
// Replaces main.py's job-queue/progress-polling with a direct postMessage
// push protocol: no server round-trip, no polling interval.
import { zipSync, type Zippable } from "fflate";
import { loadCv } from "../cv/cvRuntime";
import { runPipeline } from "../cv/pipeline";
import { AppError, type PipelineResult, type WorkerRequest, type WorkerResponse } from "../shared";
import { t } from "../i18n";

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

interface DescribedError {
  message: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** Translates a caught error into `{message, code?, params?}` for postMessage. `AppError`
 * (thrown deliberately, from pipeline.ts/matte.ts/cvRuntime.ts) carries its own i18n code --
 * the worker doesn't know the user's selected language, so `message` here is just a Japanese
 * fallback (via `t("ja", ...)`) for callers that ignore `code`; the main thread, which does
 * know the language, re-translates `code`+`params` itself. OpenCV.js's embind bindings also
 * surface a C++-level `cv::Exception` as a bare number (a pointer into the WASM heap) rather
 * than a JS Error -- `String(err)` on that is a meaningless digit string, so `cv.exceptionFromPtr`
 * decodes it back into a real (but not translatable -- it's OpenCV's own text) message. */
function describeError(err: unknown, cv: any): DescribedError {
  if (err instanceof AppError) {
    return { message: t("ja", err.code, err.params), code: err.code, params: err.params };
  }
  if (typeof err === "number" && cv?.exceptionFromPtr) {
    try {
      const decoded = cv.exceptionFromPtr(err);
      if (decoded?.msg) return { message: decoded.msg };
    } catch {
      // fall through to the generic cases below
    }
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

ctx.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "run") return;

  let cv: any;
  try {
    cv = await loadCv();

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
    post({ type: "error", ...describeError(err, cv) });
  }
});
