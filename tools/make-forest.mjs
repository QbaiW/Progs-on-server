// 森林小屋场景生成器 —— 纯代码，无外部依赖，输出 glTF 2.0 二进制 (.glb)
//
// 地形沿用 island-terrain.mjs 的那座小岛（同一份高度场，所以世界坐标、
// 停泊点、房子落点这些既有结论都不作废），只把「雪顶」换成「森林」：
// 材质分层改成 沙滩 / 林地 / 灌木土坡 / 山顶草甸，不再有雪。
// 小屋落在山顶那块近乎水平的台地上（实测 footprint 高差 7 厘米），
// 一圈松林从半山腰开始，篝火在小屋旁 4.6 米。
//
// 房子本体单独走 HousTwFl01 蓝图（world2 已上线验证过碰撞与楼梯的同一个 GLB），
// 这个文件只负责 地形 + 松树 + 篝火石圈。火苗和烟是粒子，在 scene-forest.js。
//
// 为什么地形那块照着 make-island.mjs 抄而不是抽公共模块：
// 已上线的 island.glb 有固定 sha256（3444c4df…），抽函数必须字节级复现它；
// 森林这边要往顶点缓冲里塞树，参数面完全不同。
// ponytail: 两份地形块并存；等真有第三个地形场景再抽。
//
// 顶点分两个缓冲：地形一个（176² 点），植被一个。
// Uint16 索引要求每个 accessor 的顶点数 ≤ 65535，分开放才能种够树。
//
// 用法：node tools/make-forest.mjs [输出路径]

import fs from 'node:fs'
import path from 'node:path'
import { TERRAIN, heightAt, fbm, slopeDeg } from './island-terrain.mjs'

const OUT = process.argv[2] || 'forest.glb'
const CFG = {
  ...TERRAIN,
  segments: 176,
  out: OUT,
  // 落点文件跟输出放一起，入库脚本按需读
  site: path.join(path.dirname(path.resolve(OUT)), 'forest-site.json'),
}

const BANDS = [
  { name: 'Sand', color: [0.78, 0.71, 0.5, 1], test: (h) => h < 1.6 },
  { name: 'ForestFloor', color: [0.17, 0.3, 0.14, 1], test: (h) => h < 19 },
  { name: 'Underbrush', color: [0.29, 0.27, 0.17, 1], test: (h) => h < 23.2 },
  { name: 'Clearing', color: [0.36, 0.45, 0.23, 1], test: () => true },
]

// 树和篝火用的材质，接在地形四层之后
const EXTRA_MATS = [
  { name: 'Trunk', color: [0.26, 0.17, 0.1, 1], rough: 0.9 },
  { name: 'Needles', color: [0.1, 0.27, 0.13, 1], rough: 0.95 },
  { name: 'Log', color: [0.33, 0.21, 0.12, 1], rough: 0.9 },
  { name: 'Stone', color: [0.38, 0.37, 0.35, 1], rough: 0.95 },
  { name: 'Ember', color: [1.0, 0.45, 0.1, 1], rough: 0.6, emissive: [1.0, 0.35, 0.04] },
]

const ALL_MATS = [
  ...BANDS.map((b) => ({ name: b.name, color: b.color, rough: 0.95 })),
  ...EXTRA_MATS,
]
const MAT = Object.fromEntries(ALL_MATS.map((m, i) => [m.name, i]))
const TERRAIN_MAT_COUNT = BANDS.length

// ---------------- 几何累积 ----------------
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function newTarget() {
  return { pos: [], nrm: [], buckets: ALL_MATS.map(() => []), verts: 0 }
}

function pushVert(t, p, n) {
  t.pos.push(p[0], p[1], p[2])
  t.nrm.push(n[0], n[1], n[2])
  return t.verts++
}

