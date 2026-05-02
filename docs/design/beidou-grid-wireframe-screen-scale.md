# 北斗格网线框「屏幕密纹」问题与按屏幕尺度弱化方案

## 1. 问题是什么

### 1.1 现象

在格网密度较高（`dx`、`dy` 较小或范围较大）时，三维视图中**线框在屏幕上占比过大**：相邻格子的边在像素层面连成一片，**半透明体填充的视觉层次被压扁**，用户难以感知单个格元的体积与前后关系，整体像「糊在屏幕上的网格」，空间感差。

### 1.2 原因（与当前实现相关）

大规模格网使用 `frontend/src/Rendering/BeiDouGridPrimitive.js`：**单盒几何 + GPU 实例化**，片元阶段用 **`fwidth` 的屏幕空间近似**实现**近似恒定像素线宽**的线框（`edgeMaskScreenSpace`，见该文件内 `FS_SOURCE`）。

- 每个格元在每条可见边上会贡献约 **`lineWidthPx` 像素宽度**的线带。
- 格元数量多且每个在屏幕上仍占一定像素时，**边像素总量近似随格元数增长**，线框叠加后极易「铺满屏幕」。
- 体块信息主要依赖**填充色与透明度**；线框过密时填充的渐变与遮挡关系被线条噪声淹没。

### 1.3 不在此方案首要解决的问题

- **性能极限**（实例数、draw call）：本方案以观感为主，不依赖减少实例数。
- **与分析离散格网不一致的几何 LOD**（合并体素）：本方案不改变格网划分与拾取索引。

---

## 2. 解决思路（原则）

在**不改变格网生成逻辑、不重算实例矩阵、不改 GPU 拾取编码**的前提下：

- **保留**现有片元线框与填充的 `mix` 结构。
- 引入一个**每帧（或节流）更新的标量** `outlineMix ∈ [0, 1]`，表示**线框颜色在混合中的权重上限**。
- 当**典型格元在屏幕上的投影尺度**小于某阈值时，令 `outlineMix → 0`：**主要靠半透明体表现体量**；当格子在屏幕上足够大时，`outlineMix → 1`：**线框恢复**，便于辨认单格。

即：**按屏幕尺度自动弱化线框，而不是全局把线变细或调淡**（后者在近看大格时容易过虚，且对「密纹」问题针对性弱）。

---

## 3. 技术要点（实现层）

### 3.1 片元着色器

当前逻辑（概念上）：

```text
mixedColor = mix(baseFill, u_outlineColor, edgeMask);
```

改为：

```text
mixedColor = mix(baseFill, u_outlineColor, edgeMask * u_outlineMix);
```

- `edgeMask`：仍为现有 `edgeMaskScreenSpace` / `edgeMaskFromLocalPos` 分支。
- `u_outlineMix`：由 CPU 在 `update` 中写入，经 `uniformMap` 传入。

信号强度着色分支（`u_signalMode > 0.5`）下，`baseFill` 仍为信号色；**仅调制线框项**，避免破坏信号图例语义。

### 3.2 `u_outlineMix` 的计算位置

在 **`BeiDouGridPrimitive.prototype.update(frameState)`** 中（在推 `DrawCommand` 之前或 uniform 读取之前均可），利用：

- `frameState.camera`：视点、视锥；
- 已有 **`this._boundingSphere`**（或格网世界包围球）：估计「格网区域到相机的典型距离」；
- **`this._wireframe.halfSize`**（即 `dx/2, dy/2, dz/2`）：取 **`max(dx, dy)`** 或 **`max(dx, dy, dz)`** 作为「典型格元特征尺度（米）」。

用简化的**透视投影几何**估算「该尺度在屏幕上的像素宽度」`cellPx`（一次标量计算即可，不必逐实例）：

- 例如：用相机到包围球中心的距离 `dist`、垂直视场角 `fovy`、画布高度 `canvasHeight`，估算 **每米对应像素** `pixelsPerMeter ≈ (canvasHeight / 2) / (dist * tan(fovy/2))`，再令 `cellPx ≈ max(dx, dy) * pixelsPerMeter`（可按需乘经验系数）。

再用 **`smoothstep(cellPxMin, cellPxMax, cellPx)`** 得到 `u_outlineMix`：

- `cellPx <= cellPxMin` → `outlineMix = 0`（几乎无线框）；
- `cellPx >= cellPxMax` → `outlineMix = 1`（线框全开）；
- 中间平滑过渡，避免缩放相机时闪烁。

