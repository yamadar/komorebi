'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  木漏れ日 Komorebi — 物理ベース WebGL2 実装
//
//  原理（docs/komorebi-research.md §3 ケプラーの光図形理論）:
//      地面の照度 E(x) = 樹冠の開口透過率 T ⊛ 太陽円盤
//  を文字どおり実行する。各画素で太陽の視直径 0.53° の円盤上 48 方向を
//  サンプリングし、その方向の光線が樹冠 2 層（上層・下層）を透過したかを
//  積分する。これにより
//    ・小さな葉の隙間 → 太陽像（楕円スポット, Sonnentaler）
//    ・大きな開口     → 開口形状そのままの明るい広がり
//    ・両者の中間     → 自然な融合・重なり
//  がすべて畳み込みの物理から自動的に現れる。スプライト近似はしない。
//
//  パイプライン（毎フレーム, 全て画面空間）:
//    pass1 canopy   : 風で変形する樹冠透過率場 → RG8 (R=上層, G=下層)
//    pass2 irradiance: 太陽円盤 48タップ積分（周辺減光つき）→ R8 + mips
//    pass3 screen   : 透視投影した地面 + アスファルト質感 + トーンマップ
//
//  風のモデル:
//    ・突風エンベロープ（時間 fBm × 空間を移動する突風前線）
//    ・枝の揺れ（低周波・風向きにコヒーレント）
//    ・葉のはためき（高周波・細かい）
//    ・隙間の開閉（3Dノイズの時間スライスで葉群が形を変える）
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── 定数 ─────────────────────────────────────────────────────────────────────
const SUN_HALF_ANGLE = 0.004625;  // 太陽の視半径 [rad] (0.53°/2)
const N_TAPS  = 48;               // 太陽円盤のサンプル数
const EXPAND  = 1.09;             // オフスクリーンパスの視野拡張（畳み込みの縁余白）
const CAM_H   = 1.5;              // カメラ高さ [m]
const CAM_PITCH = -35.5 * RAD;    // 俯角
const FOV_Y   = 50 * RAD;
const H_RATIO = 0.32;             // 下層樹冠の高さ / 上層樹冠の高さ
const DPR_CAP = 2;
const MAX_SIM_W = 1600;           // シミュレーションFBOの最大幅

// ── ユーザーパラメータ ────────────────────────────────────────────────────────
const P = {
  wind:   0.45,   // 風の強さ 0..1
  height: 12.0,   // 上層樹冠の高さ [m] → スポット径・ぼけ量
  cover:  0.66,   // 葉の密度 0..1
  elev:   62.0,   // 太陽高度 [deg] → 楕円伸長・色温度
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── GL 初期化 ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
if (!gl) {
  document.getElementById('nogl').hidden = false;
  throw new Error('WebGL2 unavailable');
}

// ── シェーダ共通部 ────────────────────────────────────────────────────────────
const VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.))[gl_VertexID];
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0., 1.);
}`;

// ハッシュ・ノイズ・カメラレイのGLSL共通スニペット
const NOISE_GLSL = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vn2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i),             hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3. - 2. * f);
  return mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), u.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), u.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), u.x), u.y), u.z);
}`;

const CAMERA_GLSL = `
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform vec2 uTanHalf;
// 画面UV → 地面 (y=0) との交点 [m, xz平面]
vec2 groundAt(vec2 uv) {
  vec2 n = uv * 2. - 1.;
  vec3 rd = normalize(uCamF + n.x * uTanHalf.x * uCamR + n.y * uTanHalf.y * uCamU);
  float dy = max(-rd.y, 0.02);
  return uCamPos.xz + rd.xz * (uCamPos.y / dy);
}
// 地面の点 → 画面UV（タップのリプロジェクション用）
vec2 projGround(vec2 g) {
  vec3 v = vec3(g.x, 0., g.y) - uCamPos;
  float z = dot(v, uCamF);
  return vec2(dot(v, uCamR) / (uTanHalf.x * z),
              dot(v, uCamU) / (uTanHalf.y * z)) * 0.5 + 0.5;
}`;