// 由「期望外法线」反推绕序 —— 手写绕序错了的表现是"面看不见"，极难定位
function addTri(t, a, b, c, wantN, mat) {
  let n = norm(cross(sub(b, a), sub(c, b)))
  const flip = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2] < 0
  if (flip) n = [-n[0], -n[1], -n[2]]
  const ia = pushVert(t, a, n)
  const ib = pushVert(t, b, n)
  const ic = pushVert(t, c, n)
  if (flip) t.buckets[mat].push(ia, ic, ib)
  else t.buckets[mat].push(ia, ib, ic)
}

function addQuad(t, v0, v1, v2, v3, wantN, mat) {
  const n = norm(cross(sub(v1, v0), sub(v2, v1)))
  if (n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2] < 0) {
    addTri(t, v0, v3, v2, wantN, mat)
    addTri(t, v0, v2, v1, wantN, mat)
  } else {
    addTri(t, v0, v1, v2, wantN, mat)
    addTri(t, v0, v2, v3, wantN, mat)
  }
}

function addBox(t, x0, y0, z0, x1, y1, z1, mat) {
  if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return
  addQuad(t, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], mat)
  addQuad(t, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], mat)
  addQuad(t, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], mat)
  addQuad(t, [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], [0, -1, 0], mat)
  addQuad(t, [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [0, 0, 1], mat)
  addQuad(t, [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [0, 0, -1], mat)
}

// 圆锥（松树的一层枝叶）：apex + 底面 ring，不做底面封盖（看不见）
function addCone(t, cx, baseY, cz, r, h, sides, mat) {
  const apex = [cx, baseY + h, cz]
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2
    const a1 = ((k + 1) / sides) * Math.PI * 2
    const p0 = [cx + Math.cos(a0) * r, baseY, cz + Math.sin(a0) * r]
    const p1 = [cx + Math.cos(a1) * r, baseY, cz + Math.sin(a1) * r]
    const mid = (a0 + a1) / 2
    addTri(t, p0, apex, p1, norm([Math.cos(mid), 0.6, Math.sin(mid)]), mat)
  }
}

// ---------------- 地形 ----------------
const N = CFG.segments
const V = N + 1
const half = CFG.size / 2
const step = CFG.size / N

const heights = new Float32Array(V * V)
for (let j = 0; j < V; j++) {
  for (let i = 0; i < V; i++) {
    heights[j * V + i] = heightAt(-half + i * step, -half + j * step)
  }
}

const ground = newTarget()
for (let j = 0; j < V; j++) {
  for (let i = 0; i < V; i++) {
    const k = j * V + i
    const hl = heights[j * V + Math.max(0, i - 1)]
    const hr = heights[j * V + Math.min(V - 1, i + 1)]
    const hd = heights[Math.max(0, j - 1) * V + i]
    const hu = heights[Math.min(V - 1, j + 1) * V + i]
    pushVert(ground, [-half + i * step, heights[k], -half + j * step], norm([hl - hr, 2 * step, hd - hu]))
  }
}

for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const a = j * V + i
    const b = a + 1
    const c = a + V
    const d = c + 1
    for (const tri of [[a, c, b], [b, c, d]]) {
      const avg = (heights[tri[0]] + heights[tri[1]] + heights[tri[2]]) / 3
      let bi = BANDS.findIndex((band) => band.test(avg))
      if (bi < 0) bi = BANDS.length - 1
      ground.buckets[bi].push(tri[0], tri[1], tri[2])
    }
  }
}

// 碰撞体：只有地形，一棵树都不参与（树的三角形又大又碎，PhysX 只会报警）
const colliderIndices = []
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const a = j * V + i
    const b = a + 1
    const c = a + V
    const d = c + 1
    colliderIndices.push(a, c, b, b, c, d)
  }
}

// ---------------- 选点：小屋 + 篝火 ----------------
const HX = 3.0
const HZ = 2.25
const MARGIN = 0.6
const EX = HX + MARGIN
const EZ = HZ + MARGIN

