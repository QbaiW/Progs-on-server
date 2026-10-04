// 程序化两层小房子生成器 —— 纯代码，无外部依赖，输出 glTF 2.0 二进制 (.glb)
//
// ============================================================================
// 这个文件把前面所有踩过的坑都当成硬约束写进来了：
//
// 1) 碰撞体必须是一个「单独的、单一 primitive、不带材质」的 Mesh。
//    src/core/extras/glbToNodes.js:73 的判断是
//        else if (props.node === 'collider' && object3d.isMesh)
//    而同一处的注释原文写着：一个对象如果带 collider 标记却有多种材质，
//    GLTFLoader 会把它拆成 Group + 每材质一个 Mesh，
//    标记落在 Group 上，isMesh 就成了 false —— 碰撞体静默地从未创建。
//    上一版地形就是这么"站不住/穿模"的，查了很久才查到这一行。
//    所以这里 HouseVisual(多材质) 和 HouseBody(单 primitive、无材质) 是两块网格。
//
// 2) 不需要在外层应用里勾 Collision。
//    内置 Model 应用脚本的提示原文是：
//      "Forces all meshes to have collision. Disable this if your model
//       already has embedded collision."
//    我们走的是 embedded collision，所以 blueprint 里 props.collision = false，
//    否则会给每个可视网格再套一层碰撞体，两套重叠。
//
// 3) 不能有共面且同朝向的重叠面 —— 那会产生 z-fighting（闪烁）。
//    所有体积都保证「相邻不相交」：
//      * 四道墙用企口搭接（Z 向墙通长，X 向墙缩进两侧墙厚），角上不重叠
//      * 楼梯每一级的高度区间互不相交
//      * 地板/楼板/墙在 y 方向首尾相接，不叠
//
// 4) 三角形不能太大。PhysX 会警告 "TriangleMesh: triangles are too big"，
//    墙面都被门窗洞切成小块，最大的面也就是楼板，尺寸都在米级。
//
// 5) 不用任何压缩扩展（服务端没有 DRACOLoader），不用外部贴图。
// ============================================================================
//
// 用法：node tools/make-house.mjs [输出路径]

import fs from 'node:fs'
import path from 'node:path'

// ---------------- 尺寸参数（单位：米） ----------------
const P = {
  HX: 3.00,     // 外墙 X 方向半长
  HZ: 2.25,     // 外墙 Z 方向半长
  T: 0.18,      // 墙厚
  F1: 2.70,     // 一层净高（地面 → 二层楼板底）
  SLAB: 0.25,   // 二层楼板厚
  F2: 2.50,     // 二层净高
  RISE: 1.10,   // 屋顶举高（檐口 → 屋脊）
  OVER: 0.35,   // 屋檐四面外伸
  PLINTH: 1.20, // 地基往下埋多深
  RTH: 0.14,    // 屋面厚
}
const Y2 = P.F1 + P.SLAB          // 2.95  二层地面标高
const EAVE = Y2 + P.F2            // 5.45  二层墙顶 = 檐口
const RIDGE = EAVE + P.RISE       // 6.55  屋脊
const SLOPE = P.RISE / P.HZ       // 屋面坡度（tan） —— 让屋面正好穿过墙顶
const TAN = Math.atan(SLOPE)

// 楼梯：13 级踏面把 2.95 米抬上去
const STEPS = 13
const RISER = Y2 / STEPS
const GOING = 0.29
const SX0 = P.HX - P.T - 0.95     // 梯段内侧
const SX1 = P.HX - P.T            // 贴二层墙内表面
const SZTOP = 1.95                // 第一级踏面的外沿
const SZEND = SZTOP - STEPS * GOING

// 楼梯井：二层楼板在 +X 一条通长的开口
const WELL_X0 = SX0 - 0.07
const WELL_X1 = P.HX - P.T

const IX0 = -P.HX + P.T           // 室内净空
const IX1 = P.HX - P.T
const IZ0 = -P.HZ + P.T
const IZ1 = P.HZ - P.T