// ── pass1: 樹冠透過率場 ───────────────────────────────────────────────────────
//  R = 上層 (高い・大きな葉群・ゆったり揺れる)
//  G = 下層 (低い・細かい・速い揺れ + 枝)
const CANOPY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oT;
uniform float uTime;
uniform vec2  uWindDir;
uniform float uGust;     // 突風エンベロープ × 風スライダー（CPUで計算）
uniform float uCover;    // 葉の密度 0..1
${NOISE_GLSL}
${CAMERA_GLSL}

// fBm（footprint に応じて高周波オクターブを平均値0.5へフェード → 遠景のちらつき防止。
//  オクターブ間で回転させ、value noise の正方格子による角張りを消す）
const mat2 ROT = mat2(.802, .597, -.597, .802);
float fbm2(vec2 p, float fpc) {
  float s = 0., amp = .5, fr = 1., wsum = 0.;
  vec2 q = p;
  for (int i = 0; i < 3; i++) {
    float fade = 1. - smoothstep(.2, .5, fpc * fr);
    s += amp * mix(.5, vn2(q), fade);
    wsum += amp;
    q = ROT * q * 2.13 + 17.7;
    fr *= 2.13; amp *= .5;
  }
  return s / wsum;
}
float fbmLeaf(vec2 p, float tz, float fpc) {
  float s = 0., amp = .5, fr = 1., wsum = 0.;
  vec2 q = p;
  for (int i = 0; i < 5; i++) {
    float fade = 1. - smoothstep(.2, .5, fpc * fr);
    s += amp * mix(.5, vn3(vec3(q, tz * sqrt(fr))), fade);
    wsum += amp;
    q = ROT * q * 2.07 + 11.3;
    fr *= 2.07; amp *= .5;
  }
  return s / wsum;
}

// 風による葉群の変位 [m]
vec2 windField(vec2 p, float t, float swayA, float flutA, float ph) {
  // 突風前線: 風向きに ~4m/s で流れる空間パターン
  float front = .55 + .9 * vn3(vec3(p * .12 - uWindDir * (t * .5), ph * 3.1));
  float g = uGust * front;
  // 枝の揺れ: 低周波ノイズ + 進行波のうねり
  vec2 swn = vec2(vn3(vec3(p * .085, t * .38 + ph)),
                  vn3(vec3(p * .085 + 7.31, t * .31 + ph))) - .5;
  vec2 sway = uWindDir * (swn.x * 1.7 + .35 * sin(t * 2.1 + dot(p, uWindDir) * .55 + ph))
            + vec2(-uWindDir.y, uWindDir.x) * (swn.y * .8);
  // 葉のはためき: 高周波・小振幅
  vec2 fl = vec2(vn3(vec3(p * 1.55, t * 2.3 + ph)),
                 vn3(vec3(p * 1.55 + 19.7, t * 2.1 + ph))) - .5;
  return swayA * g * sway + flutA * pow(g, 1.4) * fl * 2.;
}

