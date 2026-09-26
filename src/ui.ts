import type { CameraInfo } from './camera';
import { CLOTHING_MODES, CLOTHING_TEXTURES, SKIN_TONE_PRESETS } from './clothing';
import { DEFAULTS, saveParams, type Params } from './params';

type NumKey = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];
type BoolKey = { [K in keyof Params]: Params[K] extends boolean ? K : never }[keyof Params];

interface Slider {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

interface Toggle {
  key: BoolKey;
  label: string;
  hotkey?: string;
}

type ChoiceKey = 'clothing' | 'clothTexture';

interface ChoiceDefinition<K extends ChoiceKey> {
  key: K;
  label: string;
  options: readonly { id: Params[K]; label: string }[];
}

type Choice = { [K in ChoiceKey]: ChoiceDefinition<K> }[ChoiceKey];

interface ColorPick {
  key: 'clothColor' | 'clothColor2';
  label: string;
  color: true;
}

type Item = Slider | Toggle | Choice | ColorPick;

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: '膨らみ',
    items: [
      { key: 'effect', label: 'エフェクト', hotkey: 'e' },
      { key: 'strength', label: '大きさ', min: 0, max: 1, step: 0.01 },
      { key: 'radius', label: '範囲（×肩幅）', min: 0.15, max: 0.7, step: 0.01 },
      { key: 'depth', label: '飛び出し（×肩幅）', min: 0, max: 0.5, step: 0.01 },
      { key: 'aspectY', label: '縦横比', min: 0.6, max: 1.6, step: 0.01 },
    ],
  },
  {
    title: '陰影',
    items: [
      { key: 'shading', label: '陰影', hotkey: 'l' },
      { key: 'shadeStrength', label: '陰影の強さ', min: 0, max: 1, step: 0.01 },
      { key: 'sheen', label: 'ツヤ', min: 0, max: 1, step: 0.01 },
      { key: 'lightAngle', label: '光の向き（0 = 真上）', min: -90, max: 90, step: 1, unit: '°' },
    ],
  },
  {
    title: '服の着せ替え',
    items: [
      { key: 'clothing', label: '柄', options: CLOTHING_MODES },
      { key: 'clothColor', label: 'メインの色', color: true },
      { key: 'clothColor2', label: 'サブの色（柄）', color: true },
      { key: 'patternScale', label: '柄の大きさ', min: 0.4, max: 2.5, step: 0.05 },
    ],
  },
  {
    title: '服の質感・明るさ',
    items: [
      { key: 'clothTexture', label: 'テクスチャ', options: CLOTHING_TEXTURES },
      { key: 'textureStrength', label: '質感の強さ', min: 0, max: 1, step: 0.01 },
      { key: 'textureScale', label: '質感の大きさ', min: 0.4, max: 3, step: 0.05 },
      { key: 'clothBrightness', label: '服の明るさ', min: 0.25, max: 2, step: 0.05 },
    ],
  },
  {
    title: '位置・追従',
    items: [
      { key: 'drop', label: '肩からの距離（×肩幅）', min: 0.3, max: 1.1, step: 0.01 },
      { key: 'separation', label: '左右の間隔（×肩幅）', min: 0.1, max: 0.45, step: 0.01 },
      { key: 'smoothing', label: '平滑化', min: 0, max: 1, step: 0.01 },
      { key: 'yawCorrection', label: '体の向きを補正' },
    ],
  },
  {
    title: '揺れ',
    items: [
      { key: 'jiggle', label: '揺れ', hotkey: 'j' },
      { key: 'jiggleGain', label: '揺れ量', min: 0, max: 3, step: 0.05 },
      { key: 'jiggleFreq', label: '速さ', min: 1, max: 8, step: 0.1, unit: 'Hz' },
      { key: 'jiggleDamping', label: '減衰', min: 0.03, max: 1, step: 0.01 },
    ],
  },
  {
    title: '手で触る',
    items: [
      { key: 'touch', label: '手で触る', hotkey: 'h' },
      { key: 'pushStrength', label: '押す強さ', min: 0, max: 2, step: 0.05 },
      { key: 'handSize', label: '手の大きさ', min: 0.5, max: 2, step: 0.05 },
    ],
  },
  {
    title: '表示',
    items: [
      { key: 'mirror', label: '鏡像' },
      { key: 'showSkeleton', label: '骨格', hotkey: 's' },
      { key: 'showChest', label: '胸の推定位置', hotkey: 'c' },
      { key: 'showMesh', label: 'メッシュ', hotkey: 'm' },
      { key: 'mouseTest', label: 'マウスで操作テスト（ドラッグで触る）', hotkey: 't' },
    ],
  },
];

export interface PanelActions {
  onChange(key: keyof Params): void;
  onPoke(): void;
  onCalibrate(): void;
  getObsUrl(): string;
}

