/// <reference types="vite/client" />
import "./style.css";
import { decodeUploadedFile, IngestError } from "./ingest";
import { detectInitialLang, storeLang, t, type Lang, type Params } from "./i18n";
import {
  DEFAULT_OPTIONS,
  MAX_FILES,
  MIN_FILES,
  MAX_TOTAL_BYTES,
  STAGE_KEYS,
  type AlignedFrameResult,
  type PipelineOptions,
  type PipelineResult,
  type RunMessage,
  type WorkerResponse,
} from "./shared";

let lang: Lang = detectInitialLang();

const langToggleBtn = document.getElementById("lang-toggle") as HTMLButtonElement;
const dropzone = document.getElementById("dropzone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fileListEl = document.getElementById("file-list") as HTMLUListElement;
const fileListHint = document.getElementById("file-list-hint") as HTMLParagraphElement;
const runBtn = document.getElementById("run-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const optAligned = document.getElementById("opt-aligned") as HTMLInputElement;
const optMerged = document.getElementById("opt-merged") as HTMLInputElement;
const optCompositeAll = document.getElementById("opt-composite-all") as HTMLInputElement;
const optForceOpaque = document.getElementById("opt-force-opaque") as HTMLInputElement;
const optFeather = document.getElementById("opt-feather") as HTMLSelectElement;
const optOverlapPriority = document.getElementById("opt-overlap-priority") as HTMLSelectElement;
const optMaxSubjectArea = document.getElementById("opt-max-subject-area") as HTMLSelectElement;
const optMinInliers = document.getElementById("opt-min-inliers") as HTMLInputElement;
const optDecontaminate = document.getElementById("opt-decontaminate") as HTMLInputElement;
const optEdgeNoiseFloor = document.getElementById("opt-edge-noise-floor") as HTMLInputElement;
const optOpacityThreshold = document.getElementById("opt-opacity-threshold") as HTMLInputElement;
const optDecontamMaxCorrection = document.getElementById("opt-decontam-max-correction") as HTMLInputElement;
const optConfidentAlphaThreshold = document.getElementById("opt-confident-alpha-threshold") as HTMLInputElement;
const optOverlapBlendSigma = document.getElementById("opt-overlap-blend-sigma") as HTMLInputElement;

const progressEl = document.getElementById("progress") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressLabel = document.getElementById("progress-label") as HTMLDivElement;

const resultsPanel = document.getElementById("results-panel") as HTMLElement;
const resultsGrid = document.getElementById("results-grid") as HTMLDivElement;
const mergedCard = document.getElementById("merged-card") as HTMLDivElement;
const mergedImg = document.getElementById("merged-img") as HTMLImageElement;
const mergedDownload = document.getElementById("merged-download") as HTMLAnchorElement;
const compositeAllCard = document.getElementById("composite-all-card") as HTMLDivElement;
const compositeAllImg = document.getElementById("composite-all-img") as HTMLImageElement;
const compositeAllDownload = document.getElementById("composite-all-download") as HTMLAnchorElement;
const downloadAllLink = document.getElementById("download-all-link") as HTMLAnchorElement;
const warningsEl = document.getElementById("warnings") as HTMLDivElement;

let selectedFiles: File[] = [];
/** Which selected file is the alignment reference frame -- tracked by file identity (not list
 * position) so it stays pinned to the same photo across reordering. */
let referenceFile: File | null = null;
/** Object URLs from the previous file-list render, revoked up front on the next one -- more
 * reliable than revoking on each <img>'s onload, which never fires (leaking the URL) if the
 * element is torn down by a re-render before it finishes loading. */
let fileThumbUrls: string[] = [];
/** Object URLs backing the current results panel, revoked on the next run/reset. */
let resultObjectUrls: string[] = [];

let worker: Worker | null = null;
let running = false;

/** The most recent successfully-rendered result, kept so the results panel can be
 * re-rendered in the newly selected language without re-running the pipeline. */
let lastResult: PipelineResult | null = null;

/** Tracks the currently displayed status line as data (an i18n key/params, or a worker error's
 * code/params/raw fallback) rather than pre-rendered text, so a language switch can regenerate
 * it correctly instead of leaving stale text in the old language. */
type StatusState =
  | { kind: "plain"; key: string; params?: Params; isError: boolean }
  | { kind: "workerError"; code?: string; params?: Params; rawMessage: string };
let currentStatus: StatusState | null = null;

const LANG_NAMES: Record<Lang, string> = { ja: "日本語", en: "English" };

function applyStaticTranslations() {
  document.documentElement.lang = lang;
  document.title = t(lang, "appTitle");
  langToggleBtn.textContent = LANG_NAMES[lang === "ja" ? "en" : "ja"];
  langToggleBtn.title = LANG_NAMES[lang === "ja" ? "en" : "ja"];

  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(lang, key);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(lang, key);
  }
  for (const el of document.querySelectorAll<HTMLImageElement>("[data-i18n-alt]")) {
    const key = el.dataset.i18nAlt;
    if (key) el.alt = t(lang, key);
  }
}

function setLang(next: Lang) {
  lang = next;
  storeLang(lang);
  applyStaticTranslations();
  refreshFileList();
  renderStatus();
  if (lastResult) renderResults(lastResult);
}

langToggleBtn.addEventListener("click", () => setLang(lang === "ja" ? "en" : "ja"));

function ensureReferenceFile() {
  if (selectedFiles.length === 0) {
    referenceFile = null;
  } else if (!selectedFiles.includes(referenceFile as File)) {
    referenceFile = selectedFiles[0];
  }
}

function refreshFileList() {
  for (const url of fileThumbUrls) URL.revokeObjectURL(url);
  fileThumbUrls = [];

  ensureReferenceFile();

  fileListEl.innerHTML = "";
  fileListHint.hidden = selectedFiles.length === 0;

  selectedFiles.forEach((file, index) => {
    const li = document.createElement("li");

    const order = document.createElement("span");
    order.className = "order-badge";
    order.textContent = String(index + 1);
    li.appendChild(order);

    const img = document.createElement("img");
    const url = URL.createObjectURL(file);
    fileThumbUrls.push(url);
    img.src = url;
    li.appendChild(img);

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    li.appendChild(name);

    const isReference = file === referenceFile;
    const refLabel = document.createElement("label");
    refLabel.className = "ref-toggle" + (isReference ? " is-reference" : "");
    refLabel.title = t(lang, "refToggleTitle");
    const refInput = document.createElement("input");
    refInput.type = "radio";
    refInput.name = "reference-select";
    refInput.checked = isReference;
    refInput.addEventListener("change", () => {
      referenceFile = file;
      refreshFileList();
    });
    refLabel.appendChild(refInput);
    refLabel.appendChild(document.createTextNode(t(lang, "refLabel")));
    li.appendChild(refLabel);

    const moveUpBtn = document.createElement("button");
    moveUpBtn.type = "button";
    moveUpBtn.className = "move-btn";
    moveUpBtn.textContent = "↑";
    moveUpBtn.title = t(lang, "moveUpTitle");
    moveUpBtn.disabled = index === 0;
    moveUpBtn.addEventListener("click", () => moveFile(index, -1));
    li.appendChild(moveUpBtn);

    const moveDownBtn = document.createElement("button");
    moveDownBtn.type = "button";
    moveDownBtn.className = "move-btn";
    moveDownBtn.textContent = "↓";
    moveDownBtn.title = t(lang, "moveDownTitle");
    moveDownBtn.disabled = index === selectedFiles.length - 1;
    moveDownBtn.addEventListener("click", () => moveFile(index, 1));
    li.appendChild(moveDownBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "move-btn";
    removeBtn.textContent = "×";
    removeBtn.title = t(lang, "removeTitle");
    removeBtn.addEventListener("click", () => {
      selectedFiles = selectedFiles.filter((f) => f !== file);
      refreshFileList();
    });
    li.appendChild(removeBtn);

    fileListEl.appendChild(li);
  });
  runBtn.disabled = selectedFiles.length < MIN_FILES || running;
}

function moveFile(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= selectedFiles.length) return;
  const reordered = selectedFiles.slice();
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  selectedFiles = reordered;
  refreshFileList();
}

function addFiles(fileListLike: FileList | File[]) {
  const incoming = Array.from(fileListLike).filter(
    (f) => /^image\/(jpeg|jpg|png)$/i.test(f.type) || /\.(jpe?g|png)$/i.test(f.name),
  );
  const room = MAX_FILES - selectedFiles.length;
  const accepted = incoming.slice(0, Math.max(0, room));
  selectedFiles = selectedFiles.concat(accepted);
  refreshFileList();
  if (incoming.length > accepted.length) {
    showStatus("statusTooManyFiles", { max: MAX_FILES }, true);
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  addFiles((e.target as HTMLInputElement).files!);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  }),
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

function setStatus(text: string, isError?: boolean) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

/** Renders `currentStatus` in the current language -- called both when the status changes and
 * when the language is switched, so a language change re-translates whatever's on screen. */
function renderStatus() {
  if (!currentStatus) {
    setStatus("");
    return;
  }
  if (currentStatus.kind === "plain") {
    setStatus(t(lang, currentStatus.key, currentStatus.params), currentStatus.isError);
    return;
  }
  const inner = currentStatus.code ? t(lang, currentStatus.code, currentStatus.params) : currentStatus.rawMessage;
  setStatus(t(lang, "statusErrorPrefix", { message: inner }), true);
}

function showStatus(key: string, params?: Params, isError = false) {
  currentStatus = { kind: "plain", key, params, isError };
  renderStatus();
}

function showWorkerError(code: string | undefined, params: Params | undefined, rawMessage: string) {
  currentStatus = { kind: "workerError", code, params, rawMessage };
  renderStatus();
}

function clearStatus() {
  currentStatus = null;
  renderStatus();
}

function setProgress(visible: boolean, percent: number, label: string) {
  progressEl.hidden = !visible;
  if (visible) {
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    progressLabel.textContent = label;
  }
}

function statusLabel(status: AlignedFrameResult["status"]): string {
  if (status === "reference") return t(lang, "badgeReference");
  if (status === "ok") return t(lang, "badgeOk");
  if (status === "failed") return t(lang, "badgeFailed");
  return status;
}

function revokeResultUrls() {
  for (const url of resultObjectUrls) URL.revokeObjectURL(url);
  resultObjectUrls = [];
}

function objectUrlFor(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  resultObjectUrls.push(url);
  return url;
}

function renderResults(result: PipelineResult, scrollIntoView = false) {
  revokeResultUrls();
  resultsGrid.innerHTML = "";
  warningsEl.hidden = true;
  mergedCard.hidden = true;
  compositeAllCard.hidden = true;
  downloadAllLink.hidden = true;

  if (result.warnings.length > 0) {
    warningsEl.hidden = false;
    const items = result.warnings.map((w) => `<li>${escapeHtml(t(lang, w.code, w.params))}</li>`).join("");
    warningsEl.innerHTML = `<strong>${escapeHtml(t(lang, "warningsHeading"))}</strong><ul>${items}</ul>`;
  }

  for (const frame of result.aligned) {
    const card = document.createElement("div");
    card.className = "card";

    const frameUrl = frame.blob ? objectUrlFor(frame.blob) : null;
    if (frameUrl) {
      const img = document.createElement("img");
      img.src = frameUrl;
      img.alt = frame.filename;
      card.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "card-body";

    const badge = document.createElement("span");
    badge.className = `badge ${frame.status}`;
    badge.textContent = statusLabel(frame.status);
    body.appendChild(badge);

    const name = document.createElement("div");
    name.className = "card-filename";
    name.textContent = frame.filename;
    body.appendChild(name);

    if (frame.status !== "failed" && frame.inliers != null) {
      const inliers = document.createElement("div");
      inliers.className = "card-reason";
      inliers.textContent = t(lang, "inliersLabel", { n: frame.inliers });
      body.appendChild(inliers);
    }

    if (frame.reason) {
      const reason = document.createElement("div");
      reason.className = "card-reason";
      reason.textContent = t(lang, frame.reason.code, frame.reason.params);
      body.appendChild(reason);
    }

    if (frameUrl && frame.outputName) {
      const a = document.createElement("a");
      a.href = frameUrl;
      a.className = "button-link";
      a.textContent = t(lang, "downloadButton");
      a.download = frame.outputName;
      body.appendChild(document.createElement("br"));
      body.appendChild(a);
    }

    card.appendChild(body);
    resultsGrid.appendChild(card);
  }

  if (result.merged) {
    mergedCard.hidden = false;
    const url = objectUrlFor(result.merged.blob);
    mergedImg.src = url;
    mergedDownload.href = url;
    mergedDownload.download = result.merged.outputName;
  }

  if (result.compositeAll) {
    compositeAllCard.hidden = false;
    const url = objectUrlFor(result.compositeAll.blob);
    compositeAllImg.src = url;
    compositeAllDownload.href = url;
    compositeAllDownload.download = result.compositeAll.outputName;
  }

  if (result.zipBlob) {
    downloadAllLink.hidden = false;
    downloadAllLink.href = objectUrlFor(result.zipBlob);
    downloadAllLink.download = `${stemOf(result.referenceFilename)}_all.zip`;
  }

  resultsPanel.hidden = false;
  if (scrollIntoView) resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function stemOf(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readOptions(): PipelineOptions {
  return {
    referenceIndex: Math.max(0, selectedFiles.indexOf(referenceFile as File)),
    minInliers: Math.round(clamp(optMinInliers.valueAsNumber, 1, 500, DEFAULT_OPTIONS.minInliers)),
    outputAligned: optAligned.checked,
    outputMerged: optMerged.checked,
    outputCompositeAll: optCompositeAll.checked,
    feather: clamp(Number(optFeather.value), 0, 12, DEFAULT_OPTIONS.feather),
    forceOpaque: optForceOpaque.checked,
    overlapPriority: optOverlapPriority.value === "last" ? "last" : "first",
    maxSubjectArea: clamp(Number(optMaxSubjectArea.value), 0.01, 1, DEFAULT_OPTIONS.maxSubjectArea),
    decontaminate: optDecontaminate.checked,
    edgeNoiseFloor: clamp(optEdgeNoiseFloor.valueAsNumber, 0, 0.9, DEFAULT_OPTIONS.edgeNoiseFloor),
    opacityThreshold: clamp(optOpacityThreshold.valueAsNumber, 0.01, 1, DEFAULT_OPTIONS.opacityThreshold),
    decontamMaxCorrection: clamp(optDecontamMaxCorrection.valueAsNumber, 0, 255, DEFAULT_OPTIONS.decontamMaxCorrection),
    confidentAlphaThreshold: clamp(optConfidentAlphaThreshold.valueAsNumber, 0, 1, DEFAULT_OPTIONS.confidentAlphaThreshold),
    overlapBlendSigmaPx: clamp(optOverlapBlendSigma.valueAsNumber, 0, 200, DEFAULT_OPTIONS.overlapBlendSigmaPx),
  };
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker/pipeline.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

runBtn.addEventListener("click", async () => {
  if (running || selectedFiles.length < MIN_FILES) return;
  if (!optAligned.checked && !optMerged.checked && !optCompositeAll.checked) {
    showStatus("statusSelectOutput", undefined, true);
    return;
  }

  running = true;
  runBtn.disabled = true;
  showStatus("statusLoadingImages");
  setProgress(true, 0, t(lang, "progressLoadingImages"));

  let totalBytes = 0;
  for (const f of selectedFiles) totalBytes += f.size;
  if (totalBytes > MAX_TOTAL_BYTES) {
    showStatus("statusTotalTooLarge", undefined, true);
    setProgress(false, 0, "");
    running = false;
    runBtn.disabled = selectedFiles.length < MIN_FILES;
    return;
  }

  const bitmaps: ImageBitmap[] = [];
  try {
    for (const file of selectedFiles) {
      bitmaps.push(await decodeUploadedFile(file));
    }
  } catch (err) {
    for (const b of bitmaps) b.close();
    setProgress(false, 0, "");
    if (err instanceof IngestError) {
      showStatus(err.code, err.params, true);
    } else {
      showWorkerError(undefined, undefined, String(err));
    }
    running = false;
    runBtn.disabled = selectedFiles.length < MIN_FILES;
    return;
  }

  const options = readOptions();
  const files = selectedFiles.map((f, i) => ({ name: f.name, bitmap: bitmaps[i] }));

  showStatus("statusProcessing");

  const w = getWorker();

  const onMessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    if (msg.type === "progress") {
      const stageLabel = t(lang, STAGE_KEYS[msg.stage]);
      const label = msg.total > 1 ? t(lang, "progressWithCount", { stage: stageLabel, current: msg.current, total: msg.total }) : stageLabel;
      setProgress(true, msg.percent, label);
    } else if (msg.type === "model-progress") {
      const totalMb = msg.totalBytes ? (msg.totalBytes / 1_000_000).toFixed(1) : "?";
      const loadedMb = (msg.loadedBytes / 1_000_000).toFixed(1);
      showStatus("statusModelLoading", { loaded: loadedMb, total: totalMb });
    } else if (msg.type === "result") {
      w.removeEventListener("message", onMessage);
      setProgress(false, 0, "");
      showStatus("statusComplete");
      lastResult = msg.result;
      renderResults(msg.result, true);
      running = false;
      runBtn.disabled = selectedFiles.length < MIN_FILES;
    } else if (msg.type === "error") {
      w.removeEventListener("message", onMessage);
      setProgress(false, 0, "");
      showWorkerError(msg.code, msg.params, msg.message);
      running = false;
      runBtn.disabled = selectedFiles.length < MIN_FILES;
    }
  };
  w.addEventListener("message", onMessage);

  const runMessage: RunMessage = { type: "run", files, options };
  w.postMessage(runMessage, bitmaps);
});

function resetAll() {
  selectedFiles = [];
  refreshFileList();

  optAligned.checked = DEFAULT_OPTIONS.outputAligned;
  optMerged.checked = DEFAULT_OPTIONS.outputMerged;
  optCompositeAll.checked = DEFAULT_OPTIONS.outputCompositeAll;
  optForceOpaque.checked = DEFAULT_OPTIONS.forceOpaque;
  optFeather.value = String(DEFAULT_OPTIONS.feather);
  optOverlapPriority.value = DEFAULT_OPTIONS.overlapPriority;
  optMaxSubjectArea.value = String(DEFAULT_OPTIONS.maxSubjectArea);
  optMinInliers.value = String(DEFAULT_OPTIONS.minInliers);
  optDecontaminate.checked = DEFAULT_OPTIONS.decontaminate;
  optEdgeNoiseFloor.value = String(DEFAULT_OPTIONS.edgeNoiseFloor);
  optOpacityThreshold.value = String(DEFAULT_OPTIONS.opacityThreshold);
  optDecontamMaxCorrection.value = String(DEFAULT_OPTIONS.decontamMaxCorrection);
  optConfidentAlphaThreshold.value = String(DEFAULT_OPTIONS.confidentAlphaThreshold);
  optOverlapBlendSigma.value = String(DEFAULT_OPTIONS.overlapBlendSigmaPx);

  lastResult = null;
  revokeResultUrls();
  resultsPanel.hidden = true;
  resultsGrid.innerHTML = "";
  warningsEl.hidden = true;
  warningsEl.innerHTML = "";
  mergedCard.hidden = true;
  compositeAllCard.hidden = true;
  downloadAllLink.hidden = true;
  setProgress(false, 0, "");

  clearStatus();
}

resetBtn.addEventListener("click", resetAll);

applyStaticTranslations();
refreshFileList();
