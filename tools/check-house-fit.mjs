// tools/check-house-fit.mjs
// 用「真实碰撞网格」验证房子在岛上的贴合 —— 不看解析函数 heightAt，直接用地形 TerrainBody
// 的三角面插值，因为地形网格间距约 4 米，而房子占地只有 6.9×5.9 米，两者会差出可观的距离。
//
// 被验证的两个网格（都是零节点变换，顶点即世界坐标）：
//   _verify-island.glb  mesh[3] TerrainBody  (extras.node='collider')  ← 你实际踩的地面
//   _house.glb          mesh[1] HouseBody    (extras.node='collider')  ← 房子的碰撞体
// 房子的世界坐标 = 实体位置 +（本地坐标 × 单位四元数）

import fs from 'fs'

const ISLAND = 'tools/_verify-island.glb'
const HOUSE = 'tools/_house.glb'
const ENTITY_POS = [-5, 24.651, -1] // 写进 world2/entities 的 position
const PLINTH_BOTTOM = -1.2 // 本地 y：地基底面
const FLOOR_SLAB_TOP = 0.02 // 本地 y：一层可行走面（面层顶）
const PLINTH_TOP = 0.0 // 本地 y：地基结构顶面 = 面层底面
const STEP = 0.05 // 采样步长

// ---------- GLB 解析 ----------
function parseGLB(path) {
  const b = fs.readFileSync(path)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${path} 不是 GLB`)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)))
  const off = 20 + jsonLen
  const binLen = dv.getUint32(off, true)
  const binType = dv.getUint32(off + 4, true)
  if (binType !== 0x004e4942) throw new Error(`${path} 缺少 BIN chunk`)
  return { json, bin: b.subarray(off + 8, off + 8 + binLen), dv }
}

function readAccessor(g, bin, idx) {
  const a = g.accessors[idx]
  const bv = g.bufferViews[a.bufferView]
  const cs = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]
  const stride = bv.byteStride || cs * n
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const rd = (o) =>
    a.componentType === 5120 ? dv.getInt8(o)
      : a.componentType === 5121 ? dv.getUint8(o)
        : a.componentType === 5122 ? dv.getInt16(o, true)
          : a.componentType === 5123 ? dv.getUint16(o, true)
            : a.componentType === 5125 ? dv.getUint32(o, true)
              : dv.getFloat32(o, true)
  const out = new Array(a.count)
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride
    if (n === 1) out[i] = rd(o)
    else {
      const v = new Array(n)
      for (let c = 0; c < n; c++) v[c] = rd(o + c * cs)
      out[i] = v
    }
  }
  return out
}

function readTris(path, meshIndex) {
  const { json, bin } = parseGLB(path)
  const mesh = json.meshes[meshIndex]
  const tris = []
  for (const prim of mesh.primitives) {
    const P = readAccessor(json, bin, prim.attributes.POSITION)
    const I = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null
    if (I) for (let i = 0; i < I.length; i += 3) tris.push([P[I[i]], P[I[i + 1]], P[I[i + 2]]])
    else for (let i = 0; i < P.length; i += 3) tris.push([P[i], P[i + 1], P[i + 2]])
  }
  return { json, tris }
}

// ---------- 地形高度（三角面插值，不是解析函数） ----------
function terrainTop(x, z, tris) {
  let best = null
  for (const t of tris) {
    const a = t[0], b = t[1], c = t[2]
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if (Math.abs(d) < 1e-12) continue
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
    const l3 = 1 - l1 - l2
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
    const y = l1 * a[1] + l2 * b[1] + l3 * c[1]
    if (best === null || y > best) best = y
  }
  return best
}

// ---------- 开始 ----------
const island = readTris(ISLAND, 3)
const house = readTris(HOUSE, 1)
const P = ENTITY_POS

// 房子碰撞体的世界坐标包围盒
const hx = [], hy = [], hz = []
for (const t of house.tris) for (const v of t) { hx.push(v[0] + P[0]); hy.push(v[1] + P[1]); hz.push(v[2] + P[2]) }
const bx0 = Math.min(...hx), bx1 = Math.max(...hx)
const by0 = Math.min(...hy), by1 = Math.max(...hy)
const bz0 = Math.min(...hz), bz1 = Math.max(...hz)

console.log('=== 输入 ===')
console.log(`地形碰撞网格   : ${island.tris.length} 三角形`)
console.log(`房子碰撞网格   : ${house.tris.length} 三角形`)
console.log(`实体位置       : [${P.join(', ')}]`)
console.log(`房子世界包围盒 : x[${bx0.toFixed(3)}, ${bx1.toFixed(3)}]  y[${by0.toFixed(3)}, ${by1.toFixed(3)}]  z[${bz0.toFixed(3)}, ${bz1.toFixed(3)}]`)
console.log(`  尺寸         : ${(bx1 - bx0).toFixed(2)} × ${(by1 - by0).toFixed(2)} × ${(bz1 - bz0).toFixed(2)} 米`)
console.log(`一层可行走面   : y=${(P[1] + FLOOR_SLAB_TOP).toFixed(3)}   地基底面 : y=${(P[1] + PLINTH_BOTTOM).toFixed(3)}`)

// 只保留占地范围内的地形三角形（射线加速）
const pad = 1.5
const near = island.tris.filter((t) => {
  const ax = Math.min(t[0][0], t[1][0], t[2][0]), bx = Math.max(t[0][0], t[1][0], t[2][0])
  const az = Math.min(t[0][2], t[1][2], t[2][2]), bz = Math.max(t[0][2], t[1][2], t[2][2])
  return bx >= bx0 - pad && ax <= bx1 + pad && bz >= bz0 - pad && az <= bz1 + pad
})
console.log(`占地附近地形三角形: ${near.length} / ${island.tris.length}`)

// 整个占地范围密集采样
let maxTop = -Infinity, minTop = Infinity, maxAt = null, minAt = null, miss = 0, n = 0
for (let x = bx0; x <= bx1 + 1e-9; x += STEP) {
  for (let z = bz0; z <= bz1 + 1e-9; z += STEP) {
    const t = terrainTop(x, z, near)
    n++
    if (t === null) { miss++; continue }
    if (t > maxTop) { maxTop = t; maxAt = [x, z] }
    if (t < minTop) { minTop = t; minAt = [x, z] }
  }
}
console.log('')
console.log('=== 占地内地形的真实起伏（三角面插值） ===')
console.log(`采样 ${n} 点（步长 ${STEP} 米），未命中 ${miss} 点`)
console.log(`地形最高 ${maxTop.toFixed(4)}  在 (${maxAt[0].toFixed(2)}, ${maxAt[1].toFixed(2)})`)
console.log(`地形最低 ${minTop.toFixed(4)}  在 (${minAt[0].toFixed(2)}, ${minAt[1].toFixed(2)})`)
console.log(`起伏 ${(maxTop - minTop).toFixed(4)} 米`)

// ---------- 判定 ----------
const PLINTH_TOP_W = P[1] + PLINTH_TOP
const PLINTH_BOT_W = P[1] + PLINTH_BOTTOM
const FLOOR_W = P[1] + FLOOR_SLAB_TOP
let fail = 0
const say = (ok, msg) => { if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${msg}`) }

