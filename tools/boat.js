/* 小船 v3 —— 一个 E 键，两种玩法，按你站的位置自动决定
 *
 *  站在甲板上按 E  → 开船：W/S 前进后退，A/D 转向，再按 E 停船
 *  站在水里/岸上按 E → 抓住缆绳：船跟着你走，再按 E 松开
 *
 *  搁浅保护：前方水不够深时不硬撞，而是左右偏转找能走的方向，
 *  沿着等深线（搁浅高度）继续滑行，所以在岸上也能一直拖着船沿岸走。
 *
 *  位置同步：每帧位姿由各端各自用同一套公式算（共享时钟 + 低频按键事件），
 *  服务端只是「谁在驾驶 / 谁在拉绳」的权威，不需要逐帧广播坐标。
 */

app.configure([
  { key: 'motion', type: 'toggle', initial: true },
  { key: 'amount', type: 'number', initial: 0.035, min: 0, max: 0.2, step: 0.005 },
  { key: 'roll', type: 'number', initial: 1.2, min: 0, max: 8, step: 0.1 },
  { key: 'pitch', type: 'number', initial: 0.9, min: 0, max: 8, step: 0.1 },
  { key: 'drive', type: 'toggle', initial: true },
  { key: 'dspeed', type: 'number', initial: 2.2, min: 0.4, max: 10, step: 0.1 },
  { key: 'tow', type: 'toggle', initial: true },
  { key: 'rope', type: 'number', initial: 3.2, min: 1, max: 12, step: 0.1 },
  { key: 'speed', type: 'number', initial: 1.6, min: 0.2, max: 8, step: 0.1 },
  { key: 'turn', type: 'number', initial: 1.5, min: 0.2, max: 6, step: 0.1 },
  { key: 'depth', type: 'number', initial: 0.55, min: 0.3, max: 3, step: 0.05 },
  { key: 'slide', type: 'number', initial: 80, min: 0, max: 90, step: 5 },
])

const F = (v, d) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return n !== n ? d : n
}

const MOTION = props.motion !== false
const AMOUNT = F(props.amount, 0.035)
const ROLL = F(props.roll, 1.2) * DEG2RAD
const PITCH = F(props.pitch, 0.9) * DEG2RAD
const DRIVE = props.drive !== false
const DSPEED = F(props.dspeed, 2.2)
const TOW = props.tow !== false
const ROPE = F(props.rope, 3.2)
const SPEED = F(props.speed, 1.6)
const TURN = F(props.turn, 1.5)
const MIN_DEPTH = F(props.depth, 0.55)
const SLIDE = F(props.slide, 80)
const FLOOR = 0.36 // 船体投影下任何一点都不能浅于这个（吃水 0.30 + 浮动 0.035 + 余量）

const REVERSE = 0.4 // 倒车速度是前进的 40%
const LEAVE = 6 // 驾驶员离船超过这个距离就自动停
const ROPE_MAX = ROPE * 4 // 绳拉这么长就自动松
const AHEAD = 2.5 // 往前探这么远的水深
const isServer = !!world.isServer

// ---------------------------------------------------------------- 1. 找刚体
// 注意：服务端会给节点 id 去重加后缀（Boat → Boat_1），所以按能力找而不是按名字找。
let body = null
app.traverse(node => {
  if (!body && typeof node.setKinematicTarget === 'function') body = node
})
if (!body) {
  console.error('[boat] 没找到运动学刚体（GLB 里需要一个 extras.node=rigidbody 且 type=kinematic 的节点）')
  return
}
if (body.type !== 'kinematic') {
  console.error('[boat] 刚体 type=' + body.type + '，必须是 kinematic 才能这样开船')
  return
}

// 泊位：启动时读一次 actor 的全局位姿，之后只在这个基准上移动
const anchorPos = new Vector3()
const anchorQuat = new Quaternion()
body.getPosition(anchorPos)
body.getQuaternion(anchorQuat)
const _e0 = new Euler(0, 0, 0, 'YXZ').setFromQuaternion(anchorQuat, 'YXZ')
const DECK_Y = anchorPos.y - 0.16
const rest = { x: anchorPos.x, z: anchorPos.z, yaw: _e0.y }

