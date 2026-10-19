// check-boat-slide.mjs —— 离线验证 boat.js v3 的「走位 + 搁浅绕行」逻辑
//
// 把 boat.js v3 里的 hullFloor / deepEnough / advance 逐行搬过来（同样的 AHEAD/MIN_DEPTH/FLOOR），
// 用一个虚拟的「拉绳者沿岸走」驱动它，再独立地用更密的船体投影采样检查有没有蹭底。
//
// 用法: node tools/check-boat-slide.mjs

import { heightAt } from './island-terrain.mjs'

const DT = 1 / 30
const ROPE = 3.2
const SPEED = 1.6
const TURN = 1.5
const MIN_DEPTH = 0.55 // 前方探深要求（早警告，让它提前偏开）
const FLOOR = 0.36 // 船体投影下任何一点都不得浅于这个（吃水 0.30 + 浮动 0.035 + 余量）
const SLIDE_MAX = 80
const AHEAD = 2.5
const ROPE_MAX = ROPE * 4
const DRAFT = 0.30

const START = { x: -142.855, z: -35.609, yaw: -103.9 * Math.PI / 180 }

// 船体投影轮廓（与 make-boat.mjs 的站位表一致）
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

// —— 独立检查用：密采样（和引擎无关，纯粹算几何）——
function hullMinDepthFine(x, z, yaw) {
  const ux = Math.sin(yaw)
  const uz = Math.cos(yaw)
  const rx = uz
  const rz = -ux
  let mn = Infinity
  for (let lz = -2.20; lz <= 2.0001; lz += 0.1) {
    const h = outlineHalf(lz)
    const step = Math.max(0.08, h / 3)
    for (let lx = -h; lx <= h + 1e-9; lx += step) {
      const d = -heightAt(x + ux * lz + rx * lx, z + uz * lz + rz * lx)
      if (d < mn) mn = d
    }
  }
  return mn
}

// ---------------------------------------------------------------- v3 的走位逻辑
const ANG = [0, 15, 30, 45, 60, 75, 90]

function makeBoat(rest) {
  let slideSide = 1
  let slideAng = 0
  let slid = 0
  let probes = 0
  let blocks = 0

  // 船体投影下最浅的海底（脚本里这是在引擎里打射线，这里直接查解析高度）
  // 脚本里的采样点要避开船自己的船帮，所以外扩 0.16 米；这里保持一致
  const HULL_MARGIN = 0.16
  const HULL_Z = [-2.2, -1.65, -1.1, -0.55, 0, 0.55, 1.1, 1.65, 2.0]

  function hullFloor(x, z, yaw) {
    const ux = Math.sin(yaw)
    const uz = Math.cos(yaw)
    const rx = uz
    const rz = -ux
    let mn = Infinity
    for (let i = 0; i < HULL_Z.length; i++) {
      const lz = HULL_Z[i]
      const h = outlineHalf(lz) + HULL_MARGIN
      for (let s = -1; s <= 1; s += 2) {
        const d = -heightAt(x + ux * lz + rx * h * s, z + uz * lz + rz * h * s)
        if (d < mn) mn = d
      }
    }
    return mn
  }

  function deepEnough(x, z, ux, uz) {
    probes++
    return heightAt(x + ux * AHEAD, z + uz * AHEAD) <= -MIN_DEPTH
  }

  // 朝 (ux,uz) 挪 dist：硬条件是船体投影都不能浅于 FLOOR；
  // 首选前方也够深的方向，找不到就退而求其次贴着浅滩滑。
  function advance(ux, uz, dist, maxDeg, yaw) {
    slideAng = 0
    const last = Math.max(0, Math.min(ANG.length - 1, Math.round(maxDeg / 15)))
    let fallback = null
    for (let i = 0; i <= last; i++) {
      const base = ANG[i]
      for (let s = 0; s < (i === 0 ? 1 : 2); s++) {
        const side = i === 0 ? 0 : s === 0 ? slideSide : -slideSide
        const ang = base * side
        const rad = ang * Math.PI / 180
        const cs = Math.cos(rad)
        const sn = Math.sin(rad)
        const dx = ux * cs + uz * sn
        const dz = -ux * sn + uz * cs
        const nx = rest.x + dx * dist
        const nz = rest.z + dz * dist
        if (hullFloor(nx, nz, yaw) < FLOOR) continue
        if (deepEnough(nx, nz, dx, dz)) {
          rest.x = nx
          rest.z = nz
          if (i > 0) { slideSide = side; slid++ }
          slideAng = ang
          return true
        }
        if (!fallback) fallback = { nx: nx, nz: nz, ang: ang, side: side }
      }
    }
    if (fallback) {
      rest.x = fallback.nx
      rest.z = fallback.nz
      if (fallback.ang) { slideSide = fallback.side; slid++ }
      slideAng = fallback.ang
      return true
    }
    blocks++
    return false
  }

  // 只在转过去之后船体仍然合法时才转
  function turnTo(yaw, maxStep) {
    let diff = yaw - rest.yaw
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    const mt = maxStep
    const step = diff > mt ? mt : diff < -mt ? -mt : diff
    if (step === 0) return
    const ny = rest.yaw + step
    if (hullFloor(rest.x, rest.z, ny) < FLOOR) return
    rest.yaw = ny
  }

  return {
    rest,
    advance,
    turnTo,
    hullFloor,
    get slideAng() { return slideAng },
    get slid() { return slid },
    get probes() { return probes },
    get blocks() { return blocks },
  }
}