// ── 上層: ジッター格子の丸い穴 ─────────────────────────────────────────────
//  葉群の間の隙間は「孤立した小さな穴の集まり」。セルごとに1個の穴を置き、
//  局所開度 openness が穴の半径を決める:
//    密 → ほぼ閉じる（まれに小さな穴 = 暗部にぽつぽつ光る点）
//    中 → 小さな穴が房状に密集（写真のぶどうの房状スポット群）
//    疎 → 穴が育って融合 → 大きな光のプールへ自然につながる
//  さらにセルごとに位相の違う「呼吸」で開閉 — 風で光が明滅する核心。
float holeField(vec2 q, float openness, float t, float fp) {
  const float HF = 3.4;                 // セル間隔 ≈ 29cm
  vec2 g = q * HF;
  vec2 ic = floor(g), fc = fract(g);
  float distort = 1. + .3 * (vn2(q * 9.7) - .5);   // 輪郭の有機的な歪み
  float tph = t * (.25 + .9 * uGust);              // 呼吸は風が強いほど速い
  float T = 0.;
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++) {
    vec2 cl = vec2(float(dx), float(dy));
    vec2 cell = ic + cl;
    vec2 h = hash22(cell);
    float h2 = hash12(cell + 51.7);
    // 穴の中心: セル内ジッター + 葉の揺れによる小さな周回
    vec2 c = cl + .15 + .7 * h
           + .07 * vec2(sin(tph * (.5 + .4 * h.y) + h2 * 6.28),
                        cos(tph * (.6 + .3 * h.x) + h2 * 4.1));
    // 呼吸: ゆっくり開いたり閉じたり（位相・速さはセルごと）
    float breathe = .78 + .38 * sin(tph * (.6 + .8 * h2) + h.x * 6.28);
    float r = max(openness * (.26 + 1.25 * h2 * h2) * breathe - .05, 0.);
    float d = length(fc - c) * distort;
    T = max(T, smoothstep(r, r * .62, d));
  }
  // 遠景: セルがtexel未満になったら平均透過率へフェード
  float hfade = 1. - smoothstep(.25, .6, fp * HF);
  return mix(openness * .38, T, hfade);
}

float layerUpper(vec2 p, float t, float fp) {
  vec2 q = p + windField(p, t, .22, .05, 0.);
  vec2 w = q + .95 * (vec2(vn2(q * .40 + 3.7), vn2(q * .40 + 9.2)) - .5);
  float clump = fbm2(w * .22, fp * .22);
  float c0 = .76 - .48 * uCover;        // 密度スライダー → 開度の中心
  float openness = 1. - smoothstep(c0 - .22, c0 + .22, clump);
  openness = .07 + .93 * pow(openness, .8);
  float T = holeField(w, openness, t, fp);
  T = max(T, 1. - smoothstep(.13, .26, clump));   // 完全な空き地
  return T;
}

// ── 下層: fBm閾値方式 ──────────────────────────────────────────────────────
//  プール内を横切る葉影（pinspeck）・小さく鋭いスポット・枝を担う
float canopyLayer(vec2 p, float t, float fp,
                  float leafF, float clumpF, float warpA, float warpF,
                  float swayA, float flutA, float evolve, float coverBias,
                  float seed, bool branches) {
  vec2 q = p + windField(p, t, swayA, flutA, seed);
  // ドメインワープ → 有機的な葉群輪郭
  vec2 w = q + warpA * (vec2(vn2(q * warpF + 3.7 + seed), vn2(q * warpF + 9.2 + seed)) - .5);
  float clump = fbm2(w * clumpF + seed * 17.3, fp * clumpF);
  float tz    = t * (.03 + .45 * uGust) * evolve;
  float leaf  = fbmLeaf(w * leafF + seed * 7.7, tz, fp * leafF);

  float openness = 1. - smoothstep(.38, .58, clump);        // 葉群が薄い場所
  float cover = clamp(uCover + coverBias, .05, .97);
  // fBm(正規化済)の標準偏差 ≈ 0.10 に合わせた閾値。隙間率を低く保ち
  // （パーコレーション閾値以下）、隙間が孤立した丸い穴になるようにする。
  // 密: 隙間〜3% / 中間: 〜15% / 疎: 〜50%。大きな白い領域は下の「空き地」項が担う。
  float taub  = .26 + .52 * cover;
  float tau   = mix(taub + .09, taub - .13, openness);
  float edge  = .035 + fp * 2.2;                             // 遠景は自動的にソフト化
  float T = smoothstep(tau, tau + edge, leaf);
  T = max(T, 1. - smoothstep(.13, .26, clump));              // 完全な空き（大きな白いプール）

  if (branches) {
    // ノイズ等高線で細い枝。遠景ではフェード
    float bn = vn2(w * .55 + 13.7 + seed);
    float bw = .012 + fp * .8;
    float branch = 1. - smoothstep(bw, bw * 2., abs(bn - .5));
    float bmask  = smoothstep(.50, .66, vn2(w * .085 + 4.9 + seed));
    float bfade  = 1. - smoothstep(.01, .04, fp);
    T *= 1. - .88 * branch * bmask * bfade;
  }
  return T;
}

