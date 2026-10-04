// 雪顶小屋世界里那条小船的程序化模型（glTF 2.0 二进制 .glb）。
//
// 设计约束（都是先读源码确认过的，不是猜的）：
//
// 1) 原点在水线上：y=0 就是水面。吃水 0.30（龙骨 y=-0.30），干舷 0.26（船中舷缘 y=+0.26）。
//    船是 kinematic 刚体（不吃重力），所以世界里的实体把 y 放 0 就浮在水面上。
//
// 2) +Z 是船头，+X 是右舷。
//
// 3) 玩家没有台阶(step-up)能力 —— src/core/entities/PlayerLocal.js 里没有任何
//    step / PxController / setStepOffset，玩家是个动态刚体胶囊（半径 0.3）。
//    所以**能走上去的高差一律 ≤ 0.30 米**。本模型的站立面高差表（米）：
//        沙地 0 → 尾板顶 +0.26 (0.26) → 尾甲板 +0.02 → 舱内地板 -0.16
//        → 横座 +0.06 (0.22) → 前舱盖 +0.10 (0.26) → 舷缘顶 +0.26 (0.20/0.16)
//    全部 ≤ 0.30。check-boat.cjs 会把这张表逐条验一遍。
//
// 4) 碰撞体必须单独一个 Mesh、单个 primitive、不带材质（glbToNodes.js:73 的
//    `props.node === 'collider' && object3d.isMesh`），否则碰撞体静默不生成。
//
// 5) 家具都是从下往上的实心块，没有悬空几何；相邻体积要么错开要么压 1 毫米，
//    不留共面同朝向的重叠面。
//
// 用法：node tools/make-boat.mjs [输出路径]

import { createMeshBuilder } from './mesh-builder.mjs'

const B = createMeshBuilder()
const { addQuad, addBox, pushGeometry, writeGlb } = B

const P = {
  STERN: -2.20,
  BOW: 2.00,
  THICK: 0.045,     // 舷侧板厚
  BOT_T: 0.05,      // 船底板厚（外皮 y → 内皮 y）
  INSET: 0.012,     // 舱内家具离舷内侧的缝隙，避免共面
  TRANSOM_T: 0.10,  // 尾板厚度，它的顶面就是上船那一级

  FLOOR_Z0: -1.60, FLOOR_Z1: 1.30, FLOOR_HW: 0.32,
  FLOOR_BOT: -0.26, FLOOR_TOP: -0.16,

  AFT_Z: -2.18, AFT_TOP: 0.02, AFT_BOT: -0.20, AFT_HW: 0.39,
  BOWDECK_Z0: 1.30, BOWDECK_Z1: 1.82, BOWDECK_TOP: 0.10, BOWDECK_BOT: -0.20, BOWDECK_HW: 0.15,

  SEAT_TOP: 0.06, SEAT_TUCK: 0.001, SEAT_HW: 0.50,
  SEATS: [{ z0: -1.42, z1: -1.14 }, { z0: 0.15, z1: 0.43 }],
}

// 站位表：z / 船底半宽 hb / 舷缘半宽 hs / 船底 y(by) / 舷缘 y(sy)
const STATIONS = [
  { z: -2.20, hb: 0.28, hs: 0.64, by: -0.22, sy: 0.26 },
  { z: -1.70, hb: 0.38, hs: 0.68, by: -0.27, sy: 0.26 },
  { z: -0.90, hb: 0.44, hs: 0.72, by: -0.30, sy: 0.26 },
  { z: 0.00, hb: 0.44, hs: 0.72, by: -0.30, sy: 0.27 },
  { z: 0.85, hb: 0.42, hs: 0.70, by: -0.29, sy: 0.28 },
  { z: 1.50, hb: 0.30, hs: 0.54, by: -0.26, sy: 0.31 },
  { z: 1.87, hb: 0.13, hs: 0.28, by: -0.22, sy: 0.33 },
  { z: 2.00, hb: 0.02, hs: 0.05, by: -0.20, sy: 0.34 },
]

function stationAt(z) {
  const S = STATIONS
  if (z <= S[0].z) return S[0]
  if (z >= S[S.length - 1].z) return S[S.length - 1]
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i]
    const b = S[i + 1]
    if (z >= a.z && z <= b.z) {
      const t = (z - a.z) / (b.z - a.z)
      const L = (u, v) => u + (v - u) * t
      return { z, hb: L(a.hb, b.hb), hs: L(a.hs, b.hs), by: L(a.by, b.by), sy: L(a.sy, b.sy) }
    }
  }
  return S[S.length - 1]
}

