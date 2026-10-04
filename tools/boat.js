// ============================================================================
//  小船脚本 v2：上下浮动（摇摆） + 缆绳拖动
//
//  设计依据（全部在服务器源码里逐条核对过，不是猜的）：
//   · 脚本在服务端和每个客户端**都会跑**同一份代码（Scripts.js 的沙箱，
//     注入的全局只有 Math/Date.now/URL/console/Vector3/Quaternion/Euler/Matrix4/
//     Curve/prng/clamp/num/uuid/DEG2RAD/RAD2DEG 这些，没有 document/window）。
//   · app.on('update') 对每个已构建实体每帧触发（Entities.js:85/91）。
//   · 运动学刚体由 setKinematicTarget(pos, quat) 驱动（RigidBody.js:433），
//     physics 的 preUpdate 会把 actor 位姿插值回节点 position（RigidBody.js:132），
//     而 position 是带 _onChange 钩子的（Node.js:86）→ 会标脏并更新 matrixWorld
//     → 视觉真的会动，挂在它下面的 action 也会跟着动。
//   · 节点 id 会被引擎去重加后缀（Boat → Boat_1），所以只能用「能力」找刚体。
//   · 交互按钮 action 只在**按 E 的那个客户端**触发，回传 { playerId }
//     （ClientActions.js:update 里 node._onTrigger(...)）。
//   · 客户端 app.send(name,data) 只能发给服务端；服务端 app.send 广播给所有客户端
//     （Apps.js:284-305）。服务端由 onEntityEvent → entity.onEvent → emit(name,data,socket.id)
//     收到，所以服务端 app.on(name, (data, networkId)) 的第二个参数就是发送者的玩家 id
//     （ServerNetwork.js:493 + Socket({id:user.id})）。
//   · 于是：拖动这件事只在「谁握着绳」这一个离散状态上需要同步；握手之后，
//     每一端各自用 world.getPlayer(id).position 算同样的目标位姿 —— 零每帧流量。
//   · 海底深度用 world.raycast 量（水面没有碰撞体，射线会直接穿过水面打到地形），
//     所以「拖不上岸」是量出来的，不是拍一个圈硬限制的。
// ============================================================================

app.configure([
  { key: 'motion', type: 'toggle', initial: true, hint: '上下浮动 / 摇摆' },
  { key: 'amount', type: 'number', initial: 0.035, min: 0, max: 0.2, step: 0.005, hint: '浮动幅度（米）' },
  { key: 'roll', type: 'number', initial: 1.2, min: 0, max: 8, step: 0.1, hint: '横摇（度）' },
  { key: 'pitch', type: 'number', initial: 0.9, min: 0, max: 8, step: 0.1, hint: '纵摇（度）' },
  { key: 'tow', type: 'toggle', initial: true, hint: '允许用缆绳拖船' },
  { key: 'rope', type: 'number', initial: 3.2, min: 1.5, max: 8, step: 0.1, hint: '缆绳长度（米）' },
  { key: 'speed', type: 'number', initial: 1.6, min: 0.2, max: 4, step: 0.1, hint: '被拖速度（米/秒）' },
  { key: 'turn', type: 'number', initial: 1.5, min: 0.2, max: 6, step: 0.1, hint: '船头转向速度（弧度/秒）' },
  { key: 'depth', type: 'number', initial: 0.55, min: 0.3, max: 2, step: 0.05, hint: '最小水深（米），浅于此不再往前拖' },
])

const F = (v, d) => {
  const n = Number(v)
  return v === undefined || v === null || n !== n ? d : n
}

const MOTION = props.motion !== false
const AMOUNT = F(props.amount, 0.035)
const ROLL = F(props.roll, 1.2) * DEG2RAD
const PITCH = F(props.pitch, 0.9) * DEG2RAD
const TOW = props.tow !== false
const ROPE = F(props.rope, 3.2)
const SPEED = F(props.speed, 1.6)
const TURN = F(props.turn, 1.5)
const MIN_DEPTH = F(props.depth, 0.55)
const isServer = !!world.isServer

// ---------------------------------------------------------------- 1. 找到刚体
// 不能按名字找：GLB 里的节点名到运行时会被去重加后缀（Boat → Boat_1）。
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

// ---------------------------------------------------------------- 2. 泊位
const anchorPos = new Vector3()
const anchorQuat = new Quaternion()
body.getPosition(anchorPos)
body.getQuaternion(anchorQuat)
const _e0 = new Euler(0, 0, 0, 'YXZ')
_e0.setFromQuaternion(anchorQuat, 'YXZ')
const rest = { x: anchorPos.x, z: anchorPos.z, yaw: _e0.y }

// ---------------------------------------------------------------- 3. 缆绳状态
let ropeBy = app.state && app.state.ropeBy ? app.state.ropeBy : null
const me = world.getPlayer()
const myId = me ? me.id : null

// ---------------------------------------------------------------- 4. 交互按钮
const action = app.create('action')
action.label = '抓住缆绳'
action.distance = 4.5
action.position.set(0, 0.55, 0)
body.add(action)
action.onTrigger = event => {
  if (!TOW) return
  const id = event && event.playerId ? event.playerId : myId
  if (!id) return
  app.send('rope', { hold: ropeBy === id ? 'release' : 'grab' })
}

function applyRope(by) {
  ropeBy = by || null
  action.label = ropeBy && myId && ropeBy === myId ? '松开缆绳' : '抓住缆绳'
}
applyRope(ropeBy)

