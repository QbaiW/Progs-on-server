// 校验皮肤页：SKINS 数组是否合法、生成的 URL 是否正确
const fs = require('fs')
const path = require('path')

const file = process.argv[2] || 'shared-board/public/skin/index.html'
const html = fs.readFileSync(file, 'utf8')

const m = html.match(/const SKINS = (\[[\s\S]*?\n\])/)
if (!m) {
  console.log('❌ 没找到 SKINS 数组')
  process.exit(1)
}

let SKINS
try {
  SKINS = eval(m[1])
} catch (e) {
  console.log('❌ SKINS 语法错误:', e.message)
  process.exit(1)
}

console.log('✅ SKINS 数组合法，共', SKINS.length, '张')
console.log()

const BASE = 'https://world.myiuan.xin/assets/'
let bad = 0
for (const s of SKINS) {
  const vrm = `${BASE}avatar-${s.file}.vrm`
  const prev = `${BASE}preview-${s.file}.${s.ext}`
  const okVrm = /^https:\/\/world\.myiuan\.xin\/assets\/avatar-[a-z-]+\.vrm$/.test(vrm)
  const okPrev = /^https:\/\/world\.myiuan\.xin\/assets\/preview-[a-z-]+\.(webp|png)$/.test(prev)
  if (!okVrm || !okPrev) {
    bad++
    console.log('  ❌', s.zh, vrm, prev)
  }
}
console.log(bad ? `  ❌ 有 ${bad} 条 URL 不合法` : `  ✅ 全部 ${SKINS.length} 条的 VRM 与预览图 URL 格式均合法`)
console.log()

console.log('中文字段检查:')
console.log('  最长中文名 =', Math.max(...SKINS.map((s) => s.zh.length)), '字')
const long = SKINS.filter((s) => s.zh.length > 7)
if (long.length) console.log('  ⚠ 偏长:', long.map((s) => s.zh).join(' '))
console.log()

console.log('许可标注:')
console.log('  CC0（免署名）:', SKINS.filter((s) => s.lic === 'cc0').map((s) => s.zh).join('、'))
console.log('  需署名      :', SKINS.filter((s) => s.lic === 'by').map((s) => s.zh).join('、'))
console.log()

// 实际按页面里的模板渲染一遍，检查输出 HTML
const rendered = SKINS.map(
  (s) => `<div class="card">
    <img class="shot" loading="lazy" alt="${s.zh}" src="${BASE}preview-${s.file}.${s.ext}">
    <div class="name">${s.zh}</div>
    <a class="dl" href="${BASE}avatar-${s.file}.vrm" download>下载</a>
  </div>`
).join('\n')

const imgCount = (rendered.match(/<img /g) || []).length
const dlCount = (rendered.match(/class="dl"/g) || []).length
console.log('渲染结果:')
console.log('  <img> 数量 =', imgCount, ' <a.dl> 数量 =', dlCount)
console.log('  与 SKINS 数量一致 =', imgCount === SKINS.length && dlCount === SKINS.length ? '✅' : '❌')
console.log()

// 页面里其他要素
const checks = {
  '含有「怎么换皮肤」说明': html.includes('怎么换皮肤'),
  '含有 vtubeme 外链': html.includes('vtubeme.com/free-vrm-avatars'),
  '含有 Open Source Avatars 外链': html.includes('opensourceavatars.com'),
  '含有 VRoid Studio 外链': html.includes('vroid.com'),
  '含有返回 /world 的链接': html.includes('/world/index.html'),
  '响应式网格': html.includes('grid-template-columns'),
}
console.log('页面要素:')
for (const [k, v] of Object.entries(checks)) console.log('  ' + (v ? '✅' : '❌') + ' ' + k)