// ---------------- 材质 ----------------
const MATS = [
  { name: 'Wall', color: [0.92, 0.89, 0.82, 1], rough: 0.92, metal: 0 },
  { name: 'Wood', color: [0.40, 0.26, 0.15, 1], rough: 0.85, metal: 0 },
  { name: 'Floor', color: [0.50, 0.34, 0.20, 1], rough: 0.80, metal: 0 },
  { name: 'Roof', color: [0.40, 0.17, 0.13, 1], rough: 0.90, metal: 0 },
  { name: 'Stone', color: [0.36, 0.35, 0.34, 1], rough: 0.95, metal: 0 },
  { name: 'Glass', color: [0.60, 0.78, 0.88, 0.32], rough: 0.05, metal: 0, alpha: 'BLEND' },
]
const MI = Object.fromEntries(MATS.map((m, i) => [m.name, i]))

// ---------------- 几何累积 ----------------
// 每个面存成「4 个顶点 + 期望外法线 + 材质 + 是否参与碰撞」
const quads = []

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

// 关键：不手写绕序，直接由「期望外法线」反推，绕序错了就翻过来。
// 手写绕序是这类生成器最容易出错的地方，而且错了的表现是"面看不见"，
// 很难定位。
function addQuad(v0, v1, v2, v3, wantN, mat, solid) {
  const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
  const e2 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]]
  let n = norm([
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ])
  const dot = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2]
  if (dot < 0) {
    n = [-n[0], -n[1], -n[2]]
    quads.push({ v: [v0, v3, v2, v1], n, mat, solid })
  } else {
    quads.push({ v: [v0, v1, v2, v3], n, mat, solid })
  }
}

function addTri(a, b, c, wantN, mat, solid) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
  const n = norm([
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ])
  const dot = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2]
  // 三角形保持 3 个顶点，不凑成退化的四边形 ——
  // 零面积三角形会让 PhysX 的三角网格校验报警告。
  if (dot < 0) quads.push({ v: [a, c, b], n: [-n[0], -n[1], -n[2]], mat, solid })
  else quads.push({ v: [a, b, c], n, mat, solid })
}

// 轴对齐立方体（6 个面）
function addBox(x0, y0, z0, x1, y1, z1, mat, solid = true) {
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return
  const p = (x, y, z) => [x, y, z]
  addQuad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0), [1, 0, 0], mat, solid)
  addQuad(p(x0, y0, z1), p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), [-1, 0, 0], mat, solid)
  addQuad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), [0, 1, 0], mat, solid)
  addQuad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0), p(x0, y0, z0), [0, -1, 0], mat, solid)
  addQuad(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1), [0, 0, 1], mat, solid)
  addQuad(p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), p(x0, y0, z0), [0, 0, -1], mat, solid)
}

// 绕 X 轴旋转的立方体（屋面用）
function addRotBoxX(cx, cy, cz, sx, sy, sz, ang, mat, solid = true) {
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  // 位置绕 X 轴旋转： y' = y·cos − z·sin ，z' = y·sin + z·cos
  const rot = (x, y, z) => [cx + x, cy + y * ca - z * sa, cz + y * sa + z * ca]
  // 法线同一套旋转（只对 (y,z) 分量起作用）
  const rn = (y, z) => [0, y * ca - z * sa, y * sa + z * ca]
  const hx = sx / 2
  const hy = sy / 2
  const hz = sz / 2
  const c000 = rot(-hx, -hy, -hz), c001 = rot(-hx, -hy, hz)
  const c010 = rot(-hx, hy, -hz), c011 = rot(-hx, hy, hz)
  const c100 = rot(hx, -hy, -hz), c101 = rot(hx, -hy, hz)
  const c110 = rot(hx, hy, -hz), c111 = rot(hx, hy, hz)
  addQuad(c100, c101, c111, c110, [1, 0, 0], mat, solid)   // +X
  addQuad(c001, c000, c010, c011, [-1, 0, 0], mat, solid)  // -X
  addQuad(c010, c110, c111, c011, rn(1, 0), mat, solid)    // +Y（旋转后的"上面"）
  addQuad(c001, c101, c100, c000, rn(-1, 0), mat, solid)   // -Y
  addQuad(c001, c011, c111, c101, rn(0, 1), mat, solid)    // +Z 端
  addQuad(c100, c110, c010, c000, rn(0, -1), mat, solid)   // -Z 端
}

