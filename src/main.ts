import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { listCameras, openCamera } from './camera';
import { clothingModeIndex, ClothingSegmenter, hexToLinear } from './clothing';
import { computeChestPose, type BodyState, type ChestPose, type HandState, type Vec } from './chest';
import { Overlay } from './overlay';
import { loadParams, OBS_MODE, obsUrl, type Params } from './params';
import { Renderer, type ClothingRender } from './renderer';
import { makeDome, makeLighting, type Lighting } from './shading';
import { Spring2D, type ExternalForce } from './spring';
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
/** マウス操作テストで使う仮の肩幅（画面の高さ基準）と、ドラッグ中の手の半径（×肩幅） */
const MOUSE_TEST_SHOULDER = 0.5;
const MOUSE_TEST_HAND = 0.2;
/** 手に触れる胸の見た目の半径（×変形の横半径） */
const CONTACT_RADIUS = 0.75;
/** 手が胸を押し出す硬さ（×バネの硬さ）。大きいほど手から素早く逃げる */
const PUSH_STIFFNESS = 3;
/** 触れている間、胸が手の動きに引きずられる強さ（×固有角振動数） */
const HAND_DRAG = 1.5;
/** 押されたときに膨らみと飛び出しが減る割合 */
const SQUASH = 0.3;
/** 手が見えた・見えなくなったときのフェードの速さ [1/秒] */
const HAND_FADE_IN = 12;
const HAND_FADE_OUT = 6;
/** 柄の大きさ 1 のときの 1 周期の長さ（×肩幅） */
const PATTERN_PERIOD = 0.14;

interface TouchHand extends HandState {
  weight: number;
}

/**
 * 手が胸を押す力。見た目の胸の中心と手の円が重なった分だけ手から離れる向きに押し、
 * 触れている間は手の動きに引きずる
 */
function touchForce(anchor: Vec, hands: TouchHand[], contactR: number, gain: number, freq: number): ExternalForce {
  const omega = 2 * Math.PI * freq;
  const stiffness = (omega * omega * PUSH_STIFFNESS * params.pushStrength) / gain;
  return (x, y, vx, vy) => {
    let ax = 0;
    let ay = 0;
    // バネの位置を見た目の胸の中心に直す（揺れ量の倍率がかかっている）
    const bx = anchor.x + (x - anchor.x) * gain;
    const by = anchor.y + (y - anchor.y) * gain;
    for (const h of hands) {
      const dx = bx - h.x;
      const dy = by - h.y;
      const d = Math.hypot(dx, dy);
      const pen = contactR + h.r - d;
      if (pen <= 0) continue;
      // 真正面から押されたら下へ逃がす
      const nx = d > 1e-6 ? dx / d : 0;
      const ny = d > 1e-6 ? dy / d : 1;
      ax += nx * pen * stiffness * h.weight;
      ay += ny * pen * stiffness * h.weight;
      const drag = HAND_DRAG * omega * h.weight * Math.min(1, pen / (0.3 * contactR));
      ax += drag * (h.vx / gain - vx);
      ay += drag * (h.vy / gain - vy);
    }
    return [ax, ay];
  };
}

/** OBS のブラウザソースの中で動いているか（OBS が window.obsstudio を用意する） */
const IN_OBS = 'obsstudio' in window;
if (OBS_MODE) document.documentElement.classList.add('obs');

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
const clothing = new ClothingSegmenter();

const panel = buildPanel(byId('panel'), params, {
  onChange(key) {
    if (key === 'model') void loadModel(params.model);
    if (key === 'mouseTest') tracker.reset();
    if (key === 'camera') startCamera().catch((e) => console.error(e));
    if (key === 'clothing') loadClothingModel();
  },
  onPoke: poke,
  onCalibrate: () => tracker.calibrate(),
  // 自動選択のときも、今使っているカメラを URL に固定する
  getObsUrl: () => obsUrl({ ...params, camera: params.camera || activeCamera }),
});

