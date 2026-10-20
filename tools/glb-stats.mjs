// GLB 体量统计器 —— 只读 JSON chunk，不解析顶点数据，也不需要 three。
//
// 数的东西就是「渲染成本」：每个 primitive 在 three 里是一次 draw call，
// 三角形/顶点/材质数决定 GPU 压力。另外把 Hyperfy 认的 extras.node 标出来，
// 顺带核对碰撞体是否仍是「单 primitive、不带材质」。
//
// 用法：node tools/glb-stats.mjs <a.glb> [b.glb ...] [--verbose]

import fs from 'node:fs'
import path from 'node:path'

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const verbose = process.argv.includes('--verbose')

function readGlb(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(path.basename(file) + ': 不是 GLB')
  let offset = 12
  let json = null
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset)
    const type = buf.readUInt32LE(offset + 4)
    if (type === CHUNK_JSON) json = JSON.parse(buf.subarray(offset + 8, offset + 8 + length).toString('utf8'))
    offset += 8 + length
  }
  if (!json) throw new Error(path.basename(file) + ': 找不到 JSON chunk')
  return { json, bytes: buf.length }
}

function primitiveSize(prim, json) {
  const position = prim.attributes?.POSITION
  const verts = position === undefined ? 0 : json.accessors[position].count
  const index = prim.indices
  if (index === undefined) return { verts, tris: Math.floor(verts / 3) }
  const count = json.accessors[index].count
  const mode = prim.mode ?? 4
  return { verts, tris: mode === 4 ? Math.floor(count / 3) : 0 }
}

for (const file of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const { json, bytes } = readGlb(file)
  const rows = []
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const { verts, tris } = primitiveSize(prim, json)
      const material = prim.material === undefined ? '（无材质）' : (json.materials?.[prim.material]?.name ?? '#' + prim.material)
      rows.push({ mesh: mesh.name ?? '(无名)', material, verts, tris })
    }
  }
  const tris = rows.reduce((n, r) => n + r.tris, 0)
  const verts = rows.reduce((n, r) => n + r.verts, 0)

  const tags = new Map()
  for (const node of json.nodes ?? []) {
    const tag = node.extras?.node
    if (!tag) continue
    const list = tags.get(tag) ?? []
    list.push(node.mesh === undefined ? 0 : (json.meshes[node.mesh]?.primitives?.length ?? 0))
    tags.set(tag, list)
  }

  console.log('='.repeat(72))
  console.log(`${path.basename(file)}`)
  console.log(`  体积 ${(bytes / 1048576).toFixed(2)} MB · 网格 ${(json.meshes ?? []).length} · ` +
    `primitive ${rows.length}（≈ draw call）· 材质 ${(json.materials ?? []).length} · ` +
    `三角形 ${tris.toLocaleString('en-US')} · 顶点 ${verts.toLocaleString('en-US')}`)
  for (const [tag, prims] of tags) {
    const detail = tag === 'collider'
      ? `（${prims.join('+')} 个 primitive${prims.every((n) => n === 1) ? '、单 primitive' : '、⚠ 不是单 primitive'}）`
      : ''
    console.log(`  extras.node = ${tag} × ${prims.length}${detail}`)
  }
  const listed = verbose ? rows : [...rows].sort((a, b) => b.tris - a.tris).slice(0, 8)
  for (const r of listed) {
    console.log(`    ${String(r.material).padEnd(9)} ${String(r.tris).padStart(6)} 面  ${String(r.verts).padStart(6)} 点  ← ${r.mesh}`)
  }
  if (!verbose && rows.length > listed.length) console.log(`    …另有 ${rows.length - listed.length} 个 primitive（--verbose 全列）`)
  const colliderRow = rows.find((r) => r.material === '（无材质）')
  if (colliderRow) console.log('  碰撞体：单 primitive、无材质 ✓')
}
