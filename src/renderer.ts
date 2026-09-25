import type { Lighting } from './shading';
import type { MeshWarp } from './warp';

const MAX_DOMES = 2;

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
out vec4 outColor;

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
  outColor = vec4(c.rgb * shade + vec3(0.4 * u_shade.y * sheen), c.a);
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
    | 'eps',
    WebGLUniformLocation
  >;
  private readonly domeA = new Float32Array(MAX_DOMES * 4);
  private readonly domeB = new Float32Array(MAX_DOMES * 4);

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

    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  render(video: HTMLVideoElement, opts: { mirror: boolean; showMesh: boolean; lighting: Lighting | null }): void {
    const { gl } = this;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.mesh.pos);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.mirror, opts.mirror ? -1 : 1);
    gl.uniform1f(this.u.solid, 0);
    this.setLighting(opts.lighting);
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
    gl.uniform1f(u.aspect, this.canvas.width / this.canvas.height);
    gl.uniform3fv(u.light, l.light);
    gl.uniform4f(u.shade, l.strength, l.sheen, l.shadowStep, l.shadowSoftness);
    gl.uniform1f(u.eps, 1.5 / this.canvas.height);
  }
}
