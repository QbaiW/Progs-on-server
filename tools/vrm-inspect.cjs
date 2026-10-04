// 检查 VRM/GLB：格式、扩展、骨骼、是否有 Hyperfy 加载不了的东西
const fs = require('fs')

const p = process.argv[2]
const b = fs.readFileSync(p)

const out = { file: p, bytes: b.length }
const magic = b.toString('ascii', 0, 4)
out.magic = magic
if (magic !== 'glTF') {
  console.log(JSON.stringify({ ...out, verdict: '不是 GLB/VRM 文件', head: b.subarray(0, 16).toString('hex') }, null, 1))
  process.exit(0)
}

const ver = b.readUInt32LE(4)
const jlen = b.readUInt32LE(12)
const jtype = b.toString('ascii', 16, 20)
const j = JSON.parse(b.toString('utf8', 20, 20 + jlen))

out.glbVersion = ver
out.jsonChunk = jtype
out.extensionsUsed = j.extensionsUsed || []
out.extensionsRequired = j.extensionsRequired || []

// VRM 版本
const ext = j.extensions || {}
if (ext.VRM) out.vrm = { spec: 'VRM 0.x', meta: ext.VRM.meta }
if (ext.VRMC) out.vrm = { spec: 'VRMC_vrm ' + ext.VRMC.specVersion, meta: ext.VRMC.meta }

// 人类骨骼
const human = (ext.VRM && ext.VRM.humanoid && ext.VRM.humanoid.humanBones) ||
  (ext.VRMC && ext.VRMC.humanoid && ext.VRMC.humanoid.humanBones)
out.humanBones = human ? Object.keys(human).length : 0
out.humanBonesMissing = human
  ? ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']
      .filter((k) => !human.some((h) => h.bone === k))
  : ['(无 humanoid 定义)']

out.counts = {
  nodes: (j.nodes || []).length,
  meshes: (j.meshes || []).length,
  materials: (j.materials || []).length,
  textures: (j.textures || []).length,
  images: (j.images || []).length,
  skins: (j.skins || []).length,
  animations: (j.animations || []).length,
  accessors: (j.accessors || []).length,
}
out.totalJoints = (j.skins || []).reduce((a, s) => a + (s.joints || []).length, 0)

// 图片用的是外链还是内嵌？（注意：不能拿展示用的中文占位串当 uri 判断）
out.imagesDetail = (j.images || []).map((im) => ({
  mime: im.mimeType || null,
  source: im.bufferView !== undefined
    ? '内嵌(bufferView)'
    : im.uri
      ? (im.uri.startsWith('data:') ? '内嵌(data URI)' : '外部文件 ' + im.uri)
      : '未知',
}))

// 三角形总数
let tris = 0
for (const m of j.meshes || [])
  for (const pr of m.primitives || []) if (pr.indices !== undefined) tris += j.accessors[pr.indices].count / 3
out.triangles = Math.round(tris)

// 各 mesh 用了什么扩展（Draco 会在这里露出）
const primExt = new Set()
for (const m of j.meshes || [])
  for (const pr of m.primitives || []) for (const k of Object.keys(pr.extensions || {})) primExt.add(k)
out.primitiveExtensions = [...primExt]

// 尺寸（从 POSITION accessor 的 min/max 推）
let lo = [Infinity, Infinity, Infinity]
let hi = [-Infinity, -Infinity, -Infinity]
for (const m of j.meshes || [])
  for (const pr of m.primitives || []) {
    const a = j.accessors[pr.attributes.POSITION]
    if (a && a.min && a.max) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a.min[i]); hi[i] = Math.max(hi[i], a.max[i]) }
  }
out.boundsMeters = lo[0] === Infinity ? null : {
  min: lo.map((v) => +v.toFixed(3)),
  max: hi.map((v) => +v.toFixed(3)),
  size: hi.map((v, i) => +(v - lo[i]).toFixed(3)),
}

// Hyperfy 能不能加载？已知它没有 DRACOLoader / KTX2Loader / meshopt
const killers = []
if ((j.extensionsRequired || []).includes('KHR_draco_mesh_compression')) killers.push('Draco 压缩（Hyperfy 没挂 DRACOLoader，会直接报错）')
if (out.primitiveExtensions.includes('KHR_draco_mesh_compression')) killers.push('primitive 里用了 Draco')
if ((j.extensionsRequired || []).includes('KHR_texture_basisu')) killers.push('KTX2/Basis 贴图（没挂 KTX2Loader）')
if ((j.extensionsRequired || []).includes('EXT_meshopt_compression')) killers.push('meshopt 压缩（没挂解码器）')
if ((j.images || []).some((im) => im.bufferView === undefined && im.uri && !im.uri.startsWith('data:')))
  killers.push('贴图是外部文件引用，单文件上传会丢图')

// 场景根节点结构：蒙皮网格必须挂在父节点下，否则 glbToNodes 会掉进空分支
const roots = (j.scenes || [])[0] ? j.scenes[0].nodes || [] : []
const bareSkinnedRoots = roots.filter((i) => j.nodes[i] && j.nodes[i].skin !== undefined)
if (bareSkinnedRoots.length) {
  killers.push(
    '蒙皮网格直接暴露在场景根（没有父节点）→ glbToNodes 的 SkinnedMesh 分支是空的，' +
      '骨架挂不上 → 模型会被拉变形。用 tools/fix-vrm-root.cjs 包一层父节点即可。'
  )
}
out.sceneRoots = roots.map((i) => j.nodes[i].name)
out.killers = killers

console.log(JSON.stringify(out, null, 1))
