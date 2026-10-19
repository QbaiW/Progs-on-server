// 严格校验 glTF 2.0 二进制：逐项检查 chunk、bufferView、accessor 是否符合规范
import fs from 'node:fs'

const file = process.argv[2]
const buf = fs.readFileSync(file)
const problems = []
const notes = []

// ---- 头部 ----
const magic = buf.toString('ascii', 0, 4)
const version = buf.readUInt32LE(4)
const totalLen = buf.readUInt32LE(8)
if (magic !== 'glTF') problems.push('magic 不是 glTF')
if (version !== 2) problems.push('版本不是 2')
if (totalLen !== buf.length) problems.push(`头部声明长度 ${totalLen} != 实际 ${buf.length}`)

// ---- chunk 遍历 ----
let off = 12
const chunks = []
while (off < buf.length) {
  if (off + 8 > buf.length) { problems.push('chunk 头越界'); break }
  const len = buf.readUInt32LE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  if (len % 4 !== 0) problems.push(`chunk ${type} 长度 ${len} 未 4 字节对齐`)
  if (off + 8 + len > buf.length) { problems.push(`chunk ${type} 数据越界`); break }
  chunks.push({ type, len, dataOff: off + 8 })
  off += 8 + len
}
const jsonChunk = chunks.find((c) => c.type === 'JSON')
const binChunk = chunks.find((c) => c.type.startsWith('BIN'))
if (!jsonChunk) problems.push('缺少 JSON chunk')
if (!binChunk) problems.push('缺少 BIN chunk')

const gltf = JSON.parse(buf.toString('utf8', jsonChunk.dataOff, jsonChunk.dataOff + jsonChunk.len))
const bin = buf.subarray(binChunk.dataOff, binChunk.dataOff + binChunk.len)

// ---- buffer ----
if (gltf.buffers.length !== 1) notes.push(`buffers 数量 = ${gltf.buffers.length}`)
if (gltf.buffers[0].byteLength !== bin.length) {
  problems.push(`buffer.byteLength ${gltf.buffers[0].byteLength} != BIN chunk ${bin.length}`)
}

// ---- 扩展 ----
const used = gltf.extensionsUsed || []
if (used.includes('KHR_draco_mesh_compression')) problems.push('使用了 Draco 压缩（Hyperfy 不支持）')
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

// ---- bufferView / accessor 越界检查 ----
gltf.bufferViews.forEach((bv, i) => {
  if (bv.byteOffset + bv.byteLength > bin.length) {
    problems.push(`bufferView[${i}] 越界: off=${bv.byteOffset} len=${bv.byteLength} > ${bin.length}`)
  }
  if (bv.byteOffset % 4 !== 0) problems.push(`bufferView[${i}] byteOffset 未 4 字节对齐`)
})
gltf.accessors.forEach((a, i) => {
  const bv = gltf.bufferViews[a.bufferView]
  if (!bv) { problems.push(`accessor[${i}] 指向不存在的 bufferView`); return }
  const elemSize = COMPONENT_SIZE[a.componentType] * TYPE_COUNT[a.type]
  const stride = bv.byteStride || elemSize
  const need = (a.count - 1) * stride + elemSize
  if (need > bv.byteLength) {
    problems.push(`accessor[${i}] 需要 ${need} 字节但 bufferView[${a.bufferView}] 只有 ${bv.byteLength}`)
  }
  if (a.type === 'VEC3' && a.componentType === 5126 && (!a.min || !a.max) && gltf.meshes.some(m => m.primitives.some(p => p.attributes.POSITION === i))) {
    problems.push(`accessor[${i}] 是 POSITION 但缺少 min/max`)
  }
})