let landmarker: PoseLandmarker | null = null;
let delegate = '';
let loadToken = 0;
let modelLoading = false;
let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;
const visionFileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`));

/** 服の領域推定モデル（約 16MB）は、着せ替えを使うときだけ読み込む */
function loadClothingModel(): void {
  if (params.clothing !== 'off') void clothing.load(visionFileset(), `${BASE}models/selfie_multiclass_256x256.tflite`);
}

let lastBody: BodyState | null = null;
let lastPose: ChestPose | null = null;
let presence = 0;
let mouse: Vec | null = null;

const stats = { frames: 0, detectMs: 0, warpMs: 0, clothMs: 0, lastReport: 0, fps: 0 };

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
  statusEl.classList.toggle('error', isError);
}

async function loadModel(model: Params['model']): Promise<void> {
  const token = ++loadToken;
  modelLoading = true;
  // カメラのエラー表示は消さない
  if (!cameraFailed) setStatus('姿勢推定モデルを読み込み中…');
  try {
    const vision = await visionFileset();
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
    if (!cameraFailed) setStatus('');
  } catch (e) {
    console.error(e);
    if (token === loadToken) setStatus(`モデルの読み込みに失敗しました: ${(e as Error).message}`, true);
  } finally {
    if (token === loadToken) modelLoading = false;
  }
}

function resize(): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  renderer.resize(w, h);
  overlay.resize(w, h);
  stage.style.setProperty('--ar', `${w} / ${h}`);
  panel.setVideoSize(w, h);
}
video.addEventListener('resize', resize);

/** 今使っているカメラの名前（OBS 用 URL に入れる） */
let activeCamera = '';
let cameraToken = 0;
let cameraFailed = false;

function cameraErrorMessage(e: unknown): string {
  const name = (e as DOMException).name;
  if (name === 'NotAllowedError') {
    return IN_OBS
      ? 'OBS からカメラを使えません。OBS を起動オプション --enable-media-stream を付けて起動し直してください。'
      : 'カメラの使用が許可されていません。ブラウザのアドレスバーから許可してください。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません。';
  if (name === 'NotReadableError') {
    return IN_OBS
      ? 'カメラを開けません。OBS の「映像キャプチャデバイス」など、他で同じカメラを使っていないか確認してください。'
      : 'カメラを開けません。他のアプリが使用中の可能性があります。';
  }
  return `カメラを起動できません: ${(e as Error).message}`;
}

async function startCamera(): Promise<void> {
  const token = ++cameraToken;
  setStatus('カメラを起動しています…');
  // Windows ではカメラを 2 つのストリームで同時に開けないことがあるので、先に閉じる
  for (const t of (video.srcObject as MediaStream | null)?.getTracks() ?? []) t.stop();
  try {
    const { stream, label } = await openCamera(params.camera);
    if (token !== cameraToken) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    video.srcObject = stream;
    activeCamera = label;
    await video.play();
    resize();
    tracker.reset();
    cameraFailed = false;
    setStatus(!landmarker && modelLoading ? '姿勢推定モデルを読み込み中…' : '');
    panel.setCameras(await listCameras(), activeCamera);
  } catch (e) {
    if (token === cameraToken) {
      cameraFailed = true;
      setStatus(cameraErrorMessage(e), true);
      panel.setCameras(await listCameras().catch(() => []), activeCamera);
    }
    throw e;
  }
}

navigator.mediaDevices.addEventListener('devicechange', async () => {
  panel.setCameras(await listCameras(), activeCamera);
});

/** マウス操作テストでドラッグ中か（ドラッグ中はマウスが手になり、胸は押した位置に止まる） */
let dragging = false;
let mouseChest: Vec | null = null;
let lastMouseHand: Vec | null = null;

/** マウス位置を胸の中心とみなした仮の体。ドラッグ中はマウスを手として扱う */
function mouseBody(dt: number): BodyState | null {
  const chest = dragging ? mouseChest : mouse;
  if (!chest) return null;
  const half = MOUSE_TEST_SHOULDER / 2;
  const y = chest.y - params.drop * MOUSE_TEST_SHOULDER;
  const hands: HandState[] = [];
  if (dragging && mouse) {
    const vx = lastMouseHand ? (mouse.x - lastMouseHand.x) / dt : 0;
    const vy = lastMouseHand ? (mouse.y - lastMouseHand.y) / dt : 0;
    hands.push({ side: 1, x: mouse.x, y: mouse.y, r: MOUSE_TEST_SHOULDER * MOUSE_TEST_HAND, vx, vy });
    lastMouseHand = { ...mouse };
  } else {
    lastMouseHand = null;
  }
  return { ls: { x: chest.x + half, y }, rs: { x: chest.x - half, y }, yaw: 0, hands };
}

function pointerToImage(ev: PointerEvent): Vec {
  const r = stage.getBoundingClientRect();
  let nx = (ev.clientX - r.left) / r.width;
  if (params.mirror) nx = 1 - nx;
  return { x: (nx * video.videoWidth) / video.videoHeight, y: (ev.clientY - r.top) / r.height };
}

stage.addEventListener('pointermove', (ev) => {
  if (video.videoWidth) mouse = pointerToImage(ev);
});
stage.addEventListener('pointerdown', (ev) => {
  if (!params.mouseTest || !video.videoWidth) return;
  mouse = pointerToImage(ev);
  mouseChest = mouseChest && dragging ? mouseChest : { ...mouse };
  dragging = true;
  stage.setPointerCapture(ev.pointerId);
});
const endDrag = () => {
  dragging = false;
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

/** 手の出入りを滑らかにする（本人の左手、右手） */
const handFade = [0, 1].map(() => ({ weight: 0, hand: null as HandState | null }));

/** 見えている手をフェードさせ、胸に触れる手の一覧にする */
function touchHands(seen: HandState[], dt: number): TouchHand[] {
  const result: TouchHand[] = [];
  handFade.forEach((f, side) => {
    const h = seen.find((s) => s.side === side);
    if (h) f.hand = h;
    f.weight = h ? Math.min(1, f.weight + dt * HAND_FADE_IN) : Math.max(0, f.weight - dt * HAND_FADE_OUT);
    if (f.hand && f.weight > 0) result.push({ ...f.hand, r: f.hand.r * params.handSize, weight: f.weight });
  });
  return result;
}

function poke(): void {
  if (!lastPose) return;
  const omega = 2 * Math.PI * params.jiggleFreq;
  const v = 0.35 * lastPose.rx * omega;
  springs.forEach((s, i) => s.impulse((Math.random() - 0.5) * 0.6 * v, v * (i === 0 ? 1 : 0.9)));
}

let lastFrameTime = 0;

/** 服の領域を求め、着せ替えの描画パラメータを作る。柄は体（肩の中点と肩の軸）に固定する */
function dressUp(now: number): ClothingRender | null {
  if (params.clothing === 'off' || !clothing.ready) return null;
  const t0 = performance.now();
  const updated = clothing.update(video, now);
  stats.clothMs += performance.now() - t0;

  let frame: ClothingRender['frame'] = [0, 0, 1, 0];
  let unit = PATTERN_PERIOD * 0.5 * params.patternScale;
  if (lastPose) {
    const p = lastPose;
    // シェーダは (-uy, ux) を下向きとして使うので、体の下向きと揃える
    const flip = -p.uy * p.vx + p.ux * p.vy < 0 ? -1 : 1;
    frame = [p.shoulderMid.x, p.shoulderMid.y, p.ux * flip, p.uy * flip];
    unit = PATTERN_PERIOD * p.width * params.patternScale;
  }
  return {
    mask: updated ? clothing.mask : null,
    maskWidth: clothing.width,
    maskHeight: clothing.height,
    mode: clothingModeIndex(params.clothing),
    color1: hexToLinear(params.clothColor),
    color2: hexToLinear(params.clothColor2),
    reference: clothing.reference,
    frame,
    unit,
  };
}

function processFrame(now: number): void {
  const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.1) : 1 / 30;
  lastFrameTime = now;
  const aspect = video.videoWidth / video.videoHeight;

  // 1. 姿勢推定
  let body: BodyState | null = null;
  let landmarks: NormalizedLandmark[] | null = null;
  if (params.mouseTest) {
    body = mouseBody(dt);
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
  const hands = params.touch ? touchHands(body?.hands ?? [], dt) : [];
  let k = 0;
  let depth = 0;
  /** 手で押されて潰れている度合い（胸ごと、0〜1） */
  const pressed = [0, 0];
  lastPose = lastBody ? computeChestPose(lastBody, params) : null;
  if (lastPose) {
    const pose = lastPose;
    k = params.effect ? presence : 0;
    // 飛び出したところはカメラに近いぶん大きく写るので、その拡大を足す
    const strength = Math.min(params.strength + params.depth * DEPTH_MAGNIFY, MAX_STRENGTH);
    depth = params.depth * pose.width;
    // 体をひねると、前に出ている頂点ほど横にずれて見える（視差）
    const parallax = depth * Math.sin(pose.yaw);
    // 揺れ OFF でも手で押せるように、そのときは揺れないバネ（臨界減衰）で動かす
    const useSpring = params.jiggle || params.touch;
    const gain = params.jiggle ? params.jiggleGain : 1;
    const zeta = params.jiggle ? params.jiggleDamping : 1;
    const contactR = pose.rx * CONTACT_RADIUS;
    pose.anchors.forEach((a, i) => {
      const s = springs[i];
      if (!s.ready || reacquired || Math.hypot(s.x - a.x, s.y - a.y) > 3 * pose.rx) s.reset(a.x, a.y);
      const freq = params.jiggleFreq * (i === 0 ? 1 : RIGHT_FREQ_RATIO);
      s.step(a.x, a.y, dt, freq, zeta, hands.length ? touchForce(a, hands, contactR, gain, freq) : undefined);

      const shape: BreastShape = {
        cx: a.x,
        cy: a.y,
        ux: pose.ux,
        uy: pose.uy,
        rx: pose.rx,
        ry: pose.ry,
        strength: 0,
        ox: 0,
        oy: 0,
      };
      let ox = pose.ux * parallax;
      let oy = pose.uy * parallax;
      if (useSpring) {
        ox += (s.x - a.x) * gain;
        oy += (s.y - a.y) * gain;
      }
      [ox, oy] = limitShift(shape, ox, oy);
      // 押されている胸は少し潰れる
      for (const h of hands) {
        const pen = contactR + h.r - Math.hypot(a.x + ox - h.x, a.y + oy - h.y);
        pressed[i] = Math.max(pressed[i], Math.min(1, Math.max(0, pen / (0.5 * contactR))) * h.weight);
      }
      const squash = 1 - SQUASH * pressed[i] * Math.min(1, params.pushStrength);
      shape.strength = strength * k * squash;
      shape.ox = ox * k;
      shape.oy = oy * k;
      applied.push({ x: a.x + ox, y: a.y + oy });
      shapes.push(shape);
    });
  }

  // 3. メッシュ変形と描画（手の部分は変形させない）
  mesh.update(shapes, aspect, hands);
  let lighting: Lighting | null = null;
  if (lastPose && params.shading && depth * k > 0) {
    const pose = lastPose;
    const domes = shapes.map((sh, i) => {
      const squash = 1 - SQUASH * pressed[i] * Math.min(1, params.pushStrength);
      return makeDome(mesh.transform(sh.cx, sh.cy), pose, sh.strength, depth * k * squash);
    });
    lighting = makeLighting(domes, mesh.holes, params);
  }
  stats.warpMs += performance.now() - t1;
  renderer.render(video, { mirror: params.mirror, showMesh: params.showMesh, lighting, clothing: dressUp(now) });
  overlay.draw({
    mirror: params.mirror,
    landmarks,
    showSkeleton: params.showSkeleton,
    showChest: params.showChest,
    pose: lastPose,
    springs: applied,
    presence,
    hands: mesh.holes,
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
    const handInfo = params.touch && body ? ` · 手 ${body.hands.length}` : '';
    let clothInfo = '';
    if (params.clothing !== 'off') {
      if (clothing.error) clothInfo = ' · 服: 読み込み失敗';
      else if (clothing.ready) clothInfo = ` · 服 ${(stats.clothMs / n).toFixed(1)} ms`;
      else clothInfo = ' · 服: モデル読み込み中…';
    }
    hud.textContent = `${(n / secs).toFixed(0)} fps · ${mode} · 変形 ${(stats.warpMs / n).toFixed(2)} ms${found}${handInfo}${clothInfo}`;
    stats.frames = 0;
    stats.detectMs = 0;
    stats.warpMs = 0;
    stats.clothMs = 0;
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

// カメラが開けなくてもパネルから別のカメラを選び直せるように、ループとモデルは常に動かす
requestAnimationFrame(loop);
startCamera()
  .catch((e) => console.error(e))
  .then(() => {
    loadClothingModel();
    return loadModel(params.model);
  });