function footprintStats(cx, cz) {
  let min = Infinity
  let max = -Infinity
  const n = 7
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const h = heightAt(cx - EX + (2 * EX * i) / (n - 1), cz - EZ + (2 * EZ * j) / (n - 1))
      if (h < min) min = h
      if (h > max) max = h
    }
  }
  return { min, max, dev: max - min }
}

// 小屋要落在山顶那块台地上（林间空地），而不是斜着的林子里。
// 两遍扫：2 米粗扫定位，再在附近按 0.1 米细化两轴。
function scanSite(x0, x1, z0, z1, stepX) {
  let best = null
  for (let x = x0; x <= x1; x += stepX) {
    for (let z = z0; z <= z1; z += stepX) {
      const s = footprintStats(x, z)
      if (s.max < 21) continue
      if (!best || s.dev < best.dev) best = { x, z, y: s.max, min: s.min, dev: s.dev }
    }
  }
  return best
}

let cabin = scanSite(-40, 40, -40, 40, 1)
if (!cabin) throw new Error('找不到山顶台地')
{
  const coarse = cabin
  const fx = scanSite(coarse.x - 1, coarse.x + 1, coarse.z, coarse.z, 0.1)
  const fz = scanSite(fx.x, fx.x, coarse.z - 1, coarse.z + 1, 0.1)
  cabin = [coarse, fx, fz].filter(Boolean).reduce((a, b) => (a.dev <= b.dev ? a : b))
}
cabin.slope = slopeDeg(cabin.x, cabin.z)

// 篝火：小屋旁边 4.6 米，取那一圈里最平的点
let fire = null
for (let a = 0; a < 360; a += 3) {
  const rad = (a * Math.PI) / 180
  const fx = cabin.x + Math.cos(rad) * 4.6
  const fz = cabin.z + Math.sin(rad) * 4.6
  const s = footprintStats(fx, fz)
  if (!fire || s.dev < fire.dev) fire = { x: fx, z: fz, y: s.min, dev: s.dev }
}

