import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { BodyState, HandState } from './chest';
import { OneEuroFilter } from './oneEuro';

const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const MIN_VISIBILITY = 0.5;
/** 姿勢推定の手の点（本人の左手、右手） */
const HAND_POINTS = [
  { wrist: 15, pinky: 17, index: 19 },
  { wrist: 16, pinky: 18, index: 20 },
] as const;
/**
 * 手を覆う円。姿勢推定の人差し指・小指の点は手の中ほど（指の付け根の手前）にあり、
 * 指先は手首からその中点までの長さの約 2.6 倍先にある。手首から指先までを覆うように、
 * 中心を指先側へ寄せて半径を取る
 */
const PALM_CENTER = 1.1;
const PALM_RADIUS = 1.25;

class HandFilter {
  readonly x = new OneEuroFilter(1, 4, 1);
  readonly y = new OneEuroFilter(1, 4, 1);
  readonly r = new OneEuroFilter(0.5, 0, 1);
  private last: { x: number; y: number; t: number } | null = null;

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.r.reset();
    this.last = null;
  }

  update(side: 0 | 1, x: number, y: number, r: number, t: number, minCutoff: number): HandState {
    this.x.minCutoff = this.y.minCutoff = minCutoff;
    const fx = this.x.filter(x, t);
    const fy = this.y.filter(y, t);
    const dt = this.last ? Math.max(t - this.last.t, 1e-3) : 0;
    const vx = this.last && dt ? (fx - this.last.x) / dt : 0;
    const vy = this.last && dt ? (fy - this.last.y) / dt : 0;
    this.last = { x: fx, y: fy, t };
    return { side, x: fx, y: fy, r: this.r.filter(r, t), vx, vy };
  }
}
/** 正面の向きを測るフレーム数（30fps で約 1.5 秒） */
const CALIBRATION_FRAMES = 45;
/** 正面からこれ以下のずれは推定誤差とみなして無視する */
const YAW_DEAD_ZONE = (10 * Math.PI) / 180;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 姿勢推定の結果を平滑化して BodyState にする */
export class BodyTracker {
  private readonly pos = Array.from({ length: 4 }, () => new OneEuroFilter(1, 4, 1));
  private readonly yaw = new OneEuroFilter(0.5, 1, 1);
  private readonly handFilters = [new HandFilter(), new HandFilter()];
  /**
   * 正面を向いているときの yaw。肩の奥行き（z）の推定は、特に腰が映っていないと
   * 正面でも一定の角度に偏るので、この値を引いて打ち消す
   */
  private yawOffset: number | null = null;
  private samples: number[] = [];

  /** 正面を測定中か */
  get calibrating(): boolean {
    return this.yawOffset === null;
  }

  reset(): void {
    for (const f of this.pos) f.reset();
    for (const f of this.handFilters) f.reset();
    this.yaw.reset();
    this.calibrate();
  }

  /** 次の約 1.5 秒の向きを正面として測り直す */
  calibrate(): void {
    this.yawOffset = null;
    this.samples = [];
  }

  /**
   * @param t 秒
   * @param smoothing 0（反応重視）〜 1（安定重視）
   */
  update(lm: NormalizedLandmark[] | undefined, t: number, aspect: number, smoothing: number): BodyState | null {
    const l = lm?.[LEFT_SHOULDER];
    const r = lm?.[RIGHT_SHOULDER];
    if (!l || !r || Math.min(l.visibility ?? 1, r.visibility ?? 1) < MIN_VISIBILITY) return null;

    const minCutoff = 4 * Math.pow(0.1, smoothing); // 4Hz 〜 0.4Hz
    for (const f of this.pos) f.minCutoff = minCutoff;
    this.yaw.minCutoff = minCutoff / 2;

    // z は「小さいほどカメラに近い」、スケールは x（画面幅基準）とほぼ同じ
    const rawYaw = Math.atan2(l.z - r.z, Math.abs(l.x - r.x));
    const filtered = this.yaw.filter(rawYaw, t);
    if (this.yawOffset === null) {
      this.samples.push(rawYaw);
      if (this.samples.length >= CALIBRATION_FRAMES) this.yawOffset = median(this.samples);
    }
    const rel = this.yawOffset === null ? 0 : filtered - this.yawOffset;
    return {
      ls: { x: this.pos[0].filter(l.x * aspect, t), y: this.pos[1].filter(l.y, t) },
      rs: { x: this.pos[2].filter(r.x * aspect, t), y: this.pos[3].filter(r.y, t) },
      yaw: Math.sign(rel) * Math.max(0, Math.abs(rel) - YAW_DEAD_ZONE),
      hands: this.updateHands(lm!, t, aspect, minCutoff),
    };
  }

  private updateHands(lm: NormalizedLandmark[], t: number, aspect: number, minCutoff: number): HandState[] {
    const hands: HandState[] = [];
    HAND_POINTS.forEach((p, side) => {
      const w = lm[p.wrist];
      const a = lm[p.pinky];
      const b = lm[p.index];
      const filter = this.handFilters[side];
      if (!w || !a || !b || Math.min(w.visibility ?? 1, a.visibility ?? 1, b.visibility ?? 1) < MIN_VISIBILITY) {
        filter.reset();
        return;
      }
      const wx = w.x * aspect;
      const kx = ((a.x + b.x) / 2) * aspect;
      const ky = (a.y + b.y) / 2;
      const len = Math.hypot(kx - wx, ky - w.y);
      const cx = wx + (kx - wx) * PALM_CENTER;
      const cy = w.y + (ky - w.y) * PALM_CENTER;
      hands.push(filter.update(side as 0 | 1, cx, cy, len * PALM_RADIUS, t, minCutoff));
    });
    return hands;
  }
}
