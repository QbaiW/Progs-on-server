// 森林小屋场景脚本 —— 天空/太阳/雾 配置 + 小屋旁篝火的火苗、火星、烟
//
// 与 scene-island.js 同源（那个是雪顶小岛版），差别：
//   · 雾拉近拉浓（林子里要"看不远"才有纵深）
//   · 降雪换成篝火三件套粒子：火焰 / 火星 / 烟
//
// ⚠️ 两个坑踩过了，记在这里免得重犯（和 island 版一模一样的坑）：
//
// 1. 脚本里的 `world` 是白名单代理（Apps.js 的 worldGetters/Setters/Methods）。
//    白名单外的属性一律返回 undefined 且**不报错**；`world.network` 不在白名单，
//    所以 `world.network.isServer` 会抛 TypeError → 整个场景脚本崩溃 → 黑屏。
//    判断运行环境只用引擎暴露的 world.isServer / world.isClient / world.networkId。
//
// 2. 粒子只在客户端建，服务端建了只是白模拟。
//
// 篝火坐标不写死在这里，而是从 app.config（fireX/fireY/fireZ）读 —— 落点是
// make-forest.mjs 扫地形算出来的，写进蓝图 props，两边靠这几个 key 对接。

app.configure([
  { key: 'sky', label: 'Sky', type: 'file', kind: 'texture', hint: 'The image to use as the background.' },
  { key: 'hdr', label: 'HDR', type: 'file', kind: 'hdr', hint: 'The HDRI to use for reflections and lighting.' },
  { key: 'rotationY', label: 'Rotation', type: 'number', step: 10, bigStep: 50 },
  { key: '002', type: 'section', label: 'Sun' },
  {
    key: 'horizontalRotation',
    label: 'Direction',
    type: 'number', min: 0, max: 360, step: 10, bigStep: 50, initial: 0, dp: 0,
    hint: 'The direction of the sun in degrees',
  },
  {
    key: 'verticalRotation',
    label: 'Elevation',
    type: 'number', min: 0, max: 360, step: 10, bigStep: 50, initial: 0, dp: 0,
    hint: 'The elevation of the sun in degrees',
  },
  {
    key: 'intensity',
    label: 'Intensity',
    type: 'number', min: 0, max: 10, step: 0.1, initial: 1, dp: 1,
  },
  { key: '003', type: 'section', label: 'Fog' },
  { key: 'fogColor', label: 'Color', type: 'text', hint: 'The fog color. Leave blank to disable fog' },
  { key: 'fogNear', label: 'Near', type: 'number', dp: 0, min: 0, step: 10, initial: 0 },
  { key: 'fogFar', label: 'Far', type: 'number', dp: 0, min: 0, step: 10, initial: 0 },
  { key: '004', type: 'section', label: 'Campfire' },
  { key: 'fireOn', label: 'Campfire', type: 'toggle', initial: true, hint: 'Flame, sparks and smoke at the fire pit' },
  { key: 'fireRate', label: 'Flame Amount', type: 'number', min: 0, max: 200, step: 10, initial: 70, dp: 0 },
  { key: 'fireX', label: 'Fire X', type: 'number', step: 0.1, dp: 3, initial: 0 },
  { key: 'fireY', label: 'Fire Y', type: 'number', step: 0.1, dp: 3, initial: 0 },
  { key: 'fireZ', label: 'Fire Z', type: 'number', step: 0.1, dp: 3, initial: 0 },
])

const DEG2RAD = Math.PI / 180

// ---------------- 天空 / 太阳 / 雾 ----------------
const sky = app.create('sky')
sky.bg = app.config.sky?.url
sky.hdr = app.config.hdr?.url
sky.rotationY = app.config.rotationY * -DEG2RAD

const sunDirection = calculateSunDirection(
  app.config.verticalRotation || 0,
  app.config.horizontalRotation || 0
)
sky.sunDirection = sunDirection
sky.sunIntensity = app.config.intensity

sky.fogNear = app.config.fogNear
sky.fogFar = app.config.fogFar
sky.fogColor = app.config.fogColor

