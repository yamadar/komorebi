'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  木漏れ日  Komorebi — physically-inspired, artistically amplified dappled light
//
//  物理モデル(docs/komorebi-research.md)を骨格に保ちつつ、視覚的に増幅する。
//  リアルなSonnentalerは小さく地味なので、以下の階層で「木漏れ日らしさ」を作る:
//
//    0. 明るい林床           — 黒ではなく陽の差す地面（暖色 + 苔の緑斑）
//    1. 大きな光のプール       — 大きな葉の隙間を抜けた光だまり（加算 lighter）
//    2. Sonnentaler 楕円      — ピンホール太陽像。r_l = r_s/sin(θ) で仰角に伴い伸長
//    3. キャノピー影(乗算)     — 葉群が光と地面を暗く彫り、隙間=明部のダップルを作る
//    4. 葉シルエット(乗算)     — 近景のシャープな葉影（pinspeck）
//    5. ブルーム             — 光層を縮小ぼかし加算し、にじむ陽光感
//    6. 大気の緑被り + ビネット
//
//  ref: Minnaert "Light & Color in the Outdoors", Kepler light-figures,
//       Soler & Sillion "Fast Calculation of Soft Shadow Textures" (1998)
// ─────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const rn  = (a, b) => a + Math.random() * (b - a);
const lrp = (a, b, t) => a + (b - a) * t;
const clp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── Canvas ──────────────────────────────────────────────────────────────────
const cv = document.getElementById('c');
const cx = cv.getContext('2d');
let W, H, DPR, M;            // M = min(W,H)

// ── Runtime parameters (sliders) ──────────────────────────────────────────────
const P = { elev: 38, dens: 55, wind: 40 };

// Derived solar geometry
let HA, EL, DIR;
function recalcSolar() {
  HA  = 0.00465;                              // solar disk half-angle (0.53°/2)
  EL  = 1 / Math.sin(P.elev * Math.PI / 180); // elongation = 1/sin(θ)
  DIR = Math.PI * 0.14;                        // long-axis screen angle (~25°)
}
recalcSolar();

// ── Offscreen layers ──────────────────────────────────────────────────────────
const bgCv = document.createElement('canvas'), bgCx = bgCv.getContext('2d'); // static floor
const ltCv = document.createElement('canvas'), ltCx = ltCv.getContext('2d'); // emissive light

// Fine grain texture — breaks the smooth gradient so the floor reads as a surface
const nzCv = document.createElement('canvas'); nzCv.width = nzCv.height = 220;
const nzCx = nzCv.getContext('2d');
(function buildNoise() {
  const img = nzCx.createImageData(220, 220);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + Math.random() * 105;
    img.data[i] = img.data[i+1] = img.data[i+2] = v;
    img.data[i+3] = 255;
  }
  nzCx.putImageData(img, 0, 0);
})();

// ── Forest floor background ────────────────────────────────────────────────────
function buildBG() {
  bgCx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgCx.clearRect(0, 0, W, H);

  // Sunlit earth base — clearly NOT black
  bgCx.fillStyle = '#342817';
  bgCx.fillRect(0, 0, W, H);

  // Broad warm ambient (light spills from the sun direction, upper-left)
  const wa = bgCx.createRadialGradient(W*.38, H*.30, 0, W*.38, H*.30, Math.max(W,H)*1.0);
  wa.addColorStop(0,  'rgba(150,114,62,.46)');
  wa.addColorStop(.45,'rgba(96,72,38,.20)');
  wa.addColorStop(1,  'rgba(0,0,0,0)');
  bgCx.fillStyle = wa;
  bgCx.fillRect(0, 0, W, H);

  // Humus + moss colour patches (warm browns, a few mossy greens)
  const patches = [
    [.18,.30,.42,'rgba(104,78,42,.30)'], [.66,.58,.34,'rgba(118,90,48,.26)'],
    [.45,.78,.38,'rgba(74,92,42,.22)'],  [.83,.26,.30,'rgba(126,96,52,.24)'],
    [.10,.72,.44,'rgba(62,80,38,.20)'],  [.52,.45,.26,'rgba(138,106,58,.24)'],
    [.34,.60,.30,'rgba(90,70,40,.22)'],  [.78,.84,.40,'rgba(78,94,44,.20)'],
    [.92,.62,.30,'rgba(70,86,40,.18)'],  [.26,.14,.28,'rgba(120,92,50,.20)'],
  ];
  for (const [px, py, pr, col] of patches) {
    const g = bgCx.createRadialGradient(px*W, py*H, 0, px*W, py*H, pr*M);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    bgCx.fillStyle = g;
    bgCx.fillRect(0, 0, W, H);
  }

  // Fine earthy grain (subtle, via overlay)
  const pat = bgCx.createPattern(nzCv, 'repeat');
  bgCx.save();
  bgCx.globalAlpha = .045;
  bgCx.globalCompositeOperation = 'overlay';
  bgCx.fillStyle = pat;
  bgCx.fillRect(0, 0, W, H);
  bgCx.restore();

  // Gentle vignette — settle the edges without crushing to black
  const gv = bgCx.createRadialGradient(W*.5, H*.48, M*.20, W*.5, H*.48, Math.max(W,H)*.76);
  gv.addColorStop(0, 'rgba(0,0,0,0)');
  gv.addColorStop(1, 'rgba(0,0,0,.50)');
  bgCx.fillStyle = gv;
  bgCx.fillRect(0, 0, W, H);
}

