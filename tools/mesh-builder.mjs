// 共享的「程序化网格 → glTF 2.0 二进制(.glb)」构建器。
//
// 与 make-house.mjs 里的实现逐行相同（那边的输出 sha256 是
// 95c0f50962711539f92d322240f9984f9fcbc3f59dbd4980c187d0eb8de3e76a，已上线）。
// 这里只是把它做成可复用的工厂，新模型（小船等）直接 import，不再各写一份。
//
// 这里沉淀的是几条踩出来的硬约束：
//
// 1) 不手写绕序 —— 由「期望外法线」反推，绕序反了就翻过来。
//    手写绕序是最容易出错的地方，而且错了的表现是"面看不见"，很难定位。
//
// 2) 碰撞网格必须是「单独的、单一 primitive、不带材质」的一个 Mesh。
//    src/core/extras/glbToNodes.js:73 的判断是
//        else if (props.node === 'collider' && object3d.isMesh)
//    一个对象若带 collider 标记却有多种材质，GLTFLoader 会把它拆成
//    Group + 每材质一个 Mesh，标记落在 Group 上，isMesh 就是 false ——
//    碰撞体静默地从来没被创建过。地形那一版就是这么"站不住"的。
//
// 3) 不用任何压缩/纹理扩展（服务端没有 DRACOLoader，纹理一律用 baseColorFactor）。
//
// 4) 索引是 Uint16，所以任何一条 POSITION accessor 的顶点数必须 ≤ 65535。
//
// 5) 三角形不能太大。PhysX 的 "TriangleMesh: triangles are too big" 只是警告，
//    但面太大时物理不稳，所以模型要切成米级的块。
//
// 6) 不能有共面且同朝向的重叠面（z-fighting / 重复三角形）。
//    相邻体积要么首尾相接，要么错开，不要叠。

import fs from 'node:fs'
import path from 'node:path'

