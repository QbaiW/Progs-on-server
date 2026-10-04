// 修 saint-claus.vrm：把散落的场景根节点包进一个统一父节点。
//
// 原因：Hyperfy 的 glbToNodes 判断链里
//   isSkinnedMeshRoot = !!object3d.children.find(c => c.isSkinnedMesh)  → 建 skinnedmesh
//   object3d.type === 'Mesh'      → 建 mesh
//   object3d.type === 'SkinnedMesh' → 空实现，什么都不做
// 这个模型的蒙皮网格自己就是场景根（没有父节点），所以前两条都不成立，
// 掉进空分支 → 骨架没被正确挂上 → 帽子被拉成通天柱子。
// 包一层父节点后，父节点命中 isSkinnedMeshRoot，走正常路径。
//
// 只动 JSON 里的 scenes/nodes，顶点数据一个字节都不碰。
const fs = require('fs')

const src = process.argv[2]
const dst = process.argv[3]
const b = fs.readFileSync(src)

if (b.toString('ascii', 0, 4) !== 'glTF') throw new Error('不是 GLB')

const jsonLen = b.readUInt32LE(12)
const j = JSON.parse(b.toString('utf8', 20, 20 + jsonLen))
// BIN chunk 紧跟 JSON chunk（各带 8 字节头）
const binStart = 20 + jsonLen + 8
const binLen = b.readUInt32LE(20 + jsonLen)
const bin = b.subarray(binStart, binStart + binLen)

const roots = j.scenes[j.scene || 0].nodes
if (roots.length < 2) {
  console.log('场景只有一个根节点，无需修改')
  process.exit(0)
}

// 已经在单一根下就跳过
if (roots.length === 1 && (j.nodes[roots[0]].children || []).length) {
  console.log('已经是单一根节点结构，无需修改')
  process.exit(0)
}

console.log('修改前场景根节点:')
for (const i of roots) console.log(`  [${i}] ${j.nodes[i].name}`)

const wrapIndex = j.nodes.length
j.nodes.push({
  name: 'AvatarRoot',
  children: roots.slice(),
  // 和 nova 一样，根节点不带变换
})
j.scenes[j.scene || 0].nodes = [wrapIndex]

console.log(`修改后: 新增 [${wrapIndex}] AvatarRoot，children = [${roots.join(', ')}]`)

// 重新拼 GLB
let jsonText = JSON.stringify(j)
while (jsonText.length % 4 !== 0) jsonText += ' '
const jsonBuf = Buffer.from(jsonText, 'utf8')
let binBuf = bin
while (binBuf.length % 4 !== 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(1)])

const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length
const head = Buffer.alloc(12)
head.write('glTF', 0, 'ascii')
head.writeUInt32LE(2, 4)
head.writeUInt32LE(total, 8)
const jHdr = Buffer.alloc(8)
jHdr.writeUInt32LE(jsonBuf.length, 0)
jHdr.write('JSON', 4, 'ascii')
const bHdr = Buffer.alloc(8)
bHdr.writeUInt32LE(binBuf.length, 0)
bHdr.write('BIN\0', 4, 'ascii')

fs.writeFileSync(dst, Buffer.concat([head, jHdr, jsonBuf, bHdr, binBuf]))
console.log(`输出: ${dst}  ${fs.statSync(dst).size} 字节`)