// ---------------- 松树 ----------------
// 确定性散布：网格 + 噪声门限，跑两次结果一致（便于复现和比对）
const HASH = (ix, iz) => {
  let h = Math.imul(Math.round(ix * 16) | 0, 374761393) + Math.imul(Math.round(iz * 16) | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const TREE_STEP = 7
const MAX_TREES = 650
const trees = []
const near = (x, z, cx, cz, r) => Math.hypot(x - cx, z - cz) < r

for (let gx = -150; gx <= 150; gx += TREE_STEP) {
  for (let gz = -150; gz <= 150; gz += TREE_STEP) {
    if (Math.hypot(gx, gz) > 150) continue
    const jx = gx + (HASH(gx, gz) - 0.5) * TREE_STEP * 0.9
    const jz = gz + (HASH(gz, gx) - 0.5) * TREE_STEP * 0.9
    const h = heightAt(jx, jz)
    if (h < 2.0 || h > 20) continue
    if (slopeDeg(jx, jz) > 32) continue
    // 小屋周围 13 米、篝火周围 6.5 米留空
    if (near(jx, jz, cabin.x, cabin.z, 13) || near(jx, jz, fire.x, fire.z, 6.5)) continue
    // 密度：噪声门限，让树成群而不是均匀撒
    if (fbm(jx * 0.02 + 31, jz * 0.02 + 17, 3) < 0.44) continue
    if (HASH(jx, jz) < 0.12) continue
    trees.push({ x: jx, z: jz, y: h, s: 0.85 + HASH(jz, jx) * 0.8 })
  }
}

const planted = trees.slice(0, MAX_TREES)
const veg = newTarget()
for (const t of planted) {
  const trunkH = 1.1 * t.s
  const trunkHalf = 0.14 * t.s
  addBox(veg, t.x - trunkHalf, t.y - 0.25, t.z - trunkHalf, t.x + trunkHalf, t.y + trunkH, t.z + trunkHalf, MAT.Trunk)
  for (let i = 0; i < 3; i++) {
    addCone(veg, t.x, t.y + trunkH * 0.45 + i * 0.92 * t.s, t.z, (1.35 - i * 0.34) * t.s, 1.8 * t.s, 6, MAT.Needles)
  }
}

// ---------------- 篝火石圈 + 柴堆 ----------------
const FIRE = { x: fire.x, y: heightAt(fire.x, fire.z), z: fire.z }
for (let i = 0; i < 9; i++) {
  const a = (i / 9) * Math.PI * 2
  const sx = FIRE.x + Math.cos(a) * 0.62
  const sz = FIRE.z + Math.sin(a) * 0.62
  const sy = heightAt(sx, sz)
  const w = 0.15 + HASH(i, 7) * 0.09
  addBox(veg, sx - w, sy - 0.12, sz - w, sx + w, sy + 0.14, sz + w, MAT.Stone)
}
// 柴：四根交错成井字，两层；中间留出炭芯给粒子
addBox(veg, FIRE.x - 0.52, FIRE.y + 0.06, FIRE.z - 0.1, FIRE.x + 0.52, FIRE.y + 0.2, FIRE.z + 0.1, MAT.Log)
addBox(veg, FIRE.x - 0.52, FIRE.y + 0.06, FIRE.z + 0.22, FIRE.x + 0.52, FIRE.y + 0.2, FIRE.z + 0.42, MAT.Log)
addBox(veg, FIRE.x - 0.1, FIRE.y + 0.2, FIRE.z - 0.42, FIRE.x + 0.1, FIRE.y + 0.34, FIRE.z + 0.42, MAT.Log)
addBox(veg, FIRE.x + 0.22, FIRE.y + 0.2, FIRE.z - 0.42, FIRE.x + 0.42, FIRE.y + 0.34, FIRE.z + 0.42, MAT.Log)
// 炭芯：自发光的方块，粒子火苗从这里往上冒
addBox(veg, FIRE.x - 0.22, FIRE.y + 0.04, FIRE.z - 0.22, FIRE.x + 0.22, FIRE.y + 0.13, FIRE.z + 0.22, MAT.Ember)

// ---------------- 水面（与 make-island.mjs 同一套贴岸线算法） ----------------
const waterPositions = new Float32Array(V * V * 3)
for (let k = 0; k < V * V; k++) {
  waterPositions[k * 3] = ground.pos[k * 3]
  waterPositions[k * 3 + 1] = CFG.seaLevel
  waterPositions[k * 3 + 2] = ground.pos[k * 3 + 2]
}
const waterIndices = []
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const a = j * V + i
    const b = a + 1
    const c = a + V
    const d = c + 1
    const avg = (heights[a] + heights[b] + heights[c] + heights[d]) / 4
    if (avg < CFG.seaLevel) waterIndices.push(a, c, b, b, c, d)
  }
}
const waterNrm = new Float32Array(V * V * 3)
for (let k = 0; k < V * V; k++) waterNrm[k * 3 + 1] = 1

const FW = CFG.size / 2
const FO = CFG.radius * 16
const frameQuads = [
  [-FO, -FO, FO, -FW],
  [-FO, FW, FO, FO],
  [-FO, -FW, -FW, FW],
  [FW, -FW, FO, FW],
]
const framePos = []
const frameNrm = []
const frameIdx = []
for (const [x0, z0, x1, z1] of frameQuads) {
  const base = framePos.length / 3
  framePos.push(x0, CFG.seaLevel, z0, x1, CFG.seaLevel, z0, x0, CFG.seaLevel, z1, x1, CFG.seaLevel, z1)
  for (let k = 0; k < 4; k++) frameNrm.push(0, 1, 0)
  frameIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
}

// ---------------- 写 GLB ----------------
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

function bbox(arr) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < arr.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (arr[i + c] < min[c]) min[c] = arr[i + c]
      if (arr[i + c] > max[c]) max[c] = arr[i + c]
    }
  }
  return { min, max }
}

