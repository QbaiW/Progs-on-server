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

// ---- 索引越界检查 ----
let idxMax = -1, idxMin = Infinity, triCount = 0
for (const p of gltf.meshes[0].primitives) {
  const ia = gltf.accessors[p.indices]
  const ibv = gltf.bufferViews[ia.bufferView]
  const u16 = new Uint16Array(bin.buffer, bin.byteOffset + ibv.byteOffset, ia.count)
  for (const v of u16) { if (v > idxMax) idxMax = v; if (v < idxMin) idxMin = v }
  triCount += ia.count / 3
  if (idxMax >= gltf.accessors[posAccIdx].count) {
    problems.push(`索引 ${idxMax} 超出顶点数 ${gltf.accessors[posAccIdx].count}`)
    break
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
  顶点数: gltf.accessors[posAccIdx].count,
  高度实测: `${yMin.toFixed(2)} ~ ${yMax.toFixed(2)}`,
  索引范围: `${idxMin} ~ ${idxMax}`,
  扩展: used.length ? used : '无',
  备注: notes,
  问题: problems.length ? problems : '✅ 无',
}
console.log(JSON.stringify(report, null, 2))
process.exit(problems.length ? 1 : 0)