// 带矩形洞的墙
//   axis='x' → 墙的法线沿 X，fixed 是 x 的范围，extent 是 z 的范围
//   axis='z' → 墙的法线沿 Z，fixed 是 z 的范围，extent 是 x 的范围
//   holes: [{e0,e1,y0,y1}]，坐标在 (extent, y) 平面内
//
// 做法是把 extent / y 上所有「墙边界 + 洞边界」的坐标汇成一张网格，
// 逐个格子判断中心是否落在某个洞里；落进去就不生成。
// 这样支持任意多个洞，也不用手写"门洞上沿/两侧"那种特例。
function addWall(axis, f0, f1, e0, e1, y0, y1, holes, mat, solid = true) {
  const es = new Set([e0, e1])
  const ys = new Set([y0, y1])
  for (const h of holes) {
    const a = Math.min(Math.max(h.e0, e0), e1)
    const b = Math.min(Math.max(h.e1, e0), e1)
    const c = Math.min(Math.max(h.y0, y0), y1)
    const d = Math.min(Math.max(h.y1, y0), y1)
    if (b - a > 1e-6) { es.add(a); es.add(b) }
    if (d - c > 1e-6) { ys.add(c); ys.add(d) }
  }
  const E = [...es].sort((a, b) => a - b)
  const Y = [...ys].sort((a, b) => a - b)
  let cells = 0
  let cut = 0
  for (let i = 0; i < E.length - 1; i++) {
    for (let j = 0; j < Y.length - 1; j++) {
      const ec = (E[i] + E[i + 1]) / 2
      const yc = (Y[j] + Y[j + 1]) / 2
      const inHole = holes.some((h) => ec > h.e0 + 1e-9 && ec < h.e1 - 1e-9 && yc > h.y0 + 1e-9 && yc < h.y1 - 1e-9)
      if (inHole) { cut++; continue }
      if (axis === 'x') addBox(f0, Y[j], E[i], f1, Y[j + 1], E[i + 1], mat, solid)
      else addBox(E[i], Y[j], f0, E[i + 1], Y[j + 1], f1, mat, solid)
      cells++
    }
  }
  return { cells, cut }
}

// 山墙（三角形棱柱），法线沿 X
function addGable(x0, x1, mat, solid = true) {
  // 屋脊点必须往下压 TUCK：屋面板的**上表面**正好穿过 (z=±HZ, y=EAVE) → (z=0, y=RIDGE)
  // 这条中线（addRotBoxX 把板心沿法线平移了 RTH/2）。山墙斜边若也落在这条中线上，
  // 两者就同面同向且投影重叠 → 两片山墙上方各闪一块（实测 2 个三角形，z≈-0.75 / -1.50）。
  // 压下 12 毫米后斜面整体缩进板厚（板的半厚是 70 毫米）之内，变成看不见的内表面，
  // 只在檐口那条线上与屋面相交（零面积，不构成重叠）。
  const TUCK = 0.012
  const A0 = [x0, EAVE, -P.HZ], B0 = [x0, EAVE, P.HZ], C0 = [x0, RIDGE - TUCK, 0]
  const A1 = [x1, EAVE, -P.HZ], B1 = [x1, EAVE, P.HZ], C1 = [x1, RIDGE - TUCK, 0]
  addTri(A1, B1, C1, [1, 0, 0], mat, solid)
  addTri(C0, B0, A0, [-1, 0, 0], mat, solid)
  addQuad(A0, A1, B1, B0, [0, -1, 0], mat, solid)                       // 底
  addQuad(A0, A1, C1, C0, [0, P.HZ, -P.RISE], mat, solid)               // 斜面 -Z
  addQuad(C0, C1, B1, B0, [0, P.HZ, P.RISE], mat, solid)                // 斜面 +Z
}

// ============================================================================
// 开始搭房子
// ============================================================================
const stats = {}

