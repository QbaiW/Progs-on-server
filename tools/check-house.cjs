// 房子 GLB 的验收测试。
//
// 为什么不能只看"能不能生成出来"：这栋房子最容易死在
// 「碰撞体根本没建出来」和「碰撞体建出来了但门被堵死」这两件事上，
// 而这两种情况从文件大小、三角形数量、甚至渲染画面上都看不出来 ——
// 上一版地形就是这么骗过我好几次的。
//
// 所以这里直接对碰撞网格打射线：
//   1) 结构：刚体根 / 单 primitive 无材质的 collider / 可视网格带材质
//   2) 门能不能走进去（水平射线穿门洞）
//   3) 门框上方有没有碰头空间（向上射线）
//   4) 一层地面是不是处处踩得到（网格状向下射线，覆盖率必须 100%）
//   5) 二层楼板是不是处处踩得到
//   6) 楼梯每一级的高度和踏面尺寸，以及从一层到二层有没有断层
//   7) 三角形有没有退化/重复/NaN
//
// 用法：node tools/check-house.cjs tools/_house.glb

const fs = require('node:fs')

const file = process.argv[2] || 'house.glb'
const buf = fs.readFileSync(file)

// ---------------- 读 GLB ----------------
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB')
const total = buf.readUInt32LE(8)
if (total !== buf.length) throw new Error(`头部声明 ${total} 与实际 ${buf.length} 不符`)

let off = 12
let json = null
let bin = null
while (off < buf.length) {
  const len = buf.readUInt32LE(off)
  const type = buf.readUInt32LE(off + 4)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
  else if (type === 0x004e4942) bin = data
  off += 8 + len
}
const g = json

const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

// ---------------- 结构检查 ----------------
const rootNodes = g.scenes[g.scene].nodes
ok('场景只有一个根节点', rootNodes.length === 1, `根节点数 = ${rootNodes.length}`)

const root = g.nodes[rootNodes[0]]
ok('根节点是刚性体（extras.node = rigidbody）', root.extras && root.extras.node === 'rigidbody',
  `${root.name} extras=${JSON.stringify(root.extras)}`)

const colliderNodes = g.nodes.filter((n) => n.extras && n.extras.node === 'collider')
ok('恰好有一个 collider 节点', colliderNodes.length === 1, `找到 ${colliderNodes.length} 个`)

const cn = colliderNodes[0]
const cmesh = g.meshes[cn.mesh]
// 这一条是整件事的核心：glbToNodes.js 要求 collider 必须是「单个 Mesh」。
// 多材质会被 GLTFLoader 拆成 Group → isMesh 为 false → 碰撞体从不创建。
ok('collider 网格只有一个 primitive（否则会被拆成 Group）', cmesh.primitives.length === 1,
  `primitive 数 = ${cmesh.primitives.length}`)
ok('collider 的 primitive 不带材质（源码注释明确要求）', cmesh.primitives[0].material === undefined,
  `material = ${cmesh.primitives[0].material}`)

const visualNode = g.nodes.find((n) => n.name === 'HouseVisual')
const vmesh = g.meshes[visualNode.mesh]
const allVisualHaveMat = vmesh.primitives.every((p) => p.material !== undefined)
ok('可视网格按材质分了多个 primitive 且都带材质', vmesh.primitives.length > 1 && allVisualHaveMat,
  `${vmesh.primitives.length} 个 primitive`)

ok('没有使用任何扩展', !g.extensionsUsed && !g.extensionsRequired, JSON.stringify(g.extensionsUsed || '无'))

// ---------------- 取三角形 ----------------
function triangles(meshIndex) {
  const mesh = g.meshes[meshIndex]
  const tris = []
  const all = mesh.primitives.flatMap((p) => {
    const posAcc = g.accessors[p.attributes.POSITION]
    const posView = g.bufferViews[posAcc.bufferView]
    const base = (posView.byteOffset || 0) + (posAcc.byteOffset || 0)
    const stride = posView.byteStride || 12
    const P = []
    for (let i = 0; i < posAcc.count; i++) {
      const o = base + i * stride
      P.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)])
    }
    const idxAcc = g.accessors[p.indices]
    const idxView = g.bufferViews[idxAcc.bufferView]
    const io = (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
    const read = idxAcc.componentType === 5125
      ? (i) => bin.readUInt32LE(io + i * 4)
      : (i) => bin.readUInt16LE(io + i * 2)
    const out = []
    for (let i = 0; i < idxAcc.count; i += 3) out.push([P[read(i)], P[read(i + 1)], P[read(i + 2)]])
    return out
  })
  return all
}

const TRI = triangles(cn.mesh)

