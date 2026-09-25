// 映像を格子メッシュにして、胸の位置で頂点を動かす（前方写像）
//
// 座標はすべて「アスペクト補正済み画像空間」: x ∈ [0, aspect], y ∈ [0, 1]、y は下向き。
// 変形は楕円領域ごとの小さな写像（ステージ）を順番に合成して作る。
// 重み w(t) = (1 - t²)³（t は楕円で正規化した距離）。各ステージ単体が単射（折り返しなし）に
// なる範囲にパラメータを制限しているので、合成しても三角形が裏返らない:
//   - 膨らみ: 中心から放射状に押し広げる。半径方向の伸び率は 1 - 0.653·strength 以上。
//            strength ≤ 1 なら外周の圧縮は 0.35 倍までに収まる
//   - 揺れ:   膨らみより一回り広い領域を平行移動する。伸び率は 1 - 1.72·移動量 以上

export interface BreastShape {
  cx: number;
  cy: number;
  /** 楕円の横軸方向（単位ベクトル） */
  ux: number;
  uy: number;
  rx: number;
  ry: number;
  /** 中心での拡大率 - 1 */
  strength: number;
  /** 揺れによる中心の平行移動量 */
  ox: number;
  oy: number;
}

interface Stage {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  rx: number;
  ry: number;
  scale: number;
  tx: number;
  ty: number;
}

export const MAX_STRENGTH = 1.0;
/** 揺れの領域は膨らみの半径の何倍か */
const SHIFT_REGION = 1.25;
/** 揺れ領域の半径で正規化した最大移動量（伸び率 0.45 以上を保つ） */
const MAX_SHIFT = 0.32;

const out = { x: 0, y: 0 };

function applyStage(s: Stage, x: number, y: number): void {
  const dx = x - s.cx;
  const dy = y - s.cy;
  const lx = (dx * s.ux + dy * s.uy) / s.rx;
  const ly = (-dx * s.uy + dy * s.ux) / s.ry;
  const t2 = lx * lx + ly * ly;
  if (t2 >= 1) {
    out.x = x;
    out.y = y;
    return;
  }
  const a = 1 - t2;
  const w = a * a * a;
  out.x = x + (dx * s.scale + s.tx) * w;
  out.y = y + (dy * s.scale + s.ty) * w;
}

function applyStages(stages: Stage[], x: number, y: number): void {
  out.x = x;
  out.y = y;
  for (const s of stages) applyStage(s, out.x, out.y);
}

/** 揺れの移動量を、揺れ領域の楕円で正規化して MAX_SHIFT 以内に滑らかに収める */
export function limitShift(b: BreastShape, ox: number, oy: number): [number, number] {
  const lx = (ox * b.ux + oy * b.uy) / (b.rx * SHIFT_REGION);
  const ly = (-ox * b.uy + oy * b.ux) / (b.ry * SHIFT_REGION);
  const n = Math.hypot(lx, ly);
  if (n < 1e-9) return [0, 0];
  const k = (MAX_SHIFT * Math.tanh(n / MAX_SHIFT)) / n;
  return [ox * k, oy * k];
}

export function buildStages(shapes: BreastShape[], shiftScale = 1): Stage[] {
  const stages: Stage[] = [];
  // 各ステージの中心は、それまでのステージで胸の中心が移った先に置く
  for (const b of shapes) {
    applyStages(stages, b.cx, b.cy);
    const scale = Math.min(Math.max(b.strength, 0), MAX_STRENGTH);
    stages.push({ ...b, cx: out.x, cy: out.y, scale, tx: 0, ty: 0 });
  }
  for (const b of shapes) {
    applyStages(stages, b.cx, b.cy);
    stages.push({
      ...b,
      cx: out.x,
      cy: out.y,
      rx: b.rx * SHIFT_REGION,
      ry: b.ry * SHIFT_REGION,
      scale: 0,
      tx: b.ox * shiftScale,
      ty: b.oy * shiftScale,
    });
  }
  return stages.filter((s) => s.scale > 0 || s.tx !== 0 || s.ty !== 0);
}

/** 1フレームで揺れの抑制を戻す量（約 20 フレームで元に戻る） */
const GUARD_RECOVERY = 0.05;

