// 小岛地形的「单一事实来源」——纯数学，无副作用，可被任何工具引用。
//
// 抽出来的原因：盖房子的时候需要知道地面在哪、平不平，
// 如果 make-island.mjs 和盖房子的脚本各写一份 heightAt()，
// 两边一旦漂移，房子就会浮在空中或者埋进土里，而且很难发现。
//
// 抽完必须验证：重新生成 island.glb 的 sha256 仍然是
//   3444c4df7ff78eda63f376f358267da7781cb2c8fd3c9ac100197e3ff4d18ac5
// 对不上就说明这次重构改了数值，必须回退。

export const TERRAIN = {
  size: 700,        // 地形边长（世界单位 ≈ 米）
  radius: 180,      // 岛屿半径
  seaLevel: 0,      // 海平面高度
}

// ---------------- 噪声 ----------------
function hash2(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const smooth = (t) => t * t * (3 - 2 * t)

function valueNoise(x, y) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = smooth(x - xi)
  const v = smooth(y - yi)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

export function fbm(x, y, octaves = 5) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// ---------------- 高度场 ----------------
// 设计要点：用显式穹顶(dome)做主轮廓，保证中心最高。
// 曾经把出生点强行压平到 2 米，而周围自然地形有 20 多米 ——
// 等于在山顶挖了个坑，看起来就是"凹进去的"。
export function heightAt(x, z) {
  const d = Math.hypot(x, z) / TERRAIN.radius
  const edgeR = (TERRAIN.size / 2) / TERRAIN.radius   // 网格边缘对应的归一化半径

  // 主轮廓：中心 1，边缘 0 的平滑穹顶 —— 这是唯一的山
  const dome = 1 - smoothstep(0, 1.02, d)

  // 细节起伏：幅度刻意压得很小。
  // 曾经这里是 7*slow + 4*ridge，叠加在穹顶上凸出了好几座山峰；
  // 现在降到 2.6/1.4，只是让坡面不呆板，不会形成第二个峰。
  const slow = fbm(x * 0.0058 + 100, z * 0.0058 + 100, 6)
  const ridge = Math.pow(fbm(x * 0.014 + 7, z * 0.014 + 7, 4), 1.35)

  let h = dome * 28 + Math.pow(Math.max(0, dome), 0.6) * (2.6 * slow + 1.4 * ridge) - 4

  // 离岸小岛已移除 —— 只保留中心这一座山。
  // （之前 isletA / isletB 在 (300,190) 和 (-320,-150) 又造了两座，
  //   于是海面上出现三座山，与"只要脚下这一座"的要求冲突。）

  // 在 +X 侧切一个海湾
  const bay = Math.exp(-(((x - 118) ** 2) / 5200 + ((z - 46) ** 2) / 11000))
  h -= bay * 14 * dome

  // 浅泻湖：只降 7 米，走进去还能走回来
  h -= smoothstep(1.0, 1.65, d) * 7
  // 外缘回升，把整张网格收成封闭的碗：
  // 走到任何位置脚下都有地面，不可能掉进虚空，
  // 所以不需要那种"脚底下一层看不见的假地板"。
  h += smoothstep(edgeR - 0.28, edgeR, d) * 10

  return h
}

// ---------------- 地形法线（中心差分，与 make-island.mjs 同一套） ----------------
export function normalAt(x, z, step = 1) {
  const hl = heightAt(x - step, z)
  const hr = heightAt(x + step, z)
  const hd = heightAt(x, z - step)
  const hu = heightAt(x, z + step)
  let nx = hl - hr
  let ny = 2 * step
  let nz = hd - hu
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

// 坡度（度）。0 = 完全水平。
export function slopeDeg(x, z, step = 1) {
  const [nx, ny, nz] = normalAt(x, z, step)
  return (Math.acos(Math.min(1, Math.max(-1, ny))) * 180) / Math.PI
}
