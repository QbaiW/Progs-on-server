// tools/render-house.mjs —— 零依赖软件光栅器：把 GLB 的「可视网格」渲成 PNG
// 用途：在没有 three.js / 无头浏览器的前提下，用代码确认模型在视觉上是完整的。
//
// 关键设计：同一视角渲两张，一张开背面剔除、一张全画。
//   · 绕序反了的面 → 开剔除那张会露出「空洞」，全画那张却正常 → 一眼看出绕序问题
//   · 真缺面 → 两张都缺
// 同时把地形（只取房子附近的三角形）画成地面，看房子是不是真的坐在地上。

import fs from 'fs'
import zlib from 'zlib'

const W = 900, H = 640
const HOUSE = 'tools/_house.glb'
const ISLAND = 'tools/_verify-island.glb'
const ENTITY_POS = [-5, 24.651, -1]
const OUT = 'output'

// ---------------- GLB ----------------
function parseGLB(path) {
  const b = fs.readFileSync(path)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${path} 不是 GLB`)
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)))
  const off = 20 + jsonLen
  const binLen = dv.getUint32(off, true)
  return { json, bin: b.subarray(off + 8, off + 8 + binLen) }
}

function readAccessor(g, bin, idx) {
  const a = g.accessors[idx], bv = g.bufferViews[a.bufferView]
  const cs = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]
  const stride = bv.byteStride || cs * n
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const rd = (o) => a.componentType === 5121 ? dv.getUint8(o)
    : a.componentType === 5123 ? dv.getUint16(o, true)
      : a.componentType === 5125 ? dv.getUint32(o, true) : dv.getFloat32(o, true)
  const out = new Array(a.count)
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride
    if (n === 1) out[i] = rd(o)
    else { const v = new Array(n); for (let c = 0; c < n; c++) v[c] = rd(o + c * cs); out[i] = v }
  }
  return out
}

// 每个 primitive 一组三角形，带自己的材质色
function readGroups(path, meshIndex, offset = [0, 0, 0]) {
  const { json, bin } = parseGLB(path)
  const groups = []
  for (const prim of json.meshes[meshIndex].primitives) {
    const P = readAccessor(json, bin, prim.attributes.POSITION)
    const I = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null
    const mat = prim.material !== undefined ? json.materials[prim.material] : null
    const bc = mat?.pbrMetallicRoughness?.baseColorFactor || [0.8, 0.8, 0.8, 1]
    const name = mat?.name || '(无材质)'
    const tris = []
    const push = (a, b, c) => tris.push([
      [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]],
      [b[0] + offset[0], b[1] + offset[1], b[2] + offset[2]],
      [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]],
    ])
    if (I) for (let i = 0; i < I.length; i += 3) push(P[I[i]], P[I[i + 1]], P[I[i + 2]])
    else for (let i = 0; i < P.length; i += 3) push(P[i], P[i + 1], P[i + 2])
    groups.push({ name, color: bc.slice(0, 3), tris })
  }
  return groups
}

// ---------------- 向量 ----------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }

// ---------------- 渲染 ----------------
function render({ title, cull, eye, look, fov = 42 }) {
  const house = readGroups(HOUSE, 0, ENTITY_POS)
  // 地面：地形只取房子附近 ±14 米的三角形
  const near = []
  for (const g of readGroups(ISLAND, 0)) {
    const t2 = g.tris.filter((t) => t.some((v) => Math.abs(v[0] - ENTITY_POS[0]) < 14 && Math.abs(v[2] - ENTITY_POS[2]) < 14))
    if (t2.length) near.push({ name: g.name, color: g.color, tris: t2 })
  }
  const groups = [...near, ...house]

  const f = 1 / Math.tan((fov * Math.PI / 180) / 2)
  const aspect = W / H
  // 相机基
  const zc = norm(sub(eye, look))
  const xc = norm(cross([0, 1, 0], zc))
  const yc = cross(zc, xc)
  const toCam = (p) => {
    const d = sub(p, eye)
    return [dot(d, xc), dot(d, yc), dot(d, zc)] // 相机看向 -z
  }
  const project = (p) => {
    const v = toCam(p)
    if (v[2] > -0.05) return null // 在相机后方/太近
    const w = -v[2]
    const ndcX = (f / aspect) * v[0] / w
    const ndcY = f * v[1] / w
    return { x: (ndcX * 0.5 + 0.5) * W, y: (1 - (ndcY * 0.5 + 0.5)) * H, iw: 1 / w }
  }

  const zbuf = new Float32Array(W * H) // 存 1/w，大的更近
  const color = new Float32Array(W * H * 3)
  const hit = new Uint8Array(W * H)
  const L = norm([-0.45, 0.8, -0.4])

  let drawn = 0, culled = 0
  for (const g of groups) {
    for (const t of g.tris) {
      const n = norm(cross(sub(t[1], t[0]), sub(t[2], t[0])))
      if (!isFinite(n[0])) continue
      const a = project(t[0]), b = project(t[1]), c = project(t[2])
      if (!a || !b || !c) continue
      // 屏幕空间有向面积决定绕序（y 向下 → 逆时针为负）
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
      if (Math.abs(area) < 1e-9) continue
      const facing = area < 0 ? 1 : -1 // 朝前的几何法线在屏幕上是这种符号
      if (cull && facing < 0) { culled++; continue }
      drawn++
      const shade = 0.34 + 0.66 * Math.max(0, dot(n, L)) * (facing > 0 ? 1 : 0.55)
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
      const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
      const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
      const inv = 1 / area
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5
          let l0 = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) * inv
          let l1 = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) * inv
          let l2 = 1 - l0 - l1
          if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue
          const iw = l0 * a.iw + l1 * b.iw + l2 * c.iw
          const i = y * W + x
          if (iw <= zbuf[i]) continue
          zbuf[i] = iw
          hit[i] = 1
          color[i * 3] = g.color[0] * shade
          color[i * 3 + 1] = g.color[1] * shade
          color[i * 3 + 2] = g.color[2] * shade
        }
      }
    }
  }
  return { color, hit, drawn, culled, groups, title }
}

// ---------------- PNG ----------------
let TBL = null
function crc32(buf) {
  if (!TBL) { TBL = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c } }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = TBL[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function writePNG(path, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = rgb[y * W * 3 + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]))
}

// ---------------- 视角 ----------------
// 门在本地 -Z 面 → 从 -Z 方向看正对大门
const C = [ENTITY_POS[0], ENTITY_POS[1] + 3.2, ENTITY_POS[2]]
const views = [
  { tag: 'front', eye: [C[0] - 7.5, C[1] + 4.5, C[2] - 13.5] },   // 门面 · 左前方俯视
  { tag: 'back', eye: [C[0] + 9.5, C[1] + 6.0, C[2] + 9.0] },     // 背面 · 右后方（看烟囱）
]
fs.mkdirSync(OUT, { recursive: true })
const stats = {}
for (const v of views) {
  const a = render({ ...v, cull: true, eye: v.eye, look: C })
  const b = render({ ...v, cull: false, eye: v.eye, look: C })
  // 定量绕序检验：开剔除时没画到、但它其实有面 → 只有两种情况
  //   ① 门窗洞口里看见的室内背面（面积小、聚成几块）
  //   ② 绕序反了的外墙（面积大、连成一片）
  let diff = 0, dx0 = W, dx1 = -1, dy0 = H, dy1 = -1
  let cdiff = 0, cx0 = W, cx1 = -1, cy0 = H, cy1 = -1
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0
    if (b.hit[i] && !a.hit[i]) {
      diff++
      if (x < dx0) dx0 = x; if (x > dx1) dx1 = x
      if (y < dy0) dy0 = y; if (y > dy1) dy1 = y
    }
    // 两遍都命中、但颜色不同 → 有一次背面在正面之前通过了深度测试（外壳自相交或绕序局部反了）
    if (a.hit[i] && b.hit[i]) {
      const d = Math.max(
        Math.abs(a.color[i * 3] - b.color[i * 3]),
        Math.abs(a.color[i * 3 + 1] - b.color[i * 3 + 1]),
        Math.abs(a.color[i * 3 + 2] - b.color[i * 3 + 2]),
      )
      if (d > 0.02) {
        cdiff++
        if (x < cx0) cx0 = x; if (x > cx1) cx1 = x
        if (y < cy0) cy0 = y; if (y > cy1) cy1 = y
      }
    }
  }
  for (const [r, cull] of [[a, true], [b, false]]) {
    const rgb = Buffer.alloc(W * H * 3)
    for (let i = 0; i < W * H; i++) {
      if (r.hit[i]) {
        rgb[i * 3] = Math.min(255, r.color[i * 3] * 255) | 0
        rgb[i * 3 + 1] = Math.min(255, r.color[i * 3 + 1] * 255) | 0
        rgb[i * 3 + 2] = Math.min(255, r.color[i * 3 + 2] * 255) | 0
      } else {
        const t = ((i / W) | 0) / H
        rgb[i * 3] = (0.55 + 0.25 * t) * 255 | 0
        rgb[i * 3 + 1] = (0.68 + 0.22 * t) * 255 | 0
        rgb[i * 3 + 2] = (0.86 + 0.10 * t) * 255 | 0
      }
    }
    const name = `${OUT}/house-${v.tag}-${cull ? 'culled' : 'all'}.png`
    writePNG(name, rgb)
    stats[`${v.tag}/${cull ? 'culled' : 'all'}`] = { drawn: r.drawn, culled: r.culled, file: name }
  }
  stats[`${v.tag}/diff`] = {
    只被背面画到的像素: diff,
    占全图: `${(diff / (W * H) * 100).toFixed(2)}%`,
    区域: dx1 < 0 ? '无' : `x[${dx0},${dx1}] y[${dy0},${dy1}]  ${dx1 - dx0 + 1}×${dy1 - dy0 + 1} 像素`,
    两遍颜色不同的像素: cdiff,
    颜色差异区域: cx1 < 0 ? '无' : `x[${cx0},${cx1}] y[${cy0},${cy1}]  ${cx1 - cx0 + 1}×${cy1 - cy0 + 1} 像素`,
  }
  stats.palette = a.groups.map((g) => `${g.name}=rgb(${g.color.map((c) => Math.round(c * 255)).join(',')}) tris=${g.tris.length}`)
}
// 两张图的像素差异 = 背面（被剔除的）面积
console.log(JSON.stringify(stats, null, 1))