// 一组顶点缓冲 + 每层的索引 → 一个 mesh
function buildMesh(name, t) {
  if (t.verts > 65535) throw new Error(name + ' 顶点数超过 Uint16 上限: ' + t.verts)
  const posF = new Float32Array(t.pos)
  const nrmF = new Float32Array(t.nrm)
  const box = bbox(posF)
  const posView = pushView(Buffer.from(posF.buffer, posF.byteOffset, posF.byteLength), 34962)
  const nrmView = pushView(Buffer.from(nrmF.buffer, nrmF.byteOffset, nrmF.byteLength), 34962)
  const posAcc = pushAccessor(posView, 5126, t.verts, 'VEC3', { min: box.min, max: box.max })
  const nrmAcc = pushAccessor(nrmView, 5126, t.verts, 'VEC3')
  const primitives = []
  t.buckets.forEach((idx, bi) => {
    if (!idx.length) return
    const u16 = new Uint16Array(idx)
    const v = pushView(Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength), 34963)
    const a = pushAccessor(v, 5123, idx.length, 'SCALAR')
    primitives.push({ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: a, material: bi })
  })
  return { name, primitives, posAcc, nrmAcc, box }
}

const materials = ALL_MATS.map((m) => {
  const material = {
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: m.color,
      metallicFactor: 0,
      roughnessFactor: m.rough ?? 0.95,
    },
  }
  if (m.emissive) material.emissiveFactor = m.emissive
  return material
})

const groundMesh = buildMesh('Terrain', ground)
const vegMesh = buildMesh('Vegetation', veg)

// 碰撞体：单 primitive、无材质（glbToNodes.js:73 的硬要求）
const bodyIdx = new Uint16Array(colliderIndices)
const bodyIdxView = pushView(Buffer.from(bodyIdx.buffer, bodyIdx.byteOffset, bodyIdx.byteLength), 34963)
const bodyIdxAcc = pushAccessor(bodyIdxView, 5123, bodyIdx.length, 'SCALAR')

// 水面
const waterMatIndex = materials.length
materials.push({
  name: 'Water',
  alphaMode: 'BLEND',
  pbrMetallicRoughness: {
    baseColorFactor: [0.11, 0.36, 0.55, 0.86],
    metallicFactor: 0.1,
    roughnessFactor: 0.22,
  },
})
const wPosView = pushView(Buffer.from(waterPositions.buffer, waterPositions.byteOffset, waterPositions.byteLength), 34962)
const wNrmView = pushView(Buffer.from(waterNrm.buffer, waterNrm.byteOffset, waterNrm.byteLength), 34962)
const wPosAcc = pushAccessor(wPosView, 5126, V * V, 'VEC3', {
  min: [-half, CFG.seaLevel, -half],
  max: [half, CFG.seaLevel, half],
})
const wNrmAcc = pushAccessor(wNrmView, 5126, V * V, 'VEC3')
const waterPrimitives = []
if (waterIndices.length) {
  const wIdx = new Uint16Array(waterIndices)
  const wIdxView = pushView(Buffer.from(wIdx.buffer, wIdx.byteOffset, wIdx.byteLength), 34963)
  const wIdxAcc = pushAccessor(wIdxView, 5123, wIdx.length, 'SCALAR')
  waterPrimitives.push({ attributes: { POSITION: wPosAcc, NORMAL: wNrmAcc }, indices: wIdxAcc, material: waterMatIndex })
}

