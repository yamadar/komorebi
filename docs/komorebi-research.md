# 木漏れ日 物理モデル & 実装リファレンス

## 1. 現象の分類

木漏れ日の視覚要素は2種類に分けられる。

| 要素 | 物理機構 | 条件 |
|---|---|---|
| **楕円光斑**（明るい点） | Sonnentaler — ピンホールカメラで太陽を結像 | 開口サイズ `a ≪ s` |
| **葉形暗影**（黒い形） | Pinspeck — 葉自体が結像素子 | 開口サイズ `a ≫ s` |
| **ぼけた中間** | 両者の畳み込み | 開口サイズ `a ≈ s` |

遷移の臨界スケール:

```
s = d · tan(α)
```

- `d` = 開口（葉の隙間）〜投影面（地面）距離
- `α` = 太陽の視直径 0.53°（半角 `α/2 = 0.00465 rad`）
- `s` = 地面上の太陽像の直径

---

## 2. 楕円のジオメトリ

太陽は円盤だが、水平面への斜め投影で楕円になる。

```
短半径  r_s = d · tan(α_half) · 2  ≈  d · 0.00930
長半径  r_l = r_s / sin(θ)         = r_s · ELONG
```

- `θ` = 太陽仰角（solar elevation）
- `ELONG = 1 / sin(θ)`：仰角 38° → ELONG ≈ 1.62、仰角 20° → 2.92

楕円の長軸方向 = 太陽方位角の地面投影方向（太陽に向かう方向）

### 仰角別 ELONG 早見

| θ | sin θ | ELONG |
|---|---|---|
| 90°（真上） | 1.00 | 1.00（正円） |
| 60° | 0.87 | 1.15 |
| 45° | 0.71 | 1.41 |
| 38° | 0.62 | 1.62 |
| 30° | 0.50 | 2.00 |
| 20° | 0.34 | 2.92 |

---

## 3. ケプラーの「光図形」理論（統一モデル）

地面の照度分布 = 開口形状 ⊛ 光源形状（畳み込み）

```
I(x, y) = occluder_aperture(x, y)  ⊛  sun_disk(x, y)
```

- 開口が小さい（ピンホール）→ 結果 ≈ 太陽像（楕円）
- 開口が大きい → 結果 ≈ 開口形状（葉の隙間の形）
- 任意サイズ → 2Dガウスで近似可能（ソフトシャドウ）

### ペナンブラ幅の推定

```
penumbra_width ≈ a · (d_light_to_occluder / d_occluder_to_receiver)
```

`a` = 光源の見かけ上の幅 = `d · tan(0.53°)`

---

## 4. 一次資料・論文

| 資料 | 内容 | 用途 |
|---|---|---|
| Minnaert, *Light and Color in the Outdoors* | 木漏れ日の古典的記述。Sonnentaler という名称の出典 | 物理直観 |
| Kepler, 月の形の謎（1604/1610） | 光図形（light figures）一般理論。開口 ⊛ 光源 = 影像 | 統一モデルの源流 |
| Soler & Sillion, "Fast Calculation of Soft Shadow Textures Using Convolution", SIGGRAPH 1998 | 畳み込みによるソフトシャドウ計算。拘束配置では厳密解 | CG実装 |
| Atty et al., "Soft Shadow Maps", *Computer Graphics Forum* 25(4), 2006 | GPU上でのインタラクティブ・ソフトシャドウ。内外ペナンブラ両方計算 | リアルタイム実装 |
| Annen et al., "Convolution Shadow Maps", EGSR 2007 | 大規模シーンへの畳み込みシャドウ拡張 | 大規模シーン |
| Wyman & Hansen, "Penumbra Maps", EGSR 2003 | シルエットエッジからペナンブラ近似 | リアルタイム近似 |
| ResearchGate: "The leaves of a tree creates both pinhole images and pinspeck images of the sun" | ピンホール像（Sonnentaler）とピンスペック像の図解・実験 | 教育資料 |

---

## 5. Canvas 実装レシピ

