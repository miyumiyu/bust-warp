import { CLOTHING_MODES, CLOTHING_TEXTURES, type ClothingMode, type ClothingTexture } from './clothing';

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
  // 手で触る
  touch: boolean;
  pushStrength: number;
  handSize: number;
  // 服の着せ替え
  clothing: ClothingMode;
  /** '#rrggbb' */
  clothColor: string;
  clothColor2: string;
  patternScale: number;
  clothTexture: ClothingTexture;
  textureStrength: number;
  textureScale: number;
  clothBrightness: number;
  // 表示
  effect: boolean;
  mirror: boolean;
  showSkeleton: boolean;
  showChest: boolean;
  showMesh: boolean;
  mouseTest: boolean;
  model: 'lite' | 'full';
  /** 使うカメラの名前。空なら自動（仮想カメラ以外を優先） */
  camera: string;
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
  touch: true,
  pushStrength: 1,
  handSize: 1,
  clothing: 'off',
  clothColor: '#2f6fb3',
  clothColor2: '#f4f1ea',
  patternScale: 1,
  clothTexture: 'none',
  textureStrength: 0.35,
  textureScale: 1,
  clothBrightness: 1,
  effect: true,
  mirror: true,
  showSkeleton: true,
  showChest: true,
  showMesh: false,
  mouseTest: false,
  model: 'full',
  camera: '',
};

const STORAGE_KEY = 'webcamboobs.params.v1';

/**
 * OBS のブラウザソース用の表示（URL に ?obs）。映像だけを表示し、設定は URL の s= から読む。
 * OBS 内のブラウザは普段のブラウザと保存領域が別なので、設定を URL で渡す
 */
export const OBS_MODE = new URLSearchParams(location.search).has('obs');

/** URL に入れない、確認用の表示設定 */
const DEBUG_KEYS: (keyof Params)[] = ['showSkeleton', 'showChest', 'showMesh', 'mouseTest'];

const MATERIAL_LIMITS = {
  textureStrength: [0, 1],
  textureScale: [0.4, 3],
  clothBrightness: [0.25, 2],
} as const;

/** 既定値と同じ型の項目だけを取り込む（古い保存値や壊れた URL への備え） */
function sanitize(raw: unknown): Partial<Params> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in DEFAULTS) || typeof v !== typeof DEFAULTS[k as keyof Params]) continue;
      if (k === 'model' && v !== 'lite' && v !== 'full') continue;
      if (k === 'clothing' && !CLOTHING_MODES.some((m) => m.id === v)) continue;
      if (k === 'clothTexture' && !CLOTHING_TEXTURES.some((texture) => texture.id === v)) continue;
      if ((k === 'clothColor' || k === 'clothColor2') && !/^#[0-9a-f]{6}$/i.test(v as string)) continue;
      if (k === 'textureStrength' || k === 'textureScale' || k === 'clothBrightness') {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const [min, max] = MATERIAL_LIMITS[k];
        out[k] = Math.min(max, Math.max(min, v));
        continue;
      }
      out[k] = v;
    }
  }
  return out as Partial<Params>;
}

export function loadParams(): Params {
  if (OBS_MODE) {
    const s = new URLSearchParams(location.search).get('s');
    const fromUrl = s ? decodeSettings(s) : {};
    return { ...DEFAULTS, ...fromUrl, showSkeleton: false, showChest: false, showMesh: false, mouseTest: false };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...sanitize(JSON.parse(raw)) };
  } catch {
    // 保存領域が使えない環境では既定値で動かす
  }
  return { ...DEFAULTS };
}

export function saveParams(p: Params): void {
  // OBS 用の表示では URL の設定が正なので保存しない
  if (OBS_MODE) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // 同上
  }
}

/** 設定を URL に入れられる文字列にする（UTF-8 の JSON を base64url 化。カメラ名に日本語が入ることがある） */
export function encodeSettings(p: Params): string {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Params)[]) {
    if (!DEBUG_KEYS.includes(k)) o[k] = p[k];
  }
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(o))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSettings(s: string): Partial<Params> {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return sanitize(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return {};
  }
}

export function obsUrl(p: Params): string {
  return `${location.origin}${location.pathname}?obs&s=${encodeSettings(p)}`;
}