console.log(
  '[boat] 刚体 id=' + body.id + '，泊位 (' + rest.x.toFixed(2) + ', ' + anchorPos.y.toFixed(2) + ', ' + rest.z.toFixed(2) + ')' +
  '，朝向 ' + (rest.yaw * RAD2DEG).toFixed(1) + '°，绳长 ' + ROPE + ' 米' +
  (isServer ? '，服务端' : '，客户端 id=' + myId)
)

// ---------------------------------------------------------------- 5. 收发
if (isServer) {
  // 客户端发来的 grab/release：networkId 就是发送者的玩家 id（Socket.id = user.id）
  app.on('rope', (data, networkId) => {
    if (!TOW) return
    const by = networkId || null
    if (!by) return
    const hold = data && data.hold
    if (hold === 'grab') {
      ropeBy = by
    } else if (hold === 'release') {
      if (ropeBy !== by) return
      ropeBy = null
    } else {
      return
    }
    if (app.state) app.state.ropeBy = ropeBy
    applyRope(ropeBy)
    app.send('rope', { by: ropeBy })
    console.log('[boat] 缆绳 ' + (ropeBy ? '交给 ' + by : '松开'))
  })
  // 客户端脚本启动时自报家门：验的是「客户端能创建 action、找得到刚体、发得出消息」
  app.on('hello', (data, networkId) => {
    console.log('[boat] 客户端就绪 id=' + networkId + ' ' + JSON.stringify(data))
  })
} else {
  app.on('rope', data => {
    applyRope(data ? data.by : null)
    console.log('[boat] 缆绳状态：' + (ropeBy || '空闲'))
  })
  // 半路进来的客户端：状态在 app.state 里（实体数据随快照下发）
  app.send('hello', {
    body: body.id,
    action: action.label,
    myId: myId,
    rope: ropeBy,
  })
}

// ---------------------------------------------------------------- 6. 每帧
const _pos = new Vector3()
const _quat = new Quaternion()
const _e = new Euler(0, 0, 0, 'YXZ')
const _down = new Vector3(0, -1, 0)
const _probe = new Vector3()
const mask = TOW ? world.createLayerMask('environment') : 0
let lastTime = 0
let loggedAt = 0

app.on('update', () => {
  const now = world.getTime()
  const dt = lastTime && now > lastTime ? Math.min(now - lastTime, 0.1) : 0
  lastTime = now

  let dist = null
  if (TOW && ropeBy) {
    const p = world.getPlayer(ropeBy)
    if (!p) {
      // 拉绳的人下线/离开了
      if (isServer) {
        ropeBy = null
        if (app.state) app.state.ropeBy = null
        applyRope(null)
        app.send('rope', { by: null })
        console.log('[boat] 拉绳的人不在了，自动松开')
      }
    } else {
      const tp = p.position // 注意：这是复用的对象，读完立刻用掉
      const dx = tp.x - rest.x
      const dz = tp.z - rest.z
      dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > ROPE * 3) {
        if (isServer) {
          ropeBy = null
          if (app.state) app.state.ropeBy = null
          applyRope(null)
          app.send('rope', { by: null })
          console.log('[boat] 缆绳拉太远（' + dist.toFixed(1) + ' 米），自动松开')
        }
      } else if (dist > 0.001) {
        const ux = dx / dist
        const uz = dz / dist
        // 绳绷直了才被拉动：距离超过绳长多少，就往那个方向挪多少（不冲过头）
        const slack = dist - ROPE
        if (slack > 0.05 && dt > 0) {
          const step = Math.min(slack, SPEED * dt)
          const nx = rest.x + ux * step
          const nz = rest.z + uz * step
          if (deepEnough(nx, nz, ux, uz)) {
            rest.x = nx
            rest.z = nz
          }
        }
        // 船头逐渐转向拉绳的人（本地 +Z 是船头）
        const want = Math.atan2(ux, uz)
        let diff = want - rest.yaw
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        const maxTurn = TURN * dt
        if (diff > maxTurn) diff = maxTurn
        else if (diff < -maxTurn) diff = -maxTurn
        rest.yaw += diff
        if (isServer && now - loggedAt > 5) {
          loggedAt = now
          console.log(
            '[boat] 拖拽中：离 ' + dist.toFixed(2) + ' 米，船位 (' + rest.x.toFixed(2) + ', ' + rest.z.toFixed(2) + ')' +
            '，朝向 ' + (rest.yaw * RAD2DEG).toFixed(1) + '°'
          )
        }
      }
    }
  }

  const bob = MOTION ? AMOUNT * (0.62 * Math.sin(now * 1.15) + 0.38 * Math.sin(now * 1.93 + 1.7)) : 0
  const roll = MOTION ? ROLL * Math.sin(now * 1.31 + 0.4) : 0
  const pitch = MOTION ? PITCH * Math.sin(now * 1.71 + 2.1) : 0
  _pos.set(rest.x, anchorPos.y + bob, rest.z)
  _e.set(pitch, rest.yaw, roll, 'YXZ')
  _quat.setFromEuler(_e)
  body.setKinematicTarget(_pos, _quat)
})

// 前方 3 米处不够深就不让走（船体最长 2.2 米，3 米处一定在船体投影之外，
// 不会打到自己的碰撞体；水面没有碰撞体，射线会穿过它打到海底）。
function deepEnough(x, z, ux, uz) {
  if (!mask) return true
  _probe.set(x + ux * 3, 5, z + uz * 3)
  const hit = world.raycast(_probe, _down, 20, mask)
  if (!hit) return true // 打不到底 = 很深
  return hit.point.y <= -MIN_DEPTH
}