/** セクションの末尾に置くボタン（キーは KeyboardEvent.key の小文字） */
const BUTTONS: Record<string, { label: string; key: string; keyLabel: string; action: 'onPoke' | 'onCalibrate' }> = {
  '位置・追従': { label: '今の向きを正面にする', key: 'f', keyLabel: 'F', action: 'onCalibrate' },
  揺れ: { label: '揺らしてみる', key: ' ', keyLabel: 'Space', action: 'onPoke' },
};

export interface Panel {
  /** カメラの一覧と、今使っているカメラの名前を表示する */
  setCameras(cams: CameraInfo[], active: string): void;
  setVideoSize(width: number, height: number): void;
}

export function buildPanel(root: HTMLElement, params: Params, actions: PanelActions): Panel {
  const refreshers: (() => void)[] = [];
  const hotkeys = new Map<string, BoolKey>();

  const commit = (key: keyof Params) => {
    for (const refresh of refreshers) refresh();
    saveParams(params);
    actions.onChange(key);
  };

  const setChoice = <K extends ChoiceKey>(item: ChoiceDefinition<K>, value: string) => {
    const selected = item.options.find((option) => option.id === value);
    if (!selected) return;
    params[item.key] = selected.id;
    commit(item.key);
  };

  const h = (tag: string, cls?: string, text?: string) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  };

  root.replaceChildren();
  root.append(h('h1', 'title', 'webcam bust warp'));

  for (const section of SECTIONS) {
    const sec = h('section');
    sec.append(h('h2', undefined, section.title));
    if (section.title === '服の着せ替え') {
      sec.append(h('p', 'preset-label', '肌色プリセット'));
      const presets = h('div', 'skin-tone-presets');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', '肌色プリセット');
      for (const preset of SKIN_TONE_PRESETS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'skin-tone-preset';
        button.setAttribute('aria-label', `服を肌色にする：${preset.label}`);
        const swatch = h('span', 'skin-tone-swatch');
        swatch.style.backgroundColor = preset.color;
        swatch.setAttribute('aria-hidden', 'true');
        button.append(swatch, h('span', undefined, preset.label));
        const refresh = () => {
          const selected = params.clothing === 'solid' && params.clothColor.toLowerCase() === preset.color;
          button.setAttribute('aria-pressed', String(selected));
        };
        button.addEventListener('click', () => {
          // 先に両方の設定を更新してから通知し、OFF からでも領域推定を開始する。
          params.clothing = 'solid';
          params.clothColor = preset.color;
          commit('clothing');
          actions.onChange('clothColor');
        });
        refresh();
        refreshers.push(refresh);
        presets.append(button);
      }
      sec.append(presets, h('p', 'note preset-note', '色を押すと服全体と膨らみ部分の基本色を変更します。単色では元の布目やしわの濃淡を引き継ぎません。質感と陰影の設定は保持します。'));
    }
    if (section.title === '服の質感・明るさ') {
      sec.append(h('p', 'note', '着せ替えた服に新しい布の質感を加えます。明るさと「陰影」の光の向き・強さ・ツヤは手動で調整できます。'));
    }
    for (const item of section.items) {
      if ('min' in item) {
        const row = h('label', 'slider');
        const name = h('span', 'name', item.label);
        const value = h('span', 'value');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(item.min);
        input.max = String(item.max);
        input.step = String(item.step);
        const digits = item.step >= 1 ? 0 : item.step < 0.1 ? 2 : 1;
        const refresh = () => {
          input.value = String(params[item.key]);
          value.textContent = params[item.key].toFixed(digits) + (item.unit ?? '');
        };
        input.addEventListener('input', () => {
          params[item.key] = Number(input.value);
          refresh();
          commit(item.key);
        });
        refresh();
        refreshers.push(refresh);
        row.append(name, value, input);
        sec.append(row);
      } else if ('options' in item) {
        const row = h('label', 'choice');
        const select = document.createElement('select');
        for (const o of item.options) {
          const opt = document.createElement('option');
          opt.value = o.id;
          opt.textContent = o.label;
          select.append(opt);
        }
        const refresh = () => (select.value = params[item.key]);
        select.addEventListener('change', () => {
          setChoice(item, select.value);
        });
        refresh();
        refreshers.push(refresh);
        row.append(h('span', 'name', item.label), select);
        sec.append(row);
      } else if ('color' in item) {
        const row = h('label', 'color');
        const input = document.createElement('input');
        input.type = 'color';
        const refresh = () => (input.value = params[item.key]);
        input.addEventListener('input', () => {
          params[item.key] = input.value;
          commit(item.key);
        });
        refresh();
        refreshers.push(refresh);
        row.append(h('span', 'name', item.label), input);
        sec.append(row);
      } else {
        const row = h('label', 'toggle');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const refresh = () => {
          input.checked = params[item.key];
        };
        input.addEventListener('change', () => {
          params[item.key] = input.checked;
          commit(item.key);
        });
        refresh();
        refreshers.push(refresh);
        row.append(input, h('span', 'name', item.label));
        if (item.hotkey) {
          row.append(h('kbd', undefined, item.hotkey.toUpperCase()));
          hotkeys.set(item.hotkey, item.key);
        }
        sec.append(row);
      }
    }
    const btn = BUTTONS[section.title];
    if (btn) {
      const el = h('button', undefined, btn.label);
      el.append(h('kbd', undefined, btn.keyLabel));
      el.addEventListener('click', () => actions[btn.action]());
      sec.append(el);
    }
    root.append(sec);
  }

  const camSec = h('section');
  camSec.append(h('h2', undefined, 'カメラ・OBS 出力'));
  const camSelect = document.createElement('select');
  const camActive = h('p', 'note');
  const fillCameras = (cams: CameraInfo[]) => {
    const opts: [string, string][] = [['', '自動（仮想カメラ以外）']];
    for (const c of cams) if (c.label) opts.push([c.label, c.virtual ? `${c.label}（仮想）` : c.label]);
    if (params.camera && !opts.some(([v]) => v === params.camera)) opts.push([params.camera, `${params.camera}（見つかりません）`]);
    camSelect.replaceChildren(
      ...opts.map(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        return o;
      }),
    );
    camSelect.value = params.camera;
  };
  fillCameras([]);
  camSelect.addEventListener('change', () => {
    params.camera = camSelect.value;
    commit('camera');
  });
  refreshers.push(() => (camSelect.value = params.camera));

  const copy = h('button', undefined, 'OBS 用 URL をコピー') as HTMLButtonElement;
  copy.addEventListener('click', async () => {
    const url = actions.getObsUrl();
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = 'コピーしました';
      setTimeout(() => (copy.textContent = 'OBS 用 URL をコピー'), 2000);
    } catch {
      window.prompt('OBS のブラウザソースに貼り付ける URL', url);
    }
  });
  const hint = h('p', 'note', 'OBS の「ブラウザ」ソースに貼り付けて使います。今の設定とカメラが URL に入ります。');
  camSec.append(camSelect, camActive, copy, hint);
  root.append(camSec);

  const modelSec = h('section');
  modelSec.append(h('h2', undefined, '姿勢推定モデル'));
  const select = document.createElement('select');
  for (const [v, label] of [
    ['full', 'full（精度重視）'],
    ['lite', 'lite（速度重視）'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    select.append(opt);
  }
  select.value = params.model;
  select.addEventListener('change', () => {
    params.model = select.value as Params['model'];
    commit('model');
  });
  refreshers.push(() => (select.value = params.model));
  modelSec.append(select);

  const reset = h('button', 'secondary', '設定を初期値に戻す');
  reset.addEventListener('click', () => {
    const prev = { ...params };
    Object.assign(params, DEFAULTS);
    for (const r of refreshers) r();
    saveParams(params);
    for (const key of Object.keys(DEFAULTS) as (keyof Params)[]) {
      if (params[key] !== prev[key]) actions.onChange(key);
    }
  });
  modelSec.append(reset);
  root.append(modelSec);

  const links = h('p', 'links');
  for (const [label, href] of [
    ['GitHub', 'https://github.com/miyumiyu/bust-warp'],
    ['ライセンス', 'https://github.com/miyumiyu/bust-warp/blob/main/THIRD_PARTY_NOTICES.md'],
  ]) {
    const a = h('a', undefined, label) as HTMLAnchorElement;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    links.append(a);
  }
  links.append(h('span', undefined, '映像は端末内だけで処理されます'));
  root.append(links);

  // チェックボックスやボタンにフォーカスが残るとスペースキーで二重に反応するので外す
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLButtonElement || (t instanceof HTMLInputElement && t.type === 'checkbox')) t.blur();
  });

  window.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'range')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const pressed = ev.key.toLowerCase();
    const btn = Object.values(BUTTONS).find((b) => b.key === pressed);
    if (btn) {
      ev.preventDefault();
      actions[btn.action]();
      return;
    }
    const key = hotkeys.get(pressed);
    if (!key) return;
    params[key] = !params[key];
    for (const r of refreshers) r();
    commit(key);
  });

  return {
    setCameras(cams, active) {
      fillCameras(cams);
      camActive.textContent = active ? `使用中: ${active}` : '';
    },
    setVideoSize(width, height) {
      hint.textContent = `OBS の「ブラウザ」ソースに貼り付けて、幅 ${width}・高さ ${height} にします。今の設定とカメラが URL に入ります。`;
    },
  };
}