// ── Large light pool — sun through a wide canopy gap (additive) ────────────────
class Pool {
  constructor(cfg) { this.cfg = cfg || {}; this._new(); this.life = rn(0, this.dur); }
  _new() {
    const c = this.cfg;
    this.x   = rn(0, W);
    this.y   = rn(0, H);
    this.r   = rn(M*.07, M*.23) * (c.rScale  || 1);
    this.aB  = rn(.10, .20)     * (c.aScale  || 1);
    this.dur = rn(16, 48);
    this.fi  = rn(2.5, 6);
    this.fo  = rn(2.5, 6);
    this.ph  = rn(0, TAU);
    this.fq  = rn(.03, .09)     * (c.fqScale || 1);
    this.sw  = rn(8, 28)        * (c.swScale || 1);
    this.life = 0;
  }
  _env() {
    if (this.life < this.fi)            return clp(this.life / this.fi, 0, 1);
    if (this.life > this.dur - this.fo) return clp((this.dur - this.life) / this.fo, 0, 1);
    return 1;
  }
  draw(ts, dt, wnd) {
    this.life += dt;
    if (this.life >= this.dur) { this._new(); return; }
    const a = this.aB * this._env();
    if (a < .004) return;
    const px = this.x + Math.sin(ts * this.fq + this.ph) * this.sw * wnd;
    const py = this.y + Math.cos(ts * this.fq * .8 + this.ph) * this.sw * .6 * wnd;

    ltCx.save();
    ltCx.translate(px, py);
    ltCx.rotate(DIR);
    ltCx.scale(EL, 1);                         // elongate along sun direction
    const g = ltCx.createRadialGradient(0, 0, 0, 0, 0, this.r);
    g.addColorStop(.00, `rgba(255,241,201,${a.toFixed(3)})`);
    g.addColorStop(.42, `rgba(255,213,136,${(a*.5).toFixed(3)})`);
    g.addColorStop(.75, `rgba(250,182,94,${(a*.14).toFixed(3)})`);
    g.addColorStop(1.0, 'rgba(255,170,80,0)');
    ltCx.fillStyle = g;
    ltCx.beginPath();
    ltCx.arc(0, 0, this.r, 0, TAU);
    ltCx.fill();
    ltCx.restore();
  }
}