### 5.1 楕円スポットの描画

```javascript
const HALF_ANG = 0.00465;            // rad: 太陽半角
const ELEVATION = 38 * Math.PI / 180;
const ELONG = 1 / Math.sin(ELEVATION); // ≈ 1.62
const SUN_DIR = Math.PI * 0.18;      // 長軸スクリーン角（調整可）

function drawSpot(cx, x, y, d, alpha) {
  const rs = Math.max(2.5, d * HALF_ANG * 2); // 短半径
  const rl = rs * ELONG;                        // 長半径

  cx.save();
  cx.globalCompositeOperation = 'lighter';  // 加算合成（物理的正確）
  cx.translate(x, y);
  cx.rotate(SUN_DIR);
  cx.scale(rl, rs);   // 単位円 → 正しい楕円

  // createRadialGradient も scale に追従して楕円になる
  const g = cx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0.00, `rgba(255,254,222,${alpha})`);
  g.addColorStop(0.38, `rgba(255,231,158,${alpha * 0.60})`);
  g.addColorStop(0.72, `rgba(255,210, 96,${alpha * 0.17})`);
  g.addColorStop(1.00, `rgba(255,192, 68,0)`);

  cx.fillStyle = g;
  cx.beginPath();
  cx.arc(0, 0, 1, 0, Math.PI * 2);
  cx.fill();
  cx.restore();
}
```

**ポイント:**
- `ctx.scale(rl, rs)` → 単位円が楕円になる
- `createRadialGradient` も同様にスケールされ、グラデーションも楕円になる
- `'lighter'` GCO で重なった領域が加算増光（物理的に正しい）
- `save/restore` 内で GCO を設定 → 自動リセット

### 5.2 葉影（ペナンブラ付き）の描画

```javascript
// nearness: 0=遠い葉, 1=近い葉
const blurRadius = lerp(11, 0.6, nearness);  // 遠=ソフト, 近=シャープ
const alpha      = lerp(0.18, 0.65, nearness);

function drawLeafShadow(cx, x, y, scale, angle, leafFn, blur, alpha) {
  cx.save();
  cx.globalAlpha = alpha;
  cx.filter = `blur(${blur}px)`;   // ペナンブラ近似（ソフトシャドウ）
  cx.translate(x, y);
  cx.rotate(angle);
  cx.fillStyle = '#020902';
  leafFn(cx, scale);
  cx.fill();
  cx.restore();   // filter も自動リセット
}
```

**ペナンブラのサイズ**: `blur ∝ aperture_size / sin(θ)`
近い葉 → 小さなぼけ（鋭いシルエット）
遠い葉 → 大きなぼけ（ほぼ消えかける）

### 5.3 描画順序

```
1. 背景（暗い土の色 + 環境光グラデーション）
2. 葉影（source-over, 暗い半透明 = 減光）
   → ctx.filter = 'none'  で明示的リセット
3. 楕円光斑（lighter = 加算増光）
4. 大気散乱オーバーレイ（screen, 非常に低 alpha の緑系）
```

### 5.4 ベジェ葉形パス（4種）

```javascript
// Oval — beech / cherry
function pOval(c, s) {
  const w = s * .43;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.56,-w, -s*.56,-w, -s,0);
  c.bezierCurveTo(-s*.56, w,  s*.56, w,  s,0);
}

// Lanceolate — willow / bamboo
function pLance(c, s) {
  const w = s * .26;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.50,-w, -s*.50,-w*.76, -s,0);
  c.bezierCurveTo(-s*.50,w*.76, s*.50,w, s,0);
}

// Broad — oak / magnolia（凹基部）
function pBroad(c, s) {
  const w = s * .58;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.62,-w*.88,  -s*.10,-w,     -s*.72,-w*.34);
  c.bezierCurveTo(-s*.96,-w*.10, -s*.96, w*.10,  -s*.72, w*.34);
  c.bezierCurveTo(-s*.10, w,      s*.62, w*.88,   s,     0);
}

// Maple — 浅い裂片
function pMaple(c, s) {
  const w = s * .50;
  c.beginPath();
  c.moveTo(s, 0);
  c.bezierCurveTo(s*.70,-w*.40, s*.20,-w*.80,  0,      -w);
  c.bezierCurveTo(-s*.20,-w*.80,-s*.50,-w*.55,-s*.80,-w*.10);
  c.bezierCurveTo(-s*.90,-w*.05,-s*.90, w*.05,-s*.80, w*.10);
  c.bezierCurveTo(-s*.50, w*.55,-s*.20, w*.80,  0,       w);
  c.bezierCurveTo( s*.20, w*.80, s*.70, w*.40,  s,       0);
}
```

