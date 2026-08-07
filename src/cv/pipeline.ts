// Orchestration port of align.py's align_batch + main.py's _run_pipeline.
// The job-queue/disk-storage machinery from main.py/storage.py has no
// equivalent here -- this runs once, synchronously (from the worker's point
// of view), directly in memory, for a single browser tab's single job.
import type { CV } from "./cvRuntime";
import * as align from "./align";
import { bitmapToMatBGR, saveOutput } from "./matUtils";
import { medianStack } from "./background";
import { foregroundMask } from "./detect";
import { loadMatteSession, loadOrt, type MatteProgress } from "./matte";
import { compositeAllSubjects } from "./composite";
import { AppError, type AlignedFrameResult, type I18nMessage, type PipelineOptions, type PipelineResult, type StageKey } from "../shared";

export interface PipelineInputFile {
  name: string;
  bitmap: ImageBitmap;
}

function stemOf(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

export async function runPipeline(
  cv: CV,
  files: PipelineInputFile[],
  options: PipelineOptions,
  onProgress: (stage: StageKey, current: number, total: number, percent: number) => void,
  onModelDownloadProgress?: MatteProgress,
): Promise<PipelineResult> {
  const n = files.length;

  const needBackground = options.outputMerged || options.outputCompositeAll;
  const needDetect = options.outputCompositeAll;

  const stagePlan: Array<[StageKey, number]> = [["align", n]];
  if (needBackground) stagePlan.push(["background", 1]);
  if (needDetect) stagePlan.push(["detect", n]);
  if (options.outputCompositeAll) stagePlan.push(["composite_all", n]);
  stagePlan.push(["finalize", 1]);

  const offsets = new Map<StageKey, number>();
  const stageTotals = new Map<StageKey, number>(stagePlan);
  let totalUnits = 0;
  for (const [key, total] of stagePlan) {
    offsets.set(key, totalUnits);
    totalUnits += total;
  }
  totalUnits = Math.max(1, totalUnits);

  function report(stage: StageKey, current: number, total: number) {
    const stageTotal = stageTotals.get(stage) ?? total;
    const offset = offsets.get(stage) ?? 0;
    const doneUnits = offset + Math.min(current, stageTotal);
    const percent = Math.floor((doneUnits / totalUnits) * 100);
    onProgress(stage, current, stageTotal, percent);
  }

  const filenames = files.map((f) => f.name);
  const refIndex = options.referenceIndex;

  // Frames are decoded one at a time, right before they're needed, instead of all up front --
  // for many large photos, holding every raw decode alive for the whole align loop (on top of
  // the warped Mats accumulating alongside them) was itself a significant chunk of OpenCV.js's
  // limited WASM-heap budget. Each non-reference frame's raw decode is deleted the moment it's
  // done with (warped, or rejected as a failed alignment), so at most one extra full-resolution
  // Mat is ever alive on top of the growing warped set.
  const refImg = bitmapToMatBGR(cv, files[refIndex].bitmap);
  files[refIndex].bitmap.close();
  const refH = refImg.rows;
  const refW = refImg.cols;

  const refGray = align.toGrayClahe(cv, refImg);
  const { mat: refSmall, scale: refScale } = align.downscaleForMatching(cv, refGray, 1600);
  refGray.delete();
  const { keypoints: refKp, descriptors: refDes } = align.detectAndDescribe(cv, refSmall, 4000);
  refSmall.delete();

  interface FrameEntry {
    filename: string;
    status: "reference" | "ok" | "failed";
    inliers: number | null;
    reason: I18nMessage | null;
    warped: any | null;
  }

  const frameEntries: FrameEntry[] = [];
  const masks: any[] = [new cv.Mat(refH, refW, cv.CV_8UC1, new cv.Scalar(255, 0, 0, 0))];

  for (let i = 0; i < n; i++) {
    if (i === refIndex) {
      frameEntries.push({ filename: filenames[i], status: "reference", inliers: null, reason: null, warped: refImg });
      report("align", i + 1, n);
      continue;
    }

    const img = bitmapToMatBGR(cv, files[i].bitmap);
    files[i].bitmap.close();

    const gray = align.toGrayClahe(cv, img);
    const { mat: small, scale } = align.downscaleForMatching(cv, gray, 1600);
    gray.delete();
    const { keypoints: kp, descriptors: des } = align.detectAndDescribe(cv, small, 4000);
    small.delete();

    const matches = align.matchDescriptors(cv, refDes, des, 0.75);
    const { H: Hscaled, inliers } = align.estimateHomography(cv, refKp, kp, matches, 4.0);
    kp.delete();
    des.delete();

    if (Hscaled === null || inliers < options.minInliers) {
      img.delete();
      const reason: I18nMessage = { code: "lowInliersReason", params: { inliers, minInliers: options.minInliers } };
      frameEntries.push({ filename: filenames[i], status: "failed", inliers, reason, warped: null });
      report("align", i + 1, n);
      continue;
    }

    const Hfull = align.rescaleHomography(Hscaled, refScale, scale);
    const { warped, mask } = align.warpAndMask(cv, img, Hfull, refW, refH);
    img.delete();
    masks.push(mask);
    frameEntries.push({ filename: filenames[i], status: "ok", inliers, reason: null, warped });
    report("align", i + 1, n);
  }
  refKp.delete();
  refDes.delete();

  const okEntries = frameEntries.filter((f) => f.status !== "failed");
  if (okEntries.length === 0) {
    for (const m of masks) m.delete();
    throw new AppError("allFramesFailed");
  }

  let combinedMask = masks[0].clone();
  for (let i = 1; i < masks.length; i++) {
    cv.bitwise_and(combinedMask, masks[i], combinedMask);
  }
  const cropRect = align.largestInscribedRectangle(cv, combinedMask, 1000, 2);
  combinedMask.delete();
  for (const m of masks) m.delete();

  const alignedResults: AlignedFrameResult[] = [];
  const croppedFrames: any[] = [];
  const croppedNames: string[] = [];

  for (const fr of frameEntries) {
    let blob: Blob | null = null;
    let thumbBlob: Blob | null = null;
    let outputName: string | null = null;
    if (fr.status !== "failed" && fr.warped) {
      const crop = align.cropMat(cv, fr.warped, cropRect);
      // Free the full-frame warped Mat the moment it's cropped, rather than batching
      // deletion after this whole loop -- otherwise every frame's full-size warped Mat and
      // its (near-full-size) cropped Mat are briefly alive together, close to doubling peak
      // WASM-heap usage right when JPEG-encoding each one adds its own transient Mats on top.
      fr.warped.delete();
      fr.warped = null;
      croppedFrames.push(crop);
      croppedNames.push(fr.filename);
      if (options.outputAligned) {
        const saved = await saveOutput(cv, crop);
        blob = saved.blob;
        thumbBlob = saved.thumbBlob;
        outputName = `${stemOf(fr.filename)}_aligned.jpg`;
      }
    }
    alignedResults.push({
      filename: fr.filename,
      status: fr.status,
      inliers: fr.inliers,
      reason: fr.reason,
      outputName,
      blob,
      thumbBlob,
    });
  }

  const warnings: I18nMessage[] = [];
  for (const fr of frameEntries) {
    if (fr.status === "failed") {
      warnings.push({
        code: "frameSkippedLowInliers",
        params: { filename: fr.filename, inliers: fr.inliers ?? 0, minInliers: options.minInliers },
      });
    }
  }

  const refStem = stemOf(filenames[refIndex]);

  let merged: any = null;
  let mergedBlobs: { outputName: string; blob: Blob; thumbBlob: Blob } | null = null;
  if (needBackground && croppedFrames.length > 0) {
    merged = medianStack(cv, croppedFrames);
    report("background", 1, 1);
    if (options.outputMerged) {
      const saved = await saveOutput(cv, merged);
      mergedBlobs = { outputName: `${refStem}_background.jpg`, ...saved };
    }
  }

  let compositeAllResult: { outputName: string; blob: Blob; thumbBlob: Blob; frameCount: number } | null = null;

  if (needDetect && merged) {
    const masksDetect: any[] = [];
    const oversizedList: boolean[] = [];
    for (let i = 0; i < croppedFrames.length; i++) {
      const { mask, oversized } = foregroundMask(cv, croppedFrames[i], merged, 0.0002, options.maxSubjectArea, 97.0);
      masksDetect.push(mask);
      oversizedList.push(oversized);
      report("detect", i + 1, croppedFrames.length);
    }

    for (let i = 0; i < croppedFrames.length; i++) {
      if (oversizedList[i] && cv.countNonZero(masksDetect[i]) === 0) {
        warnings.push({ code: "subjectOversizedExcluded", params: { filename: croppedNames[i] } });
      }
    }

    if (options.outputCompositeAll) {
      const [session, ort] = await Promise.all([loadMatteSession(onModelDownloadProgress), loadOrt()]);
      const { composite, usedCount } = await compositeAllSubjects(
        cv,
        ort,
        session,
        merged,
        croppedFrames,
        masksDetect,
        {
          extraFeather: options.feather,
          forceOpaque: options.forceOpaque,
          overlapPriority: options.overlapPriority,
          edgeNoiseFloor: options.edgeNoiseFloor,
          opacityThreshold: options.opacityThreshold,
          decontaminate: options.decontaminate,
          decontamMaxCorrection: options.decontamMaxCorrection,
          confidentAlphaThreshold: options.confidentAlphaThreshold,
          overlapBlendSigmaPx: options.overlapBlendSigmaPx,
        },
        (current, total) => report("composite_all", current, total),
      );
      if (usedCount === 0) {
        warnings.push({ code: "noSubjectDetected" });
      } else {
        const saved = await saveOutput(cv, composite);
        compositeAllResult = { outputName: `${refStem}_composite.jpg`, ...saved, frameCount: usedCount };
      }
      composite.delete();
    }

    for (const m of masksDetect) m.delete();
  }

  report("finalize", 1, 1);

  for (const c of croppedFrames) c.delete();
  merged?.delete();

  return {
    referenceFilename: filenames[refIndex],
    cropRect,
    aligned: alignedResults,
    merged: mergedBlobs,
    compositeAll: compositeAllResult,
    warnings,
    zipBlob: null,
  };
}