void main() {
  vec2 p = groundAt(vUV);
  float fp = max(length(dFdx(p)), length(dFdy(p)));  // 1texelの地面サイズ [m]
  float t = uTime;

  // 上層: 高い樹冠 — 葉群の小さな隙間がピンホールとなり丸いスポットを作る
  float TA = layerUpper(p, t, fp);
  // 下層: 低い枝葉 — 細かく、速く小さく揺れる、まばら + 枝
  float TB = canopyLayer(p, t, fp,
    4.2,  .55, .55, .70,
    .09,  .07, 1.5, -.38,
    5., true);

  oT = vec4(TA, TB, 0., 1.);
}`;

// ── pass2: 太陽円盤の畳み込み（照度）──────────────────────────────────────────
const IRR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oE;
uniform sampler2D uCanopy;
uniform vec3 uTaps[${N_TAPS}];  // xy=単位円盤上の位置, z=周辺減光ウェイト
uniform mat2 uSunM;             // 単位円盤 → 上層の地面オフセット [m]（楕円・伸長込み）
uniform float uHRatio;          // 下層オフセット比
${NOISE_GLSL}
${CAMERA_GLSL}

void main() {
  vec2 p = groundAt(vUV);
  // 画素ごとに円盤を回転 → 渦巻きバンディングをノイズ化
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  float cr = cos(rot), sr = sin(rot);

  float E = 0., W = 0.;
  for (int i = 0; i < ${N_TAPS}; i++) {
    vec3 tp = uTaps[i];
    vec2 d = vec2(tp.x * cr - tp.y * sr, tp.x * sr + tp.y * cr);
    vec2 oA = uSunM * d;                       // この太陽内方向の上層レバーアーム
    float T = texture(uCanopy, projGround(p + oA)).r
            * texture(uCanopy, projGround(p + oA * uHRatio)).g;
    E += tp.z * T;
    W += tp.z;
  }
  oE = vec4(E / W, 0., 0., 1.);
}`;

// ── pass3: 地面の合成 ─────────────────────────────────────────────────────────
const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 oC;
uniform sampler2D uIrr;
uniform float uExpand;     // オフスクリーン視野 / 表示視野
uniform float uTime;
uniform vec3  uSunCol, uSkyCol;
uniform float uExposure;
${NOISE_GLSL}
${CAMERA_GLSL}

float fbm2s(vec2 p) {
  return .5 * vn2(p) + .25 * vn2(p * 2.13 + 5.2) + .125 * vn2(p * 4.41 + 9.1);
}

// プロシージャルなアスファルト アルベド
vec3 asphalt(vec2 p, float fp) {
  float mot  = fbm2s(p * .45);                  // 広域のむら（補修・汚れ）
  float med  = vn2(p * 22.);                    // 2〜6cm の濃淡
  float grain = hash12(floor(p * 720.));        // 骨材の粒 ~1.4mm
  float fadeG = 1. - smoothstep(.0012, .005, fp);
  float fadeC = 1. - smoothstep(.006, .03, fp);
  // 明るい砕石チップ
  vec2 cp = p * 55.;
  vec2 ci = floor(cp);
  vec2 co = hash22(ci);
  float chipR = .12 + .3 * co.y;
  float chip = hash12(ci + 3.3) > .86
    ? 1. - smoothstep(chipR * .6, chipR, length(fract(cp) - (.25 + .5 * co)))
    : 0.;
  float v = .49
          + (mot - .47) * .22
          + (med - .5) * .10
          + chip * .19 * fadeC
          + (grain - .5) * (.28 * fadeG + .04);
  vec3 tint = mix(vec3(1.035, 1.0, .955), vec3(.975, .99, 1.015), fbm2s(p * .23 + 31.));
  return clamp(v, 0., 1.) * tint;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.);
}