---

## 6. アニメーション設計

### 6.1 スポットのライフサイクル（葉の開閉模倣）

```javascript
// フェードイン → 維持 → フェードアウト → 再配置
lifeAlpha(life, dur, fi, fo) {
  if (life < fi)       return life / fi;          // fade in
  if (life > dur - fo) return (dur - life) / fo;  // fade out
  return 1;
}
```

パラメータ例: `dur = 10〜40s`, `fi = fo = 0.4〜2.8s`

### 6.2 風による揺れ

```javascript
// 個別揺れ（各スポットが独立した位相・周波数）
const px = x + Math.sin(ts * freq + phase) * swayX;

// グローバル風（全体的なゆったり揺動を重畳）
const globalDrift = Math.sin(ts * 0.05) * windStrength;
const finalX = px + globalDrift;
```

個別揺れ周波数 0.10〜0.28 Hz（4〜10秒周期）
グローバル風 0.04〜0.05 Hz（20〜25秒周期）

### 6.3 見かけの揺れと奥行き

遠いスポット（大きい d）ほど揺れが小さく見える:

```javascript
const swayScale = 100 / d;
swayX = rand(3, 16) * swayScale;
```

---

## 7. 色・ライティング設計

### 太陽光スペクトル

| 光源状態 | 色温度 | RGB概算 |
|---|---|---|
| 正午の太陽光 | 5500〜6000K | `rgba(255,254,240,...)` |
| 午後の斜光 | 4000〜5000K | `rgba(255,240,200,...)` |
| 夕方 | 2500〜3500K | `rgba(255,210,130,...)` |

実装は午後想定: core=`(255,254,222)`, mid=`(255,231,158)`, edge=`(255,210,96)`

### 背景パレット

- 土の基本色: `#1c1208`（hsl 30, 55%, 8% 相当）
- 腐葉土パッチ: `hsla(H, S%, L%, .22)` で数個重ねる（H=20〜35, S=40〜58, L=8〜15）
- キャノピー散乱（環境光）: `rgba(14,42,7,.26)` の広いラジアルグラデーション
- ビネット: `rgba(0,0,0,.96)` で画面端を締める

---

## 8. パフォーマンスメモ

| 手法 | コスト | 備考 |
|---|---|---|
| `createRadialGradient` per spot | 中 | フレームごと生成。50〜80個で60fps維持 |
| `ctx.filter = 'blur()'` per leaf | GPU加速 | 20〜40個で問題なし |
| `save/restore` | 低 | GCO・filter の自動リセットに活用 |
| 背景を offscreen canvas に事前描画 | 高効率 | リサイズ時のみ再構築 |

大量スポットが必要な場合: 全スポットを offscreen canvas に描画 → main に `screen` で一括合成。

---

## 9. 拡張アイデア

- **太陽移動**: `ELEVATION` と `SUN_DIR` を時間で変化させる → 朝〜夕の光変化
- **スペクトル分散**: スポット端に微小な虹色（chromatic aberration 的）→ `rgba(200,240,255,...)` を最外周に
- **水面反射**: 別レイヤーに歪んだ光紋（波紋による反射）→ sinノイズで歪み
- **光柱（ゴッドレイ）**: 上方から細い放射状グラデーション + screen合成
- **雨後の散乱**: globalAlpha 全体を下げ、青みを強化