console.log('')
console.log('=== 判定 ===')
say(maxTop <= PLINTH_TOP_W,
  `地形不高于地基结构顶面（${maxTop.toFixed(4)} ≤ ${PLINTH_TOP_W.toFixed(4)}，余量 ${(PLINTH_TOP_W - maxTop).toFixed(4)} 米）→ 地形不会顶穿一层地板`)
say(maxTop <= FLOOR_W - 0.02 - 1e-9,
  `地形甚至够不到一层地板面层底面（面层底 ${(FLOOR_W - 0.02).toFixed(4)}）`)
say(minTop >= PLINTH_BOT_W,
  `地形处处高于地基底面（${minTop.toFixed(4)} ≥ ${PLINTH_BOT_W.toFixed(4)}）→ 地基没有悬空露底`)
say(minTop >= P[1] - 0.9,
  `地基最浅处也埋了 ${(minTop - PLINTH_BOT_W).toFixed(3)} 米（≥0.9 米才不会有明显悬空感）`)

// 门口与四角
console.log('')
console.log('=== 关键位置的地面高度 ===')
const probe = (label, x, z) => {
  const t = terrainTop(x, z, near)
  if (t === null) { console.log(`  ${label}: 无地形（悬空！）`); fail++; return }
  console.log(`  ${label}: 地面 y=${t.toFixed(4)}  与一层可行走面(${FLOOR_W.toFixed(3)}) 落差 ${(FLOOR_W - t).toFixed(4)} 米`)
  return t
}
// 门在本地 -Z 墙、本地 x∈[-0.55,0.55] → 世界 z = -1-2.25 = -3.25
const doorT = probe('门口正中   (-5.00, -3.25)', P[0], P[2] - 2.25)
const doorL = terrainTop(P[0] - 0.5, P[2] - 2.25, near)
const doorR = terrainTop(P[0] + 0.5, P[2] - 2.25, near)
console.log(`  ↳ 门洞左右两端地面: ${doorL === null ? '无' : doorL.toFixed(4)} / ${doorR === null ? '无' : doorR.toFixed(4)}`)
probe('门廊外侧   (-5.00, -4.20)', P[0], P[2] - 3.2)
probe('四角 (+X,+Z)', bx1, bz1)
probe('四角 (+X,-Z)', bx1, bz0)
probe('四角 (-X,+Z)', bx0, bz1)
probe('四角 (-X,-Z)', bx0, bz0)

