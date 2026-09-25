// MediaPipe の WASM と、姿勢推定・服の領域推定のモデルを public/ に配置する（npm install 後に自動実行）
import { access, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDir = path.join(root, 'public', 'models');

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = [
  ...['lite', 'full'].map((m) => ({
    file: `pose_landmarker_${m}.task`,
    url: `${MODEL_BASE}/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`,
  })),
  // 背景・髪・肌（体）・肌（顔）・服・その他 の 6 クラスに分ける人物セグメンテーション
  {
    file: 'selfie_multiclass_256x256.tflite',
    url: `${MODEL_BASE}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,
  },
];

const exists = (p) => access(p).then(() => true, () => false);

// WASM はパッケージのバージョンと必ず一致させるため毎回上書きコピーする。
// ES モジュール版（*_module_internal）は FilesetResolver の既定では使わないので省く。
// （フォルダごと消すと、開発サーバーが開いているファイルが Windows で削除待ちのまま残るので上書きにする）
const isModuleVariant = (name) => name.includes('_module_internal');
await mkdir(wasmDst, { recursive: true });
await cp(wasmSrc, wasmDst, { recursive: true, filter: (src) => !isModuleVariant(src) });
for (const name of await readdir(wasmDst)) {
  if (isModuleVariant(name)) await rm(path.join(wasmDst, name), { force: true });
}
console.log(`[assets] wasm -> ${path.relative(root, wasmDst)}`);

await mkdir(modelDir, { recursive: true });
for (const m of MODELS) {
  const dst = path.join(modelDir, m.file);
  if (await exists(dst)) {
    console.log(`[assets] ${m.file}: already present`);
    continue;
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.file}: HTTP ${res.status}`);
  await writeFile(dst, Buffer.from(await res.arrayBuffer()));
  console.log(`[assets] ${m.file} -> ${path.relative(root, dst)}`);
}