app.add(sky)

function calculateSunDirection(verticalDegrees, horizontalDegrees) {
  const verticalRad = verticalDegrees * DEG2RAD
  const horizontalRad = horizontalDegrees * DEG2RAD
  const x = Math.sin(verticalRad) * Math.sin(horizontalRad)
  const y = -Math.cos(verticalRad)
  const z = Math.sin(verticalRad) * Math.cos(horizontalRad)
  return new Vector3(x, y, z)
}

// ---------------- 运行环境 ----------------
let isServer = false
try {
  isServer = !!world.isServer
} catch (err) {
  console.warn('[forest] could not read world.isServer:', err && err.message)
}
console.log('[forest] isServer =', isServer)

// ---------------- 篝火 ----------------
if (app.config.fireOn !== false && !isServer) {
  const fx = Number(app.config.fireX) || 0
  const fy = Number(app.config.fireY) || 0
  const fz = Number(app.config.fireZ) || 0
  const rate = app.config.fireRate ?? 70

  // 火焰：贴着柴堆往上舔，颜色从亮黄压到暗红
  const flame = app.create('particles', {
    shape: ['box', 0.5, 0.14, 0.5, 1, 'volume', false],
    direction: 1,
    rate,
    duration: 20,
    loop: true,
    max: 90,
    life: '0.5~1.0',
    speed: '0.5~1.1',
    size: '0.55~0.95',
    rotate: '0~360',
    color: '#ffca6a',
    alpha: '0.95',
    emissive: '1',
    blending: 'additive',
    billboard: 'full',
    space: 'world',
    lit: false,
    image: '/particle.png',
    sizeOverLife: '0,0.75|0.35,1|1,0.15',
    colorOverLife: '0,#ffd98a|0.55,#ff8a2b|1,#7a2410',
    alphaOverLife: '0,0|0.12,1|1,0',
  })
  flame.position.set(fx, fy + 0.16, fz)
  flame.force = new Vector3(0, 0.9, 0)
  app.add(flame)

  // 火星：偶尔窜高、飘走
  const sparks = app.create('particles', {
    shape: ['box', 0.4, 0.1, 0.4, 1, 'volume', false],
    direction: 1,
    rate: Math.max(3, Math.round(rate * 0.12)),
    duration: 20,
    loop: true,
    max: 40,
    life: '1.2~2.6',
    speed: '1.1~2.1',
    size: '0.07~0.15',
    rotate: '0~360',
    color: '#ffb056',
    alpha: '1',
    emissive: '1',
    blending: 'additive',
    billboard: 'full',
    space: 'world',
    lit: false,
    image: '/particle.png',
    sizeOverLife: '0,1|1,0.2',
    alphaOverLife: '0,1|0.7,0.8|1,0',
  })
  sparks.position.set(fx, fy + 0.2, fz)
  sparks.force = new Vector3(0.2, 0.45, 0.08)
  app.add(sparks)

  // 烟：从火头上方慢慢升起、越飘越大，几乎不透明度收尾
  const smoke = app.create('particles', {
    shape: ['box', 0.4, 0.2, 0.4, 1, 'volume', false],
    direction: 1,
    rate: Math.max(2, Math.round(rate * 0.14)),
    duration: 20,
    loop: true,
    max: 40,
    life: '2.5~4.0',
    speed: '0.45~0.85',
    size: '0.7~1.2',
    rotate: '0~360',
    color: '#9aa0a6',
    alpha: '0.26',
    emissive: '0',
    blending: 'normal',
    billboard: 'full',
    space: 'world',
    lit: false,
    image: '/particle.png',
    sizeOverLife: '0,0.5|1,2.4',
    alphaOverLife: '0,0|0.2,1|1,0',
  })
  smoke.position.set(fx, fy + 0.55, fz)
  smoke.force = new Vector3(0.28, 0.32, 0.06)
  app.add(smoke)

  console.log('[forest] campfire created at', fx.toFixed(2), fy.toFixed(2), fz.toFixed(2))
}
