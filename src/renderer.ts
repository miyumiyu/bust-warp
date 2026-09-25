import type { Lighting } from './shading';
import type { MeshWarp } from './warp';

const MAX_DOMES = 2;
const MAX_HANDS = 2;

/** 服の着せ替えの描画パラメータ（座標はアスペクト補正済み空間） */
export interface ClothingRender {
  /** 服らしさ 0〜255。前回から変わっていなければ null（テクスチャを使い回す） */
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  /** clothing.ts の CLOTHING_MODES の番号（0 = OFF） */
  mode: number;
  color1: [number, number, number];
  color2: [number, number, number];
  reference: number;
  /** 柄の原点と横軸（(-uy, ux) が下向き） */
  frame: [number, number, number, number];
  /** 柄の 1 周期の長さ */
  unit: number;
}

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform float u_mirror;
out vec2 v_uv;
out vec2 v_pos;
void main() {
  v_uv = a_uv;
  v_pos = a_pos;
  gl_Position = vec4((a_pos.x * 2.0 - 1.0) * u_mirror, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

// 胸を高さ場 h(p) とみなし、法線から拡散光とツヤ、光の方向の高さから落ち影を計算する。
// 平らな所では明るさが変わらないように、平面の明るさで正規化している
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_pos;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_solid;
uniform float u_aspect;
uniform int u_domeCount;
uniform vec4 u_domeA[${MAX_DOMES}]; // cx, cy, ux, uy（(-uy, ux) が下向き）
uniform vec4 u_domeB[${MAX_DOMES}]; // rx, 下側の ry, depth, 上側の伸び
uniform vec3 u_light;
uniform vec4 u_shade; // strength, sheen, shadowStep, shadowSoftness
uniform float u_eps;
uniform int u_handCount;
uniform vec4 u_hands[${MAX_HANDS}]; // x, y, inner, outer
uniform vec2 u_handWeight;
uniform sampler2D u_clothMask;  // 服らしさ（元の映像の座標）
uniform int u_clothMode;        // 0 = OFF, 1 = 無地, 2〜 = 柄（clothing.ts の CLOTHING_MODES の順）
uniform vec3 u_cloth1;          // メインの色（リニア）
uniform vec3 u_cloth2;          // サブの色（リニア）
uniform float u_clothRef;       // 服の平均の明るさ（リニア）
uniform vec4 u_bodyFrame;       // 柄の原点 x, y と横軸 ux, uy（(-uy, ux) が下向き）
uniform float u_patternUnit;    // 柄の 1 周期の長さ（アスペクト補正済み空間）
out vec4 outColor;

// ---- 服の着せ替え ----

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 周期 1 の縞。duty は縞の太さの割合。境目は画面上の 1 ピクセル程度でぼかす
float stripe(float x, float duty) {
  float d = abs(fract(x) - 0.5);
  float w = fwidth(x);
  return 1.0 - smoothstep(0.5 * duty - w, 0.5 * duty + w, d);
}

// 体に固定した座標（柄の周期単位）でのサブの色の割合
float patternAmount(vec2 q) {
  if (u_clothMode == 2) return stripe(q.y, 0.5);                           // ボーダー
  if (u_clothMode == 3) return stripe(q.x * 1.5, 0.3);                     // ストライプ
  if (u_clothMode == 4) return 1.0 - 0.5 * (stripe(q.x, 0.5) + stripe(q.y, 0.5)); // ギンガム（重なりが濃い）
  if (u_clothMode == 5) {                                                   // ドット（段ごとに半周期ずらす）
    vec2 g = q * 1.2;
    g.x += 0.5 * mod(floor(g.y), 2.0);
    float d = length(fract(g) - 0.5);
    float w = fwidth(d);
    return 1.0 - smoothstep(0.22 - w, 0.22 + w, d);
  }
  if (u_clothMode == 6) {                                                   // アーガイル（菱形と細い斜線）
    vec2 r = vec2(q.x + q.y * 0.7, q.x - q.y * 0.7) * 0.5;
    float diamond = mod(floor(r.x) + floor(r.y), 2.0) * 0.35;
    float line = max(stripe(r.x + 0.5, 0.06), stripe(r.y + 0.5, 0.06));
    return max(diamond, line);
  }
  if (u_clothMode == 7) {                                                   // 迷彩（ノイズを 3 段階に分ける）
    vec2 g = q * 0.6;
    float n = 0.6 * vnoise(g) + 0.3 * vnoise(g * 2.3 + 7.0) + 0.1 * vnoise(g * 5.1 + 3.0);
    float w = fwidth(n);
    return 0.5 * smoothstep(0.45 - w, 0.45 + w, n) + 0.5 * smoothstep(0.6 - w, 0.6 + w, n);
  }
  return 0.0;                                                               // 無地
}

vec3 toLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

vec3 toSrgb(vec3 c) {
  return pow(max(c, 0.0), vec3(1.0 / 2.2));
}

// 服の部分に色や柄を載せる。元の服の明るさを平均との比で残し、しわ・縫い目・プリントの濃淡を保つ
vec3 dressUp(vec3 c) {
  if (u_clothMode == 0) return c;
  // 推定した服の境目はやや内側に寄っていて、元の服の色が縁に細く残るので、少し外側まで塗る
  float m = smoothstep(0.12, 0.45, texture(u_clothMask, v_uv).r);
  if (m <= 0.0) return c;
  vec3 lin = toLinear(c);
  float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  // 暗い服のノイズを増幅しすぎないよう、小さな値を足してから比を取り、少し圧縮する
  float shade = clamp(pow((lum + 0.02) / (u_clothRef + 0.02), 0.8), 0.0, 2.5);
  vec2 s = vec2(v_uv.x * u_aspect, v_uv.y) - u_bodyFrame.xy;
  vec2 q = vec2(dot(s, u_bodyFrame.zw), dot(s, vec2(-u_bodyFrame.w, u_bodyFrame.z))) / u_patternUnit;
  vec3 target = mix(u_cloth1, u_cloth2, patternAmount(q));
  return mix(c, toSrgb(target * shade), m);
}

// ---- 陰影 ----

// 手は胸の手前にあるので陰影をつけない（手の部分は変形もしていない）
float handMask(vec2 p) {
  float m = 0.0;
  for (int i = 0; i < ${MAX_HANDS}; i++) {
    if (i >= u_handCount) break;
    vec4 h = u_hands[i];
    m = max(m, (1.0 - smoothstep(h.z, h.w, distance(p, h.xy))) * u_handWeight[i]);
  }
  return m;
}

// 光の回り込み。大きいほど陰影の境目が柔らかくなる
const float WRAP = 0.4;

float dome(vec2 p, int i) {
  vec4 a = u_domeA[i];
  vec4 b = u_domeB[i];
  vec2 d = p - a.xy;
  float lx = dot(d, a.zw) / b.x;
  float ly = dot(d, vec2(-a.w, a.z));
  // 上側はなだらかに胸元へつなげ、下側を丸く張り出させる
  ly /= ly < 0.0 ? b.y * b.w : b.y;
  float k = max(1.0 - lx * lx - ly * ly, 0.0);
  return b.z * k * k;
}

float height(vec2 p) {
  float h = dome(p, 0);
  if (u_domeCount > 1) {
    // 谷間の折れ目を丸める滑らかな max（丸みの外側では 0 のまま）
    float h2 = dome(p, 1);
    float k = 0.15 * max(u_domeB[0].z, u_domeB[1].z);
    h = 0.5 * (h + h2 + sqrt((h - h2) * (h - h2) + k * k) - k);
  }
  return h;
}

void main() {
  if (u_solid > 0.0) {
    outColor = u_color;
    return;
  }
  vec4 c = texture(u_tex, v_uv);
  // 柄は元の映像の座標で塗るので、そのあとのメッシュ変形で膨らみに沿って伸びる
  c.rgb = dressUp(c.rgb);
  if (u_domeCount == 0) {
    outColor = c;
    return;
  }
  vec2 p = vec2(v_pos.x * u_aspect, v_pos.y);
  float h = height(p);
  float hx = height(p + vec2(u_eps, 0.0)) - height(p - vec2(u_eps, 0.0));
  float hy = height(p + vec2(0.0, u_eps)) - height(p - vec2(0.0, u_eps));
  vec3 n = normalize(vec3(-hx, -hy, 2.0 * u_eps));
  vec3 L = u_light;

  // 平らな面との明るさの比。服は明るくなる側の変化が小さいので、明るくする側は半分に抑える
  float ratio = max(dot(n, L) + WRAP, 0.0) / (L.z + WRAP);
  float diffuse = ratio > 1.0 ? 1.0 + 0.5 * (ratio - 1.0) : ratio;

  // 光の方へ進んだ先の高さが光線より上にあれば影になる（胸の下に落ちる影）
  vec2 toLight = normalize(L.xy);
  float rise = L.z / length(L.xy);
  float occ = 0.0;
  for (int s = 1; s <= 4; s++) {
    float dist = float(s) * u_shade.z;
    occ = max(occ, (height(p + toLight * dist) - h - dist * rise) / u_shade.w);
  }
  occ = clamp(occ, 0.0, 1.0);

  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float sheen = max(pow(max(dot(n, H), 0.0), 8.0) - pow(H.z, 8.0), 0.0);

  float shade = mix(1.0, diffuse, u_shade.x) * (1.0 - 0.5 * u_shade.x * occ);
  // ツヤは足し算で乗せる（黒い服でも丸みが見えるように）
  vec3 lit = c.rgb * shade + vec3(0.4 * u_shade.y * sheen);
  outColor = vec4(mix(lit, c.rgb, handMask(p)), c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
  }
  return sh;
}

/** 映像テクスチャを貼った格子メッシュを描く */
export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly posBuf: WebGLBuffer;
  private readonly triCount: number;
  private readonly lineCount: number;
  private readonly triBuf: WebGLBuffer;
  private readonly lineBuf: WebGLBuffer;
  private readonly tex: WebGLTexture;
  private readonly u: Record<
    | 'mirror'
    | 'color'
    | 'solid'
    | 'tex'
    | 'aspect'
    | 'domeCount'
    | 'domeA'
    | 'domeB'
    | 'light'
    | 'shade'
    | 'eps'
    | 'handCount'
    | 'hands'
    | 'handWeight'
    | 'clothMask'
    | 'clothMode'
    | 'cloth1'
    | 'cloth2'
    | 'clothRef'
    | 'bodyFrame'
    | 'patternUnit',
    WebGLUniformLocation
  >;
  private readonly maskTex: WebGLTexture;
  private readonly domeA = new Float32Array(MAX_DOMES * 4);
  private readonly domeB = new Float32Array(MAX_DOMES * 4);
  private readonly hands = new Float32Array(MAX_HANDS * 4);
  private readonly handWeight = new Float32Array(MAX_HANDS);

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly mesh: MeshWarp,
  ) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 が使えません');
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed');
    }
    gl.useProgram(prog);
    const loc = (name: string) => gl.getUniformLocation(prog, name)!;
    this.u = {
      mirror: loc('u_mirror'),
      color: loc('u_color'),
      solid: loc('u_solid'),
      tex: loc('u_tex'),
      aspect: loc('u_aspect'),
      domeCount: loc('u_domeCount'),
      domeA: loc('u_domeA'),
      domeB: loc('u_domeB'),
      light: loc('u_light'),
      shade: loc('u_shade'),
      eps: loc('u_eps'),
      handCount: loc('u_handCount'),
      hands: loc('u_hands'),
      handWeight: loc('u_handWeight'),
      clothMask: loc('u_clothMask'),
      clothMode: loc('u_clothMode'),
      cloth1: loc('u_cloth1'),
      cloth2: loc('u_cloth2'),
      clothRef: loc('u_clothRef'),
      bodyFrame: loc('u_bodyFrame'),
      patternUnit: loc('u_patternUnit'),
    };

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    const aUv = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

    this.posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.triBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.triangles, gl.STATIC_DRAW);
    this.triCount = mesh.triangles.length;

    this.lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.lines, gl.STATIC_DRAW);
    this.lineCount = mesh.lines.length;

    this.tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.u.tex, 0);

    // 服の領域（1 チャンネル）。最初は服なしの 1×1
    this.maskTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    gl.uniform1i(this.u.clothMask, 1);
    gl.activeTexture(gl.TEXTURE0);

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  render(
    video: HTMLVideoElement,
    opts: { mirror: boolean; showMesh: boolean; lighting: Lighting | null; clothing: ClothingRender | null },
  ): void {
    const { gl } = this;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.pos);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.mirror, opts.mirror ? -1 : 1);
    gl.uniform1f(this.u.solid, 0);
    gl.uniform1f(this.u.aspect, this.canvas.width / this.canvas.height);
    this.setLighting(opts.lighting);
    this.setClothing(opts.clothing);
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triBuf);
    gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_SHORT, 0);

    if (opts.showMesh) {
      gl.enable(gl.BLEND);
      gl.uniform1f(this.u.solid, 1);
      gl.uniform4f(this.u.color, 0.2, 1.0, 0.8, 0.45);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineBuf);
      gl.drawElements(gl.LINES, this.lineCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  private setClothing(c: ClothingRender | null): void {
    const { gl, u } = this;
    gl.uniform1i(u.clothMode, c ? c.mode : 0);
    if (!c || c.mode === 0) return;
    if (c.mask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, c.maskWidth, c.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, c.mask);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform3fv(u.cloth1, c.color1);
    gl.uniform3fv(u.cloth2, c.color2);
    gl.uniform1f(u.clothRef, c.reference);
    gl.uniform4fv(u.bodyFrame, c.frame);
    gl.uniform1f(u.patternUnit, c.unit);
  }

  private setLighting(l: Lighting | null): void {
    const { gl, u } = this;
    const domes = (l?.domes ?? []).filter((d) => d.depth > 0).slice(0, MAX_DOMES);
    gl.uniform1i(u.domeCount, domes.length);
    if (!l || domes.length === 0) return;
    domes.forEach((d, i) => {
      this.domeA.set([d.cx, d.cy, d.ux, d.uy], i * 4);
      this.domeB.set([d.rx, d.ry, d.depth, d.upperStretch], i * 4);
    });
    gl.uniform4fv(u.domeA, this.domeA);
    gl.uniform4fv(u.domeB, this.domeB);
    gl.uniform3fv(u.light, l.light);
    gl.uniform4f(u.shade, l.strength, l.sheen, l.shadowStep, l.shadowSoftness);
    gl.uniform1f(u.eps, 1.5 / this.canvas.height);

    const hands = l.hands.slice(0, MAX_HANDS);
    gl.uniform1i(u.handCount, hands.length);
    this.handWeight.fill(0);
    hands.forEach((h, i) => {
      this.hands.set([h.x, h.y, h.inner, h.outer], i * 4);
      this.handWeight[i] = h.weight;
    });
    gl.uniform4fv(u.hands, this.hands);
    gl.uniform2fv(u.handWeight, this.handWeight);
  }
}
