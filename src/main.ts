import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeChestPose, type BodyState, type ChestPose, type Vec } from './chest';
import { Overlay } from './overlay';
import { loadParams, type Params } from './params';
import { Renderer } from './renderer';
import { makeDome, makeLighting, type Lighting } from './shading';
import { Spring2D } from './spring';
import { BodyTracker } from './tracker';
import { buildPanel } from './ui';
import { limitShift, MAX_STRENGTH, MeshWarp, type BreastShape } from './warp';
import './style.css';

const BASE = import.meta.env.BASE_URL;
/**
 * 飛び出し（×肩幅）1 あたりに足す拡大率。カメラまでの距離を肩幅の約 1.8 倍（60〜70cm）とすると、
 * 頂点は 1 / (1 - 飛び出し / 1.8) 倍に写るので、飛び出しが小さい範囲ではおよそ 0.55 倍
 */
const DEPTH_MAGNIFY = 0.5;
/** 右の胸だけ固有振動数を少しずらして、左右が完全に同期しないようにする */
const RIGHT_FREQ_RATIO = 1.07;
/** マウス操作テストで使う仮の肩幅（画面の高さ基準） */
const MOUSE_TEST_SHOULDER = 0.5;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = byId<HTMLVideoElement>('video');
const stage = byId<HTMLDivElement>('stage');
const hud = byId<HTMLDivElement>('hud');
const statusEl = byId<HTMLDivElement>('status');

const params = loadParams();
const mesh = new MeshWarp(192, 108);
const renderer = new Renderer(byId<HTMLCanvasElement>('gl'), mesh);
const overlay = new Overlay(byId<HTMLCanvasElement>('overlay'));
const tracker = new BodyTracker();
const springs = [new Spring2D(), new Spring2D()];

let landmarker: PoseLandmarker | null = null;
let delegate = '';
let loadToken = 0;
let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

let lastBody: BodyState | null = null;
let lastPose: ChestPose | null = null;
let presence = 0;
let mouse: Vec | null = null;

const stats = { frames: 0, detectMs: 0, warpMs: 0, lastReport: 0, fps: 0 };

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
  statusEl.classList.toggle('error', isError);
}