// ── Sonnentaler — pinhole sun-image ellipse (additive) ────────────────────────
class Spot {
  constructor() { this._new(); this.life = rn(0, this.dur); }
  _new() {
    this.x   = rn(-M*.10, W + M*.10);
    this.y   = rn(-M*.10, H + M*.10);
    this.d   = rn(M*.12, M*.92);                       // canopy distance
    this.sz  = lrp(.7, 3.4, Math.pow(Math.random(), 2.2)); // skewed: many small, few big
    this.aB  = rn(.62, 1.15);
    this.aM  = rn(.12, .34);                           // shimmer depth
    this.aF  = rn(.08, .30);
    this.aP  = rn(0, TAU);
    this.ph  = rn(0, TAU);
    this.fq  = rn(.10, .30);
    const q  = 120 / this.d;
    this.swX = rn(3, 16) * q;
    this.swY = rn(1.5, 8) * q;
    this.dur = rn(9, 40);
    this.fi  = rn(.5, 3);
    this.fo  = rn(.5, 3);
    this.life = 0;
  }
  _env() {
    if (this.life < this.fi)            return clp(this.life / this.fi, 0, 1);
    if (this.life > this.dur - this.fo) return clp((this.dur - this.life) / this.fo, 0, 1);
    return 1;
  }
  draw(ts, dt, wnd) {
    this.life += dt;
    if (this.life >= this.dur) { this._new(); return; }
    const rs = Math.max(3, this.d * HA * 2) * 1.5 * this.sz; // short radius (× artistic gain)
    const rl = rs * EL;                                       // long radius = rs / sin(θ)
    const a  = this.aB * this._env()
             * (1 - this.aM * (.5 + .5 * Math.sin(ts * this.aF + this.aP)));
    if (a < .008) return;
    const px = this.x + Math.sin(ts * this.fq + this.ph) * this.swX * wnd;
    const py = this.y + Math.cos(ts * this.fq * .72 + this.ph + 1.2) * this.swY * wnd;

    ltCx.save();
    ltCx.translate(px, py);
    ltCx.rotate(DIR);
    ltCx.scale(rl, rs);
    const g = ltCx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(.00, `rgba(255,253,238,${a.toFixed(3)})`);
    g.addColorStop(.26, `rgba(255,238,176,${(a*.74).toFixed(3)})`);
    g.addColorStop(.58, `rgba(255,210,108,${(a*.26).toFixed(3)})`);
    g.addColorStop(1.0, 'rgba(255,190,70,0)');
    ltCx.fillStyle = g;
    ltCx.beginPath();
    ltCx.arc(0, 0, 1, 0, TAU);
    ltCx.fill();
    ltCx.restore();
  }
}

// ── Canopy shadow blob — carves the macro dapple (multiply on main) ────────────
class Shadow {
  constructor() { this._new(); }
  _new() {
    this.x   = rn(-M*.15, W + M*.15);
    this.y   = rn(-M*.15, H + M*.15);
    this.r   = rn(M*.12, M*.38);
    this.asp = rn(.55, 1.6);     // aspect → organic, not perfect circles
    this.an  = rn(0, TAU);
    this.a   = rn(.16, .40);
    this.ph  = rn(0, TAU);
    this.fq  = rn(.03, .10);
    this.sw  = rn(10, 42);
  }
  draw(ts, wnd) {
    const px = this.x + Math.sin(ts * this.fq + this.ph) * this.sw * wnd;
    const py = this.y + Math.cos(ts * this.fq * .83 + this.ph) * this.sw * .7 * wnd;
    cx.save();
    cx.globalCompositeOperation = 'multiply';
    cx.translate(px, py);
    cx.rotate(this.an);
    cx.scale(this.asp, 1);
    const g = cx.createRadialGradient(0, 0, 0, 0, 0, this.r);
    g.addColorStop(.00, `rgba(18,22,12,${this.a.toFixed(3)})`);
    g.addColorStop(.55, `rgba(22,27,15,${(this.a*.55).toFixed(3)})`);
    g.addColorStop(1.0, 'rgba(22,27,15,0)');
    cx.fillStyle = g;
    cx.beginPath();
    cx.arc(0, 0, this.r, 0, TAU);
    cx.fill();
    cx.restore();
  }
}

// ── Leaf silhouette paths ─────────────────────────────────────────────────────
function pOval(c, s) {           // beech / cherry
  const w = s * .43;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo( s*.56, -w,   -s*.56, -w,  -s, 0);
  c.bezierCurveTo(-s*.56,  w,    s*.56,  w,   s, 0);
}
function pLance(c, s) {          // willow / bamboo
  const w = s * .26;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.50, -w,  -s*.50, -w*.76, -s, 0);
  c.bezierCurveTo(-s*.50, w*.76, s*.50, w,      s, 0);
}
function pBroad(c, s) {          // oak / magnolia (wide, concave base)
  const w = s * .58;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo( s*.62, -w*.88,  -s*.10, -w,    -s*.72, -w*.34);
  c.bezierCurveTo(-s*.96, -w*.10,  -s*.96,  w*.10, -s*.72,  w*.34);
  c.bezierCurveTo(-s*.10,  w,       s*.62,  w*.88,  s,      0);
}
function pMaple(c, s) {          // simple lobed maple
  const w = s * .50;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.70, -w*.40, s*.20, -w*.80,  0,       -w);
  c.bezierCurveTo(-s*.20,-w*.80,-s*.50, -w*.55, -s*.80, -w*.10);
  c.bezierCurveTo(-s*.90,-w*.05,-s*.90,  w*.05, -s*.80,  w*.10);
  c.bezierCurveTo(-s*.50, w*.55,-s*.20,  w*.80,  0,        w);
  c.bezierCurveTo(s*.20,  w*.80, s*.70,  w*.40,  s,        0);
}
const LFNS = [pOval, pLance, pBroad, pMaple];

