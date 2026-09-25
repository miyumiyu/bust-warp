import { PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { ChestPose, Vec } from './chest';

export interface OverlayState {
  mirror: boolean;
  landmarks: NormalizedLandmark[] | null;
  showSkeleton: boolean;
  showChest: boolean;
  pose: ChestPose | null;
  /** 揺れ（バネ）の現在位置 */
  springs: Vec[];
  presence: number;
}

/** 骨格と胸の推定位置を映像の上に描く（デバッグ表示） */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  draw(s: OverlayState): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (s.mirror) ctx.setTransform(-1, 0, 0, 1, W, 0);
    const lw = Math.max(1.5, H / 360);

    if (s.showSkeleton && s.landmarks) {
      const lm = s.landmarks;
      ctx.lineWidth = lw * 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath();
      for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
        const a = lm[start];
        const b = lm[end];
        if (!a || !b || (a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue;
        ctx.moveTo(a.x * W, a.y * H);
        ctx.lineTo(b.x * W, b.y * H);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(80, 200, 255, 0.9)';
      for (const p of lm) {
        if ((p.visibility ?? 1) < 0.3) continue;
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, lw * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 胸の推定値はアスペクト補正済み空間なので、H を掛けるとピクセルになる
    if (s.showChest && s.pose && s.presence > 0.01) {
      const p = s.pose;
      ctx.globalAlpha = Math.min(1, s.presence);
      const angle = Math.atan2(p.uy, p.ux);

      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(255, 210, 60, 0.9)';
      ctx.beginPath();
      ctx.moveTo(p.shoulderMid.x * H, p.shoulderMid.y * H);
      ctx.lineTo(p.center.x * H, p.center.y * H);
      ctx.stroke();

      p.anchors.forEach((a, i) => {
        ctx.strokeStyle = 'rgba(255, 110, 180, 0.9)';
        ctx.setLineDash([lw * 4, lw * 3]);
        ctx.beginPath();
        ctx.ellipse(a.x * H, a.y * H, p.rx * H, p.ry * H, angle, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(255, 110, 180, 1)';
        ctx.beginPath();
        ctx.arc(a.x * H, a.y * H, lw * 3, 0, Math.PI * 2);
        ctx.fill();

        const sp = s.springs[i];
        if (sp) {
          ctx.strokeStyle = 'rgba(120, 255, 160, 1)';
          ctx.beginPath();
          ctx.moveTo(a.x * H, a.y * H);
          ctx.lineTo(sp.x * H, sp.y * H);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(sp.x * H, sp.y * H, lw * 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });

      ctx.fillStyle = 'rgba(255, 210, 60, 1)';
      ctx.beginPath();
      ctx.arc(p.center.x * H, p.center.y * H, lw * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}
