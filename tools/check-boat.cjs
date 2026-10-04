// 小船模型校验器（零依赖，直接读 .glb 的二进制，对真碰撞网格打射线）。
//
// 为什么不用解析公式验：解析算的是「我打算造什么」，射线打的是「我实际造出了什么」。
// 房子那次就是靠这个发现烟囱基脚没在判据覆盖范围里。
//
// 用法：node tools/check-boat.cjs tools/_boat.glb

const fs = require('fs')

const file = process.argv[2] || 'tools/_boat.glb'

// ---------------------------------------------------------------- GLB 读取
function loadGlb(f) {
  const buf = fs.readFileSync(f)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
  const bin = buf.slice(20 + jsonLen + 8)
  const read = (accIdx) => {
    const a = json.accessors[accIdx]
    const bv = json.bufferViews[a.bufferView]
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0)
    const n = a.type === 'VEC3' ? 3 : 1
    const out = new Float64Array(a.count * n)
    const stride = a.byteStride || 0
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < n; k++) {
        const p = off + i * (stride || n * (a.componentType === 5126 ? 4 : 2)) + k * (a.componentType === 5126 ? 4 : 2)
        out[i * n + k] = a.componentType === 5126
          ? bin.readFloatLE(p)
          : (a.componentType === 5123 ? bin.readUInt16LE(p) : bin.readUInt32LE(p))
      }
    }
    return { arr: out, count: a.count, n }
  }
  return { json, read, size: buf.length }
}

function trisOf(g, meshIdx, primIdx) {
  const prim = g.json.meshes[meshIdx].primitives[primIdx]
  const pos = g.read(prim.attributes.POSITION)
  const idx = g.read(prim.indices)
  const tris = []
  for (let i = 0; i < idx.count; i += 3) {
    const t = []
    for (let k = 0; k < 3; k++) {
      const v = idx.arr[i + k]
      t.push([pos.arr[v * 3], pos.arr[v * 3 + 1], pos.arr[v * 3 + 2]])
    }
    tris.push(t)
  }
  return tris
}

// ---------------------------------------------------------------- 向量 / 射线
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

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

// 返回沿射线方向所有交点（按 t 升序），剔除「共面重叠三角形」造成的重复点
function castAll(tris, o, d) {
  const hits = []
  for (const t of tris) {
    const tt = rayTri(o, d, t[0], t[1], t[2])
    if (tt !== null) hits.push({ t: tt, p: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt] })
  }
  hits.sort((a, b) => a.t - b.t)
  const out = []
  for (const h of hits) if (!out.length || h.t - out[out.length - 1].t > 1e-5) out.push(h)
  return out
}

const castDown = (tris, x, z, y0 = 2.0) => {
  const h = castAll(tris, [x, y0, z], [0, -1, 0])
  return h.length ? h[0].p : null
}