// ── Soft leaf-cluster shadow — organic canopy dapple (pinspeck, multiply) ──────
//  数枚の葉を束ねた塊として描く。常にぼかして penumbra にし、切り絵感を避ける。
class Leaf {
  constructor() { this._init(); }
  _init() {
    this.s   = rn(M*.035, M*.095);           // single-leaflet scale
    this.bl  = rn(4, 16);                     // always soft → penumbra
    this.al  = rn(.14, .34);
    this.x   = rn(-M*.14, W + M*.14);
    this.y   = rn(-M*.14, H + M*.14);
    this.an  = rn(0, TAU);
    this.ph  = rn(0, TAU);
    this.fq  = rn(.08, .22);
    this.sw  = rn(10, 38);
    this.ra  = rn(.03, .12);
    // a little sprig of 3–6 leaflets so it reads as foliage, not a lone lens
    this.cl  = [];
    const n  = Math.floor(rn(3, 7));
    for (let i = 0; i < n; i++) {
      this.cl.push({
        dx: rn(-this.s*1.4, this.s*1.4),
        dy: rn(-this.s*1.1, this.s*1.1),
        da: rn(0, TAU),
        ds: rn(.5, 1.05),
        tp: Math.floor(rn(0, 4)),
      });
    }
  }
  draw(ts, wnd) {
    const px = this.x + Math.sin(ts * this.fq + this.ph) * this.sw * wnd;
    const py = this.y + Math.cos(ts * this.fq * .75 + this.ph + .9) * this.sw * .5 * wnd;
    const an = this.an + Math.sin(ts * this.fq * 1.1 + this.ph) * this.ra * wnd;
    cx.save();
    cx.globalCompositeOperation = 'multiply';
    cx.globalAlpha = this.al;
    cx.filter = `blur(${this.bl.toFixed(1)}px)`;
    cx.translate(px, py);
    cx.rotate(an);
    cx.fillStyle = '#12190d';
    for (const lf of this.cl) {
      cx.save();
      cx.translate(lf.dx, lf.dy);
      cx.rotate(lf.da);
      LFNS[lf.tp](cx, this.s * lf.ds);
      cx.fill();
      cx.restore();
    }
    cx.restore();
  }
}

// ── Scene ──────────────────────────────────────────────────────────────────────
//  「光のプール」は3つの独立レイヤー(1a/1b/1c)に複製。スケール・密度・揺れ速度が
//  異なるので別々の模様になり、重ねると多層的な光だまりになる。個別にトグル可能。
const POOL_LAYERS = [
  { key: 'L1a', cfg: { rScale: 1.7, aScale: .65, swScale: .55, fqScale: .65 }, base: [6, 12]  }, // 奥・大・ゆったり
  { key: 'L1b', cfg: { rScale: 1.0, aScale: .85, swScale: 1.0, fqScale: 1.0 }, base: [12, 22] }, // 中
  { key: 'L1c', cfg: { rScale: .50, aScale: 1.0, swScale: 1.5, fqScale: 1.4 }, base: [18, 32] }, // 手前・小・活発
];

let spots = [], shadows = [], leaves = [];
let poolLayers = POOL_LAYERS.map(() => []);   // POOL_LAYERS と並びが対応する Pool 配列

function buildPools() {
  const sc = clp(Math.sqrt(W * H / (1920 * 1080)), .35, 2.0);
  const df = clp(P.dens / 55, .4, 2.0);
  poolLayers = POOL_LAYERS.map(pl =>
    Array.from({ length: Math.round(lrp(pl.base[0], pl.base[1], sc) * df) }, () => new Pool(pl.cfg)));
}

function init() {
  buildBG();
  const sc = clp(Math.sqrt(W * H / (1920 * 1080)), .35, 2.0);
  const df = clp(P.dens / 55, .4, 2.0);
  buildPools();
  spots   = Array.from({ length: Math.round(lrp(60, 120, sc) * df) }, () => new Spot());
  shadows = Array.from({ length: Math.round(lrp(10, 18, sc)) },      () => new Shadow());
  leaves  = Array.from({ length: Math.round(lrp(10, 18, sc)) },      () => new Leaf());
}

