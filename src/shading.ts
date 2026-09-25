// 胸を丸み（高さ場）として扱い、光を当てて陰影をつけるためのパラメータを作る
// 実際の陰影計算は renderer.ts のフラグメントシェーダで行う

import type { ChestPose, Vec } from './chest';
import type { ResolvedHole } from './warp';

/** 高さ場の丸み 1 つ分（アスペクト補正済み空間、変形後の映像上の位置） */
export interface Dome {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  rx: number;
  /** 頂点より下側の縦半径 */
  ry: number;
  /** 頂点より上側の縦半径は ry の何倍か */
  upperStretch: number;
  /** 頂点の高さ（カメラ方向、x と同じ単位） */
  depth: number;
}

export interface Lighting {
  domes: Dome[];
  /** 光源方向の単位ベクトル（x 右、y 下、z カメラ側）。鏡像なしの映像基準 */
  light: [number, number, number];
  strength: number;
  sheen: number;
  /** 落ち影を調べる刻み幅 */
  shadowStep: number;
  /** 落ち影の境界のぼかし幅 */
  shadowSoftness: number;
  /** 陰影をつけない円（胸の手前にある手） */
  hands: ResolvedHole[];
}

/** 光源のカメラ軸からの角度。大きいほど影が長く濃くなる */
const LIGHT_TILT = (50 * Math.PI) / 180;
/**
 * 丸みの半径（×変形の範囲）。変形は範囲の外周ほど圧縮されるので、拡大された胸の
 * 見かけの大きさはおおよそ範囲の 0.65 倍（大きさ 0）〜 0.85 倍（大きさ 1）になる
 */
const DOME_RADIUS_BASE = 0.65;
const DOME_RADIUS_PER_STRENGTH = 0.2;
/** 胸の上側はなだらかに胸元へつながるので、上側の縦半径を伸ばす */
const UPPER_STRETCH = 1.6;
/** 手の縁で陰影をぼかす幅（×手の半径） */
const HAND_SHADE_FEATHER = 1.25;

/**
 * @param angleDeg 表示上の光の向き（0 = 真上、正 = 画面右から）
 */
export function lightVector(angleDeg: number, mirror: boolean): [number, number, number] {
  const phi = (angleDeg * Math.PI) / 180;
  const s = Math.sin(LIGHT_TILT);
  const x = s * Math.sin(phi);
  return [mirror ? -x : x, -s * Math.cos(phi), Math.cos(LIGHT_TILT)];
}

/**
 * @param center 変形後の映像上での胸の中心
 * @param strength 変形に使った大きさ（見かけの半径を合わせるため）
 */
export function makeDome(center: Vec, pose: ChestPose, strength: number, depth: number): Dome {
  const k = DOME_RADIUS_BASE + DOME_RADIUS_PER_STRENGTH * strength;
  // シェーダは (-uy, ux) を下向きとして上下を区別するので、体の下向きと揃える
  const flip = -pose.uy * pose.vx + pose.ux * pose.vy < 0 ? -1 : 1;
  return {
    cx: center.x,
    cy: center.y,
    ux: pose.ux * flip,
    uy: pose.uy * flip,
    rx: pose.rx * k,
    ry: pose.ry * k,
    upperStretch: UPPER_STRETCH,
    depth,
  };
}

export function makeLighting(
  domes: Dome[],
  hands: ResolvedHole[],
  p: { lightAngle: number; mirror: boolean; shadeStrength: number; sheen: number },
): Lighting {
  const radius = Math.max(...domes.map((d) => (d.rx + d.ry) / 2));
  const depth = Math.max(...domes.map((d) => d.depth));
  return {
    domes,
    light: lightVector(p.lightAngle, p.mirror),
    strength: p.shadeStrength,
    sheen: p.sheen,
    shadowStep: radius * 0.12,
    shadowSoftness: Math.max(depth * 0.15, 1e-5),
    // 陰影を消すのは手そのものだけ（変形を戻す幅は折り返し防止のためなので広すぎる）
    hands: hands.map((h) => ({ ...h, outer: h.inner * HAND_SHADE_FEATHER })),
  };
}