// 舷内侧在高度 y 处的半宽（内表面 = 外表面沿外法线内缩板厚）
function innerHalfAt(z, y) {
  const s = stationAt(z)
  const dx = s.hs - s.hb
  const dy = s.sy - s.by
  const L = Math.hypot(dx, dy)
  const nx = dy / L
  const ny = -dx / L
  const hbIn = s.hb - P.THICK * nx
  const byIn = s.by - P.THICK * ny
  const hsIn = s.hs - P.THICK * nx
  const syIn = s.sy - P.THICK * ny
  const t = Math.min(1, Math.max(0, (y - byIn) / (syIn - byIn)))
  return hbIn + (hsIn - hbIn) * t
}

function minInnerHalf(z0, z1, y) {
  let m = Infinity
  for (let k = 0; k <= 12; k++) m = Math.min(m, innerHalfAt(z0 + (z1 - z0) * (k / 12), y))
  return m
}

// ============================================================================
// 船体
// ============================================================================
for (let i = 0; i < STATIONS.length - 1; i++) {
  const a = STATIONS[i]
  const b = STATIONS[i + 1]
  // 用这一段的「中点剖面」定内缩方向，两站共用同一个向量 —— 板厚恒定，内面不扭
  const dx = (a.hs + b.hs) / 2 - (a.hb + b.hb) / 2
  const dy = (a.sy + b.sy) / 2 - (a.by + b.by) / 2
  const L = Math.hypot(dx, dy)
  const nx = dy / L          // +X 侧外法线的 x 分量（在 半宽/y 平面里，> 0）
  const ny = -dx / L         // 外法线的 y 分量（< 0：朝外且朝下，因为舷侧外张）
  const ix = -P.THICK * nx   // 内缩向量：半宽方向
  const iy = -P.THICK * ny   // 内缩向量：y 方向（> 0，略往上）

  for (const sg of [1, -1]) {
    const obA = [sg * a.hb, a.by, a.z]
    const osA = [sg * a.hs, a.sy, a.z]
    const obB = [sg * b.hb, b.by, b.z]
    const osB = [sg * b.hs, b.sy, b.z]
    const ibA = [sg * (a.hb + ix), a.by + iy, a.z]
    const isA = [sg * (a.hs + ix), a.sy + iy, a.z]
    const ibB = [sg * (b.hb + ix), b.by + iy, b.z]
    const isB = [sg * (b.hs + ix), b.sy + iy, b.z]

    addQuad(obA, obB, osB, osA, [sg * nx, ny, 0], 'Hull')       // 舷外板
    addQuad(ibA, ibB, isB, isA, [-sg * nx, -ny, 0], 'Tar')      // 舷内侧（舱内是深色）
    addQuad(osA, osB, isB, isA, [sg, 1, 0], 'Trim')             // 舷缘顶面
  }

  // 船底（外皮朝下 + 内皮朝上，内皮内缩、上抬板厚）
  addQuad(
    [-a.hb, a.by, a.z], [a.hb, a.by, a.z], [b.hb, b.by, b.z], [-b.hb, b.by, b.z],
    [0, -1, 0], 'Tar',
  )
  const e = 0.03
  addQuad(
    [-a.hb + e, a.by + P.BOT_T, a.z], [a.hb - e, a.by + P.BOT_T, a.z],
    [b.hb - e, b.by + P.BOT_T, b.z], [-b.hb + e, b.by + P.BOT_T, b.z],
    [0, 1, 0], 'Tar',
  )
}

// 尾板（盒子，顶面 +0.26 就是走上船的那一级；比舷缘各宽 1 厘米，正好盖住舷板的开口端）
const s0 = STATIONS[0]
addBox(-s0.hs - 0.01, s0.by - 0.02, P.STERN, s0.hs + 0.01, s0.sy, P.STERN + P.TRANSOM_T, 'Hull')

// 船头封板
const sN = STATIONS[STATIONS.length - 1]
addQuad([-sN.hb, sN.by, sN.z], [sN.hb, sN.by, sN.z], [sN.hs, sN.sy, sN.z], [-sN.hs, sN.sy, sN.z], [0, 0, 1], 'Hull')

