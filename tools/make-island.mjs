// 程序化小岛地形生成器 —— 纯代码，无外部依赖，输出 glTF 2.0 二进制 (.glb)
//
// 设计要点：
//   * 不用任何外部模型资源，形状由噪声 + 岛屿遮罩程序化生成
//   * 按高度把三角形分到 沙 / 草 / 岩 / 雪 四组，各自一个材质
//     （不用顶点色，避免引擎端材质处理差异；也不用贴图，避免外部依赖）
//   * 单独一个半透明水面网格
//   * 不启用任何压缩扩展（Hyperfy 服务端没有 DRACOLoader）
//
// 用法：node tools/make-island.mjs [输出路径]

import fs from 'node:fs'
import path from 'node:path'
import { TERRAIN, heightAt } from './island-terrain.mjs'

// ---------------- 可调参数 ----------------
// size / radius / seaLevel 与 heightAt() 都来自 island-terrain.mjs，
// 保证「盖房子的工具」和「生成地形的工具」用的是同一份数学。
const CFG = {
  ...TERRAIN,
  segments: 176,      // 网格分段数
  out: process.argv[2] || 'island.glb',
}

// ---------------- 材质分层的阈值 ----------------
// 与当前穹顶高度（中心约 26 米）匹配，雪线拉到 21 米形成明显的雪顶
const BANDS = [
  { name: 'Sand', test: (h) => h < 1.6, color: [0.78, 0.71, 0.50, 1] },
  { name: 'Grass', test: (h) => h < 14, color: [0.28, 0.47, 0.20, 1] },
  { name: 'Rock', test: (h) => h < 21, color: [0.42, 0.40, 0.38, 1] },
  { name: 'Snow', test: () => true, color: [0.95, 0.97, 1.0, 1] },
]

// ---------------- 构建几何 ----------------
const N = CFG.segments
const V = N + 1
const half = CFG.size / 2
const step = CFG.size / N

const positions = new Float32Array(V * V * 3)
const normals = new Float32Array(V * V * 3)
const heights = new Float32Array(V * V)

for (let j = 0; j < V; j++) {
  for (let i = 0; i < V; i++) {
    const x = -half + i * step
    const z = -half + j * step
    const h = heightAt(x, z)
    const k = j * V + i
    heights[k] = h
    positions[k * 3] = x
    positions[k * 3 + 1] = h
    positions[k * 3 + 2] = z
  }
}

// 法线：由高度场做中心差分
for (let j = 0; j < V; j++) {
  for (let i = 0; i < V; i++) {
    const k = j * V + i
    const hl = heights[j * V + Math.max(0, i - 1)]
    const hr = heights[j * V + Math.min(V - 1, i + 1)]
    const hd = heights[Math.max(0, j - 1) * V + i]
    const hu = heights[Math.min(V - 1, j + 1) * V + i]
    let nx = hl - hr
    let ny = 2 * step
    let nz = hd - hu
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    normals[k * 3] = nx
    normals[k * 3 + 1] = ny
    normals[k * 3 + 2] = nz
  }
}

// 三角形按平均高度分桶
const buckets = BANDS.map(() => [])
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
      buckets[bi].push(tri[0], tri[1], tri[2])
    }
  }
}

// ---------------- 水面 ----------------
// 关键修正：以前用一个大平面盖在 y=0，而岛从中心升到十几米，
// 那个平面会直接从山体中间穿过去，到处是"水在割岛"的穿模。
// 现在改成：复用同一套地形网格，只在地形真正低于海平面的格子生成三角形。
// 水面因此永远贴着岸线走，不可能切进山体。
const waterPositions = new Float32Array(V * V * 3)
for (let k = 0; k < V * V; k++) {
  waterPositions[k * 3] = positions[k * 3]
  waterPositions[k * 3 + 1] = CFG.seaLevel
  waterPositions[k * 3 + 2] = positions[k * 3 + 2]
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
const waterIdx = new Uint16Array(waterIndices)

// 地形网格之外的远海：四片大矩形拼成外框，延伸到地平线。
// 那一片本来就没有地形，所以同样不存在穿模问题。
const FW = CFG.size / 2          // 地形半边长
const FO = CFG.radius * 16       // 外框半边长
const frameQuads = [
  // [x0,z0, x1,z1] 逆时针
  [-FO, -FO, FO, -FW],   // 北
  [-FO, FW, FO, FO],     // 南
  [-FO, -FW, -FW, FW],   // 西
  [FW, -FW, FO, FW],     // 东
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

// ---------------- 组装 GLB ----------------
const pad4 = (n) => (n + 3) & ~3

function alignBuffer(buf, fill = 0) {
  const rem = buf.length % 4
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(4 - rem, fill)])
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

// 共用顶点缓冲
const posBuf = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength)
const nrmBuf = Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength)
const posView = pushView(posBuf, 34962)
const nrmView = pushView(nrmBuf, 34962)

const minP = [Infinity, Infinity, Infinity]
const maxP = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < positions.length; i += 3) {
  for (let c = 0; c < 3; c++) {
    const v = positions[i + c]
    if (v < minP[c]) minP[c] = v
    if (v > maxP[c]) maxP[c] = v
  }
}
const posAcc = pushAccessor(posView, 5126, V * V, 'VEC3', { min: minP, max: maxP })
const nrmAcc = pushAccessor(nrmView, 5126, V * V, 'VEC3')