// --- 地基（往地里埋 1.2 米，四周探出 0.15 米做裙边） ---
addBox(-P.HX - 0.15, -P.PLINTH, -P.HZ - 0.15, P.HX + 0.15, -0.30, P.HZ + 0.15, 'Stone')

// --- 一层地面：结构层 + 木质面层 ---
addBox(-P.HX, -0.30, -P.HZ, P.HX, 0.00, P.HZ, 'Stone')
addBox(IX0, 0.00, IZ0, IX1, 0.02, IZ1, 'Floor')

// --- 门口的石头门廊 ---
addBox(-0.95, -0.55, -P.HZ - 1.05, 0.95, 0.00, -P.HZ, 'Stone')

// --- 一层四面墙 ---
// 企口：Z 向墙通长，X 向墙缩进两侧墙厚，角上不产生共面重叠面
const f1WindowY = [0.95, 2.05]
const f2WindowY = [3.95, 5.05]
const DOOR = { e0: -0.55, e1: 0.55, y0: 0.02, y1: 2.10 }

const wZminus = addWall('z', -P.HZ, -P.HZ + P.T, -P.HX, P.HX, 0, EAVE,
  [DOOR, { e0: -0.95, e1: 0.95, y0: 3.95, y1: 5.05 }], 'Wall')
const wZplus = addWall('z', P.HZ - P.T, P.HZ, -P.HX, P.HX, 0, EAVE,
  [{ e0: -0.90, e1: 0.90, y0: f1WindowY[0], y1: f1WindowY[1] },
   { e0: -0.90, e1: 0.90, y0: 3.90, y1: 5.00 }], 'Wall')
const wXminus = addWall('x', -P.HX, -P.HX + P.T, IZ0, IZ1, 0, EAVE,
  [{ e0: -0.75, e1: 0.75, y0: f1WindowY[0], y1: f1WindowY[1] },
   { e0: -0.75, e1: 0.75, y0: f2WindowY[0], y1: f2WindowY[1] }], 'Wall')
const wXplus = addWall('x', P.HX - P.T, P.HX, IZ0, IZ1, 0, EAVE,
  [{ e0: -0.90, e1: 0.90, y0: f2WindowY[0], y1: f2WindowY[1] }], 'Wall')

stats.一层墙格子 = { '前(-Z)': wZminus.cells, '后(+Z)': wZplus.cells, '左(-X)': wXminus.cells, '右(+X)': wXplus.cells }
stats.被门窗挖掉的格子 = wZminus.cut + wZplus.cut + wXminus.cut + wXplus.cut

// --- 二层楼板：只铺到楼梯井左侧，楼梯井那条是通的 ---
// 必须收在外墙的**内侧**面（IX0/IZ0/IZ1），不能铺到 -HX/-HZ：
// 外墙是从 0 一砌到 EAVE 的整片，楼板若铺到 HZ，它的 ±Z 面就和外墙的外表面
// 落在同一个平面上 → 二层墙裙那一圈共面 z-fighting（实测有 19 个三角形）。
addBox(IX0, P.F1, IZ0, WELL_X0, P.F1 + P.SLAB, IZ1, 'Stone')
// 楼板顶面铺木地板
addBox(IX0, P.F1 + P.SLAB, IZ0, WELL_X0, Y2 + 0.02, IZ1, 'Floor')
// 这里原本还有一块「楼梯井边缘收边小梁」，但它的 x ∈ [WELL_X0-0.06, WELL_X0]、
// y 和 z 与上面那块木地板完全相同 → 被木地板整个包住，是纯多余几何：
// 顶面共面导致 z-fighting（没能起到收边作用），+X 面又与木地板的 +X 面完全重合，
// 产生 2 个重复三角形。已删除。见 tools/check-house.cjs 的「共面重叠」检查。

// --- 楼梯：每一级只占自己那一格高度，相邻不重叠（避免 z-fighting） ---
// 第一级要从地面**面层顶**（y=0.02）起步，不能从 y=0 起：
// 那会与一层地面面层的底面（也是 y=0.00）同面同向重叠。
for (let k = 0; k < STEPS; k++) {
  const z1 = SZTOP - k * GOING
  const z0 = SZTOP - (k + 1) * GOING
  addBox(SX0, Math.max(k * RISER, 0.02), z0, SX1, (k + 1) * RISER, z1, 'Wood')
}