可选：**对 `outlineMix` 做时间或角度节流**（例如仅当变化超过 `ε` 或每 N 帧更新），一般非必须。

### 3.3 配置项（建议）

在构造 `BeiDouGridPrimitive` 时传入的 `options.wireframe` 上扩展可选字段（名称可微调）：

| 字段 | 含义 | 建议默认 |
|------|------|----------|
| `outlineScreenFadeEnabled` | 是否启用按屏幕尺度弱化 | `true` |
| `outlineScreenPxMin` | 低于此近似像素宽度时线框权重为 0 | `8`～`12` |
| `outlineScreenPxMax` | 高于此近似像素宽度时线框权重为 1 | `24`～`40` |

`map.js` 中 `showBeiDouGrid` 里创建 `BeiDouGridPrimitive` 时传入上述配置，便于与 `GridConfig.vue` 后续联动（可选）。

### 3.4 与拾取、WebGL1 的关系

- **拾取**：拾取使用独立 pass / shader，**不经过**上述 `mix` 修改；只要不动实例矩阵与 pick 编码，**无需改拾取逻辑**。
- **WebGL1 无 `OES_standard_derivatives`**：走 `edgeMaskFromLocalPos` 分支时，同样乘以 `u_outlineMix`，行为一致。

---

## 4. 代码层面要怎么改（文件级清单）

### 4.1 `frontend/src/Rendering/BeiDouGridPrimitive.js`

1. **`FS_SOURCE`（片元着色器字符串）**
   - 增加 `uniform float u_outlineMix;`（默认视为 1.0 的兼容路径在 CPU 侧保证）。
   - 将最终 `mix` 的第三参由 `edgeMask` 改为 `edgeMask * clamp(u_outlineMix, 0.0, 1.0)`。

2. **类成员**
   - 增加 `_outlineMix`（number），在 `update` 中赋值；构造时默认 `1.0`。

3. **`_buildResources` 内 `uniformMap`**
   - 增加 `u_outlineMix: () => this._outlineMix`（或从 `wireframe` 配置读取并乘总开关）。

4. **`update(frameState)`**
   - 若 `wireframe.outlineScreenFadeEnabled === false`，设 `_outlineMix = 1.0` 并返回。
   - 否则根据 `frameState.camera`、`this._boundingSphere`、`halfSize` 与画布尺寸计算 `cellPx`，再 `smoothstep` 得到 `_outlineMix`。

5. **`setWireframeStyle`（若存在且会重建/更新 uniform 相关状态）**
   - 确保新字段可被更新；若 uniform 已惰性绑定，仅改 `this._wireframe` 即可由 `uniformMap` 读取。

### 4.2 `frontend/src/stores/map.js`

- 在 `showBeiDouGrid` 的 **instanced 分支** 创建 `BeiDouGridPrimitive` 时，在 `wireframe: { ... }` 中传入：
  - `outlineScreenFadeEnabled`、可选 `outlineScreenPxMin` / `outlineScreenPxMax`。
- **非 instanced** 的 `Cesium.Primitive` + `PerInstanceColorAppearance` 路径**没有**同一套片元线框；若需观感一致，可另开「仅大规模」或后续再对 primitive 路径做简化（非本方案必选）。

### 4.3 `frontend/src/components/GridConfig.vue`（可选）

- 增加「线框随视角自动淡化」勾选框与两个像素阈值（高级设置可折叠），写入 store / 调用 `showBeiDouGrid` 的参数或 `primitive.setWireframeStyle`。

---

## 5. 验收建议

1. **密格网 + 中远距离**：线框不再糊满屏，体块层次可辨。
2. **拉近到单格占较大屏幕区域**：线框清晰，与改动前接近。
3. **连续缩放相机**：`outlineMix` 过渡平滑，无明显阶跃闪烁。
4. **开启信号着色**：填充仍为信号色，线框仅弱化，不出现反直觉的纯色块。
5. **拾取**：格元选中 / 高亮与改动前一致。

---

## 6. 小结

| 项目 | 说明 |
|------|------|
| 问题 | 恒定像素线框 × 大量格元 → 边像素过多 → 屏显「密纹」、体量感差 |
| 手段 | 用「典型格元屏幕像素尺度」调制 `edgeMask` 权重，保留填充 |
| 主改文件 | `BeiDouGridPrimitive.js`（shader + `update` + uniform）；`map.js` 传参 |
| 不改 | 实例数据、格网参数、拾取编码、分析语义 |

本文件为**设计说明**；具体实现以仓库内 Cesium **1.99.0** 的 `frameState` / `Camera` API 为准编写计算代码。
