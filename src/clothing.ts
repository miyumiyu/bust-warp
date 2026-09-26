// 服の着せ替え: 人物セグメンテーションで服の領域を求め、色や柄を塗り替える
//
// 単色は均一な基本色に素材・陰影を加え、柄モードは元の服の明暗（しわ・縫い目・プリント）も残す。
// 実際の塗り替えは renderer.ts のフラグメントシェーダで行う。

import { ImageSegmenter, type FilesetResolver } from '@mediapipe/tasks-vision';

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/** 柄の一覧。並び順がシェーダの柄番号になる（0 = OFF） */
export const CLOTHING_MODES = [
  { id: 'off', label: 'OFF' },
  { id: 'solid', label: '単色' },
  { id: 'border', label: 'ボーダー' },
  { id: 'stripe', label: 'ストライプ' },
  { id: 'gingham', label: 'ギンガムチェック' },
  { id: 'dots', label: 'ドット' },
  { id: 'argyle', label: 'アーガイル' },
  { id: 'camo', label: '迷彩' },
] as const;

export type ClothingMode = (typeof CLOTHING_MODES)[number]['id'];

/** 元映像の布目とは別に生成する、衣服の素材。並び順がシェーダの素材番号になる。 */
export const CLOTHING_TEXTURES = [
  { id: 'none', label: 'なし' },
  { id: 'weave', label: '織り布' },
  { id: 'knit', label: 'ニット' },
] as const;

export type ClothingTexture = (typeof CLOTHING_TEXTURES)[number]['id'];

/** 衣服の基本色を変える肌色のプリセット。単色モードで描画する。 */
export const SKIN_TONE_PRESETS = [
  { label: 'ライト', color: '#f2d6c4' },
  { label: 'ピーチ', color: '#e9bca6' },
  { label: 'ベージュ', color: '#d5ad8c' },
  { label: 'タン', color: '#bd8a66' },
  { label: 'ブラウン', color: '#956548' },
  { label: 'ダーク', color: '#634432' },
] as const;

export function clothingModeIndex(id: string): number {
  return Math.max(0, CLOTHING_MODES.findIndex((m) => m.id === id));
}

export function clothingTextureIndex(id: string): number {
  return Math.max(0, CLOTHING_TEXTURES.findIndex((texture) => texture.id === id));
}

/** '#rrggbb' をリニアの RGB にする */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

/** 推定に使う縮小画像の幅（モデルの入力は 256×256 なので、これ以上大きくしても精度は上がらない） */
const MASK_WIDTH = 512;
/** 服の平均の明るさを測る縮小画像の幅 */
const STAT_WIDTH = 64;
/** 服の平均の明るさを追う速さ（フレームごと） */
const REFERENCE_FOLLOW = 0.15;

const srgbToLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export class ClothingSegmenter {
  private segmenter: ImageSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private clothesIndex = 4;
  private readonly input = document.createElement('canvas');
  private readonly inputCtx = this.input.getContext('2d')!;
  private readonly stat = document.createElement('canvas');
  private readonly statCtx = this.stat.getContext('2d', { willReadFrequently: true })!;
  private readonly lut = new Float32Array(256).map((_, i) => srgbToLinear(i));

  /** 服らしさ 0〜255（元の映像の座標、MASK_WIDTH × height） */
  mask = new Uint8Array(0);
  width = 0;
  height = 0;
  /** 服の平均の明るさ（リニア） */
  reference = 0.2;
  /** 読み込み失敗時のメッセージ */
  error = '';

  get ready(): boolean {
    return this.segmenter !== null;
  }

  get isLoading(): boolean {
    return this.loading !== null && !this.segmenter && !this.error;
  }

  load(vision: Promise<WasmFileset>, modelPath: string): Promise<void> {
    this.loading ??= (async () => {
      const create = async (delegate: 'GPU' | 'CPU') =>
        ImageSegmenter.createFromOptions(await vision, {
          baseOptions: { modelAssetPath: modelPath, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      try {
        let seg: ImageSegmenter;
        try {
          seg = await create('GPU');
        } catch (e) {
          console.warn('服の領域推定を GPU で初期化できなかったので CPU で再試行します', e);
          seg = await create('CPU');
        }
        const i = seg.getLabels().findIndex((l) => /cloth/i.test(l));
        if (i >= 0) this.clothesIndex = i;
        this.segmenter = seg;
      } catch (e) {
        console.error(e);
        this.error = `服の領域推定モデルを読み込めませんでした: ${(e as Error).message}`;
      }
    })();
    return this.loading;
  }

  /** 1 フレーム分の服の領域と平均の明るさを求める。成功したら true */
  update(video: HTMLVideoElement, timestamp: number): boolean {
    const seg = this.segmenter;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!seg || !vw || !vh) return false;

    const w = MASK_WIDTH;
    const h = Math.round((MASK_WIDTH * vh) / vw);
    if (this.input.width !== w || this.input.height !== h) {
      this.input.width = w;
      this.input.height = h;
      this.stat.width = STAT_WIDTH;
      this.stat.height = Math.round((STAT_WIDTH * vh) / vw);
    }
    this.inputCtx.drawImage(video, 0, 0, w, h);

    let ok = false;
    seg.segmentForVideo(this.input, timestamp, (result) => {
      const m = result.confidenceMasks?.[this.clothesIndex];
      if (!m) return;
      const conf = m.getAsFloat32Array();
      if (this.mask.length !== conf.length) this.mask = new Uint8Array(conf.length);
      for (let i = 0; i < conf.length; i++) this.mask[i] = conf[i] * 255;
      this.width = m.width;
      this.height = m.height;
      ok = true;
    });
    if (ok) this.updateReference(video);
    return ok;
  }

  /** 服の部分の平均の明るさ。色を載せるときに、これを基準にしわや陰影の濃淡を残す */
  private updateReference(video: HTMLVideoElement): void {
    const { stat, statCtx, mask, width, height, lut } = this;
    statCtx.drawImage(video, 0, 0, stat.width, stat.height);
    const px = statCtx.getImageData(0, 0, stat.width, stat.height).data;
    let sum = 0;
    let weight = 0;
    for (let y = 0; y < stat.height; y++) {
      const my = Math.min(height - 1, Math.floor(((y + 0.5) / stat.height) * height));
      for (let x = 0; x < stat.width; x++) {
        const mx = Math.min(width - 1, Math.floor(((x + 0.5) / stat.width) * width));
        const m = mask[my * width + mx] / 255;
        if (m < 0.5) continue;
        const i = (y * stat.width + x) * 4;
        sum += m * (0.2126 * lut[px[i]] + 0.7152 * lut[px[i + 1]] + 0.0722 * lut[px[i + 2]]);
        weight += m;
      }
    }
    // 服がほとんど映っていないときは基準を変えない
    if (weight < 8) return;
    this.reference += (sum / weight - this.reference) * REFERENCE_FOLLOW;
  }

  close(): void {
    this.segmenter?.close();
    this.segmenter = null;
    this.loading = null;
  }
}