// ---------------- 射线 ----------------
// Möller–Trumbore。返回最近的正向交点距离，没有交点返回 Infinity。
function ray(origin, dir, maxT = Infinity) {
  let best = Infinity
  for (const [a, b, c] of TRI) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const p = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]]
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]]
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
    if (t > 1e-6 && t < best && t <= maxT) best = t
  }
  return best
}

const down = (x, y0, z) => {
  const t = ray([x, y0, z], [0, -1, 0])
  return t === Infinity ? null : y0 - t
}

// ---------------- 几何常量（必须与 make-house.mjs 一致） ----------------
const HX = 3.0, HZ = 2.25, T = 0.18
const F1 = 2.70, SLAB = 0.25, F2 = 2.50
const Y2 = F1 + SLAB
const EAVE = Y2 + F2
const IX0 = -HX + T, IX1 = HX - T, IZ0 = -HZ + T, IZ1 = HZ - T
const WELL_X0 = HX - T - 0.95 - 0.07
const SX0 = HX - T - 0.95
const SX1 = HX - T
const SZTOP = 1.95

// 2) 门能不能走进去
{
  let blocked = []
  for (const x of [-0.40, -0.20, 0, 0.20, 0.40]) {
    for (const y of [0.30, 0.80, 1.30, 1.80, 2.00]) {
      const t = ray([x, y, -3.2], [0, 0, 1], 1.5)
      const zhit = t === Infinity ? null : -3.2 + t
      // 门洞在 z ∈ [-2.25, -2.07]，必须一路穿到室内 z > -2.0
      if (zhit !== null && zhit < -2.0) blocked.push(`x=${x} y=${y} 挡在 z=${zhit.toFixed(3)}`)
    }
  }
  ok('门洞在整片范围内可以走进去（20 条水平射线全通）', blocked.length === 0,
    blocked.length ? blocked.join('; ') : '20/20 通过')
}

// 3) 门框上的碰头空间
{
  const h = down(0, 6.0, -2.16) === null ? null : null
  void h
  const t = ray([0, 0.05, -2.16], [0, 1, 0])
  const clear = t === Infinity ? null : 0.05 + t
  ok('门口上方有 2.05 米净空', clear !== null && clear >= 2.05, `上沿 y=${clear === null ? '∞' : clear.toFixed(3)}`)
}

// 4) 一层地面覆盖率
{
  const bad = []
  let n = 0
  for (let x = IX0 + 0.15; x <= IX1 - 0.15; x += 0.20) {
    for (let z = IZ0 + 0.15; z <= IZ1 - 0.15; z += 0.20) {
      if (x >= WELL_X0 - 0.05) continue       // 楼梯井那条是通的，不算地面
      n++
      const y = down(x, 2.5, z)
      if (y === null || y < -0.05 || y > 0.06) bad.push(`(${x.toFixed(2)},${z.toFixed(2)})→${y === null ? '打空' : y.toFixed(3)}`)
    }
  }
  ok(`一层地面处处踩得到（${n} 个采样点）`, bad.length === 0,
    bad.length ? `${bad.length} 个点异常，例如 ${bad.slice(0, 4).join(' ')}` : `${n}/${n} 在 y≈0.02`)
}

// 5) 二层楼板覆盖率
{
  const bad = []
  let n = 0
  for (let x = IX0 + 0.15; x <= WELL_X0 - 0.15; x += 0.20) {
    for (let z = IZ0 + 0.15; z <= IZ1 - 0.15; z += 0.20) {
      n++
      const y = down(x, 5.3, z)
      if (y === null || y < Y2 - 0.05 || y > Y2 + 0.06) bad.push(`(${x.toFixed(2)},${z.toFixed(2)})→${y === null ? '打空' : y.toFixed(3)}`)
    }
  }
  ok(`二层楼板处处踩得到（${n} 个采样点）`, bad.length === 0,
    bad.length ? `${bad.length} 个点异常，例如 ${bad.slice(0, 4).join(' ')}` : `${n}/${n} 在 y≈${(Y2 + 0.02).toFixed(2)}`)
}

// 6) 楼梯
{
  const STEPS = 13
  const RISER = Y2 / STEPS
  const GOING = 0.29
  const hs = []
  const bad = []
  for (let k = 0; k < STEPS; k++) {
    const zc = SZTOP - (k + 0.5) * GOING
    const xc = (SX0 + SX1) / 2
    const y = down(xc, 3.4, zc)
    hs.push(y)
    const want = (k + 1) * RISER
    if (y === null || Math.abs(y - want) > 0.02) bad.push(`第${k + 1}级 期望${want.toFixed(3)} 实测${y === null ? '打空' : y.toFixed(3)}`)
  }
  ok('楼梯 13 级高度都对得上', bad.length === 0, bad.length ? bad.slice(0, 5).join('; ') : `第1级 ${hs[0].toFixed(3)} → 第13级 ${hs[12].toFixed(3)}`)

  let maxRiser = 0
  let prev = 0.02
  const risers = []
  for (const y of hs) {
    if (y === null) continue
    risers.push(y - prev)
    maxRiser = Math.max(maxRiser, y - prev)
    prev = y
  }
  ok('每一级抬升 ≤ 0.30 米（角色控制器上得去）', maxRiser > 0 && maxRiser <= 0.30, `最大 ${maxRiser.toFixed(3)} 米`)
  ok('楼梯顶端与二层地面平接（落差 ≤ 0.30 米）', hs[12] !== null && Math.abs((Y2 + 0.02) - hs[12]) <= 0.30,
    `顶端 ${hs[12] === null ? '?' : hs[12].toFixed(3)} → 二层 ${(Y2 + 0.02).toFixed(2)}`)
}

