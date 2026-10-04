// 对比两个 VRM 的结构，找出可疑差异
const fs = require('fs')

function load(p) {
  const b = fs.readFileSync(p)
  const jlen = b.readUInt32LE(12)
  return { j: JSON.parse(b.toString('utf8', 20, 20 + jlen)), b }
}

const A = load(process.argv[2]) // 有问题的
const B = load(process.argv[3]) // 已知能用

function facts({ j, b }, tag) {
  const ext = j.extensions || {}
  const prims = []
  for (const m of j.meshes || [])
    for (const pr of m.primitives || []) prims.push(pr)

  const attrs = new Set()
  for (const pr of prims) for (const k of Object.keys(pr.attributes || {})) attrs.add(k)

  const mat = (j.materials || [])[0] || {}
  const pbr = mat.pbrMetallicRoughness || {}

  return {
    tag,
    vrm: ext.VRM ? 'VRM 0.x' : ext.VRMC ? 'VRMC_vrm ' + ext.VRMC.specVersion : '无',
    extensionsUsed: (j.extensionsUsed || []).join(', ') || '(无)',
    extensionsRequired: (j.extensionsRequired || []).join(', ') || '(无)',
    // 顶点属性
    attributes: [...attrs].sort().join(' '),
    hasNormals: attrs.has('NORMAL'),
    hasUV: attrs.has('TEXCOORD_0'),
    hasSkinWeights: attrs.has('JOINTS_0') && attrs.has('WEIGHTS_0'),
    hasMorphTargets: prims.some((pr) => (pr.targets || []).length > 0),
    morphCount: prims.reduce((a, pr) => a + (pr.targets || []).length, 0),
    meshCount: (j.meshes || []).length,
    primitiveCount: prims.length,
    materialCount: (j.materials || []).length,
    // 材质
    matName: mat.name || '(无名)',
    matUnlit: !!(mat.extensions && mat.extensions.KHR_materials_unlit),
    matExt: mat.extensions ? Object.keys(mat.extensions).join(',') : '(无)',
    baseColorFactor: pbr.baseColorFactor || '(默认)',
    baseColorTexture: pbr.baseColorTexture ? 'yes' : 'no',
    doubleSided: !!mat.doubleSided,
    // VRM 专有
    vrmMatProps: ext.VRM && ext.VRM.materialProperties ? ext.VRM.materialProperties.length : 0,
    vrmBlendShapeGroups: ext.VRM && ext.VRM.blendShapeMaster
      ? (ext.VRM.blendShapeMaster.blendShapeGroups || []).length : 0,
    vrmFirstPerson: ext.VRM && ext.VRM.firstPerson
      ? JSON.stringify(ext.VRM.firstPerson).slice(0, 60) : '(无)',
    // 节点
    nodeCount: (j.nodes || []).length,
    rootNodes: (j.scenes || [])[0] ? (j.scenes[0].nodes || []).map((i) => j.nodes[i].name) : [],
    rootHasRotation: (j.scenes || [])[0]
      ? (j.scenes[0].nodes || []).map((i) => JSON.stringify(j.nodes[i].rotation || null)).join(' ')
      : '',
    rootHasScale: (j.scenes || [])[0]
      ? (j.scenes[0].nodes || []).map((i) => JSON.stringify(j.nodes[i].scale || null)).join(' ')
      : '',
    skinCount: (j.skins || []).length,
    joints: (j.skins || []).reduce((a, s) => a + (s.joints || []).length, 0),
    images: (j.images || []).map((im) => im.mimeType + (im.uri ? ' 外链' : ' bufferView')).join(', ') || '(无)',
    animations: (j.animations || []).length,
    bytes: b.length,
  }
}

const fa = facts(A, 'saint-claus')
const fb = facts(B, 'nova(可用)')

const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => k !== 'tag')
console.log('字段'.padEnd(24) + 'saint-claus'.padEnd(34) + 'nova(可用)')
console.log('-'.repeat(92))
for (const k of keys) {
  const a = String(fa[k])
  const b = String(fb[k])
  const flag = a !== b ? '  ← 不同' : ''
  console.log(k.padEnd(24) + a.slice(0, 32).padEnd(34) + b.slice(0, 32) + flag)
}