const fPos = new Float32Array(framePos)
const fNrm = new Float32Array(frameNrm)
const fIdx = new Uint16Array(frameIdx)
const fPosView = pushView(Buffer.from(fPos.buffer, fPos.byteOffset, fPos.byteLength), 34962)
const fNrmView = pushView(Buffer.from(fNrm.buffer, fNrm.byteOffset, fNrm.byteLength), 34962)
const fPosAcc = pushAccessor(fPosView, 5126, fPos.length / 3, 'VEC3', {
  min: [-FO, CFG.seaLevel, -FO],
  max: [FO, CFG.seaLevel, FO],
})
const fNrmAcc = pushAccessor(fNrmView, 5126, fNrm.length / 3, 'VEC3')
const fIdxView = pushView(Buffer.from(fIdx.buffer, fIdx.byteOffset, fIdx.byteLength), 34963)
const fIdxAcc = pushAccessor(fIdxView, 5123, fIdx.length, 'SCALAR')

const gltf = {
  asset: { version: '2.0', generator: 'make-forest.mjs' },
  scene: 0,
  scenes: [{ name: 'Forest', nodes: [5] }],
  nodes: [
    { name: 'Terrain', mesh: 0 },
    { name: 'Vegetation', mesh: 1 },
    { name: 'Water', mesh: 2 },
    { name: 'OpenSea', mesh: 3 },
    { name: 'TerrainBody', mesh: 4, extras: { node: 'collider' } },
    { name: 'Forest', children: [0, 1, 2, 3, 4], extras: { node: 'rigidbody' } },
  ],
  meshes: [
    { name: groundMesh.name, primitives: groundMesh.primitives },
    { name: vegMesh.name, primitives: vegMesh.primitives },
    { name: 'Water', primitives: waterPrimitives },
    {
      name: 'OpenSea',
      primitives: [{ attributes: { POSITION: fPosAcc, NORMAL: fNrmAcc }, indices: fIdxAcc, material: waterMatIndex }],
    },
    {
      name: 'TerrainBody',
      primitives: [{ attributes: { POSITION: groundMesh.posAcc, NORMAL: groundMesh.nrmAcc }, indices: bodyIdxAcc }],
    },
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
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuffer.length, 8)

const jsonChunkHeader = Buffer.alloc(8)
jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0)
jsonChunkHeader.write('JSON', 4, 'ascii')

const binChunkHeader = Buffer.alloc(8)
binChunkHeader.writeUInt32LE(binBuffer.length, 0)
binChunkHeader.write('BIN\0', 4, 'ascii')

const glb = Buffer.concat([header, jsonChunkHeader, jsonBuf, binChunkHeader, binBuffer])

fs.mkdirSync(path.dirname(path.resolve(CFG.out)), { recursive: true })
fs.writeFileSync(CFG.out, glb)

// 落点信息给入库脚本用（房子实体坐标 + 篝火坐标）
const site = {
  cabin: {
    x: +cabin.x.toFixed(3),
    z: +cabin.z.toFixed(3),
    y: +cabin.y.toFixed(3),
    dev: +cabin.dev.toFixed(3),
    slope: +cabin.slope.toFixed(2),
  },
  fire: { x: +FIRE.x.toFixed(3), y: +FIRE.y.toFixed(3), z: +FIRE.z.toFixed(3) },
  trees: planted.length,
}
fs.writeFileSync(CFG.site, JSON.stringify(site, null, 2) + '\n')

const triTotal = ALL_MATS.reduce(
  (sum, _, i) => sum + ground.buckets[i].length / 3 + veg.buckets[i].length / 3,
  0,
)
console.log(
  JSON.stringify(
    {
      输出文件: path.resolve(CFG.out),
      文件大小: (glb.length / 1048576).toFixed(2) + ' MB',
      顶点: { 地形: ground.verts, 植被: veg.verts },
      三角形: triTotal,
      松树: planted.length,
      材质分层: ALL_MATS.map((m, i) => m.name + '=' + (ground.buckets[i].length + veg.buckets[i].length) / 3).join(' '),
      小屋落点: site.cabin,
      篝火: site.fire,
      高度范围: groundMesh.box.min[1].toFixed(2) + ' ~ ' + groundMesh.box.max[1].toFixed(2),
    },
    null,
    2,
  ),
)
