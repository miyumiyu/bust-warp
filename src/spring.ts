// 2次元のバネ・ダンパ。目標（体に固定された胸の位置）から遅れて追従し、行き過ぎて揺れる

const SUBSTEP = 1 / 240;

export class Spring2D {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  private tx = 0;
  private ty = 0;
  private initialized = false;

  get ready(): boolean {
    return this.initialized;
  }

  reset(x: number, y: number): void {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.vx = this.vy = 0;
    this.initialized = true;
  }

  /**
   * @param freq 固有振動数 [Hz]
   * @param zeta 減衰比（1 で振動しない、小さいほど長く揺れる）
   */
  step(targetX: number, targetY: number, dt: number, freq: number, zeta: number): void {
    if (!this.initialized) {
      this.reset(targetX, targetY);
      return;
    }
    const omega = 2 * Math.PI * freq;
    const k = omega * omega;
    const c = 2 * zeta * omega;
    // 検出は 30fps 程度で飛び飛びなので、目標をサブステップ内で線形補間して段差による余計な励振を防ぐ
    const total = Math.min(dt, 0.1);
    const n = Math.max(1, Math.ceil(total / SUBSTEP));
    const h = total / n;
    const x0 = this.tx;
    const y0 = this.ty;
    for (let i = 1; i <= n; i++) {
      const a = i / n;
      const gx = x0 + (targetX - x0) * a;
      const gy = y0 + (targetY - y0) * a;
      this.vx += (k * (gx - this.x) - c * this.vx) * h;
      this.vy += (k * (gy - this.y) - c * this.vy) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
    }
    this.tx = targetX;
    this.ty = targetY;
  }

  impulse(vx: number, vy: number): void {
    this.vx += vx;
    this.vy += vy;
  }
}
