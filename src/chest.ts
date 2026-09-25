// 肩の位置から胸の位置を推定する
//
// 座標はアスペクト補正済み画像空間（warp.ts と同じ）。
// 机に座ると腰が映らないことが多いので、スケールは肩幅だけから決める。

export interface Vec {
  x: number;
  y: number;
}

/** 手のひら（円で近似） */
export interface HandState {
  /** 0 = 本人の左手、1 = 右手 */
  side: 0 | 1;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

/** フィルタ済みの体の状態 */
export interface BodyState {
  /** 本人の左肩（ランドマーク 11、鏡像なしの映像では画面右側） */
  ls: Vec;
  /** 本人の右肩（ランドマーク 12） */
  rs: Vec;
  /** 体の左右の向き [rad]。正のとき本人の左肩が奥にある */
  yaw: number;
  /** 見えている手 */
  hands: HandState[];
}

export interface ChestParams {
  /** 肩のラインから胸の中心までの距離（×肩幅） */
  drop: number;
  /** 胸の中心から左右それぞれの胸までの距離（×肩幅） */
  separation: number;
  /** 変形する楕円の横半径（×肩幅） */
  radius: number;
  /** 楕円の縦半径 / 横半径 */
  aspectY: number;
  yawCorrection: boolean;
}

export interface ChestPose {
  /** 肩の軸（鏡像なしで画面右向き） */
  ux: number;
  uy: number;
  /** 肩の軸に垂直で下向きの体軸 */
  vx: number;
  vy: number;
  /** 体の向きを補正した肩幅（体のスケール） */
  width: number;
  /** 補正に使った体の向き [rad]（補正 OFF のときは 0） */
  yaw: number;
  shoulderMid: Vec;
  center: Vec;
  /** [画面左側, 画面右側]（鏡像なしの映像基準） */
  anchors: [Vec, Vec];
  rx: number;
  ry: number;
}

/** 肩のラインから胸の前面までの奥行き（×肩幅）。体をひねると胸が横にずれて見える量を決める */
const CHEST_DEPTH = 0.35;
export const MAX_YAW = 1.0;

export function computeChestPose(b: BodyState, p: ChestParams): ChestPose {
  let ux = b.ls.x - b.rs.x;
  let uy = b.ls.y - b.rs.y;
  const sw = Math.hypot(ux, uy) || 1e-6;
  ux /= sw;
  uy /= sw;
  // v: 肩の軸に垂直で下向きの体軸
  let vx = -uy;
  let vy = ux;
  if (vy < 0) {
    vx = -vx;
    vy = -vy;
  }

  const yaw = p.yawCorrection ? Math.max(-MAX_YAW, Math.min(MAX_YAW, b.yaw)) : 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // 体をひねると見かけの肩幅が縮むので、実際の肩幅に戻してスケールに使う
  const width = sw / cos;

  const shoulderMid = { x: (b.ls.x + b.rs.x) / 2, y: (b.ls.y + b.rs.y) / 2 };
  const lateral = CHEST_DEPTH * width * sin;
  const center = {
    x: shoulderMid.x + vx * p.drop * width + ux * lateral,
    y: shoulderMid.y + vy * p.drop * width + uy * lateral,
  };
  const half = p.separation * width * cos;
  const rx = p.radius * width * (1 + cos) / 2;
  return {
    ux,
    uy,
    vx,
    vy,
    width,
    yaw,
    shoulderMid,
    center,
    anchors: [
      { x: center.x - ux * half, y: center.y - uy * half },
      { x: center.x + ux * half, y: center.y + uy * half },
    ],
    rx,
    ry: p.radius * width * p.aspectY,
  };
}