// ---------------------------------------------------------------- 沿岸沙滩走道
function shoreAt(theta, target) {
  let lo = 60
  let hi = 220
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (heightAt(Math.cos(theta) * mid, Math.sin(theta) * mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const theta0 = Math.atan2(START.z, START.x)
console.log('泊位 (' + START.x.toFixed(2) + ', ' + START.z.toFixed(2) + ')，离岛心 ' + Math.hypot(START.x, START.z).toFixed(1) + ' 米')
console.log('船体投影下最浅海底（泊位处）: ' + hullMinDepthFine(START.x, START.z, START.yaw).toFixed(3) + ' 米（吃水 ' + DRAFT + '）')
console.log('')

// ---------------------------------------------------------------- 试 1：人在岸上沿岸走，缆绳拖船
{
  const rest = { x: START.x, z: START.z, yaw: START.yaw }
  const boat = makeBoat(rest)
  const WALK = 1.4
  let theta = theta0
  let minHull = Infinity
  let maxDist = 0
  let released = false
  let moved = 0
  let stuck = 0
  const path = []
  const steps = Math.round(70 / DT)

  for (let i = 0; i < steps; i++) {
    const r = shoreAt(theta, 0.25)
    theta += (WALK * DT) / r
    const px = Math.cos(theta) * shoreAt(theta, 0.25)
    const pz = Math.sin(theta) * shoreAt(theta, 0.25)

    const dx = px - rest.x
    const dz = pz - rest.z
    const dist = Math.hypot(dx, dz)
    if (dist > maxDist) maxDist = dist
    if (dist > ROPE_MAX) { released = true; break }

    if (dist > 0.001) {
      const ux = dx / dist
      const uz = dz / dist
      const slack = dist - ROPE
      const bx = rest.x
      const bz = rest.z
      if (slack > 0.05) {
        boat.advance(ux, uz, Math.min(slack, SPEED * DT), SLIDE_MAX, rest.yaw)
        moved += Math.hypot(rest.x - bx, rest.z - bz)
      }
      // 船头朝「实际被拖走的方向」（深水里就等于朝拉绳的人）
      const mdx = rest.x - bx
      const mdz = rest.z - bz
      if (mdx * mdx + mdz * mdz > 1e-8) boat.turnTo(Math.atan2(mdx, mdz), TURN * DT)
      else boat.turnTo(Math.atan2(ux, uz), TURN * DT)
      if (boat.slideAng !== 0) { /* 绕行中 */ }
    }

    const hm = hullMinDepthFine(rest.x, rest.z, rest.yaw)
    if (hm < minHull) minHull = hm
    if (i > 1 && hm < DRAFT) stuck++
    if (i % Math.round(10 / DT) === 0) {
      path.push('  t=' + (i * DT).toFixed(0).padStart(2) + 's 船(' + rest.x.toFixed(1) + ', ' + rest.z.toFixed(1) +
        ') 船头 ' + (rest.yaw * 180 / Math.PI).toFixed(0).padStart(4) + '° 离人 ' + dist.toFixed(1) +
        '米 最浅 ' + hm.toFixed(2) + ' 绕行 ' + boat.slideAng.toFixed(0) + '°')
    }
  }

  console.log('=== 试 1：人在岸上沿岸走 1.4 m/s 共 70 秒（≈98 米），缆绳拖船 ===')
  for (const line of path) console.log(line)
  console.log('  船移动 ' + moved.toFixed(1) + ' 米，最大离人 ' + maxDist.toFixed(2) + ' 米' + (released ? '  ✗ 中途松绳' : '  ✓ 没松绳'))
  console.log('  船体最浅海底 ' + minHull.toFixed(3) + ' 米 → ' + (minHull >= DRAFT ? '✓ 没搁浅' : '✗ 蹭底 ' + stuck + ' 帧'))
  console.log('  绕行 ' + boat.slid + ' 次（最大偏角 ' + boat.slideAng.toFixed(0) + '°），探深 ' + boat.probes + ' 次，完全走不动 ' + boat.blocks + ' 帧')
  console.log('  结论: ' + (moved > 30 && !released && minHull >= DRAFT ? '✓ 能沿岸拖走，不搁浅、不卡死' : '✗ 不达标'))
  console.log('')
}

// ---------------------------------------------------------------- 试 2：站在船上开，冲到浅滩
{
  const rest = { x: START.x, z: START.z, yaw: START.yaw }
  const boat = makeBoat(rest)
  let minHull = Infinity
  let phase = 'forward'
  let moved = 0
  const log = []
  const steps = Math.round(40 / DT)
  for (let i = 0; i < steps; i++) {
    if (i === Math.round(15 / DT)) { phase = 'toShore'; rest.yaw += Math.PI }
    const fx = Math.sin(rest.yaw)
    const fz = Math.cos(rest.yaw)
    const bx = rest.x
    const bz = rest.z
    if (boat.advance(fx, fz, 2.2 * DT, 40, rest.yaw) && boat.slideAng) {
      const ny = rest.yaw + Math.max(-TURN * DT, Math.min(TURN * DT, boat.slideAng * Math.PI / 180))
      if (boat.hullFloor(rest.x, rest.z, ny) >= FLOOR) rest.yaw = ny
    }
    moved += Math.hypot(rest.x - bx, rest.z - bz)
    const hm = hullMinDepthFine(rest.x, rest.z, rest.yaw)
    if (hm < minHull) minHull = hm
    if (i % Math.round(5 / DT) === 0) {
      log.push('  t=' + (i * DT).toFixed(0).padStart(2) + 's ' + (phase === 'forward' ? '出海' : '冲岸') +
        ' 船(' + rest.x.toFixed(1) + ', ' + rest.z.toFixed(1) + ') 离岛心 ' + Math.hypot(rest.x, rest.z).toFixed(1) +
        '米 最浅 ' + hm.toFixed(2) + ' 绕行 ' + boat.slideAng.toFixed(0) + '°')
    }
  }
  console.log('=== 试 2：开船出海 15 秒后掉头冲岸 25 秒（2.2 m/s）===')
  for (const line of log) console.log(line)
  console.log('  总航程 ' + moved.toFixed(1) + ' 米，船体最浅 ' + minHull.toFixed(3) + ' 米 → ' + (minHull >= DRAFT ? '✓ 没搁浅' : '✗ 蹭底'))
  console.log('  绕行 ' + boat.slid + ' 次，完全走不动 ' + boat.blocks + ' 帧')
  console.log('  结论: ' + (minHull >= DRAFT && boat.slid > 0 ? '✓ 冲到浅滩会自己沿等深线偏开' : '✗ 不达标'))
}