// ---------------------------------------------------------------- 2. 状态
const me = world.getPlayer()
const myId = me ? me.id : null
let driveBy = app.state && app.state.drive ? app.state.drive : null
let ropeBy = app.state && app.state.rope ? app.state.rope : null
let din = { f: 0, b: 0, l: 0, r: 0 } // 驾驶输入（各端一致）
let ctrl = null // 客户端接管的方向键
let lastAct = 0 // 按 E 的去抖时间

// ---------------------------------------------------------------- 3. 交互按钮
const action = app.create('action')
action.distance = 4.5
action.position.set(0, 0.55, 0)
action.label = '互动'
body.add(action)

// 人是不是站在甲板上（用船的局部坐标判断，和引擎带人的判定范围对齐）
function onBoard() {
  if (isServer) return false
  const p = world.getPlayer()
  if (!p) return false
  const tp = p.position // 复用对象，读完立刻用掉
  const tx = tp.x
  const tz = tp.z
  const ty = tp.y
  const dx = tx - rest.x
  const dz = tz - rest.z
  const cs = Math.cos(rest.yaw)
  const sn = Math.sin(rest.yaw)
  const lx = dx * cs - dz * sn
  const lz = dx * sn + dz * cs
  const dy = ty - DECK_Y
  return lx > -0.95 && lx < 0.95 && lz > -2.3 && lz < 2.2 && dy > -0.55 && dy < 1.4
}

let lastLabel = ''
function refreshLabel() {
  let want
  if (myId && driveBy === myId) want = '停船'
  else if (myId && ropeBy === myId) want = '松开缆绳'
  else if (DRIVE && onBoard()) want = '开船'
  else if (TOW) want = '抓住缆绳'
  else want = '互动'
  if (want !== lastLabel) {
    lastLabel = want
    action.label = want
  }
}

// 按住 E 不放时，引擎每 0.5 秒会重复触发一次 onStart，所以这里夹一个去抖窗口。
// onStart 没有参数，但它只会跑在按 E 的那个客户端上，所以 myId 就是按的人。
action.onStart = () => {
  const now = world.getTime()
  if (now - lastAct < 0.8) return
  lastAct = now
  if (!myId) return
  if (DRIVE && onBoard()) {
    app.send('act', { what: driveBy === myId ? 'stop' : 'drive' })
  } else if (TOW) {
    app.send('act', { what: ropeBy === myId ? 'release' : 'grab' })
  }
}

// ---------------------------------------------------------------- 4. 方向键接管
function startControls() {
  if (isServer || ctrl) return
  const c = app.control({})
  c.keyW.capture = true
  c.keyS.capture = true
  c.keyA.capture = true
  c.keyD.capture = true
  ctrl = c
  console.log('[boat] 接管方向键（开船中）')
}
function stopControls() {
  if (!ctrl) return
  ctrl.release()
  ctrl = null
  console.log('[boat] 交还方向键')
}

// ---------------------------------------------------------------- 5. 收发
function syncAct() {
  if (app.state) {
    app.state.drive = driveBy
    app.state.rope = ropeBy
  }
  app.send('act', { drive: driveBy, rope: ropeBy })
}
function clearInput() {
  din = { f: 0, b: 0, l: 0, r: 0 }
}
function applyAct(data) {
  driveBy = data && data.drive ? data.drive : null
  ropeBy = data && data.rope ? data.rope : null
  if (driveBy === myId && !isServer) startControls()
  else {
    clearInput()
    stopControls()
  }
  if (!isServer) refreshLabel()
}

