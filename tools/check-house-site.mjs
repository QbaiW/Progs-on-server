// 检查房子选址，并算出房子该放多高。
//
// 为什么需要这个：房子和地形是两个**独立的碰撞体**（岛屿是场景蓝图的 GLB、
// 房子是地图上的一个应用实体），它们之间没有任何自动贴合。放低了地形会从一层
// 地面戳进屋里，放高了房子会悬空。基准高度必须由地形自己算出来，不能拍脑袋。
//
// 判据（全部相对房子原点，房子原点 = 一层地面结构层顶面标高）：
//   地形最高点 ≤ 0.00        否则地面会从一层地面戳进屋里
//   地形最低点 ≥ -1.20       否则地基够不着、房子悬空
//   推荐基准 = 地形最高点 + 净空，让四周露出一圈台明，也留出浮点余量
//
// 用法：
//   node tools/check-house-site.mjs                  # 用默认位置，自动算基准高度
//   node tools/check-house-site.mjs -5 -1            # 指定平面位置
//   node tools/check-house-site.mjs -5 -1 24.65      # 手动指定基准高度

import { heightAt } from './island-terrain.mjs'

const X = Number(process.argv[2] ?? -5)
const Z = Number(process.argv[3] ?? -1)
const CLEARANCE = 0.03   // 一层地面高出地形最高点的净空
const STEP = 0.10        // 采样步长

// 占地范围（相对房子原点）—— 取自 GLB 包围盒：
// x ∈ [-3.35, 3.52]（含 +X 侧挂在外墙上的烟囱）
// z ∈ [-3.30, 2.60]（含 -Z 侧门廊与四周屋檐挑出）
const X0 = -3.35, X1 = 3.52, Z0 = -3.30, Z1 = 2.60

let min = Infinity, max = -Infinity, minAt = null, maxAt = null
for (let dx = X0; dx <= X1 + 1e-9; dx += STEP) {
  for (let dz = Z0; dz <= Z1 + 1e-9; dz += STEP) {
    const h = heightAt(X + dx, Z + dz)
    if (h < min) { min = h; minAt = [X + dx, Z + dz] }
    if (h > max) { max = h; maxAt = [X + dx, Z + dz] }
  }
}

const autoBase = max + CLEARANCE
const BASE = process.argv[4] !== undefined ? Number(process.argv[4]) : autoBase
const EPS = 1e-6

const FLOOR_STRUCT_TOP = BASE + 0.00   // 一层地面结构层顶面（木面层在 +0.02）
const FOUNDATION_BOTTOM = BASE - 1.20  // 地基底面

const floats = min < FOUNDATION_BOTTOM - EPS
const pokes = max > FLOOR_STRUCT_TOP + EPS

console.log(`平面位置 (${X}, ${Z})，占地 ${(X1 - X0).toFixed(2)} × ${(Z1 - Z0).toFixed(2)} 米，步长 ${STEP} 米`)
console.log(`地形：最低 ${min.toFixed(4)}（${minAt[0].toFixed(2)}, ${minAt[1].toFixed(2)}） 最高 ${max.toFixed(4)}（${maxAt[0].toFixed(2)}, ${maxAt[1].toFixed(2)}）`)
console.log(`起伏 ${(max - min).toFixed(4)} 米`)
console.log()
console.log(`基准高度（一层地面标高）：${BASE.toFixed(4)}${process.argv[4] === undefined ? '  ← 自动 = 地形最高 + ' + CLEARANCE : '  ← 手动指定'}`)
console.log(`  ${floats ? '✗ 地形有地方低于地基底面 → 房子悬空' : '✓ 地基埋在地形里（最浅处入土 ' + (min - (BASE - 1.20)).toFixed(3) + ' 米）'}`)
console.log(`  ${pokes ? '✗ 地形有地方高过一层地面 → 会戳进屋里' : '✓ 地形整体在一层地面之下'}`)
console.log()
console.log(`一层地面高出地形最高点 ${(BASE - max).toFixed(4)} 米 → 四周露出台明 ${((BASE - max) + 0.30).toFixed(3)} 米（结构层 0.30 + 净空）`)
console.log(`地基从 ${(FOUNDATION_BOTTOM).toFixed(3)} 到 ${(BASE - 0.30).toFixed(3)}，最浅处入土 ${(min - FOUNDATION_BOTTOM).toFixed(3)} 米`)
console.log()
if (floats || pokes) {
  console.log('结论：这个选址不行，需要换地方或加高地基。')
} else {
  console.log(`结论：选址可用。实体 position 用 [${X}, ${BASE.toFixed(4)}, ${Z}]。`)
}
