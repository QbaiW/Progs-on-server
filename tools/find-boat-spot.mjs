// 给小船找停泊点。
//
// 做法分两步，故意的：
//   1) 用解析高度场 heightAt() 快速扫全岛岸线，找出满足条件的候选（快，能扫 12000 个点）；
//   2) 对选中的那个点，用**真地形网格**（island.glb 里的 TerrainBody，61952 三角形）
//      打射线复核 —— 解析值只用来搜，判定必须落在真网格上。
//
// 判定条件（都在「水线 y=0 为原点」的坐标系里算）：
//   · 船体投影范围内海底必须处处 ≤ -0.40 米
//     （吃水 0.30 + 上下浮动 0.035 + 8 厘米余量，保证不蹭底、浮动是真的）
//   · 离岸越近越好（玩家蹚水距离短）；顺带报坡度与平整度
//
// 用法：node tools/find-boat-spot.mjs [地形glb] [小船glb]

import fs from 'node:fs'
import { heightAt, normalAt } from './island-terrain.mjs'

const islandFile = process.argv[2] || 'tools/_verify-island.glb'
const boatFile = process.argv[3] || 'tools/_boat.glb'

// ---------------------------------------------------------------- GLB
function loadGlb(f) {
  const buf = fs.readFileSync(f)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
  const bin = buf.slice(20 + jsonLen + 8)
  const read = (i) => {
    const a = json.accessors[i]
    const bv = json.bufferViews[a.bufferView]
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0)
    const n = a.type === 'VEC3' ? 3 : 1
    const out = new Float64Array(a.count * n)
    for (let k = 0; k < a.count * n; k++) {
      out[k] = a.componentType === 5126 ? bin.readFloatLE(off + k * 4)
        : (a.componentType === 5123 ? bin.readUInt16LE(off + k * 2) : bin.readUInt32LE(off + k * 4))
    }
    return out
  }
  const trisOf = (meshName) => {
    const mi = json.meshes.findIndex((m) => m.name === meshName)
    const prim = json.meshes[mi].primitives[0]
    const pos = read(prim.attributes.POSITION)
    const idx = read(prim.indices)
    const tris = []
    for (let i = 0; i < idx.length; i += 3) {
      const t = []
      for (let k = 0; k < 3; k++) {
        const v = idx[i + k]
        t.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])
      }
      tris.push(t)
    }
    return tris
  }
  return { json, trisOf }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function rayTri(o, d, v0, v1, v2) {
  const e1 = sub(v1, v0)
  const e2 = sub(v2, v0)
  const p = cross(d, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-12) return null
  const inv = 1 / det
  const tv = sub(o, v0)
  const u = dot(tv, p) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return null
  const q = cross(tv, e1)
  const v = dot(d, q) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return null
  const t = dot(e2, q) * inv
  return t > 1e-7 ? t : null
}

// ---------------------------------------------------------------- 真网格（分格加速）
const island = loadGlb(islandFile)
const terrain = island.trisOf('TerrainBody')
console.log(`真地形网格: ${terrain.length} 三角形`)

const CELL = 8
const buckets = new Map()
const bkey = (cx, cz) => `${cx}|${cz}`
for (const t of terrain) {
  const xs = [t[0][0], t[1][0], t[2][0]]
  const zs = [t[0][2], t[1][2], t[2][2]]
  const x0 = Math.floor(Math.min(...xs) / CELL)
  const x1 = Math.floor(Math.max(...xs) / CELL)
  const z0 = Math.floor(Math.min(...zs) / CELL)
  const z1 = Math.floor(Math.max(...zs) / CELL)
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const k = bkey(cx, cz)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(t)
    }
  }
}

// 竖直向下打射线，取最高的命中面 = 该处地表/海底高度
function meshHeight(x, z) {
  const list = buckets.get(bkey(Math.floor(x / CELL), Math.floor(z / CELL)))
  if (!list) return null
  let best = -Infinity
  for (const t of list) {
    const tt = rayTri([x, 500, z], [0, -1, 0], t[0], t[1], t[2])
    if (tt !== null) {
      const y = 500 - tt
      if (y > best) best = y
    }
  }
  return best === -Infinity ? null : best
}