// ---------------------------------------------------------------- 结果记录
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`)
}
function section(title) { console.log(`\n— ${title} —`) }

// ---------------------------------------------------------------- 载入
const g = loadGlb(file)
const { json } = g
const collMesh = json.meshes.findIndex((m) => m.name === 'BoatBody')
const visMesh = json.meshes.findIndex((m) => m.name === 'BoatVisual')
const collTris = trisOf(g, collMesh, 0)

const bbox = (tris) => {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) {
    if (v[k] < mn[k]) mn[k] = v[k]
    if (v[k] > mx[k]) mx[k] = v[k]
  }
  return { mn, mx }
}
const bb = bbox(collTris)

console.log(`文件 ${file}  ${g.size} 字节  ${json.nodes.length} 节点  ${collTris.length} 碰撞三角形`)
console.log(`包围盒 X ${bb.mn[0].toFixed(3)}~${bb.mx[0].toFixed(3)}  Y ${bb.mn[1].toFixed(3)}~${bb.mx[1].toFixed(3)}  Z ${bb.mn[2].toFixed(3)}~${bb.mx[2].toFixed(3)}`)

// ================================================================ A 结构
section('A. 节点结构（决定 Hyperfy 能不能建出碰撞体）')
{
  const roots = json.scenes[json.scene].nodes
  check('场景只有一个根节点', roots.length === 1, `scene=${json.scene} roots=${roots.length}`)
  const root = json.nodes[roots[0]]
  check('根节点的 extras.node === "rigidbody"', root.extras && root.extras.node === 'rigidbody', JSON.stringify(root.extras))
  check('刚体类型是 kinematic（不吃重力、能被脚本摆）', root.extras && root.extras.type === 'kinematic', `type=${root.extras && root.extras.type}`)
  check('根节点挂两个子节点（视觉 + 碰撞）', Array.isArray(root.children) && root.children.length === 2, JSON.stringify(root.children))

  const collNode = json.nodes.find((n) => n.extras && n.extras.node === 'collider')
  check('有且只有一个 collider 节点', json.nodes.filter((n) => n.extras && n.extras.node === 'collider').length === 1)
  const cm = collNode && json.meshes[collNode.mesh]
  check('collider 的网格只有 1 个 primitive', cm && cm.primitives.length === 1, `primitives=${cm && cm.primitives.length}`)
  check('collider 不指定材质（否则 GLTFLoader 会拆成 Group，isMesh=false，碰撞体静默不生成）',
    cm && cm.primitives[0].material === undefined, `material=${cm && cm.primitives[0].material}`)
  const vis = json.meshes[visMesh]
  check('视觉网格每个 primitive 都有材质', vis && vis.primitives.every((p) => p.material !== undefined), `primitives=${vis && vis.primitives.length}`)
  check('整个文件不含任何扩展（服务端没有 DRACO/KTX2 解码器）', json.extensions === undefined && json.extensionsRequired === undefined)
  check('根节点没有位移/旋转（顶点即船体本地坐标）', !root.translation && !root.rotation && !root.scale)
}

// ================================================================ B 三角形卫生
section('B. 三角形卫生')
{
  let nan = 0
  let zeroArea = 0
  const areas = []
  for (const t of collTris) {
    if (t.some((v) => v.some((c) => !Number.isFinite(c)))) nan++
    const a = 0.5 * len(cross(sub(t[1], t[0]), sub(t[2], t[0])))
    areas.push(a)
    if (a < 1e-9) zeroArea++
  }
  check('没有 NaN / Infinity 顶点', nan === 0, `坏三角形 ${nan}`)
  check('没有零面积三角形', zeroArea === 0, `零面积 ${zeroArea}`)
  check('没有过大的三角形（PhysX 会抱怨 triangles are too big）', Math.max(...areas) < 1.0,
    `最大面积 ${Math.max(...areas).toFixed(4)} m²`)

  const key = (v) => v.map((c) => c.toFixed(5)).join(',')
  const seen = new Set()
  let dup = 0
  for (const t of collTris) {
    const k = t.map(key).sort().join('|')
    if (seen.has(k)) dup++
    seen.add(k)
  }
  check('没有重复三角形', dup === 0, `重复 ${dup}`)

  // 共面 + 同朝向 + 重叠 = z-fighting 的根源；相邻三角形只共边，交集面积为 0
  const planes = new Map()
  for (const t of collTris) {
    const n = unit(cross(sub(t[1], t[0]), sub(t[2], t[0])))
    const q = n.map((c) => Math.round(c * 1e4) / 1e4)
    const off = Math.round(dot(n, t[0]) * 1e4) / 1e4
    const k = `${q.join(',')}@${off}`
    if (!planes.has(k)) planes.set(k, [])
    planes.get(k).push({ t, n })
  }
  // 平面内 2D 分离轴测试（凸多边形，严格重叠才算）
  const axesOf = (p) => {
    const ax = []
    for (let i = 0; i < p.length; i++) {
      const e = sub(p[(i + 1) % p.length], p[i])
      ax.push([-e[1], e[0]])
    }
    return ax
  }
  const flat = (p, n) => {
    const a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u = unit(cross(n, a))
    const v = cross(n, u)
    return p.map((q) => [dot(q, u), dot(q, v)])
  }
  const overlap2 = (f1, f2) => {
    for (const ax of [...axesOf(f1), ...axesOf(f2)]) {
      const l = Math.hypot(ax[0], ax[1])
      if (l < 1e-9) continue
      const p1 = f1.map((p) => (p[0] * ax[0] + p[1] * ax[1]) / l)
      const p2 = f2.map((p) => (p[0] * ax[0] + p[1] * ax[1]) / l)
      const o = Math.min(Math.max(...p1), Math.max(...p2)) - Math.max(Math.min(...p1), Math.min(...p2))
      if (o < 1e-5) return false
    }
    return true
  }
  let coplanarOverlaps = 0
  let worst = ''
  for (const [, list] of planes) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const f1 = flat(list[i].t, list[i].n)
        const f2 = flat(list[j].t, list[j].n)
        if (overlap2(f1, f2)) {
          coplanarOverlaps++
          if (!worst) worst = `面 ${list[i].t[0].map((c) => c.toFixed(3))} 与 ${list[j].t[0].map((c) => c.toFixed(3))}`
        }
      }
    }
  }
  check('没有共面同朝向的重叠面（z-fighting 根源）', coplanarOverlaps === 0,
    coplanarOverlaps ? `${coplanarOverlaps} 对，例：${worst}` : `${planes.size} 个独立平面`)
}

// ================================================================ C 船体
section('C. 船体几何')
{
  check('吃水 0.300 米（龙骨最低点＝原点下方，原点就是水线）', Math.abs(bb.mn[1] + 0.300) < 0.002, `minY=${bb.mn[1].toFixed(4)}`)
  check('船头最高点 0.347 米（≈船中干舷 0.26 上翘到船头）', Math.abs(bb.mx[1] - 0.347) < 0.005, `maxY=${bb.mx[1].toFixed(4)}`)
  check('总长 4.20 米', Math.abs((bb.mx[2] - bb.mn[2]) - 4.20) < 0.005, `${(bb.mx[2] - bb.mn[2]).toFixed(4)}`)
  check('最大半宽 0.72 米（船中舷缘）', Math.abs(bb.mx[0] - 0.72) < 0.005, `${bb.mx[0].toFixed(4)}`)

  // 船底不透水：从水下向上打，必须打到船体（宽扫，证明没有逃出去的缝）
  let miss = 0
  let n = 0
  for (let x = -0.30; x <= 0.3001; x += 0.15) {
    for (let z = -2.0; z <= 1.8001; z += 0.2) {
      n++
      if (!castAll(collTris, [x, -1.0, z], [0, 1, 0]).length) miss++
    }
  }
  check('船底无孔（水下向上打射线，全部命中船体）', miss === 0, `采样 ${n} 点，未命中 ${miss}`)

  // 窄带（±0.15，处处都在船底正下方）里第一个命中必须就是船底板
  let badY = 0
  let firstBad = ''
  for (let x = -0.15; x <= 0.1501; x += 0.15) {
    for (let z = -2.0; z <= 1.8001; z += 0.2) {
      const h = castAll(collTris, [x, -1.0, z], [0, 1, 0])
      if (!h.length || h[0].p[1] < -0.32 || h[0].p[1] > -0.18) {
        badY++
        if (!firstBad) firstBad = `x=${x.toFixed(2)} z=${z.toFixed(2)} y=${h.length ? h[0].p[1].toFixed(3) : '未命中'}`
      }
    }
  }
  check('船底板就是第一个命中面（高度 -0.32~-0.18）', badY === 0, badY ? `${badY} 个异常：${firstBad}` : '60 点全部命中船底板')

  // 舷侧 + 首尾不透水：从船外朝船内打
  let sideMiss = 0
  let sideN = 0
  const sideShots = []
  for (const z of [-2.0, -1.5, -1.0, 0, 0.5, 1.0, 1.5, 1.85]) {
    for (const y of [-0.20, -0.05, 0.10, 0.22]) {
      for (const sx of [1, -1]) {
        sideN++
        const h = castAll(collTris, [sx * 1.5, y, z], [-sx, 0, 0])
        if (!h.length) { sideMiss++; sideShots.push(`x${sx} y${y} z${z}`) }
      }
    }
  }
  check('舷侧无孔（船外横向朝里打射线全部命中舷板）', sideMiss === 0, `采样 ${sideN} 点，未命中 ${sideMiss} ${sideShots.slice(0, 4).join(' ')}`)

  let longMiss = 0
  for (const y of [-0.10, 0.10, 0.24]) {
    for (const x of [-0.25, 0, 0.25]) {
      if (!castAll(collTris, [x, y, -3.0], [0, 0, 1]).length) longMiss++
      if (!castAll(collTris, [x, y, 3.0], [0, 0, -1]).length) longMiss++
    }
  }
  check('船尾板与船头封板无孔（纵向朝里打射线全部命中）', longMiss === 0, `未命中 ${longMiss}/18`)
}

// ================================================================ D 站立面
section('D. 站立面高度（玩家能站的地方，坐标 = 水线起算的米数）')
{
  const probe = (x, z, want, label) => {
    const p = castDown(collTris, x, z)
    if (!p) { check(label, false, '射线没打到东西'); return }
    check(label, Math.abs(p[1] - want) < 0.02, `x=${x} z=${z} 实测 ${p[1].toFixed(4)} 期望 ${want.toFixed(3)}`)
  }
  probe(0, -1.50, -0.16, '舱内地板（尾段）')
  probe(0, 0.00, -0.16, '舱内地板（船中）')
  probe(0.25, 1.10, -0.16, '舱内地板（前段）')
  probe(0, -1.28, 0.06, '横座 1 顶面')
  probe(0.35, -1.28, 0.06, '横座 1 顶面（靠舷侧）')
  probe(0, 0.29, 0.06, '横座 2 顶面')
  probe(0, -1.90, 0.02, '尾甲板')
  probe(0, -2.15, 0.26, '尾板顶面（走上船的那一级）')
  probe(0, 1.60, 0.10, '前舱盖')

  const gw = castDown(collTris, 0.70, 0.0)
  check('舷缘顶面在 0.26~0.35（船中约 +0.29）', gw && gw[1] > 0.26 && gw[1] < 0.35, gw ? `实测 ${gw[1].toFixed(4)}` : '未命中')

  // 舱内家具不能捅穿舷侧：横向射线的命中次序必须是 舷外 → 舷内 → 家具
  let orderBad = 0
  const badCases = []
  for (const y of [0.06, 0.02, 0.10]) {
    for (const z of [-1.28, 0.29, -1.90, 1.60]) {
      for (const sx of [1, -1]) {
        const h = castAll(collTris, [sx * 1.5, y, z], [-sx, 0, 0])
        if (h.length < 2) { orderBad++; badCases.push(`y${y} z${z} x${sx} 只命中 ${h.length}`); continue }
        // 第一个命中必须在舷外板（|x| 接近该处舷缘），第二个更靠内
        const first = h[0].p[0]
        const second = h[1].p[0]
        if (!(Math.abs(first) > Math.abs(second) + 0.02)) { orderBad++; badCases.push(`y${y} z${z} x${sx} ${first.toFixed(3)}→${second.toFixed(3)}`) }
      }
    }
  }
  check('家具都没有捅穿舷侧（射线命中次序 舷外→舷内→家具）', orderBad === 0, orderBad ? badCases.slice(0, 4).join(' | ') : '12 组全部有序')
}

// ================================================================ E 上船高差
section('E. 上船高差（玩家是个半径 0.3 的胶囊，没有台阶能力，所以每级必须 ≤ 0.30）')
{
  const LEVELS = {
    '沙地（岸上）': 0,
    '尾板顶面': 0.26,
    '尾甲板': 0.02,
    '舱内地板': -0.16,
    '横座': 0.06,
    '前舱盖': 0.10,
    '舷缘顶（船中）': 0.26,
  }
  const STEPS = [
    ['沙地（岸上）', '尾板顶面'],
    ['尾板顶面', '尾甲板'],
    ['尾甲板', '舱内地板'],
    ['舱内地板', '横座'],
    ['横座', '前舱盖'],
    ['前舱盖', '舷缘顶（船中）'],
  ]
  let bad = 0
  for (const [a, b] of STEPS) {
    const d = Math.abs(LEVELS[b] - LEVELS[a])
    const ok = d <= 0.30 + 1e-9
    if (!ok) bad++
    console.log(`   ${ok ? '✓' : '✗'} ${a} ${LEVELS[a].toFixed(2)} → ${b} ${LEVELS[b].toFixed(2)}   高差 ${d.toFixed(3)} 米`)
  }
  check('上船路径每一级高差都 ≤ 0.30 米', bad === 0, bad ? `${bad} 级超标` : `6 级全部通过`)
}

// ================================================================ F 碰撞体 = 视觉体
section('F. 碰撞体与视觉体一致')
{
  let visTris = 0
  for (let i = 0; i < json.meshes[visMesh].primitives.length; i++) visTris += trisOf(g, visMesh, i).length
  check('碰撞三角形数 = 视觉三角形数', visTris === collTris.length, `视觉 ${visTris} / 碰撞 ${collTris.length}`)
  const vb = bbox([].concat(...json.meshes[visMesh].primitives.map((_, i) => trisOf(g, visMesh, i))))
  const same = [0, 1, 2].every((k) => Math.abs(vb.mn[k] - bb.mn[k]) < 1e-6 && Math.abs(vb.mx[k] - bb.mx[k]) < 1e-6)
  check('视觉包围盒与碰撞包围盒完全一致', same,
    `视觉 Y ${vb.mn[1].toFixed(4)}~${vb.mx[1].toFixed(4)} / 碰撞 Y ${bb.mn[1].toFixed(4)}~${bb.mx[1].toFixed(4)}`)
}

// ================================================================ 汇总
console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `全部判定通过 ✓   （${pass} 项）` : `${fail} 项未通过 ✗   （通过 ${pass} 项）`)
process.exitCode = fail === 0 ? 0 : 1