// --- 山墙（屋脊沿 X，所以山墙在 ±X 两端） ---
addGable(-P.HX, -P.HX + P.T, 'Wall')
addGable(P.HX - P.T, P.HX, 'Wall')

// --- 屋面：两块斜板 + 一根屋脊盖 ---
// 两块斜板的板面正好穿过 (z=±HZ, y=EAVE) 与 (z=0, y=RIDGE) 这条线，
// 所以山墙的底边和屋面严丝合缝，不会漏缝。
const roofLen = Math.hypot(P.HZ + P.OVER, SLOPE * (P.HZ + P.OVER))
const midZ = (P.HZ + P.OVER) / 2
const midY = (RIDGE + (EAVE - SLOPE * P.OVER)) / 2
const nx = Math.cos(TAN)
const nz = Math.sin(TAN)
const roofW = 2 * (P.HX + P.OVER)
for (const sgn of [1, -1]) {
  const ang = sgn * TAN
  const cy = midY - (P.RTH / 2) * nx
  const cz = sgn * (midZ - (P.RTH / 2) * nz)
  addRotBoxX(0, cy, cz, roofW, P.RTH, roofLen, ang, 'Roof')
}
addBox(-(P.HX + P.OVER), RIDGE - 0.05, -0.11, P.HX + P.OVER, RIDGE + 0.02, 0.11, 'Roof')

// --- 烟囱（挂在房子外侧，不占室内，也就不挡楼梯） ---
addBox(P.HX - 0.05, -0.40, -0.45, P.HX + 0.45, RIDGE + 0.65, 0.35, 'Stone')
addBox(P.HX - 0.12, RIDGE + 0.65, -0.52, P.HX + 0.52, RIDGE + 0.80, 0.42, 'Stone')

// --- 窗玻璃 + 窗台 ---
// 玻璃放在墙厚正中；窗台是块木板，不参与碰撞（否则门口/窗边会绊脚）
const glassT = 0.05
function addGlassZ(zc, x0, x1, y0, y1, sillOut) {
  addBox(x0, y0, zc - glassT / 2, x1, y1, zc + glassT / 2, 'Glass')
  const s = sillOut
  addBox(x0 - 0.06, y0 - 0.06, s - 0.30, x1 + 0.06, y0, s + P.T + 0.30, 'Wood', false)
}
function addGlassX(xc, z0, z1, y0, y1) {
  addBox(xc - glassT / 2, y0, z0, xc + glassT / 2, y1, z1, 'Glass')
}

const zcMinus = -P.HZ + P.T / 2
const zcPlus = P.HZ - P.T / 2
const xcMinus = -P.HX + P.T / 2
const xcPlus = P.HX - P.T / 2

addGlassZ(zcMinus, -0.95, 0.95, 3.95, 5.05, -P.HZ)   // 正面二层
addGlassZ(zcPlus, -0.90, 0.90, f1WindowY[0], f1WindowY[1], P.HZ - P.T)  // 背面一层
addGlassZ(zcPlus, -0.90, 0.90, 3.90, 5.00, P.HZ - P.T)                  // 背面二层
addGlassX(xcMinus, -0.75, 0.75, f1WindowY[0], f1WindowY[1])             // 左侧一层
addGlassX(xcMinus, -0.75, 0.75, f2WindowY[0], f2WindowY[1])             // 左侧二层
addGlassX(xcPlus, -0.90, 0.90, f2WindowY[0], f2WindowY[1])              // 右侧二层（楼梯上方）
stats.窗玻璃 = 6

// --- 门框（木，不参与碰撞，门口的洞留着走人） ---
addBox(-0.62, 0.00, -P.HZ - 0.03, -0.55, 2.10, -P.HZ + P.T + 0.03, 'Wood', false)
addBox(0.55, 0.00, -P.HZ - 0.03, 0.62, 2.10, -P.HZ + P.T + 0.03, 'Wood', false)
addBox(-0.62, 2.10, -P.HZ - 0.03, 0.62, 2.18, -P.HZ + P.T + 0.03, 'Wood', false)