// ---------------------------------------------------------------- 船体投影轮廓
// 与 make-boat.mjs 的站位表一致（用舷缘半宽，取最宽处，偏保守）
const OUTLINE = [
  [-2.20, 0.64], [-1.70, 0.68], [-0.90, 0.72], [0.00, 0.72],
  [0.85, 0.70], [1.50, 0.54], [1.87, 0.28], [2.00, 0.05],
]
function outlineHalf(z) {
  if (z <= OUTLINE[0][0]) return OUTLINE[0][1]
  if (z >= OUTLINE[OUTLINE.length - 1][0]) return OUTLINE[OUTLINE.length - 1][1]
  for (let i = 0; i < OUTLINE.length - 1; i++) {
    const [z0, h0] = OUTLINE[i]
    const [z1, h1] = OUTLINE[i + 1]
    if (z >= z0 && z <= z1) return h0 + (h1 - h0) * ((z - z0) / (z1 - z0))
  }
  return 0.05
}

// 在船体投影内采样：返回 [x,z] 世界坐标数组
function footprint(ox, oz, ux, uz) {
  const pts = []
  // 局部 +Z 是船头方向 u；局部 +X 是右舷 = (uz, -ux)（水平面内右手系）
  const rx = uz
  const rz = -ux
  for (let lz = -2.20; lz <= 2.0001; lz += 0.1) {
    const h = outlineHalf(lz)
    const step = Math.max(0.08, h / 3)
    for (let lx = -h; lx <= h + 1e-9; lx += step) {
      pts.push([ox + ux * lz + rx * lx, oz + uz * lz + rz * lx])
    }
  }
  return pts
}

function trackStats(ox, oz, ux, uz, fn) {
  const pts = footprint(ox, oz, ux, uz)
  let mn = Infinity
  let mx = -Infinity
  let bad = 0
  for (const [x, z] of pts) {
    const h = fn(x, z)
    if (h === null) { bad++; continue }
    if (h < mn) mn = h
    if (h > mx) mx = h
  }
  return { mn, mx, bad, n: pts.length }
}

// 横向倾斜：同一横剖面上左右舷海底的高度差（越小平得越平）
function crossTilt(ox, oz, ux, uz, fn) {
  const rx = uz
  const rz = -ux
  let worst = 0
  for (let lz = -2.0; lz <= 1.8001; lz += 0.4) {
    const h = outlineHalf(lz)
    const a = fn(ox + ux * lz - rx * h, oz + uz * lz - rz * h)
    const b = fn(ox + ux * lz + rx * h, oz + uz * lz + rz * h)
    if (a !== null && b !== null) worst = Math.max(worst, Math.abs(a - b))
  }
  return worst
}

// ---------------------------------------------------------------- 扫描岸线
const CLEAR = -0.40          // 海底必须低于这个值
const DECK_TOP = 0.26        // 尾板顶面（上船那一级）
const MIN_LOW = -0.335       // 船体最低点（吃水 0.30 + 浮动 0.035）

const cands = []
for (let deg = 0; deg < 360; deg += 2) {
  const th = (deg * Math.PI) / 180
  const dx = Math.cos(th)
  const dz = Math.sin(th)
  // 从岛内往岛外走，找第一个 h <= 0 的地方
  let rHit = null
  for (let r = 100; r <= 178; r += 0.4) {
    if (heightAt(dx * r, dz * r) <= 0) { rHit = r; break }
  }
  if (rHit === null) continue
  // 二分细化到 1 厘米
  let lo = rHit - 0.4
  let hi = rHit
  for (let k = 0; k < 12; k++) {
    const mid = (lo + hi) / 2
    if (heightAt(dx * mid, dz * mid) <= 0) hi = mid
    else lo = mid
  }
  const px = dx * hi
  const pz = dz * hi
  // 高度场的法线 n ∝ (-∂h/∂x, 1, -∂h/∂z)，所以水平分量就是下坡方向（朝海）
  // —— 符号别搞反：朝外下坡的方向 = +n 的水平分量，不是 -n。
  const n = normalAt(px, pz, 1.5)
  let ux = n[0]
  let uz = n[2]
  const ul = Math.hypot(ux, uz) || 1
  ux /= ul
  uz /= ul
  // 从靠岸处往外试，找第一个「整条船底都 ≤ CLEAR」的位置
  const ok = (tt) => {
    const s = trackStats(px + ux * tt, pz + uz * tt, ux, uz, (x, z) => heightAt(x, z))
    return s.mx <= CLEAR && s.bad === 0
  }
  let t = null
  for (let tt = 0.25; tt <= 9; tt += 0.25) {
    if (ok(tt)) { t = tt; break }
  }
  if (t === null) continue
  // 二分细化到 1 厘米（贴着约束边界停靠，蹚水最短）
  let tlo = t - 0.25
  let thi = t
  for (let k = 0; k < 12; k++) {
    const mid = (tlo + thi) / 2
    if (ok(mid)) thi = mid
    else tlo = mid
  }
  t = thi
  const ox = px + ux * t
  const oz = pz + uz * t
  const s = trackStats(ox, oz, ux, uz, (x, z) => heightAt(x, z))
  const tilt = crossTilt(ox, oz, ux, uz, (x, z) => heightAt(x, z))
  // 蹚水距离 = 船尾到岸线的距离
  const wade = t - 2.20
  cands.push({ deg, px, pz, ux, uz, t, ox, oz, minH: s.mn, maxH: s.mx, wade, rough: s.mx - s.mn, tilt })
}