// ── Resize ─────────────────────────────────────────────────────────────────────
function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  M = Math.min(W, H);
  for (const c of [cv, bgCv, ltCv]) { c.width = W * DPR; c.height = H * DPR; }
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  init();
}
window.addEventListener('resize', resize, { passive: true });

// ── Sliders ─────────────────────────────────────────────────────────────────────
function bindSlider(id, valId, key, onChange) {
  const el = document.getElementById(id);
  const vl = document.getElementById(valId);
  el.addEventListener('input', () => {
    P[key] = parseFloat(el.value);
    vl.textContent = el.value + (key === 'elev' ? '°' : '');
    if (onChange) onChange();
  });
}
bindSlider('sElev', 'sElevV', 'elev', () => recalcSolar());
bindSlider('sDens', 'sDensV', 'dens', () => {
  const sc = clp(Math.sqrt(W * H / (1920 * 1080)), .35, 2.0);
  const df = clp(P.dens / 55, .4, 2.0);
  spots = Array.from({ length: Math.round(lrp(60, 120, sc) * df) }, () => new Spot());
  buildPools();
});
bindSlider('sWind', 'sWindV', 'wind');

// ── Layer toggles ─────────────────────────────────────────────────────────────
//  L は各チェックボックス(id)の実状態から初期化する（ブラウザのフォーム復元と常に一致）
const L = {};
for (const el of document.querySelectorAll('#params input[type=checkbox]')) {
  L[el.id] = el.checked;
  el.addEventListener('change', () => { L[el.id] = el.checked; });
}

// ── Frame loop ─────────────────────────────────────────────────────────────────
let pT = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt  = clp((t - pT) * .001, 0, .05);
  pT = t;
  const ts  = t * .001;
  const wnd = P.wind / 50;

  // Always clear first, so toggling the floor (layer 0) off doesn't smear frames
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx.globalCompositeOperation = 'source-over';
  cx.globalAlpha = 1;
  cx.filter = 'none';
  cx.clearRect(0, 0, W, H);

  // 0. Forest floor (+ vignette)
  if (L.L0) cx.drawImage(bgCv, 0, 0, W, H);

  // 1+2. Emissive light layer (pools + sonnentaler) onto offscreen, additive
  ltCx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ltCx.globalCompositeOperation = 'source-over';
  ltCx.clearRect(0, 0, W, H);
  ltCx.globalCompositeOperation = 'lighter';
  // 1. light pools — 3 overlaid layers (1a/1b/1c), each its own pattern
  for (let i = 0; i < POOL_LAYERS.length; i++) {
    if (L[POOL_LAYERS[i].key]) for (const p of poolLayers[i]) p.draw(ts, dt, wnd);
  }
  if (L.L2) for (const s of spots) s.draw(ts, dt, wnd);   // 2. sonnentaler ellipses

  // composite light onto floor (additive); empty if all light layers are off
  cx.globalCompositeOperation = 'lighter';
  cx.drawImage(ltCv, 0, 0, W, H);

  // 5. Bloom — soft glow around bright light. Drawn BEFORE the shadows so the
  //    canopy/foliage occludes the glow too; otherwise only the bloom shines in
  //    shaded areas. Kept subtle so the crisp pools/spots stay dominant.
  if (L.L5) {
    cx.globalCompositeOperation = 'lighter';
    cx.globalAlpha = .28;
    cx.filter = 'blur(13px)';
    cx.drawImage(ltCv, 0, 0, W, H);
    cx.filter = 'none';
    cx.globalAlpha = 1;
  }

  // 3. Canopy shadow — multiply carves dapple into floor, light AND bloom
  if (L.L3) for (const sh of shadows) sh.draw(ts, wnd);
  // 4. Soft leaf-cluster shadows
  if (L.L4) for (const lf of leaves) lf.draw(ts, wnd);
  cx.filter = 'none';

  // 6. Atmospheric green veil (canopy-scattered ambient)
  if (L.L6) {
    cx.globalCompositeOperation = 'screen';
    cx.globalAlpha = .03;
    const ga = cx.createRadialGradient(W*.42, H*.30, 0, W*.42, H*.30, W*.8);
    ga.addColorStop(0, 'rgba(60,120,40,1)');
    ga.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = ga;
    cx.fillRect(0, 0, W, H);
  }

  // reset
  cx.globalCompositeOperation = 'source-over';
  cx.globalAlpha = 1;
}

resize();
requestAnimationFrame(frame);