// 每个材质桶一个索引访问器
const materials = []
const primitives = []
BANDS.forEach((band, bi) => {
  const idx = buckets[bi]
  materials.push({
    name: band.name,
    pbrMetallicRoughness: {
      baseColorFactor: band.color,
      metallicFactor: 0,
      roughnessFactor: 0.95,
    },
  })
  if (!idx.length) return
  const u16 = new Uint16Array(idx)
  const v = pushView(Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength), 34963)
  const a = pushAccessor(v, 5123, idx.length, 'SCALAR')
  primitives.push({
    attributes: { POSITION: posAcc, NORMAL: nrmAcc },
    indices: a,
    material: bi,
  })
})

// 水面网格（视觉）：贴岸线的网格水面 + 外框远海
const waterMatIndex = materials.length
materials.push({
  name: 'Water',
  alphaMode: 'BLEND',
  doubleSided: false,
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
if (waterIdx.length) {
  const wIdxView = pushView(Buffer.from(waterIdx.buffer, waterIdx.byteOffset, waterIdx.byteLength), 34963)
  const wIdxAcc = pushAccessor(wIdxView, 5123, waterIdx.length, 'SCALAR')
  waterPrimitives.push({ attributes: { POSITION: wPosAcc, NORMAL: wNrmAcc }, indices: wIdxAcc, material: waterMatIndex })
}

// 外框远海（地形网格之外，那里的地形本来就不存在，不会穿模）
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

// ---------------- 碰撞体网格 ----------------
// glbToNodes.js 里写得很明白：
//   else if (props.node === 'collider' && object3d.isMesh)
// 注释原文：单个对象如果带 collider 标记却有多种材质，导出后会被包成 Group，
// 标记落在 Group 上而不是 Mesh 上，"it won't work as expected"，
// 并且明确要求 "colliders should not have materials on them"。
//
// 我的地形为了分 沙/草/岩/雪 用了 4 个 primitive —— 正是这个情况，
// 所以碰撞体从头到尾就没生成过，人自然"没有地方可以踩"。
//
// 解决：单独做一个只有一个 primitive、且不指定材质的碰撞网格。
// 顶点复用同一份 POSITION/NORMAL，只多一条索引缓冲，体积几乎不增加。
const allIdx = new Uint16Array(N * N * 6)
let ai = 0
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const a = j * V + i
    const b = a + 1
    const c = a + V
    const d = c + 1
    allIdx[ai++] = a; allIdx[ai++] = c; allIdx[ai++] = b
    allIdx[ai++] = b; allIdx[ai++] = c; allIdx[ai++] = d
  }
}
const bodyIdxView = pushView(Buffer.from(allIdx.buffer, allIdx.byteOffset, allIdx.byteLength), 34963)
const bodyIdxAcc = pushAccessor(bodyIdxView, 5123, allIdx.length, 'SCALAR')

const gltf = {
  asset: { version: '2.0', generator: 'make-island.mjs' },
  scene: 0,
  scenes: [{ name: 'Island', nodes: [4] }],
  // Hyperfy 通过 glTF 节点的 extras.node 标记建立物理体：
  //   "rigidbody" —— 刚体根节点
  //   "collider"  —— 用该节点(必须是单个 Mesh)的几何体作为碰撞形状
  nodes: [
    { name: 'Terrain', mesh: 0 },
    { name: 'Water', mesh: 1 },
    { name: 'OpenSea', mesh: 2 },
    { name: 'TerrainBody', mesh: 3, extras: { node: 'collider' } },
    { name: 'Island', children: [0, 1, 2, 3], extras: { node: 'rigidbody' } },
  ],
  meshes: [
    { name: 'Terrain', primitives },
    { name: 'Water', primitives: waterPrimitives },
    { name: 'OpenSea', primitives: [{ attributes: { POSITION: fPosAcc, NORMAL: fNrmAcc }, indices: fIdxAcc, material: waterMatIndex }] },
    // 碰撞网格：单 primitive、不指定材质
    { name: 'TerrainBody', primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: bodyIdxAcc }] },
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

fs.mkdirSync(path.dirname(path.resolve(CFG.out)), { recursive: true })
fs.writeFileSync(CFG.out, glb)

// ---------------- 自检 ----------------
const triTotal = buckets.reduce((a, b) => a + b.length / 3, 0)
const stats = {
  输出文件: path.resolve(CFG.out),
  文件大小: (glb.length / 1048576).toFixed(2) + ' MB',
  顶点数: V * V,
  三角形数: triTotal,
  材质分层: BANDS.map((b, i) => `${b.name}=${buckets[i].length / 3}`).join('  '),
  水面三角形: waterIdx.length / 3,
  高度范围: `${minP[1].toFixed(2)} ~ ${maxP[1].toFixed(2)}`,
  平面范围: `${minP[0]} ~ ${maxP[0]}`,
  使用扩展: Object.keys(gltf.extensionsUsed || {}).length ? gltf.extensionsUsed : '无',
}
console.log(JSON.stringify(stats, null, 2))
