# 連写写真 背景位置合わせツール(Web版)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**公開ページ: https://meinogizaka.github.io/BurstAlignImageWeb/**

連写写真の「共通の背景領域」を検出して位置合わせ・クロップし、動く被写体をAIセグメンテーションで切り抜いて合成する [BurstAlignImage](https://github.com/MeiNogizaka/BurstAlignImage)(Python/FastAPI/Dockerのサーバー版)を、**GitHub Pagesで公開できる完全クライアントサイド版**として移植したものです。

このリポジトリはWeb版専用です。仕組み・アルゴリズムの詳しい説明は[オリジナル版のREADME](https://github.com/MeiNogizaka/BurstAlignImage#仕組み)を参照してください。ここでは**オリジナル版との違い**を中心にまとめます。

## オリジナル版との違い

### アーキテクチャ:サーバーなし、ブラウザ内で完結

最大の違いは、Python/FastAPI/Docker のサーバーが完全に不要になったことです。

| | オリジナル版 | Web版 |
|---|---|---|
| 実行環境 | ローカルPCでDockerコンテナ起動 | ブラウザでURLを開くだけ |
| 画像処理 | サーバー側でOpenCV(Python) | ブラウザ内でOpenCV.js(WebAssembly) |
| 被写体切り抜き | サーバー側でrembg(onnxruntime, Python) | ブラウザ内でonnxruntime-web(WebAssembly) |
| 画像のアップロード | サーバーにアップロードして処理 | **一切アップロードしない**(ブラウザ内のWeb Workerで処理) |
| インストール | Docker必須 | 不要(URLを開くだけ) |
| ホスティング | 自分のPC/サーバー | GitHub Pages(静的サイト、GitHub Actionsで自動デプロイ) |

処理(位置合わせ・背景生成・被写体検出・全フレーム合成)はすべて専用のWeb Worker内で実行され、メインスレッド(UI)をブロックしません。進捗もポーリングではなくWorkerからのpush通知でリアルタイムに表示されます。

### 被写体切り抜きモデル

オリジナル版が使う `rembg` の `u2netp` モデルと**全く同じONNXファイル**(MD5: `8e83ca70e441ab06c318d82300c84806`、[rembg公式配布元](https://github.com/danielgatis/rembg)から取得・照合済み)を使用しています。ただし配布元がCORSヘッダーを返さずブラウザから直接取得できないため、このリポジトリに同梱し同一オリジンで配信しています。前処理・後処理(リサイズ方式、正規化方法など)もrembgの実装に忠実に再現しています。

### 制限値の違い(ブラウザのメモリ事情による)

サーバー版はマシンのRAM(数GB〜)をほぼそのまま使えますが、ブラウザ内のOpenCV.js(WebAssembly)が使えるメモリ領域はそれよりずっと小さい上限しかありません。位置合わせアルゴリズムの性質上、背景生成(中央値スタッキング)のために全フレームの画像を同時にメモリ上に保持する必要があり、これは避けられません。そのため、実測に基づいて以下のような制限を設けています。

| | オリジナル版 | Web版 |
|---|---|---|
| 枚数上限 | 15枚 | **8枚** |
| 解像度 | 長辺8000pxを超える画像のみ縮小 | **総画素数が20MPを超える画像は、アスペクト比を保ったまま20MPまで自動縮小** |
| 被写体サイズの上限(小) | 画面の3% | **画面の5%** |
| 被写体サイズの上限(既定値) | 小(3%) | **中(15%)** |

20MP×8枚程度までは実測で安定動作を確認済みです。それを超える組み合わせ(例: 60MP×15枚)では、現状はメモリ不足エラーになる可能性が高いです。

### UIの追加要素

- **日本語/English 切り替えボタン**(画面右上)。静的な文言だけでなく、処理中のステータス・進捗・結果パネル(成功/失敗バッジ、警告、エラーメッセージ)まで含めて両言語対応しています。初回はブラウザの言語設定から自動判定し、選択結果は次回訪問時のためにブラウザに保存されます。
- フッターに、応援用のAmazonほしいものリストへのリンクを追加しています。

### 実装されていない機能

オリジナル版のCLI(`python -m app.align`)には「最も被写体がはっきり写った1フレームだけを合成する」機能(`--composite`)がありますが、これはオリジナル版のUIにも元々含まれていない(全フレーム重ね合わせ機能と役割が重複するため)ものなので、Web版でも実装していません。

### ジョブ管理・保存まわりの簡略化

オリジナル版はジョブキュー(同時実行数制限・待機列)や、ジョブごとのディスク保存・1時間後の自動削除といった、複数人が同時にアクセスするサーバーを前提としたロジックを持っていますが、Web版はブラウザタブの中で1人のユーザーが1つの処理を行うだけなので、これらは丸ごと不要になり削除しています。結果はメモリ上(Blob)にのみ存在し、タブを閉じる・リロードすると消えます(ダウンロードやzip一括ダウンロードで保存してください)。

## 技術的な補足

- **利用ライブラリ**: [OpenCV.js](https://github.com/TechStark/opencv-js)(特徴点マッチング・ホモグラフィ推定・ワープ・中央値スタッキングなど画像処理全般)、[onnxruntime-web](https://github.com/microsoft/onnxruntime)(被写体切り抜きのAI推論)、[fflate](https://github.com/101arrowz/fflate)(zip一括ダウンロードの生成)。いずれもクライアントサイドで完結する形で利用しています。
- **初回アクセス時**、OpenCV.js(約10MB)・onnxruntime-webのWASM(約13MB)・切り抜きモデル(約4.5MB)を読み込むため、写真の枚数や解像度に関わらず最初の処理実行時に数十秒かかることがあります(2回目以降はブラウザにキャッシュされます)。
- EXIF回転補正は `createImageBitmap` のオプションで行っており、Pillowの`exif_transpose`と同等の効果があります。
- 解凍爆弾対策(極端に大きい画像の拒否)は、ブラウザにヘッダーのみを読むAPIがないため、サーバー版よりわずかに弱い実装(デコード後に判定)になっています。個人利用のツールとして許容しています。

## 開発

```bash
npm install
npm run dev      # ローカル開発サーバー
npm run build    # 本番ビルド(dist/に出力)
npm run preview  # ビルド結果をローカルで確認
```

`main` ブランチへのpushで、GitHub Actions(`.github/workflows/deploy.yml`)が自動的にビルド・GitHub Pagesへのデプロイを行います。

## ライセンス

このプロジェクト自体のコードは[オリジナル版](https://github.com/MeiNogizaka/BurstAlignImage)と同じ [MIT License](LICENSE) の下で公開しています。

### サードパーティのライセンス

| ライブラリ | ライセンス |
|---|---|
| [OpenCV.js](https://github.com/TechStark/opencv-js) / [OpenCV](https://opencv.org/) | Apache 2.0 License |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT License |
| [fflate](https://github.com/101arrowz/fflate) | MIT License |
| [Vite](https://vitejs.dev/) | MIT License |
| [U2-Net](https://github.com/xuebinqin/U-2-Net)(`u2netp`モデル本体。本リポジトリに同梱) | Apache 2.0 License |

`u2netp.onnx` は [rembg](https://github.com/danielgatis/rembg)(MIT License)が配布するものと同一のファイルです。再配布にあたってはU2-NetのApache 2.0ライセンス条項(著作権表示・変更点の明示等)に従ってください。