// ============================================================================
// 组装 GLB
// ============================================================================
const pad4 = (n) => (n + 3) & ~3
const alignBuffer = (buf) => {
  const rem = buf.length % 4
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, 0)])
}

const bufferViews = []
const accessors = []
const binParts = []
let binOffset = 0

function pushView(buf, target) {
  const aligned = alignBuffer(buf)
  const view = { buffer: 0, byteOffset: binOffset, byteLength: buf.length }
  if (target) view.target = target
  bufferViews.push(view)
  binParts.push(aligned)
  binOffset += aligned.length
  return bufferViews.length - 1
}
function pushAccessor(view, componentType, count, type, extra = {}) {
  accessors.push({ bufferView: view, componentType, count, type, ...extra })
  return accessors.length - 1
}

// 把一个面列表编译成 (POSITION, NORMAL, indices)
// 面既可能是四边形（4 个顶点 / 2 个三角形），也可能是三角形（3 / 1）——
// 山墙的端面就是三角形。
function compile(faces) {
  let vTotal = 0
  let triTotal = 0
  for (const q of faces) {
    vTotal += q.v.length
    triTotal += q.v.length - 2
  }
  const pos = new Float32Array(vTotal * 3)
  const nrm = new Float32Array(vTotal * 3)
  const idx = new Uint16Array(triTotal * 3)
  let pi = 0
  let ii = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const q of faces) {
    const base = pi / 3
    for (const v of q.v) {
      pos[pi] = v[0]; pos[pi + 1] = v[1]; pos[pi + 2] = v[2]
      nrm[pi] = q.n[0]; nrm[pi + 1] = q.n[1]; nrm[pi + 2] = q.n[2]
      for (let c = 0; c < 3; c++) {
        const val = v[c]
        if (val < min[c]) min[c] = val
        if (val > max[c]) max[c] = val
      }
      pi += 3
    }
    for (let k = 1; k < q.v.length - 1; k++) {
      idx[ii++] = base; idx[ii++] = base + k; idx[ii++] = base + k + 1
    }
  }
  return { pos, nrm, idx, min, max, vTotal, triTotal }
}

function pushGeometry(faces, materialIndex) {
  const g = compile(faces)
  const posView = pushView(Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength), 34962)
  const nrmView = pushView(Buffer.from(g.nrm.buffer, g.nrm.byteOffset, g.nrm.byteLength), 34962)
  const idxView = pushView(Buffer.from(g.idx.buffer, g.idx.byteOffset, g.idx.byteLength), 34963)
  const posAcc = pushAccessor(posView, 5126, g.pos.length / 3, 'VEC3', { min: g.min, max: g.max })
  const nrmAcc = pushAccessor(nrmView, 5126, g.nrm.length / 3, 'VEC3')
  const idxAcc = pushAccessor(idxView, 5123, g.idx.length, 'SCALAR')
  const prim = { attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc }
  if (materialIndex !== undefined) prim.material = materialIndex
  return { prim, tri: g.idx.length / 3, min: g.min, max: g.max }
}

// 视觉网格：按材质分 primitive（这就是那个"多材质"陷阱的源头，没关系，
// 它有材质、只是不能拿来当 collider）
const visualPrims = []
const visualTris = {}
MATS.forEach((m, i) => {
  const faces = quads.filter((q) => q.mat === m.name)
  if (!faces.length) return
  const r = pushGeometry(faces, i)
  visualPrims.push(r.prim)
  visualTris[m.name] = r.tri
})

// 碰撞网格：一个 primitive、不指定 material。
// 这是整个文件存在的理由 —— 上一版地形就是少了这块，
// 于是 glbToNodes.js 的 `object3d.isMesh` 判断失败，从来没建出过碰撞体。
const solidFaces = quads.filter((q) => q.solid)
const colliderGeo = pushGeometry(solidFaces, undefined)