// ---- 网格实际数据抽查 ----
let posAccIdx = -1
for (const m of gltf.meshes) for (const p of m.primitives) if (posAccIdx < 0) posAccIdx = p.attributes.POSITION
const pa = gltf.accessors[posAccIdx]
const pbv = gltf.bufferViews[pa.bufferView]
const posData = new Float32Array(bin.buffer, bin.byteOffset + pbv.byteOffset, pa.count * 3)
let yMin = Infinity, yMax = -Infinity, finite = true
for (let i = 0; i < posData.length; i++) {
  if (!Number.isFinite(posData[i])) { finite = false; break }
  if (i % 3 === 1) { if (posData[i] < yMin) yMin = posData[i]; if (posData[i] > yMax) yMax = posData[i] }
}
if (!finite) problems.push('POSITION 中存在非有限数值')

// ---- 索引统计 ----
// 越界检查在下面「每个 primitive 自己的顶点数」里做：mesh[0] 若按材质分成多个
// primitive，每个 primitive 都有自己的 POSITION，拿第一个的顶点数去比别人的索引
// 只会得到假报错（房子有 15 个 primitive，就在这儿误报过一次）。
let idxMax = -1, idxMin = Infinity, triCount = 0
for (const m of gltf.meshes) for (const p of m.primitives) {
  const ia = gltf.accessors[p.indices]
  const ibv = gltf.bufferViews[ia.bufferView]
  const u16 = new Uint16Array(bin.buffer, bin.byteOffset + ibv.byteOffset, ia.count)
  for (const v of u16) { if (v > idxMax) idxMax = v; if (v < idxMin) idxMin = v }
  triCount += ia.count / 3
}

// ---- 场景/子节点引用检查 ----
// 少写一位（scenes[0].nodes 指向不存在的下标）时，Hyperfy 的 GLTFLoader 只会报
// "Cannot read properties of undefined (reading 'name')"，然后整个世界黑屏。
for (const sc of gltf.scenes || []) {
  for (const n of sc.nodes || []) {
    if (!gltf.nodes[n]) problems.push(`scene "${sc.name}" 引用了不存在的节点 ${n}（nodes 共 ${gltf.nodes.length} 个）`)
  }
}
for (const n of gltf.nodes || []) {
  for (const c of n.children || []) {
    if (!gltf.nodes[c]) problems.push(`节点 "${n.name}" 的 children 引用了不存在的节点 ${c}`)
  }
}

// ---- 每个 primitive 的索引都要落在自己的 POSITION 顶点数内 ----
// 上面只查了 mesh[0]；分顶点缓冲的模型（地形 + 植被）各自有上限。
for (const m of gltf.meshes) {
  for (const p of m.primitives) {
    const ia = gltf.accessors[p.indices]
    const ibv = gltf.bufferViews[ia.bufferView]
    const u16 = new Uint16Array(bin.buffer, bin.byteOffset + ibv.byteOffset, ia.count)
    let max = -1
    for (const v of u16) if (v > max) max = v
    const bound = gltf.accessors[p.attributes.POSITION].count
    if (max >= bound) problems.push(`mesh "${m.name}" 的索引 ${max} 超出顶点数 ${bound}`)
  }
}

const report = {
  文件: file,
  大小: (buf.length / 1048576).toFixed(2) + ' MB',
  chunk数: chunks.length,
  BIN字节: bin.length,
  节点: gltf.nodes.map((n) => n.name),
  网格: gltf.meshes.map((m, i) => `mesh[${i}] ${m.name} primitives=${m.primitives.length}`),
  材质: gltf.materials.map((m) => m.name),
  地形三角形: triCount,
  顶点数: Math.max(...gltf.meshes.flatMap((m) => m.primitives.map((p) => gltf.accessors[p.attributes.POSITION].count))),
  高度实测: `${yMin.toFixed(2)} ~ ${yMax.toFixed(2)}`,
  索引范围: `${idxMin} ~ ${idxMax}`,
  扩展: used.length ? used : '无',
  备注: notes,
  问题: problems.length ? problems : '✅ 无',
}
console.log(JSON.stringify(report, null, 2))
process.exit(problems.length ? 1 : 0)