async function loadModel(model: Params['model']): Promise<void> {
  const token = ++loadToken;
  setStatus('姿勢推定モデルを読み込み中…');
  try {
    filesetPromise ??= FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    const vision = await filesetPromise;
    const create = (d: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let next: PoseLandmarker;
    let nextDelegate: string;
    try {
      next = await create('GPU');
      nextDelegate = 'GPU';
    } catch (e) {
      console.warn('GPU での初期化に失敗したので CPU で再試行します', e);
      next = await create('CPU');
      nextDelegate = 'CPU';
    }
    if (token !== loadToken) {
      next.close();
      return;
    }
    landmarker?.close();
    landmarker = next;
    delegate = nextDelegate;
    tracker.reset();
    setStatus('');
  } catch (e) {
    console.error(e);
    if (token === loadToken) setStatus(`モデルの読み込みに失敗しました: ${(e as Error).message}`, true);
  }
}

function resize(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  renderer.resize(w, h);
  overlay.resize(w, h);
  stage.style.setProperty('--ar', `${w} / ${h}`);
}

async function startCamera(): Promise<void> {
  setStatus('カメラを起動しています…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    video.addEventListener('resize', resize);
    await video.play();
    resize();
    setStatus('');
  } catch (e) {
    const name = (e as DOMException).name;
    const msg =
      name === 'NotAllowedError'
        ? 'カメラの使用が許可されていません。ブラウザのアドレスバーから許可してください。'
        : name === 'NotFoundError'
          ? 'カメラが見つかりません。'
          : name === 'NotReadableError'
            ? 'カメラを開けません。他のアプリが使用中の可能性があります。'
            : `カメラを起動できません: ${(e as Error).message}`;
    setStatus(msg, true);
    throw e;
  }
}

/** マウス位置を胸の中心とみなした仮の体 */
function mouseBody(): BodyState | null {
  if (!mouse) return null;
  const half = MOUSE_TEST_SHOULDER / 2;
  const y = mouse.y - params.drop * MOUSE_TEST_SHOULDER;
  return { ls: { x: mouse.x + half, y }, rs: { x: mouse.x - half, y }, yaw: 0 };
}

stage.addEventListener('pointermove', (ev) => {
  if (!video.videoWidth) return;
  const r = stage.getBoundingClientRect();
  let nx = (ev.clientX - r.left) / r.width;
  if (params.mirror) nx = 1 - nx;
  mouse = { x: (nx * video.videoWidth) / video.videoHeight, y: (ev.clientY - r.top) / r.height };
});

function poke(): void {
  if (!lastPose) return;
  const omega = 2 * Math.PI * params.jiggleFreq;
  const v = 0.35 * lastPose.rx * omega;
  springs.forEach((s, i) => s.impulse((Math.random() - 0.5) * 0.6 * v, v * (i === 0 ? 1 : 0.9)));
}

let lastFrameTime = 0;

function processFrame(now: number): void {
  const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.1) : 1 / 30;
  lastFrameTime = now;
  const aspect = video.videoWidth / video.videoHeight;

  // 1. 姿勢推定
  let body: BodyState | null = null;
  let landmarks: NormalizedLandmark[] | null = null;
  if (params.mouseTest) {
    body = mouseBody();
  } else if (landmarker) {
    const t0 = performance.now();
    const result = landmarker.detectForVideo(video, now);
    stats.detectMs += performance.now() - t0;
    landmarks = result.landmarks[0] ?? null;
    body = tracker.update(landmarks ?? undefined, now / 1000, aspect, params.smoothing);
  }

  // 見失ったら最後の位置のままエフェクトをフェードアウトさせる
  const reacquired = body !== null && presence < 0.05;
  presence += ((body ? 1 : 0) - presence) * Math.min(1, dt * (body ? 8 : 3));
  if (body) lastBody = body;

  // 2. 胸の位置と揺れ
  const t1 = performance.now();
  const shapes: BreastShape[] = [];
  const applied: Vec[] = [];
  let k = 0;
  let depth = 0;
  lastPose = lastBody ? computeChestPose(lastBody, params) : null;
  if (lastPose) {
    const pose = lastPose;
    k = params.effect ? presence : 0;
    // 飛び出したところはカメラに近いぶん大きく写るので、その拡大を足す
    const strength = Math.min(params.strength + params.depth * DEPTH_MAGNIFY, MAX_STRENGTH);
    depth = params.depth * pose.width;
    // 体をひねると、前に出ている頂点ほど横にずれて見える（視差）
    const parallax = depth * Math.sin(pose.yaw);
    pose.anchors.forEach((a, i) => {
      const s = springs[i];
      if (!s.ready || reacquired || Math.hypot(s.x - a.x, s.y - a.y) > 3 * pose.rx) s.reset(a.x, a.y);
      s.step(a.x, a.y, dt, params.jiggleFreq * (i === 0 ? 1 : RIGHT_FREQ_RATIO), params.jiggleDamping);

      const shape: BreastShape = {
        cx: a.x,
        cy: a.y,
        ux: pose.ux,
        uy: pose.uy,
        rx: pose.rx,
        ry: pose.ry,
        strength: strength * k,
        ox: 0,
        oy: 0,
      };
      let ox = pose.ux * parallax;
      let oy = pose.uy * parallax;
      if (params.jiggle) {
        ox += (s.x - a.x) * params.jiggleGain;
        oy += (s.y - a.y) * params.jiggleGain;
      }
      [ox, oy] = limitShift(shape, ox, oy);
      shape.ox = ox * k;
      shape.oy = oy * k;
      applied.push({ x: a.x + ox, y: a.y + oy });
      shapes.push(shape);
    });
  }

  // 3. メッシュ変形と描画
  mesh.update(shapes, aspect);
  let lighting: Lighting | null = null;
  if (lastPose && params.shading && depth * k > 0) {
    const pose = lastPose;
    const domes = shapes.map((sh) => makeDome(mesh.transform(sh.cx, sh.cy), pose, sh.strength, depth * k));
    lighting = makeLighting(domes, params);
  }
  stats.warpMs += performance.now() - t1;
  renderer.render(video, { mirror: params.mirror, showMesh: params.showMesh, lighting });
  overlay.draw({
    mirror: params.mirror,
    landmarks,
    showSkeleton: params.showSkeleton,
    showChest: params.showChest,
    pose: lastPose,
    springs: applied,
    presence,
  });

  stats.frames++;
  if (now - stats.lastReport > 500) {
    const n = stats.frames;
    const secs = (now - stats.lastReport) / 1000;
    const mode = params.mouseTest ? 'マウス操作テスト' : landmarker ? `推定 ${(stats.detectMs / n).toFixed(1)} ms (${delegate})` : '推定: 準備中';
    let found = '';
    if (!params.mouseTest && landmarker) {
      if (!body) found = ' · 人物: 未検出';
      else if (tracker.calibrating) found = ' · 人物: 検出 · 正面を測定中…';
      else {
        const deg = Math.round((body.yaw * 180) / Math.PI);
        found = ` · 人物: 検出 · 体の向き ${deg > 0 ? '+' : ''}${deg}°${params.yawCorrection ? '' : '（補正 OFF）'}`;
      }
    }
    hud.textContent = `${(n / secs).toFixed(0)} fps · ${mode} · 変形 ${(stats.warpMs / n).toFixed(2)} ms${found}`;
    stats.frames = 0;
    stats.detectMs = 0;
    stats.warpMs = 0;
    stats.lastReport = now;
  }
}

// 新しいカメラフレームが来たときだけ処理する。requestVideoFrameCallback が動いていなければ毎フレーム処理
let presentedFrames = -1;
let processedFrames = -1;
let lastVideoCallback = -Infinity;
if ('requestVideoFrameCallback' in video) {
  const onVideoFrame: VideoFrameRequestCallback = (_now, meta) => {
    presentedFrames = meta.presentedFrames;
    lastVideoCallback = performance.now();
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback(onVideoFrame);
}

function loop(): void {
  requestAnimationFrame(loop);
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
  const now = performance.now();
  if (now - lastVideoCallback < 500) {
    if (presentedFrames === processedFrames) return;
    processedFrames = presentedFrames;
  }
  processFrame(now);
}

buildPanel(byId('panel'), params, {
  onChange(key) {
    if (key === 'model') void loadModel(params.model);
    if (key === 'mouseTest') tracker.reset();
  },
  onPoke: poke,
  onCalibrate: () => tracker.calibrate(),
});

startCamera()
  .then(() => {
    requestAnimationFrame(loop);
    return loadModel(params.model);
  })
  .catch((e) => console.error(e));