void main() {
  vec2 p = groundAt(vUV);
  float fp = max(length(dFdx(p)), length(dFdy(p)));
  vec2 n = vUV * 2. - 1.;
  vec2 uvI = (n / uExpand) * .5 + .5;

  // 遠景は軽くLODを上げて光学的なぼけ・圧縮感を出す
  float dist0 = length(vec3(p.x, 0., p.y) - uCamPos);
  float flod = 2.0 * smoothstep(4., 12., dist0);
  float E    = textureLod(uIrr, uvI, flod).r;   // 直達光の照度 0..1
  float open = textureLod(uIrr, uvI, 5.).r;     // 空の見え方（広域平均）→ 環境光
  float blm  = textureLod(uIrr, uvI, 3.5).r;    // ハレーション用のぼかし

  vec3 alb = asphalt(p, fp);
  // ペナンブラ（半影）をわずかに暖色へ — 太陽縁の減光と大気散乱の写真的フリンジ
  vec3 warm = mix(vec3(1.05, .97, .86), vec3(1.), smoothstep(.12, .7, E));
  vec3 col = alb * (uSunCol * (E * 1.08 + .02) * warm + uSkyCol * (.24 + .15 * open));
  col += uSunCol * pow(blm, 2.2) * .12;         // ささやかなブルーム

  // 砕石のきらめき（日なたのみ）
  float gh = hash12(floor(p * 260.) + 17.);
  col += uSunCol * smoothstep(.992, 1., gh) * E * 1.2 * (1. - smoothstep(.002, .006, fp));

  col = aces(col * uExposure);
  col = pow(col, vec3(1. / 2.2));

  // 遠景の空気感（わずかに霞ませてコントラストを下げる）
  col = mix(col, vec3(.56, .565, .575), .13 * smoothstep(5., 12., dist0));

  // フィルムグレイン + 周縁減光
  float gn = hash13(vec3(gl_FragCoord.xy, mod(uTime * 60., 256.)));
  col *= .985 + .03 * gn;
  float r = length((vUV - .5) * vec2(1., 1.15));
  col *= 1. - .16 * smoothstep(.42, .85, r);

  oC = vec4(col, 1.);
}`;

// ── コンパイル・FBO ヘルパ ────────────────────────────────────────────────────
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
  }
  return s;
}
function program(fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { prog: p, u };
}

const passCanopy = program(CANOPY_FS);
const passIrr    = program(IRR_FS);
const passScreen = program(SCREEN_FS);

function makeTarget(w, h, internal, format, mips) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

let rtCanopy = null, rtIrr = null;
let simScale = 0.66;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  canvas.width  = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width  = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  const scale = Math.min(simScale, MAX_SIM_W / canvas.width);
  const sw = Math.max(2, Math.round(canvas.width * scale));
  const sh = Math.max(2, Math.round(canvas.height * scale));
  if (rtCanopy) { gl.deleteTexture(rtCanopy.tex); gl.deleteFramebuffer(rtCanopy.fbo); }
  if (rtIrr)    { gl.deleteTexture(rtIrr.tex);    gl.deleteFramebuffer(rtIrr.fbo); }
  rtCanopy = makeTarget(sw, sh, gl.RG8, gl.RG, false);
  rtIrr    = makeTarget(sw, sh, gl.R8,  gl.RED, true);
}
window.addEventListener('resize', resize, { passive: true });
resize();

// ── CPU側: 1Dノイズ（突風・手持ちカメラ揺れ）─────────────────────────────────
function noise1(seed) {
  const h = i => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return t => {
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  };
}
const nGust1 = noise1(1), nGust2 = noise1(2);
const nWobP = noise1(3), nWobY = noise1(4), nWobR = noise1(5), nWobX = noise1(6);

// ── カメラ ───────────────────────────────────────────────────────────────────
const cam = { pos: [0, CAM_H, 0], R: [1, 0, 0], U: [0, 0, 0], F: [0, 0, 0], tanHalf: [0, 0] };

function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm(a) { const l = Math.hypot(...a); return [a[0]/l, a[1]/l, a[2]/l]; }

function updateCamera(t) {
  const wob = reducedMotion ? 0 : 1;
  const pitch = CAM_PITCH + (nWobP(t * .21) - .5) * .012 * wob;
  const yaw   =             (nWobY(t * .17) - .5) * .010 * wob;
  const roll  =             (nWobR(t * .13) - .5) * .008 * wob;
  cam.pos = [(nWobX(t * .19) - .5) * .012 * wob, CAM_H + (nWobP(t * .27) - .5) * .010 * wob, 0];

  const F = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  let R = norm(cross([0, 1, 0], F));
  let U = cross(F, R);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const R2 = [R[0]*cr + U[0]*sr, R[1]*cr + U[1]*sr, R[2]*cr + U[2]*sr];
  const U2 = [U[0]*cr - R[0]*sr, U[1]*cr - R[1]*sr, U[2]*cr - R[2]*sr];
  cam.R = R2; cam.U = U2; cam.F = F;
  const tanY = Math.tan(FOV_Y / 2);
  cam.tanHalf = [tanY * (canvas.width / canvas.height), tanY];
}

function setCameraUniforms(u, expand) {
  gl.uniform3fv(u.uCamPos, cam.pos);
  gl.uniform3fv(u.uCamR, cam.R);
  gl.uniform3fv(u.uCamU, cam.U);
  gl.uniform3fv(u.uCamF, cam.F);
  gl.uniform2f(u.uTanHalf, cam.tanHalf[0] * expand, cam.tanHalf[1] * expand);
}

// ── 太陽 ─────────────────────────────────────────────────────────────────────
const SUN_AZIM = 145 * RAD;   // 方位（楕円の長軸方向を決める）
const WIND_DIR = norm([0.8, 0, 0.6]);

// 太陽円盤(単位円) → 上層樹冠の地面オフセット行列 [m]。数値ヤコビアンで厳密に。
function sunMatrix(elevDeg, hA) {
  const e = elevDeg * RAD, a = SUN_AZIM;
  const S = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
  const B1 = norm(cross(S, [0, 1, 0]));
  const B2 = cross(B1, S);
  const f = (tx, ty) => {
    const w = norm([S[0] + tx*B1[0] + ty*B2[0], S[1] + tx*B1[1] + ty*B2[1], S[2] + tx*B1[2] + ty*B2[2]]);
    return [w[0] / w[1], w[2] / w[1]];
  };
  const eps = 1e-4, k = SUN_HALF_ANGLE * hA / (2 * eps);
  const p1 = f(eps, 0), m1 = f(-eps, 0), p2 = f(0, eps), m2 = f(0, -eps);
  // 列優先 mat2: [c0x, c0y, c1x, c1y]
  return [(p1[0]-m1[0])*k, (p1[1]-m1[1])*k, (p2[0]-m2[0])*k, (p2[1]-m2[1])*k];
}

// Vogel円盤 + 太陽の周辺減光（リム・ダークニング）
const taps = new Float32Array(N_TAPS * 3);
for (let i = 0; i < N_TAPS; i++) {
  const r = Math.sqrt((i + 0.5) / N_TAPS);
  const a = i * 2.399963229728653;
  taps[i*3]   = r * Math.cos(a);
  taps[i*3+1] = r * Math.sin(a);
  taps[i*3+2] = 1 - 0.56 * (1 - Math.sqrt(Math.max(0, 1 - r * r)));
}

// 太陽高度 → 直達光の色（低いほど暖色。正午でもわずかにクリーム色）
function sunColor(elevDeg) {
  const t = clamp((elevDeg - 20) / 60, 0, 1);
  return [1.05, 0.96 + 0.045 * t, 0.80 + 0.115 * t];
}

// ── UI ───────────────────────────────────────────────────────────────────────
function bind(id, key, fmt, scale) {
  const el = document.getElementById(id);
  const vl = document.getElementById(id + 'V');
  if (!el) return;
  const apply = () => {
    P[key] = parseFloat(el.value) * scale;
    vl.textContent = fmt(el.value);
  };
  el.addEventListener('input', apply);
  apply();
}
bind('uWind',   'wind',   v => v,        0.01);
bind('uHeight', 'height', v => v + 'm',  1);
bind('uCover',  'cover',  v => v,        0.01);
bind('uElev',   'elev',   v => v + '°',  1);

// ── フレームループ ────────────────────────────────────────────────────────────
let tAccum = 137.0;       // 見栄えのよい初期位相
let prevMs = 0;
let fpsSamples = [], perfChecked = false;

// デバッグ/検証用フック（動きの確認のために時間を正確に進める・ベンチマーク）
window.__komorebi = {
  advance: s => { tAccum += s; },
  set: (k, v) => { P[k] = v; },
  time: () => tAccum,
  bench: n => {
    const t0 = performance.now();
    for (let i = 0; i < (n || 60); i++) { tAccum += 1 / 60; render(tAccum); }
    gl.finish();
    return (performance.now() - t0) / (n || 60);
  },
};

function frame(ms) {
  requestAnimationFrame(frame);
  const dt = clamp((ms - prevMs) * 0.001, 0, 0.05);
  prevMs = ms;
  if (!reducedMotion) tAccum += dt;   // reduced-motion 環境では静止画

  // 自動パフォーマンス調整: 最初の数秒で重ければシミュレーション解像度を下げる
  if (!perfChecked && dt > 0) {
    fpsSamples.push(dt);
    if (fpsSamples.length === 90) {
      const avg = fpsSamples.reduce((a, b) => a + b) / fpsSamples.length;
      if (avg > 0.024 && simScale > 0.5) { simScale = 0.5; resize(); }
      perfChecked = true;
    }
  }

  render(tAccum);
}

function render(t) {
  updateCamera(t);

  // 突風エンベロープ（多重時間スケール）
  const env = 0.6 * nGust1(t * 0.10) + 0.4 * nGust2(t * 0.31);
  const gust = (reducedMotion ? 0 : P.wind) * (0.30 + 0.95 * env);

  // pass1: canopy
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtCanopy.fbo);
  gl.viewport(0, 0, rtCanopy.w, rtCanopy.h);
  gl.useProgram(passCanopy.prog);
  setCameraUniforms(passCanopy.u, EXPAND);
  gl.uniform1f(passCanopy.u.uTime, t);
  gl.uniform2f(passCanopy.u.uWindDir, WIND_DIR[0], WIND_DIR[2]);
  gl.uniform1f(passCanopy.u.uGust, gust);
  gl.uniform1f(passCanopy.u.uCover, P.cover);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // pass2: irradiance
  gl.bindFramebuffer(gl.FRAMEBUFFER, rtIrr.fbo);
  gl.viewport(0, 0, rtIrr.w, rtIrr.h);
  gl.useProgram(passIrr.prog);
  setCameraUniforms(passIrr.u, EXPAND);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, rtCanopy.tex);
  gl.uniform1i(passIrr.u.uCanopy, 0);
  gl.uniform3fv(passIrr.u.uTaps, taps);
  gl.uniformMatrix2fv(passIrr.u.uSunM, false, sunMatrix(P.elev, P.height));
  gl.uniform1f(passIrr.u.uHRatio, H_RATIO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // mips（環境光・ブルーム用）
  gl.bindTexture(gl.TEXTURE_2D, rtIrr.tex);
  gl.generateMipmap(gl.TEXTURE_2D);

  // pass3: screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(passScreen.prog);
  setCameraUniforms(passScreen.u, 1.0);
  gl.bindTexture(gl.TEXTURE_2D, rtIrr.tex);
  gl.uniform1i(passScreen.u.uIrr, 0);
  gl.uniform1f(passScreen.u.uExpand, EXPAND);
  gl.uniform1f(passScreen.u.uTime, t);
  const sc = sunColor(P.elev);
  gl.uniform3f(passScreen.u.uSunCol, sc[0], sc[1], sc[2]);
  gl.uniform3f(passScreen.u.uSkyCol, 0.62, 0.635, 0.67);
  gl.uniform1f(passScreen.u.uExposure, 1.18);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
requestAnimationFrame(frame);