export class MeshWarp {
  readonly vertexCount: number;
  /** 元の位置（テクスチャ座標, 0..1） */
  readonly uv: Float32Array;
  /** 変形後の位置（0..1） */
  readonly pos: Float32Array;
  readonly triangles: Uint16Array;
  readonly lines: Uint16Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    lineStep = 4,
  ) {
    const vc = (cols + 1) * (rows + 1);
    if (vc > 65535) throw new Error('mesh too large');
    this.vertexCount = vc;
    this.uv = new Float32Array(vc * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = (j * (cols + 1) + i) * 2;
        this.uv[k] = i / cols;
        this.uv[k + 1] = j / rows;
      }
    }
    this.pos = new Float32Array(this.uv);

    const idx = (i: number, j: number) => j * (cols + 1) + i;
    const tri: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        tri.push(idx(i, j), idx(i + 1, j), idx(i, j + 1));
        tri.push(idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1));
      }
    }
    this.triangles = new Uint16Array(tri);

    const ln: number[] = [];
    for (let j = 0; j <= rows; j += lineStep) {
      for (let i = 0; i < cols; i++) ln.push(idx(i, j), idx(i + 1, j));
    }
    for (let i = 0; i <= cols; i += lineStep) {
      for (let j = 0; j < rows; j++) ln.push(idx(i, j), idx(i, j + 1));
    }
    this.lines = new Uint16Array(ln);
  }

  /** 揺れの移動量に掛ける係数。三角形の裏返りを検出したら下げる */
  shiftScale = 1;
  /** 変形がかかっている格子の範囲 [i0, i1) × [j0, j1) */
  private box = { i0: 0, i1: 0, j0: 0, j1: 0 };
  private stages: Stage[] = [];

  /** 直前の update と同じ変形を 1 点に適用する（アスペクト補正済み空間） */
  transform(x: number, y: number): { x: number; y: number } {
    applyStages(this.stages, x, y);
    return { x: out.x, y: out.y };
  }

  update(shapes: BreastShape[], aspect: number): void {
    // 各ステージは単体では裏返らないが、胸の間で圧縮が重なり、揺れが最大のときだけ
    // 格子の分解能が足りず裏返ることがある。そのフレームは揺れを弱めて作り直す
    let scale = Math.min(1, this.shiftScale + GUARD_RECOVERY);
    for (let attempt = 0; ; attempt++) {
      this.warp(buildStages(shapes, scale), aspect);
      if (scale === 0 || !this.hasFlippedTriangle()) break;
      scale = attempt < 2 ? scale * 0.5 : 0;
    }
    this.shiftScale = scale;
  }

  private warp(stages: Stage[], aspect: number): void {
    const { uv, pos, cols, rows } = this;
    pos.set(uv);
    this.stages = stages;
    if (stages.length === 0) {
      this.box = { i0: 0, i1: 0, j0: 0, j1: 0 };
      return;
    }
    // どのステージの領域にも入らない頂点は動かないので、外接矩形の中だけ計算する
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of stages) {
      const e = Math.max(s.rx, s.ry);
      minX = Math.min(minX, s.cx - e);
      maxX = Math.max(maxX, s.cx + e);
      minY = Math.min(minY, s.cy - e);
      maxY = Math.max(maxY, s.cy + e);
    }
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const box = {
      i0: clamp(Math.floor((minX / aspect) * cols), cols),
      i1: clamp(Math.ceil((maxX / aspect) * cols), cols),
      j0: clamp(Math.floor(minY * rows), rows),
      j1: clamp(Math.ceil(maxY * rows), rows),
    };
    this.box = box;
    for (let j = box.j0; j <= box.j1; j++) {
      for (let i = box.i0; i <= box.i1; i++) {
        const k = (j * (cols + 1) + i) * 2;
        applyStages(stages, uv[k] * aspect, uv[k + 1]);
        pos[k] = out.x / aspect;
        pos[k + 1] = out.y;
      }
    }
  }

  hasFlippedTriangle(): boolean {
    const { pos, cols, box } = this;
    const area = (a: number, b: number, c: number) =>
      (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a]);
    for (let j = box.j0; j < box.j1; j++) {
      for (let i = box.i0; i < box.i1; i++) {
        const a = (j * (cols + 1) + i) * 2;
        const b = a + 2;
        const c = a + (cols + 1) * 2;
        const d = c + 2;
        if (area(a, b, c) <= 0 || area(b, d, c) <= 0) return true;
      }
    }
    return false;
  }
}