cands.sort((a, b) => a.wade - b.wade || a.tilt - b.tilt || a.rough - b.rough)
console.log(`\n解析扫描：${cands.length} 个可用候选（岸边走向 2° 一个），按蹚水距离排序：`)
console.log('  方位   岸点(x,z)              下坡方向        蹚水   船底最深/最浅     起伏   横向倾斜')
for (const c of cands.slice(0, 10)) {
  console.log(`  ${String(c.deg).padStart(3)}°  (${c.px.toFixed(1)},${c.pz.toFixed(1)})`.padEnd(30)
    + `(${c.ux.toFixed(2)},${c.uz.toFixed(2)})`.padEnd(18)
    + `${c.wade.toFixed(2)}m`.padEnd(8)
    + `${c.minH.toFixed(3)} / ${c.maxH.toFixed(3)}`.padEnd(20)
    + `${c.rough.toFixed(3)}`.padEnd(8)
    + `${c.tilt.toFixed(3)}`)
}

// ---------------------------------------------------------------- 真网格复核
// 选：先按蹚水距离取前 12 个，再取其中横向倾斜最小的（船坐得平）
const shortlist = cands.slice(0, 12).sort((a, b) => a.tilt - b.tilt || a.rough - b.rough)
const best = shortlist[0]

// 真网格再裁决 + 往外挪：解析高度场与三角网格在岸边有毫米级差异，
// 贴着约束边界挑选时「最浅处」会超标（实测差 5 毫米），所以最终位置
// 必须由真地形网格点头，必要时以 2 厘米为步长往外让。
for (let k = 0; k < 80; k++) {
  const ox = best.px + best.ux * best.t
  const oz = best.pz + best.uz * best.t
  const ms = trackStats(ox, oz, best.ux, best.uz, meshHeight)
  if (ms.mx <= CLEAR && ms.bad === 0) {
    best.ox = ox
    best.oz = oz
    best.wade = best.t - 2.20
    break
  }
  best.t += 0.02
}

console.log(`\n选中：方位 ${best.deg}°，岸点 (${best.px.toFixed(2)}, ${best.pz.toFixed(2)})，`
  + `船位 (${best.ox.toFixed(2)}, ${best.oz.toFixed(2)})，蹚水 ${best.wade.toFixed(2)} 米`)

const meshStats = trackStats(best.ox, best.oz, best.ux, best.uz, meshHeight)
const anaStats = trackStats(best.ox, best.oz, best.ux, best.uz, (x, z) => heightAt(x, z))

console.log(`\n真地形网格复核（船体投影内 ${meshStats.n} 个采样点）：`)
console.log(`  海底最低 ${meshStats.mn.toFixed(3)}   最高 ${meshStats.mx.toFixed(3)}   起伏 ${(meshStats.mx - meshStats.mn).toFixed(3)}   未命中 ${meshStats.bad}`)
console.log(`  解析场对比：最低 ${anaStats.mn.toFixed(3)}  最高 ${anaStats.mx.toFixed(3)}  （差 ${(meshStats.mx - anaStats.mx).toFixed(3)}）`)

// 沿船轴的水深剖面（真网格）
console.log(`\n沿船轴的真实水深剖面（船尾 -2.20 → 船头 +2.00）：`)
const prof = []
for (let lz = -2.20; lz <= 2.001; lz += 0.4) {
  const x = best.ox + best.ux * lz
  const z = best.oz + best.uz * lz
  const mh = meshHeight(x, z)
  prof.push(`  ${lz >= 0 ? '+' : ''}${lz.toFixed(2)}  海底 ${mh === null ? '未命中' : mh.toFixed(3)}`)
}
console.log(prof.join('\n'))

