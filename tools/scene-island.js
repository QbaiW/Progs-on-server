// 小岛场景脚本 —— 天空/太阳/雾 配置 + 山顶降雪
//
// 这是替换默认场景脚本的自定义版本。默认脚本只创建 sky，这里额外加了一个
// 粒子发射器在山顶上方持续降雪。
//
// 注意：粒子只在客户端创建（world.network.isServer 为真时跳过），
// 否则服务端会白白模拟几千个粒子。

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
  { key: '004', type: 'section', label: 'Snow' },
  { key: 'snowfall', label: 'Snowfall', type: 'toggle', initial: true, hint: 'Snow falling over the summit only' },
  { key: 'snowRate', label: 'Snow Amount', type: 'number', min: 0, max: 1200, step: 50, initial: 300, dp: 0 },
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

// ---------------- 山顶降雪 ----------------
// ⚠️ 两个坑都踩过了，记在这里免得重犯：
//
// 1. 脚本里的 `world` 不是原始对象，而是白名单代理（见 Apps.js 的
//    worldGetters / worldSetters / worldMethods）。白名单外的属性一律返回
//    undefined 而且**不报错**。`world.network` 不在白名单里，
//    所以 `world.network.isServer` 得到 undefined，再读 .isServer 就抛
//    TypeError，整个场景脚本崩溃 → 天空和地形都没建起来 → 世界黑屏。
//
// 2. 判断运行环境要用引擎专门暴露的 getter：world.isServer / world.isClient /
//    world.networkId。不要自己去翻 world 的内部结构。
let isServer = false
try {
  isServer = !!world.isServer
} catch (err) {
  // 万一这个 getter 也不可用，宁可两端都建粒子，也不要让场景挂掉
  console.warn('[island] could not read world.isServer:', err && err.message)
}
console.log('[island] isServer =', isServer)

if (app.config.snowfall !== false && !isServer) {
  // 只在山顶下雪。实测地形：
  //   峰顶 24.5m（r=0）· 雪线 21m（r=32m）· 山脚 1.7m（r=120m）
  // 所以发射器只盖住山顶那一小片，粒子寿命也压短到落到雪线附近就消散，
  // 不会飘到低海拔去（上一版从 32m 一路落到 2m，山脚也在下雪）。
  const snow = app.create('particles', {
    // ['box', width, height, depth, thickness, origin, spherize]
    // 90x90 刚好覆盖雪线区（直径约 63m）再留一点余量
    shape: ['box', 90, 6, 90, 1, 'volume', false],
    direction: 0.4,
    rate: app.config.snowRate || 300,
    duration: 20,
    loop: true,
    max: 1200,
    life: '2~4',
    speed: '0.3~1.0',
    size: '0.3~0.75',
    rotate: '0~360',
    color: '#ffffff',
    alpha: '0.9',
    emissive: '0.25',
    blending: 'normal',
    billboard: 'full',
    space: 'world',
    lit: false,
    image: '/particle.png',
  })
  // 发射器放在峰顶(24.5m)上方，盒子只占 y=29~35。
  // 配合 life '2~4' 与 force -0.6，粒子最多下落约 8.8 米，
  // 即活动范围约 y=20.2~35 —— 正好压在雪线(21m)以上，不会飘到低海拔。
  snow.position.set(0, 32, 0)
  snow.force = new Vector3(0.2, -0.6, 0.08)
  app.add(snow)
  console.log('[island] snowfall created')
}