console.log('')
say(doorT !== null && doorT <= FLOOR_W,
  `门口地面不高于室内地面（门槛落差 ${doorT === null ? '—' : (FLOOR_W - doorT).toFixed(4)} 米）→ 不会「地形堵住门」`)
say(doorT !== null && FLOOR_W - doorT <= 0.35,
  `进门台阶不超过 0.35 米（实际 ${doorT === null ? '—' : (FLOOR_W - doorT).toFixed(4)} 米）→ 走得进去`)

// ---------- 烟囱基脚 ----------
// 烟囱挂在 +X 墙外侧（本地 x 2.95~3.52，大部分落在地基轮廓之外），底面在本地 y=-0.40，
// 比地基底面(-1.20)高得多 —— 一般判定（地形处处 ≥ 地基底面）覆盖不到它，必须单独查。
const CHIMNEY_BOTTOM_W = P[1] - 0.4
let chimMin = Infinity, chimMax = -Infinity
for (let x = P[0] + 2.95; x <= P[0] + 3.52 + 1e-9; x += STEP) {
  for (let z = P[2] - 0.52; z <= P[2] + 0.42 + 1e-9; z += STEP) {
    const t = terrainTop(x, z, near)
    if (t === null) continue
    if (t < chimMin) chimMin = t
    if (t > chimMax) chimMax = t
  }
}
console.log('')
console.log('=== 烟囱基脚 ===')
console.log(`  烟囱占地   x[${(P[0] + 2.95).toFixed(2)}, ${(P[0] + 3.52).toFixed(2)}]  z[${(P[2] - 0.52).toFixed(2)}, ${(P[2] + 0.42).toFixed(2)}]`)
console.log(`  烟囱底面   y=${CHIMNEY_BOTTOM_W.toFixed(3)}     该处地形 ${chimMin.toFixed(4)} ~ ${chimMax.toFixed(4)}`)
say(chimMin >= CHIMNEY_BOTTOM_W,
  `烟囱底面埋在地形之下（埋深 ${(chimMin - CHIMNEY_BOTTOM_W).toFixed(3)} 米）→ 不会露出生在半空中的基脚`)

console.log('')
console.log(fail === 0 ? '全部判定通过 ✓' : `有 ${fail} 项不通过`)
process.exit(fail === 0 ? 0 : 1)
