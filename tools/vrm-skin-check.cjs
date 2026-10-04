// 查蒙皮数据：零权重顶点、异常骨骼变换、绑骨矩阵
const fs = require('fs')

function load(p) {
  const b = fs.readFileSync(p)
  const jlen = b.readUInt32LE(12)
  const j = JSON.parse(b.toString('utf8', 20, 20 + jlen))
  const binOff = 20 + jlen + 8
  return { j, bin: b.subarray(binOff) }
}

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] }
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function acc({ j, bin }, i) {
  const a = j.accessors[i]
  const bv = j.bufferViews[a.bufferView]
  const [Arr, sz] = CT[a.componentType]
  const n = a.count * NC[a.type]
  const byteOffset = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0)
  return new Arr(bin.buffer, byteOffset, n)
}

function report(p, tag) {
  const g = load(p)
  const { j } = g
  console.log('======= ' + tag + ' =======')
  console.log('  场景根节点:')
  for (const i of (j.scenes?.[0]?.nodes || [])) {
    const n = j.nodes[i]
    console.log(`    [${i}] ${n.name}  mesh=${n.mesh ?? '-'} skin=${n.skin ?? '-'} children=${(n.children || []).length}`)
  }

  // 找出带 skin 的网格节点
  const skinned = j.nodes.map((n, i) => ({ n, i })).filter((x) => x.n.skin !== undefined)
  console.log('  带 skin 的节点:', skinned.map((x) => `${x.n.name}(#${x.i})`).join(', ') || '(无)')

  for (const { n } of skinned) {
    const s = j.skins[n.skin]
    console.log(`  skin[${n.skin}]: joints=${s.joints.length} skeleton=${s.skeleton !== undefined ? j.nodes[s.skeleton].name : '(未指定)'} ibm=${s.inverseBindMatrices !== undefined ? 'yes' : 'NO'}`)
    // 关节名抽样
    console.log('    关节名抽样:', s.joints.slice(0, 4).map((k) => j.nodes[k].name).join(', '), '...')
    // 骨骼绝对变换是否异常
    const ibm = s.inverseBindMatrices !== undefined ? acc(g, s.inverseBindMatrices) : null
    if (ibm) {
      let maxScale = 0, maxTrans = 0, weird = []
      for (let k = 0; k < s.joints.length; k++) {
        const m = ibm.subarray(k * 16, k * 16 + 16)
        const sx = Math.hypot(m[0], m[1], m[2])
        const tx = Math.hypot(m[12], m[13], m[14])
        if (sx > maxScale) maxScale = sx
        if (tx > maxTrans) maxTrans = tx
        if (!isFinite(sx) || sx > 100 || sx < 0.001) weird.push(`${j.nodes[s.joints[k]].name} scale=${sx.toFixed(2)}`)
      }
      console.log(`    绑骨矩阵: 最大缩放=${maxScale.toFixed(3)} 最大平移=${maxTrans.toFixed(3)}`)
      if (weird.length) console.log('    ⚠ 异常关节(缩放偏离 1 太多):', weird.slice(0, 8).join(' | '))
    }
  }

  // 网格顶点权重
  const meshNodes = j.nodes.filter((n) => n.mesh !== undefined)
  for (const n of meshNodes) {
    for (const pr of j.meshes[n.mesh].primitives) {
      const w = pr.attributes.WEIGHTS_0
      const jt = pr.attributes.JOINTS_0
      if (w === undefined) continue
      const W = acc(g, w)
      const J = acc(g, jt)
      let zero = 0, bad = 0
      for (let v = 0; v < W.length; v += 4) {
        const s = W[v] + W[v + 1] + W[v + 2] + W[v + 3]
        if (s < 0.0001) zero++
        else if (Math.abs(s - 1) > 0.05) bad++
      }
      console.log(`  网格 "${n.name}" 顶点=${W.length / 4}: 零权重=${zero} 权重和偏离1=${bad}`)
      if (zero) console.log('    ⚠ 零权重顶点会被当成世界坐标处理 → 拉飞的尖刺')
      // 关节索引范围
      let maxJ = 0
      for (const x of J) if (x > maxJ) maxJ = x
      console.log(`    最大关节索引=${maxJ}  skin 关节数=${j.skins[n.skin]?.joints.length ?? '?'}`)
      if (j.skins[n.skin] && maxJ >= j.skins[n.skin].joints.length) console.log('    ⚠ 关节索引越界！')
    }
  }

  // 节点变换异常
  const odd = []
  j.nodes.forEach((n, i) => {
    const s = n.scale
    if (s && (Math.abs(s[0]) > 50 || Math.abs(s[1]) > 50 || Math.abs(s[2]) > 50)) odd.push(`#${i} ${n.name} scale=${JSON.stringify(s)}`)
    const t = n.translation
    if (t && Math.hypot(...t) > 1000) odd.push(`#${i} ${n.name} translation=${JSON.stringify(t)}`)
  })
  console.log('  异常节点变换:', odd.length ? odd.slice(0, 6).join(' | ') : '无')
  console.log()
}

report(process.argv[2], process.argv[3] || 'A')
if (process.argv[4]) report(process.argv[4], process.argv[5] || 'B')