// 7) 三角形卫生
{
  let degenerate = 0
  let nan = 0
  const seen = new Map()
  const dupList = []
  for (const [a, b, c] of TRI) {
    for (const p of [a, b, c]) for (const v of p) if (!Number.isFinite(v)) nan++
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    if (Math.hypot(...cr) / 2 < 1e-9) degenerate++
    const key = [a, b, c].map((p) => p.map((v) => v.toFixed(4)).join(',')).sort().join('|')
    if (seen.has(key)) {
      dupList.push([a, b, c])
    }
    seen.set(key, 1)
  }
  const dup = dupList.length
  ok('没有完全重复的三角形', dup === 0, dup === 0 ? '重复 0' : `重复 ${dup} 组，位置：` +
    dupList.slice(0, 4).map(([a, b, c]) => {
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3
      return `(${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)})`
    }).join(' '))
  ok('没有 NaN 坐标', nan === 0, `NaN 分量 ${nan}`)
  ok('没有零面积三角形', degenerate === 0, `退化三角形 ${degenerate}`)
}

// 8) 共面重叠 —— 这一类靠「完全重复的三角形」抓不到。
// 两块面躺在同一个平面上、朝向相同、投影还互相盖住，渲染器就会 z-fighting。
// 判据：取每个三角形的重心，看它有没有落在同组另一个三角形的内部（要求离边有余量）。
{
  const triNormal = ([a, b, c]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    const L = Math.hypot(...n)
    return L < 1e-12 ? null : n.map((v) => v / L)
  }
  // 重心坐标，要求三个分量都 ≥ eps 才算「真的在里面」（避免相邻面共边误判）
  const inside = (p, a, b, c, eps = 0.02) => {
    const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
    const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2]
    const d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
    const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]
    const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2]
    const d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2]
    const den = d00 * d11 - d01 * d01
    if (Math.abs(den) < 1e-12) return false
    const u = (d11 * d20 - d01 * d21) / den
    const v = (d00 * d21 - d01 * d20) / den
    return u >= eps && v >= eps && 1 - u - v >= eps
  }

  const groups = new Map()
  TRI.forEach((tri, i) => {
    const n = triNormal(tri)
    if (!n) return
    const off = n[0] * tri[0][0] + n[1] * tri[0][1] + n[2] * tri[0][2]
    const key = [n, off].flat().map((v) => v.toFixed(4)).join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ tri, i })
  })

  const overlap = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    for (const A of list) {
      const ca = [
        (A.tri[0][0] + A.tri[1][0] + A.tri[2][0]) / 3,
        (A.tri[0][1] + A.tri[1][1] + A.tri[2][1]) / 3,
        (A.tri[0][2] + A.tri[1][2] + A.tri[2][2]) / 3,
      ]
      for (const B of list) {
        if (A === B) continue
        if (inside(ca, B.tri[0], B.tri[1], B.tri[2])) {
          overlap.push(ca)
          break
        }
      }
    }
  }
  ok('没有共面互相盖住的面（不会 z-fighting）', overlap.length === 0,
    overlap.length === 0 ? `${groups.size} 个平面分组全部干净` :
      `${overlap.length} 个三角形压在别的面上，例如 ` +
      overlap.slice(0, 4).map((p) => `(${p.map((v) => v.toFixed(2)).join(', ')})`).join(' '))
}

// ---------------- 输出 ----------------
let fail = 0
for (const r of results) {
  if (!r.pass) fail++
  console.log(`${r.pass ? '  OK  ' : ' FAIL '} ${r.name}${r.detail ? '   —— ' + r.detail : ''}`)
}
console.log()
console.log(`节点树: ${g.nodes.map((n, i) => `[${i}]${n.name}${n.extras ? '(' + n.extras.node + ')' : ''}${n.mesh !== undefined ? '→mesh' + n.mesh : ''}`).join('  ')}`)
console.log(`碰撞三角形 ${TRI.length} 个，检查项 ${results.length} 条，失败 ${fail} 条`)
process.exit(fail ? 1 : 0)