const sternH = meshHeight(best.ox - best.ux * 2.2, best.oz - best.uz * 2.2)
const shoreH = meshHeight(best.px, best.pz)
console.log(`\n上船条件（真网格）：`)
console.log(`  岸线处地面 ${shoreH === null ? '?' : shoreH.toFixed(3)}`)
console.log(`  船尾正下方海底 ${sternH === null ? '?' : sternH.toFixed(3)}`)
if (sternH !== null) {
  const feet = sternH
  console.log(`  玩家站在船尾旁：脚底 ${feet.toFixed(3)}，水深 ${(0 - feet).toFixed(3)} 米`)
  console.log(`  踩上尾板顶（+${DECK_TOP}）需要抬升 ${(DECK_TOP - feet).toFixed(3)} 米`)
  console.log(`  引擎跳跃初速给的抬升 ≈ 1.5 米（PlayerLocal.js jumpHeight），${DECK_TOP - feet <= 1.4 ? '跳得上去 ✓' : '要游泳才行 ✗'}`)
  console.log(`  船体最低点 ${MIN_LOW} vs 船尾海底 ${sternH.toFixed(3)} → ${MIN_LOW >= sternH ? '整体浮着没蹭底 ✓' : '会蹭底 ✗'}`)
}

// 偏航角：本地 +Z（船头）对准下坡方向 u
const yaw = Math.atan2(best.ux, best.uz)
const qy = Math.sin(yaw / 2)
const qw = Math.cos(yaw / 2)

console.log(`\n================ 写进世界的数据 ================`)
console.log(`实体 position: [${best.ox.toFixed(3)}, 0, ${best.oz.toFixed(3)}]`)
console.log(`实体 quaternion: [0, ${qy.toFixed(6)}, 0, ${qw.toFixed(6)}]      (yaw = ${(yaw * 180 / Math.PI).toFixed(1)}°)`)
console.log(`船头朝向: (${best.ux.toFixed(3)}, 0, ${best.uz.toFixed(3)})  —— 船头朝海、船尾朝岸`)
console.log(`吃水线以下 ${(-MIN_LOW).toFixed(3)} 米、以上 ${(0.347).toFixed(3)} 米；所有判定：${meshStats.mx <= CLEAR ? '海底处处 ≥0.40 米深 ✓' : '不满足 ✗'}`)

// ---------------------------------------------------------------- 水面网格覆盖
// 水面是另一个网格（Water primitive，只在地形低于海平面的格子上生成三角形）。
// 船的落脚点必须落在它真有三角形的地方，否则船看上去浮在沙子上。
const water = island.trisOf('Water')
const wb = new Map()
for (const t of water) {
  const xs = [t[0][0], t[1][0], t[2][0]]
  const zs = [t[0][2], t[1][2], t[2][2]]
  for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
    for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
      const k = bkey(cx, cz)
      if (!wb.has(k)) wb.set(k, [])
      wb.get(k).push(t)
    }
  }
}
function waterHeight(x, z) {
  const list = wb.get(bkey(Math.floor(x / CELL), Math.floor(z / CELL)))
  if (!list) return null
  let bestY = -Infinity
  for (const t of list) {
    const tt = rayTri([x, 500, z], [0, -1, 0], t[0], t[1], t[2])
    if (tt !== null) {
      const y = 500 - tt
      if (y > bestY) bestY = y
    }
  }
  return bestY === -Infinity ? null : bestY
}
const wpts = footprint(best.ox, best.oz, best.ux, best.uz)
let wHit = 0
for (const [x, z] of wpts) if (waterHeight(x, z) !== null) wHit++
const probe = (name, x, z) => {
  const w = waterHeight(x, z)
  console.log(`  ${name.padEnd(10)} (${x.toFixed(1)},${z.toFixed(1)})  水面 ${w === null ? '无 ✗' : `${w.toFixed(3)} ✓`}`)
}
console.log(`\n水面网格覆盖（${water.length} 三角形，船体投影内 ${wHit}/${wpts.length} 点有水面）：`)
probe('船尾', best.ox - best.ux * 2.2, best.oz - best.uz * 2.2)
probe('船中', best.ox, best.oz)
probe('船头', best.ox + best.ux * 2.0, best.oz + best.uz * 2.0)
probe('岸线', best.px, best.pz)
console.log(`  结论：${wHit === wpts.length ? '船体投影内处处有水面 ✓' : '有采样点在水面网格之外 ✗'}`)