if (isServer) {
  // networkId 就是发送者的玩家 id（Socket.id = user.id = player.data.id）
  app.on('act', (data, networkId) => {
    const id = networkId || null
    if (!id) return
    const what = data && data.what
    if (what === 'drive') {
      if (!DRIVE) return
      ropeBy = null
      driveBy = id
      clearInput()
    } else if (what === 'stop') {
      if (driveBy !== id) return
      driveBy = null
      clearInput()
    } else if (what === 'grab') {
      if (!TOW) return
      driveBy = null
      ropeBy = id
      clearInput()
    } else if (what === 'release') {
      if (ropeBy !== id) return
      ropeBy = null
    } else return
    syncAct()
    console.log('[boat] ' + what + ' ← ' + id + '：驾驶=' + (driveBy || '无') + ' 缆绳=' + (ropeBy || '无'))
  })
  // 驾驶员的方向键状态：低频变化才广播，各端用它自己积分
  app.on('drive', (data, networkId) => {
    if (!driveBy || networkId !== driveBy) return
    din = {
      f: data && data.f ? 1 : 0,
      b: data && data.b ? 1 : 0,
      l: data && data.l ? 1 : 0,
      r: data && data.r ? 1 : 0,
    }
    app.send('drive', { f: din.f, b: din.b, l: din.l, r: din.r })
  })
  app.on('hello', (data, networkId) => {
    console.log('[boat] 客户端就绪 id=' + networkId + ' ' + JSON.stringify(data))
  })
} else {
  app.on('act', data => {
    applyAct(data)
    console.log('[boat] 状态：驾驶=' + (driveBy || '无') + ' 缆绳=' + (ropeBy || '无'))
  })
  // 我自己就是驾驶员时，本地输入是权威，忽略回声（避免旧值覆盖新值）
  app.on('drive', data => {
    if (driveBy === myId) return
    din = {
      f: data && data.f ? 1 : 0,
      b: data && data.b ? 1 : 0,
      l: data && data.l ? 1 : 0,
      r: data && data.r ? 1 : 0,
    }
  })
  app.send('hello', {
    body: body.id,
    action: action.label,
    myId: myId,
    board: onBoard(),
    drive: driveBy,
    rope: ropeBy,
  })
  if (driveBy === myId) startControls()
}

// ---------------------------------------------------------------- 6. 走位（含搁浅绕行）
const _down = new Vector3(0, -1, 0)
const _probe = new Vector3()
const mask = world.createLayerMask('environment')
const ANG = [0, 15, 30, 45, 60, 75, 90]
const HULL_Z = [-2.2, -1.65, -1.1, -0.55, 0, 0.55, 1.1, 1.65, 2.0]
const HULL_OUTLINE = [[-2.2, 0.64], [-1.7, 0.68], [-0.9, 0.72], [0, 0.72], [0.85, 0.7], [1.5, 0.54], [1.87, 0.28], [2.0, 0.05]]
let slideSide = 1 // 上次绕行的方向，用来避免左右抖
let slideAng = 0 // 本帧绕行了几度

