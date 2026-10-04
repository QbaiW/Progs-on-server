// 在岛上找一块「够平、够高（雪线上）、放得下两层小房子」的地方。
//
// 为什么要算而不是眼看：房子是刚性的，地面是弯的。
// 地基要埋进最矮的那个角，其余地方就会露出裙边 —— 露多少完全由
// 这块地的「四角高差」决定，所以我直接在候选点上把这个量算出来。
//
// 用法：node tools/find-house-spot.mjs

import { heightAt, slopeDeg } from './island-terrain.mjs'

// 房子外轮廓（含屋檐外伸 0.35m）+ 再加一点余量，避免墙角悬空
const HX = 3.0      // 房子在 X 方向的半边长
const HZ = 2.25     // 房子在 Z 方向的半边长
const MARGIN = 0.6  // 屋檐外沿 + 地基外扩

const ex = HX + MARGIN
const ez = HZ + MARGIN

const SNOW_MIN = 21.5   // 雪线是 21，留 0.5 米余量，保证房子在雪里
const MAX_RADIUS = 60   // 不想把房子搁到很远的坡上

// 在房子覆盖的矩形上打 7×7 个采样点，取高差
function footprintStats(cx, cz) {
  let min = Infinity
  let max = -Infinity
  const n = 7
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = cx - ex + (2 * ex * i) / (n - 1)
      const z = cz - ez + (2 * ez * j) / (n - 1)
      const h = heightAt(x, z)
      if (h < min) min = h
      if (h > max) max = h
    }
  }
  return { min, max, dev: max - min }
}

const candidates = []
for (let x = -MAX_RADIUS; x <= MAX_RADIUS; x += 0.5) {
  for (let z = -MAX_RADIUS; z <= MAX_RADIUS; z += 0.5) {
    if (Math.hypot(x, z) > MAX_RADIUS) continue
    const s = footprintStats(x, z)
    if (s.min < SNOW_MIN) continue
    candidates.push({
      x,
      z,
      r: Math.hypot(x, z),
      min: s.min,
      max: s.max,
      dev: s.dev,
      slope: slopeDeg(x, z),
    })
  }
}

if (!candidates.length) {
  console.log('雪线上找不到任何能放下房子的地方，得放宽条件')
  process.exit(1)
}

// 先比平整度（四角高差），平手就看坡度，再看海拔（越接近雪线越好？不，越高越像山顶小屋）
candidates.sort((a, b) => a.dev - b.dev || a.slope - b.slope || b.max - a.max)

console.log('候选点数:', candidates.length)
console.log()
console.log('排名  坐标(x, z)      离岛心   四角高差   最低点   最高点   坡度')
for (const c of candidates.slice(0, 12)) {
  console.log(
    String(candidates.indexOf(c) + 1).padStart(3),
    ` (${c.x.toFixed(1).padStart(6)}, ${c.z.toFixed(1).padStart(6)})`,
    c.r.toFixed(1).padStart(6),
    c.dev.toFixed(3).padStart(9),
    c.min.toFixed(2).padStart(8),
    c.max.toFixed(2).padStart(8),
    c.slope.toFixed(2).padStart(7)
  )
}

const best = candidates[0]
console.log()
console.log('推荐：')
console.log('  --x=' + best.x.toFixed(2) + ' --z=' + best.z.toFixed(2))
console.log('  地基顶面放在 y=' + best.max.toFixed(3) + '（覆盖范围内最高点，保证不埋进土里）')
console.log('  最深的一角会露出裙边 ' + best.dev.toFixed(2) + ' 米')
console.log('  周围坡度 ' + best.slope.toFixed(2) + ' 度')
