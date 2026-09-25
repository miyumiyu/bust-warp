export interface Params {
  // 膨らみ
  strength: number;
  radius: number;
  depth: number;
  aspectY: number;
  // 陰影
  shading: boolean;
  shadeStrength: number;
  sheen: number;
  lightAngle: number;
  // 位置
  drop: number;
  separation: number;
  yawCorrection: boolean;
  smoothing: number;
  // 揺れ
  jiggle: boolean;
  jiggleGain: number;
  jiggleFreq: number;
  jiggleDamping: number;
  // 表示
  effect: boolean;
  mirror: boolean;
  showSkeleton: boolean;
  showChest: boolean;
  showMesh: boolean;
  mouseTest: boolean;
  model: 'lite' | 'full';
}

export const DEFAULTS: Params = {
  strength: 0.5,
  radius: 0.38,
  depth: 0.2,
  aspectY: 1.0,
  shading: true,
  shadeStrength: 0.5,
  sheen: 0.4,
  lightAngle: 0,
  drop: 0.55,
  separation: 0.24,
  yawCorrection: true,
  smoothing: 0.5,
  jiggle: true,
  jiggleGain: 1.5,
  jiggleFreq: 3.0,
  jiggleDamping: 0.15,
  effect: true,
  mirror: true,
  showSkeleton: true,
  showChest: true,
  showMesh: false,
  mouseTest: false,
  model: 'full',
};

const STORAGE_KEY = 'webcamboobs.params.v1';

export function loadParams(): Params {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // 保存領域が使えない環境では既定値で動かす
  }
  return { ...DEFAULTS };
}

export function saveParams(p: Params): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // 同上
  }
}