export function createMeshBuilder() {
  // 每个面：{ v: [顶点…], n: 外法线, mat: 材质名, solid: 是否参与碰撞 }
  // 面既可能是四边形（4 顶点 / 2 三角形），也可能是三角形（3 / 1）。
  const quads = []

  const bufferViews = []
  const accessors = []
  const binParts = []
  let binOffset = 0

  const alignBuffer = (buf) => {
    const rem = buf.length % 4
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, 0)])
  }

  function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }

  function cross(e1, e2) {
    return norm([
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ])
  }

  function addQuad(v0, v1, v2, v3, wantN, mat, solid = true) {
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
    const e2 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]]
    let n = cross(e1, e2)
    const dot = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2]
    if (dot < 0) {
      n = [-n[0], -n[1], -n[2]]
      quads.push({ v: [v0, v3, v2, v1], n, mat, solid })
    } else {
      quads.push({ v: [v0, v1, v2, v3], n, mat, solid })
    }
  }

  function addTri(a, b, c, wantN, mat, solid = true) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]]
    const n = cross(e1, e2)
    const dot = n[0] * wantN[0] + n[1] * wantN[1] + n[2] * wantN[2]
    // 三角形保持 3 个顶点，不凑成退化的四边形 ——
    // 零面积三角形会让 PhysX 的三角网格校验报警告。
    if (dot < 0) quads.push({ v: [a, c, b], n: [-n[0], -n[1], -n[2]], mat, solid })
    else quads.push({ v: [a, b, c], n, mat, solid })
  }

  // 轴对齐立方体（6 个面）
  function addBox(x0, y0, z0, x1, y1, z1, mat, solid = true) {
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return
    const p = (x, y, z) => [x, y, z]
    addQuad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0), [1, 0, 0], mat, solid)
    addQuad(p(x0, y0, z1), p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), [-1, 0, 0], mat, solid)
    addQuad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), [0, 1, 0], mat, solid)
    addQuad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0), p(x0, y0, z0), [0, -1, 0], mat, solid)
    addQuad(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1), [0, 0, 1], mat, solid)
    addQuad(p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), p(x0, y0, z0), [0, 0, -1], mat, solid)
  }

  // 绕 X 轴旋转的立方体（斜面用，比如屋面板）
  function addRotBoxX(cx, cy, cz, sx, sy, sz, ang, mat, solid = true) {
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    // 位置绕 X 轴旋转： y' = y·cos − z·sin ，z' = y·sin + z·cos
    const rot = (x, y, z) => [cx + x, cy + y * ca - z * sa, cz + y * sa + z * ca]
    // 法线同一套旋转（只对 (y,z) 分量起作用）
    const rn = (y, z) => [0, y * ca - z * sa, y * sa + z * ca]
    const hx = sx / 2
    const hy = sy / 2
    const hz = sz / 2
    const c000 = rot(-hx, -hy, -hz), c001 = rot(-hx, -hy, hz)
    const c010 = rot(-hx, hy, -hz), c011 = rot(-hx, hy, hz)
    const c100 = rot(hx, -hy, -hz), c101 = rot(hx, -hy, hz)
    const c110 = rot(hx, hy, -hz), c111 = rot(hx, hy, hz)
    addQuad(c100, c101, c111, c110, [1, 0, 0], mat, solid)   // +X
    addQuad(c001, c000, c010, c011, [-1, 0, 0], mat, solid)  // -X
    addQuad(c010, c110, c111, c011, rn(1, 0), mat, solid)    // +Y（旋转后的"上面"）
    addQuad(c001, c101, c100, c000, rn(-1, 0), mat, solid)   // -Y
    addQuad(c001, c011, c111, c101, rn(0, 1), mat, solid)    // +Z 端
    addQuad(c100, c110, c010, c000, rn(0, -1), mat, solid)   // -Z 端
  }

  // ---------------- 二进制写入 ----------------
  function pushView(buf, target) {
    const aligned = alignBuffer(buf)
    const view = { buffer: 0, byteOffset: binOffset, byteLength: buf.length }
    if (target) view.target = target
    bufferViews.push(view)
    binParts.push(aligned)
    binOffset += aligned.length
    return bufferViews.length - 1
  }

  function pushAccessor(view, componentType, count, type, extra = {}) {
    accessors.push({ bufferView: view, componentType, count, type, ...extra })
    return accessors.length - 1
  }

  // 把一个面列表编译成 (POSITION, NORMAL, indices)
  function compile(faces) {
    let vTotal = 0
    let triTotal = 0
    for (const q of faces) {
      vTotal += q.v.length
      triTotal += q.v.length - 2
    }
    const pos = new Float32Array(vTotal * 3)
    const nrm = new Float32Array(vTotal * 3)
    const idx = new Uint16Array(triTotal * 3)
    let pi = 0
    let ii = 0
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const q of faces) {
      const base = pi / 3
      for (const v of q.v) {
        pos[pi] = v[0]; pos[pi + 1] = v[1]; pos[pi + 2] = v[2]
        nrm[pi] = q.n[0]; nrm[pi + 1] = q.n[1]; nrm[pi + 2] = q.n[2]
        for (let c = 0; c < 3; c++) {
          const val = v[c]
          if (val < min[c]) min[c] = val
          if (val > max[c]) max[c] = val
        }
        pi += 3
      }
      for (let k = 1; k < q.v.length - 1; k++) {
        idx[ii++] = base; idx[ii++] = base + k; idx[ii++] = base + k + 1
      }
    }
    return { pos, nrm, idx, min, max, vTotal, triTotal }
  }

  function pushGeometry(faces, materialIndex) {
    const g = compile(faces)
    const posView = pushView(Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength), 34962)
    const nrmView = pushView(Buffer.from(g.nrm.buffer, g.nrm.byteOffset, g.nrm.byteLength), 34962)
    const idxView = pushView(Buffer.from(g.idx.buffer, g.idx.byteOffset, g.idx.byteLength), 34963)
    const posAcc = pushAccessor(posView, 5126, g.pos.length / 3, 'VEC3', { min: g.min, max: g.max })
    const nrmAcc = pushAccessor(nrmView, 5126, g.nrm.length / 3, 'VEC3')
    const idxAcc = pushAccessor(idxView, 5123, g.idx.length, 'SCALAR')
    const prim = { attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc }
    if (materialIndex !== undefined) prim.material = materialIndex
    return { prim, tri: g.idx.length / 3, min: g.min, max: g.max }
  }

  // 组装并写盘。nodes / meshes / materials 由调用方给，
  // sceneRoots 是场景根节点在 nodes 里的下标数组。
  function writeGlb(out, { generator, sceneName, sceneRoots, nodes, meshes, materials }) {
    const maxVert = accessors
      .filter((a) => a.type === 'VEC3')
      .reduce((m, a) => Math.max(m, a.count), 0)
    if (maxVert > 65535) throw new Error('顶点数超过 Uint16 上限: ' + maxVert)

    const binBuffer = Buffer.concat(binParts)
    const gltf = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ name: sceneName, nodes: sceneRoots }],
      nodes,
      meshes,
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binBuffer.length }],
    }

    let jsonText = JSON.stringify(gltf)
    while (jsonText.length % 4 !== 0) jsonText += ' '
    const jsonBuf = Buffer.from(jsonText, 'utf8')

    const header = Buffer.alloc(12)
    header.write('glTF', 0, 'ascii')
    header.writeUInt32LE(2, 4)
    const totalLength = 12 + 8 + jsonBuf.length + 8 + binBuffer.length
    header.writeUInt32LE(totalLength, 8)

    const jsonChunkHeader = Buffer.alloc(8)
    jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0)
    jsonChunkHeader.write('JSON', 4, 'ascii')

    const binChunkHeader = Buffer.alloc(8)
    binChunkHeader.writeUInt32LE(binBuffer.length, 0)
    binChunkHeader.write('BIN\0', 4, 'ascii')

    const glb = Buffer.concat([header, jsonChunkHeader, jsonBuf, binChunkHeader, binBuffer])
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
      fs.writeFileSync(out, glb)
    }
    return { glb, byteLength: glb.length, maxVert }
  }

  return {
    quads,
    accessors,
    bufferViews,
    addQuad,
    addTri,
    addBox,
    addRotBoxX,
    norm,
    compile,
    pushView,
    pushAccessor,
    pushGeometry,
    writeGlb,
  }
}
