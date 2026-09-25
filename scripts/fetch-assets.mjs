// MediaPipe の WASM と姿勢推定モデルを public/ に配置する（npm install 後に自動実行）
import { access, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDir = path.join(root, 'public', 'models');

const MODELS = ['lite', 'full'];
const modelUrl = (m) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

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
  const dst = path.join(modelDir, `pose_landmarker_${m}.task`);
  if (await exists(dst)) {
    console.log(`[assets] model ${m}: already present`);
    continue;
  }
  const res = await fetch(modelUrl(m));
  if (!res.ok) throw new Error(`model ${m}: HTTP ${res.status}`);
  await writeFile(dst, Buffer.from(await res.arrayBuffer()));
  console.log(`[assets] model ${m} -> ${path.relative(root, dst)}`);
}