// 校验：必须真的生成了几何，且索引能塞进 Uint16
if (!visualPrims.length) throw new Error('没有视觉几何')
if (!solidFaces.length) throw new Error('没有碰撞几何')
const maxVert = accessors.filter((a) => a.type === 'VEC3').reduce((m, a) => Math.max(m, a.count), 0)
if (maxVert > 65535) throw new Error('顶点数超过 Uint16 上限: ' + maxVert)

const materials = MATS.map((m) => {
  const mat = {
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: m.color,
      metallicFactor: m.metal,
      roughnessFactor: m.rough,
    },
  }
  if (m.alpha) mat.alphaMode = m.alpha
  return mat
})

const gltf = {
  asset: { version: '2.0', generator: 'make-house.mjs' },
  scene: 0,
  scenes: [{ name: 'House', nodes: [2] }],
  nodes: [
    { name: 'HouseVisual', mesh: 0 },
    // ↑ 多材质可视网格
    { name: 'HouseBody', mesh: 1, extras: { node: 'collider' } },
    // ↑ 碰撞体：单 primitive、无材质、extras.node='collider'
    { name: 'House', children: [0, 1], extras: { node: 'rigidbody' } },
    // ↑ 刚体根：extras.node='rigidbody'
  ],
  meshes: [
    { name: 'HouseVisual', primitives: visualPrims },
    { name: 'HouseBody', primitives: [colliderGeo.prim] },
  ],
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: 0 }],
}

const binBuffer = Buffer.concat(binParts)
gltf.buffers[0].byteLength = binBuffer.length

let jsonText = JSON.stringify(gltf)
while (jsonText.length % 4 !== 0) jsonText += ' '
const jsonBuf = Buffer.from(jsonText, 'utf8')

const header = Buffer.alloc(12)
header.write('glTF', 0, 'ascii')
header.writeUInt32LE(2, 4)
const totalLength = 12 + 8 + jsonBuf.length + 8 + binBuffer.length
header.writeUInt32LE(totalLength, 8)

const jsonChunkHeader = Buffer.alloc(8)
jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0)
jsonChunkHeader.write('JSON', 4, 'ascii')

const binChunkHeader = Buffer.alloc(8)
binChunkHeader.writeUInt32LE(binBuffer.length, 0)
binChunkHeader.write('BIN\0', 4, 'ascii')

const glb = Buffer.concat([header, jsonChunkHeader, jsonBuf, binChunkHeader, binBuffer])

const out = process.argv[2] || 'house.glb'
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, glb)

// ---------------- 自检 ----------------
const solidTris = colliderGeo.tri
const allTri = Object.values(visualTris).reduce((a, b) => a + b, 0)
console.log(
  JSON.stringify(
    {
      输出文件: path.resolve(out),
      文件大小: (glb.length / 1024).toFixed(1) + ' KB',
      视觉三角形: allTri,
      按材质: visualTris,
      碰撞三角形: solidTris,
      碰撞网格材质: colliderGeo.prim.material === undefined ? '无（正确）' : '有（错误！）',
      包围盒: {
        min: colliderGeo.min.map((v) => +v.toFixed(2)),
        max: colliderGeo.max.map((v) => +v.toFixed(2)),
      },
      房屋尺寸: `${(colliderGeo.max[0] - colliderGeo.min[0]).toFixed(2)} × ${(colliderGeo.max[1] - colliderGeo.min[1]).toFixed(2)} × ${(colliderGeo.max[2] - colliderGeo.min[2]).toFixed(2)} 米`,
      关键标高: { 一层地面: 0, 二层地面: Y2, 檐口: EAVE, 屋脊: RIDGE, 地基底: -P.PLINTH },
      楼梯: `${STEPS} 级，踏高 ${RISER.toFixed(3)} 米，踏宽 ${GOING} 米，从 z=${SZTOP} 到 z=${SZEND.toFixed(2)}`,
      楼梯井开口: `x ∈ [${WELL_X0.toFixed(2)}, ${WELL_X1.toFixed(2)}]（通长）`,
      使用扩展: '无',
    },
    null,
    2
  )
)