// ============================================================================
// 舱内：地板 / 横座 / 尾甲板 / 前舱盖 —— 都是从下往上的实心块
// ============================================================================
addBox(-P.FLOOR_HW, P.FLOOR_BOT, P.FLOOR_Z0, P.FLOOR_HW, P.FLOOR_TOP, P.FLOOR_Z1, 'Hull')

for (const s of P.SEATS) {
  const hw = Math.min(P.SEAT_HW, minInnerHalf(s.z0, s.z1, P.SEAT_TOP) - P.INSET)
  addBox(-hw, P.FLOOR_TOP - P.SEAT_TUCK, s.z0, hw, P.SEAT_TOP, s.z1, 'Trim')
}

{
  const hwA = Math.min(P.AFT_HW, minInnerHalf(P.AFT_Z, -1.70, P.AFT_TOP) - P.INSET)
  addBox(-hwA, P.AFT_BOT, P.AFT_Z, hwA, P.AFT_TOP, -1.70, 'Hull')
  const hwB = Math.min(P.BOWDECK_HW, minInnerHalf(P.BOWDECK_Z0, P.BOWDECK_Z1, P.BOWDECK_TOP) - P.INSET)
  addBox(-hwB, P.BOWDECK_BOT, P.BOWDECK_Z0, hwB, P.BOWDECK_TOP, P.BOWDECK_Z1, 'Hull')
}

// ============================================================================
// 组装 GLB
// ============================================================================
const MATS = [
  { name: 'Hull', pbr: { baseColorFactor: [0.78, 0.58, 0.36, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
  { name: 'Trim', pbr: { baseColorFactor: [0.42, 0.27, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.80 } },
  { name: 'Tar', pbr: { baseColorFactor: [0.24, 0.22, 0.21, 1], metallicFactor: 0, roughnessFactor: 0.92 } },
]
const MI = {}
MATS.forEach((m, i) => { MI[m.name] = i })

const visualPrims = []
const visualTris = {}
MATS.forEach((m) => {
  const faces = B.quads.filter((q) => q.mat === m.name)
  if (!faces.length) return
  const r = pushGeometry(faces, MI[m.name])
  visualPrims.push(r.prim)
  visualTris[m.name] = r.tri
})

// 碰撞网格：所有实体面，单个 primitive、不指定材质
const solidFaces = B.quads.filter((q) => q.solid)
const body = pushGeometry(solidFaces)

const out = process.argv[2] || 'tools/_boat.glb'
const r = writeGlb(out, {
  generator: 'make-boat.mjs',
  sceneName: 'Boat',
  sceneRoots: [2],
  nodes: [
    { name: 'BoatVisual', mesh: 0 },
    { name: 'BoatBody', mesh: 1, extras: { node: 'collider' } },
    { name: 'Boat', children: [0, 1], extras: { node: 'rigidbody', type: 'kinematic' } },
  ],
  meshes: [
    { name: 'BoatVisual', primitives: visualPrims },
    { name: 'BoatBody', primitives: [body.prim] },
  ],
  materials: MATS.map((m) => ({ name: m.name, pbrMetallicRoughness: m.pbr })),
})

// ============================================================================
// 自检
// ============================================================================
const all = [...solidFaces]
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
for (const q of all) {
  for (const v of q.v) {
    minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0])
    minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1])
    minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2])
  }
}

console.log('写入:', out, r.byteLength, '字节')
console.log('视觉三角形:', Object.entries(visualTris).map(([k, v]) => `${k}=${v}`).join(' '), '合计', Object.values(visualTris).reduce((s, v) => s + v, 0))
console.log('碰撞三角形:', body.tri)
console.log('包围盒 X', minX.toFixed(3), '→', maxX.toFixed(3), ' 长', (maxZ - minZ).toFixed(3))
console.log('包围盒 Y', minY.toFixed(3), '→', maxY.toFixed(3), ' 吃水', (-minY).toFixed(3), ' 干舷(船中)', s0.sy.toFixed(3))
console.log('包围盒 Z', minZ.toFixed(3), '→', maxZ.toFixed(3), ' 最大顶点数', r.maxVert)
console.log('站立面: 尾板顶 +0.26 / 尾甲板 +0.02 / 舱内地板 -0.16 / 横座 +0.06 / 前舱盖 +0.10 / 舷缘顶(船中) +0.26')
