// Minimal i18n: a flat key -> template dictionary per language, with `{param}`
// interpolation. Pure data/functions, no DOM/Worker-specific APIs, so this can be
// imported from both the main-thread UI and (for the shared message-code contract
// only, not for rendering) worker-side code.
export type Lang = "ja" | "en";

export type Params = Record<string, string | number>;

const STORAGE_KEY = "burst-align-lang";

export function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "ja" || stored === "en") return stored;
  } catch {
    // localStorage unavailable (private browsing etc.) -- fall back to browser language
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "ja";
  return nav.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore -- language just won't persist across visits
  }
}

function fmt(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

export function t(lang: Lang, key: string, params?: Params): string {
  const template = dict[lang][key] ?? dict.ja[key] ?? key;
  return fmt(template, params);
}

const dict: Record<Lang, Record<string, string>> = {
  ja: {
    // Header
    appTitle: "連写写真 背景位置合わせツール",
    appSubtitle1: "手持ち連写で撮った写真の「共通の背景領域」を検出して位置合わせ・クロップします。",
    appSubtitle2: "このページはブラウザ内で完結して動作します。画像はサーバーにアップロードされません。",

    // Upload panel
    dropzoneMain: "ここに画像をドラッグ&ドロップ、またはクリックして選択",
    dropzoneHint: "JPEG / PNG、2〜8枚(同一シーンの連写写真を推奨)。20MPを超える画像は自動的に20MPまで縮小されます",
    fileListHint: "番号は合成時の重ね順です。↑↓ボタンで並び替えられます。「基準」を選んだ写真が位置合わせの基準フレームになります。",
    refToggleTitle: "この写真を位置合わせの基準フレームにします(全フレームがこの写真の座標系に揃えられます)。",
    refLabel: "基準",
    moveUpTitle: "前に移動",
    moveDownTitle: "後に移動",
    removeTitle: "削除",

    outputOptionsLabel: "出力する画像の種類",
    optAlignedTitle: "各写真を共通の背景領域に位置合わせ・クロップした画像を出力します。",
    optAlignedLabel: "位置合わせ&クロップ画像(各写真)",
    optMergedTitle: "中央値スタッキングで動く被写体を消去した、背景だけの画像を出力します。",
    optMergedLabel: "合成背景のみ画像(動く被写体を消去)",
    optCompositeAllTitle: "動く被写体をAIで切り抜き、全フレーム分を合成背景の上に重ねて出力します。",
    optCompositeAllLabel: "被写体を残した合成画像(全フレームを重ね合わせ)",

    overlapLabel: "重なりの扱い",
    overlapPriorityTitle: "全フレーム重ね合わせで複数の被写体がはっきり重なったとき、どちらの色を手前に描画するかを選びます(写真の並び順基準)。",
    overlapPriorityLabel: "重なった場合の優先順位",
    overlapPriorityFirst: "先(番号が若い方)を手前に",
    overlapPriorityLast: "後(番号が大きい方)を手前に",
    maxSubjectAreaTitle: "動体として検出する塊の最大サイズです。大きくすると人物・動物などの大きな被写体にも対応できますが、ボケた背景を誤検出しやすくなります。",
    maxSubjectAreaLabel: "被写体サイズの上限",
    maxSubjectAreaSmall: "小(鳥など、画面の5%まで)",
    maxSubjectAreaMedium: "中(人物・動物など、画面の15%まで・推奨)",
    maxSubjectAreaLarge: "大(画面の40%まで)",
    maxSubjectAreaNone: "制限をほぼ外す(画面の90%まで)",

    advancedSummary: "詳細設定(通常は既定値のままで問題ありません。項目名にマウスを乗せると説明が出ます)",
    minInliersTitle: "位置合わせが成功したとみなす、背景の動きに合致した特徴点マッチ数の下限です。これを下回るフレームは位置合わせ失敗として扱われます。",
    minInliersLabel: "最小インライア数",
    edgeNoiseFloorTitle: "rembgのアルファ値のうち、この値未満を信頼できないノイズとして切り捨てます。ボケた背景にうっすら残る誤検出を減らします。",
    edgeNoiseFloorLabel: "低信頼度アルファの切り捨て閾値",
    forceOpaqueTitle: "動きでブレて薄く写った領域の不透明度を底上げし、くっきり表示します。輪郭にわずかな色にじみが出ることがあります。",
    forceOpaqueLabel: "被写体を常に不透明にする",
    opacityThresholdTitle: "「被写体を常に不透明にする」で、この値以上のアルファを完全不透明にします。",
    opacityThresholdLabel: "不透明化のブースト閾値",
    featherTitle: "切り抜きモデルのマットにさらにぼかしを加えます。マットは既に十分滑らかなため、通常は「なし」で問題ありません。",
    featherLabel: "追加の縁ぼかし",
    featherNone: "なし(推奨)",
    feather3: "3px",
    feather5: "5px",
    feather8: "8px",
    feather12: "12px(輪郭やわらか)",
    decontaminateTitle: "被写体の縁の色から、その写真に元々写っていた背景色の影響を差し引き、合成先の背景との色にじみを防ぎます。",
    decontaminateLabel: "色デコンタミネーションを行う",
    decontamMaxCorrectionTitle: "色デコンタミネーションの補正量の上限です。大きくすると補正が強く効きますが、過補正による不自然な色ムラが出やすくなります。",
    decontamMaxCorrectionLabel: "デコンタミネーション補正量の上限",
    confidentAlphaThresholdTitle: "全フレーム重ね合わせで、複数の被写体が「本当に重なっている」と判定するアルファ値の閾値です。",
    confidentAlphaThresholdLabel: "重なり判定のアルファ閾値",
    overlapBlendSigmaTitle: "被写体同士が重なる境界で、色の切り替わりをなめらかにブレンドする幅(px)です。",
    overlapBlendSigmaLabel: "重なり境界のブレンド幅(px)",

    runButton: "処理を実行",
    resetButton: "リセット",

    // Status / progress
    statusLoadingImages: "画像を読み込んでいます…",
    statusProcessing: "処理中です。初回はモデルのダウンロードも行うため、写真の枚数や解像度によっては数十秒〜数分かかることがあります…",
    statusComplete: "処理が完了しました。",
    statusErrorPrefix: "エラー: {message}",
    statusTooManyFiles: "アップロードできる画像は最大{max}枚です。超過分は追加されませんでした。",
    statusTotalTooLarge: "アップロード合計サイズが大きすぎます。",
    statusSelectOutput: "出力形式を少なくとも1つ選択してください。",
    statusModelLoading: "被写体切り抜きモデルを読み込み中… ({loaded} / {total} MB)",
    progressLoadingImages: "画像を読み込み中…",
    progressWithCount: "{stage} ({current}/{total})",

    stageAlign: "位置合わせ中",
    stageBackground: "背景を生成中",
    stageDetect: "被写体を検出中",
    stageCompositeAll: "合成画像を生成中(全フレーム重ね合わせ)",
    stageFinalize: "仕上げ中",

    // Results
    resultsHeading: "結果",
    downloadAllLink: "すべてダウンロード (.zip)",
    warningsHeading: "注意:",
    alignedHeading: "位置合わせ&クロップ画像",
    compositeAllHeading: "被写体を残した合成画像(全フレーム重ね合わせ)",
    compositeAllAlt: "被写体入り合成画像(全フレーム重ね合わせ)",
    mergedHeading: "合成背景のみ",
    mergedAlt: "合成背景画像",
    downloadButton: "ダウンロード",
    badgeReference: "基準フレーム",
    badgeOk: "位置合わせ成功",
    badgeFailed: "位置合わせ失敗",
    inliersLabel: "インライア数: {n}",

    // Ingest errors
    ingestUnsupportedFormat: "未対応のファイル形式です: {filename}",
    ingestFileTooLarge: "ファイルサイズが大きすぎます: {filename}",
    ingestDecodeFailed: "画像として読み込めませんでした: {filename}",
    ingestTooHighRes: "画像の解像度が大きすぎます: {filename} ({width}x{height})",

    // Worker-generated messages (reasons / warnings / errors)
    lowInliersReason: "特徴点マッチ数 {inliers}/{minInliers}(RANSAC後)",
    frameSkippedLowInliers: "{filename}: 背景の動きに合致した特徴点マッチが{inliers}/{minInliers}点しかなかったためスキップしました",
    allFramesFailed: "全てのフレームで位置合わせに失敗しました。写真の枚数や被写体が背景を覆う割合を確認してください。",
    subjectOversizedExcluded: "{filename}: 検出された動体が「被写体サイズの上限」を超えていたため、この写真の被写体は合成画像に含まれていません。上限を上げると含まれる可能性があります。",
    noSubjectDetected: "動く被写体が検出されなかったため、全フレーム重ね合わせ画像は生成されませんでした。",
    openCvLoadFailed: "OpenCV.jsの読み込みに失敗しました (HTTP {status})",
    matteModelFetchFailed: "被写体切り抜きモデルの取得に失敗しました (HTTP {status})",

    // Footer
    footerOriginalPrefix: "",
    footerOriginalLink: "オリジナル(サーバー版)",
    footerOriginalSuffix: "の処理をブラウザ内(WebAssembly)で再現したWeb版です。",
    footerWishlistPrefix: "気に入っていただけたら、",
    footerWishlistLink: "ほしいものリスト",
    footerWishlistSuffix: "からの応援も歓迎です。",
  },
  en: {
    appTitle: "Burst Photo Background Aligner",
    appSubtitle1: "Detects the “common background region” across handheld burst photos, then aligns and crops to it.",
    appSubtitle2: "This page runs entirely in your browser. Your photos are never uploaded to a server.",

    dropzoneMain: "Drag & drop images here, or click to select",
    dropzoneHint: "JPEG / PNG, 2–8 photos (a burst of the same scene is recommended). Images over 20MP are automatically downscaled to 20MP.",
    fileListHint: "The number is the layering order used when compositing. Use the ↑↓ buttons to reorder. The photo marked “Reference” becomes the alignment reference frame.",
    refToggleTitle: "Make this photo the alignment reference frame (every frame is aligned into this photo's coordinate system).",
    refLabel: "Reference",
    moveUpTitle: "Move earlier",
    moveDownTitle: "Move later",
    removeTitle: "Remove",

    outputOptionsLabel: "Output image types",
    optAlignedTitle: "Outputs each photo aligned and cropped to the common background region.",
    optAlignedLabel: "Aligned & cropped images (per photo)",
    optMergedTitle: "Outputs a background-only image with moving subjects removed via median stacking.",
    optMergedLabel: "Background-only composite (moving subjects removed)",
    optCompositeAllTitle: "Cuts out the moving subject with AI and layers every frame onto the composite background.",
    optCompositeAllLabel: "Composite with subject (all frames layered)",

    overlapLabel: "Overlap handling",
    overlapPriorityTitle: "When multiple subjects clearly overlap in the all-frames composite, choose whose color is drawn on top (based on photo order).",
    overlapPriorityLabel: "Priority when overlapping",
    overlapPriorityFirst: "Earlier (lower number) on top",
    overlapPriorityLast: "Later (higher number) on top",
    maxSubjectAreaTitle: "The maximum size of a blob detected as a moving subject. Raising it supports larger subjects like people or animals, but makes a blurred background more likely to be misdetected.",
    maxSubjectAreaLabel: "Max subject size",
    maxSubjectAreaSmall: "Small (e.g. birds, up to 5% of the frame)",
    maxSubjectAreaMedium: "Medium (e.g. people/animals, up to 15% of the frame · recommended)",
    maxSubjectAreaLarge: "Large (up to 40% of the frame)",
    maxSubjectAreaNone: "Nearly unrestricted (up to 90% of the frame)",

    advancedSummary: "Advanced settings (the defaults are fine for most cases — hover a label for details)",
    minInliersTitle: "The minimum number of feature matches consistent with the background's motion for alignment to count as successful. Frames below this are treated as failed.",
    minInliersLabel: "Minimum inlier count",
    edgeNoiseFloorTitle: "Alpha values below this are discarded as unreliable noise, reducing faint false positives left over a blurred background.",
    edgeNoiseFloorLabel: "Low-confidence alpha cutoff",
    forceOpaqueTitle: "Boosts the opacity of regions that appear faint due to motion blur, rendering them crisply. May cause a slight color fringe at the edges.",
    forceOpaqueLabel: "Always render the subject opaque",
    opacityThresholdTitle: "With “Always render the subject opaque” on, alpha values at or above this become fully opaque.",
    opacityThresholdLabel: "Opacity boost threshold",
    featherTitle: "Adds extra blur to the cutout model's matte. The matte is already smooth enough, so “None” is fine in most cases.",
    featherLabel: "Extra edge feather",
    featherNone: "None (recommended)",
    feather3: "3px",
    feather5: "5px",
    feather8: "8px",
    feather12: "12px (soft edge)",
    decontaminateTitle: "Subtracts the original background color's influence from the subject's edge color, preventing color bleed against the composite background.",
    decontaminateLabel: "Apply color decontamination",
    decontamMaxCorrectionTitle: "The maximum correction amount for color decontamination. Higher values correct more strongly but are more prone to unnatural color blotches from overcorrection.",
    decontamMaxCorrectionLabel: "Max decontamination correction",
    confidentAlphaThresholdTitle: "In the all-frames composite, the alpha threshold above which multiple subjects are considered to genuinely overlap.",
    confidentAlphaThresholdLabel: "Overlap-detection alpha threshold",
    overlapBlendSigmaTitle: "The width (px) over which color transitions are smoothly blended at the boundary between overlapping subjects.",
    overlapBlendSigmaLabel: "Overlap boundary blend width (px)",

    runButton: "Run",
    resetButton: "Reset",

    statusLoadingImages: "Loading images…",
    statusProcessing: "Processing. This also downloads the model on the first run, so it may take anywhere from tens of seconds to a few minutes depending on the number and resolution of photos…",
    statusComplete: "Processing complete.",
    statusErrorPrefix: "Error: {message}",
    statusTooManyFiles: "You can upload up to {max} images. The extra ones weren't added.",
    statusTotalTooLarge: "The total upload size is too large.",
    statusSelectOutput: "Please select at least one output type.",
    statusModelLoading: "Loading the subject-cutout model… ({loaded} / {total} MB)",
    progressLoadingImages: "Loading images…",
    progressWithCount: "{stage} ({current}/{total})",

    stageAlign: "Aligning",
    stageBackground: "Generating background",
    stageDetect: "Detecting subject",
    stageCompositeAll: "Generating composite (all frames layered)",
    stageFinalize: "Finalizing",

    resultsHeading: "Results",
    downloadAllLink: "Download all (.zip)",
    warningsHeading: "Note:",
    alignedHeading: "Aligned & cropped images",
    compositeAllHeading: "Composite with subject (all frames layered)",
    compositeAllAlt: "Composite image with subject (all frames layered)",
    mergedHeading: "Background-only composite",
    mergedAlt: "Composite background image",
    downloadButton: "Download",
    badgeReference: "Reference frame",
    badgeOk: "Alignment succeeded",
    badgeFailed: "Alignment failed",
    inliersLabel: "Inliers: {n}",

    ingestUnsupportedFormat: "Unsupported file format: {filename}",
    ingestFileTooLarge: "File is too large: {filename}",
    ingestDecodeFailed: "Couldn't load as an image: {filename}",
    ingestTooHighRes: "Image resolution is too large: {filename} ({width}x{height})",

    lowInliersReason: "{inliers}/{minInliers} inlier feature matches (after RANSAC)",
    frameSkippedLowInliers: "{filename}: skipped — only {inliers}/{minInliers} feature matches were consistent with the background's motion",
    allFramesFailed: "Alignment failed for every frame. Check the number of photos and how much of the frame the subject covers.",
    subjectOversizedExcluded: "{filename}: the detected moving blob exceeded the “max subject size” setting, so this photo's subject isn't included in the composite. Raising the limit may include it.",
    noSubjectDetected: "No moving subject was detected, so the all-frames composite wasn't generated.",
    openCvLoadFailed: "Failed to load OpenCV.js (HTTP {status})",
    matteModelFetchFailed: "Failed to fetch the subject-cutout model (HTTP {status})",

    footerOriginalPrefix: "This is a web version that reproduces the processing of the ",
    footerOriginalLink: "original (server version)",
    footerOriginalSuffix: " entirely in the browser (WebAssembly).",
    footerWishlistPrefix: "If you like this tool, ",
    footerWishlistLink: "wishlist",
    footerWishlistSuffix: " donations are also very welcome.",
  },
};
