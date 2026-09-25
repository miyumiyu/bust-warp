import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { BodyState } from './chest';
import { OneEuroFilter } from './oneEuro';

const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const MIN_VISIBILITY = 0.5;
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
    };
  }
}