function CL(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// 船体半宽（按站位表收窄，与 make-boat.mjs 一致）
function hullHalf(z) {
  if (z <= HULL_OUTLINE[0][0]) return HULL_OUTLINE[0][1]
  const last = HULL_OUTLINE[HULL_OUTLINE.length - 1]
  if (z >= last[0]) return last[1]
  for (let i = 0; i < HULL_OUTLINE.length - 1; i++) {
    const a = HULL_OUTLINE[i]
    const b = HULL_OUTLINE[i + 1]
    if (z >= a[0] && z <= b[0]) return a[1] + (b[1] - a[1]) * ((z - a[0]) / (b[0] - a[0]))
  }
  return 0.05
}

// 从高空往下打射线量海底深度：水面没有碰撞体，射线穿过去打到海底；打不到 = 岛外，算很深
function depthAt(x, z) {
  _probe.set(x, 40, z)
  const hit = world.raycast(_probe, _down, 60, mask)
  if (!hit) return 999
  return -hit.point.y
}

// 船体投影下最浅的深度：光看船中心不够，船首尾和两侧舷也要查。
// 注意：船自己的碰撞体也在 environment 层上，所以采样点必须放在船体轮廓外侧，
// 否则射线打到的是自己的船帮（实测会得到 +0.276 这种「海底在水面上」的假值）。
const HULL_MARGIN = 0.16

function hullFloor(x, z, yaw) {
  const ux = Math.sin(yaw)
  const uz = Math.cos(yaw)
  const rx = uz
  const rz = -ux
  let mn = 999
  for (let i = 0; i < HULL_Z.length; i++) {
    const lz = HULL_Z[i]
    const h = hullHalf(lz) + HULL_MARGIN
    const d1 = depthAt(x + ux * lz + rx * h, z + uz * lz + rz * h)
    if (d1 < mn) mn = d1
    const d2 = depthAt(x + ux * lz - rx * h, z + uz * lz - rz * h)
    if (d2 < mn) mn = d2
  }
  return mn
}

// 前方探深：够深就直行（提前绕开，别等蹭到才躲）
function deepEnough(x, z, ux, uz) {
  return depthAt(x + ux * AHEAD, z + uz * AHEAD) >= MIN_DEPTH
}

// 朝 (ux,uz) 挪 dist：硬条件是整条船都不蹭底；
// 首选前方也够深的方向，实在不行就贴着浅滩滑 —— 这就是「沿搁浅高度等高移动」
function advance(ux, uz, dist, maxDeg, yaw) {
  slideAng = 0
  const last = Math.max(0, Math.min(ANG.length - 1, Math.round(maxDeg / 15)))
  let fb = null
  for (let i = 0; i <= last; i++) {
    const base = ANG[i]
    for (let s = 0; s < (i === 0 ? 1 : 2); s++) {
      const side = i === 0 ? 0 : s === 0 ? slideSide : -slideSide
      const ang = base * side
      const rad = ang * DEG2RAD
      const cs = Math.cos(rad)
      const sn = Math.sin(rad)
      const dx = ux * cs + uz * sn
      const dz = -ux * sn + uz * cs
      const nx = rest.x + dx * dist
      const nz = rest.z + dz * dist
      if (hullFloor(nx, nz, yaw) < FLOOR) continue
      if (deepEnough(nx, nz, dx, dz)) {
        rest.x = nx
        rest.z = nz
        if (i > 0) slideSide = side
        slideAng = ang
        return true
      }
      if (!fb) fb = { x: nx, z: nz, ang: ang, side: side }
    }
  }
  if (fb) {
    rest.x = fb.x
    rest.z = fb.z
    if (fb.ang) slideSide = fb.side
    slideAng = fb.ang
    return true
  }
  return false
}

// 转船头：只有转过去之后船体仍然合法时才转（否则船首会甩到沙滩上）
function turnToward(yaw, maxStep) {
  let diff = yaw - rest.yaw
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  const step = CL(diff, -maxStep, maxStep)
  if (step === 0) return
  const ny = rest.yaw + step
  if (hullFloor(rest.x, rest.z, ny) < FLOOR) return
  rest.yaw = ny
}

console.log(
  '[boat] 刚体 id=' + body.id + '，泊位 (' + rest.x.toFixed(2) + ', ' + anchorPos.y.toFixed(2) + ', ' + rest.z.toFixed(2) + ')' +
  '，朝向 ' + (rest.yaw * RAD2DEG).toFixed(1) + '°，绳长 ' + ROPE + ' 米，前方需 ' + MIN_DEPTH + ' 米、船底需 ' + FLOOR + ' 米' +
  '，泊位船底 ' + hullFloor(rest.x, rest.z, rest.yaw).toFixed(3) + ' 米（脚本刚启动时的读数，地形 GLB 还没加载完就是 999）' +
  (isServer ? '，服务端' : '，客户端 id=' + myId)
)

// ---------------------------------------------------------------- 7. 每帧
const _pos = new Vector3()
const _quat = new Quaternion()
const _e = new Euler(0, 0, 0, 'YXZ')
let lastTime = 0
let loggedAt = 0
const bornAt = world.getTime()
let diagDone = false

app.on('update', () => {
  const now = world.getTime()
  const dt = lastTime && now > lastTime ? Math.min(now - lastTime, 0.1) : 0
  lastTime = now

  // ---- 一次性自检 ----
  // 地形碰撞体是异步加载的，脚本刚起来时物理场景里可能只有船自己，
  // 那时候任何向下射线都打不到海底（返回 999）。等 3 秒再打一次才是真读数。
  if (!diagDone && now - bornAt > 3) {
    diagDone = true
    const here = hullFloor(rest.x, rest.z, rest.yaw)
    const ahead = depthAt(rest.x + Math.sin(rest.yaw) * 2.5, rest.z + Math.cos(rest.yaw) * 2.5)
    const mid = depthAt(rest.x, rest.z)
    console.log(
      '[boat] 自检 t=' + (now - bornAt).toFixed(1) + 's：泊位船底 ' + here.toFixed(3) + ' 米（需 ' + FLOOR + '），' +
      '中心点 ' + (mid > 900 ? '打不到' : mid.toFixed(3)) + ' 米，' +
      '前方 2.5 米 ' + (ahead > 900 ? '打不到' : ahead.toFixed(3)) + ' 米（需 ' + MIN_DEPTH + '）' +
      (isServer ? '，服务端' : '，客户端 id=' + myId)
    )
  }

  // ---- 开船 ----
  if (DRIVE && driveBy && dt > 0) {
    const turn = (din.l ? 1 : 0) - (din.r ? 1 : 0)
    if (turn) turnToward(rest.yaw + TURN * dt * turn, TURN * dt)
    const thr = din.f ? 1 : din.b ? -REVERSE : 0
    if (thr) {
      const sgn = thr > 0 ? 1 : -1
      const fx = Math.sin(rest.yaw) * sgn
      const fz = Math.cos(rest.yaw) * sgn
      if (advance(fx, fz, DSPEED * Math.abs(thr) * dt, Math.min(SLIDE, 40), rest.yaw)) {
        // 擦着浅滩滑行时船头跟着偏，看起来像贴着岸走
        if (slideAng) turnToward(rest.yaw + slideAng * DEG2RAD, TURN * dt)
      }
    }
    if (isServer) {
      const p = world.getPlayer(driveBy)
      let gone = !p
      if (p) {
        const tp = p.position
        const ddx = tp.x - rest.x
        const ddz = tp.z - rest.z
        if (Math.sqrt(ddx * ddx + ddz * ddz) > LEAVE) gone = true
      }
      if (gone) {
        driveBy = null
        clearInput()
        syncAct()
        console.log('[boat] 驾驶员离开，自动停船')
      }
    }
  }

  // ---- 缆绳拖拽 ----
  if (TOW && ropeBy) {
    const p = world.getPlayer(ropeBy)
    if (!p) {
      if (isServer) {
        ropeBy = null
        syncAct()
        console.log('[boat] 拉绳的人不在了，自动松开')
      }
    } else {
      const tp = p.position // 复用的对象，读完立刻用掉
      const dx = tp.x - rest.x
      const dz = tp.z - rest.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > ROPE_MAX) {
        if (isServer) {
          ropeBy = null
          syncAct()
          console.log('[boat] 缆绳拉太远（' + dist.toFixed(1) + ' 米），自动松开')
        }
      } else if (dist > 0.001) {
        const ux = dx / dist
        const uz = dz / dist
        // 绳绷直了才被拉动：超绳长多少就挪多少（不冲过头）
        const slack = dist - ROPE
        const bx = rest.x
        const bz = rest.z
        if (slack > 0.05 && dt > 0) {
          advance(ux, uz, Math.min(slack, SPEED * dt), SLIDE, rest.yaw)
        }
        // 船头朝「实际被拖走的方向」：深水里就等于朝拉绳的人，贴着浅滩走时朝等深线方向
        const mdx = rest.x - bx
        const mdz = rest.z - bz
        if (mdx * mdx + mdz * mdz > 0.000025) turnToward(Math.atan2(mdx, mdz), TURN * dt)
        else turnToward(Math.atan2(ux, uz), TURN * dt)
        if (isServer && now - loggedAt > 5) {
          loggedAt = now
          console.log(
            '[boat] 拖拽中：离 ' + dist.toFixed(2) + ' 米，船位 (' + rest.x.toFixed(2) + ', ' + rest.z.toFixed(2) + ')' +
            '，朝向 ' + (rest.yaw * RAD2DEG).toFixed(1) + '°，绕行 ' + slideAng.toFixed(0) + '°'
          )
        }
      }
    }
  }

  // ---- 驾驶员上传方向键 ----
  if (!isServer && ctrl && driveBy === myId && dt > 0) {
    const f = ctrl.keyW.down ? 1 : 0
    const b = ctrl.keyS.down ? 1 : 0
    const l = ctrl.keyA.down ? 1 : 0
    const r = ctrl.keyD.down ? 1 : 0
    if (f !== din.f || b !== din.b || l !== din.l || r !== din.r) {
      din = { f: f, b: b, l: l, r: r }
      app.send('drive', { f: f, b: b, l: l, r: r })
    }
  }

  // ---- 交互提示 ----
  if (!isServer) refreshLabel()

  // ---- 写入位姿 ----
  const bob = MOTION ? AMOUNT * (0.62 * Math.sin(now * 1.15) + 0.38 * Math.sin(now * 1.93 + 1.7)) : 0
  const roll = MOTION ? ROLL * Math.sin(now * 1.31 + 0.4) : 0
  const pitch = MOTION ? PITCH * Math.sin(now * 1.71 + 2.1) : 0
  _pos.set(rest.x, anchorPos.y + bob, rest.z)
  _e.set(pitch, rest.yaw, roll, 'YXZ')
  _quat.setFromEuler(_e)
  body.setKinematicTarget(_pos, _quat)
})
