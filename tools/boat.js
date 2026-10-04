// 小船：固定吃水线 + 随波浮动（不做物理模拟）。
//
// 为什么这个脚本里一行联机同步代码都没有：
//   · world.getTime() 是**服务端时钟**（ClientNetwork 用 serverTimeOffset 校正，
//     见 core/systems/ClientNetwork.js:84），所以每个客户端算出来的 t 完全一样；
//   · 服务端和每个客户端都跑这段脚本，同一个 t → 同一个姿态；
//   · 运动学刚体由本地 PhysX 解算，姿态再被引擎回读进节点
//     （Physics.postFixedUpdate/preUpdate → RigidBody.onInterpolate），
//     所以甲板会跟着动、站在上面的人由 PlayerLocal 的移动平台逻辑带着走。
//   结论：只要输入是「共享时钟 + 固定锚点」，就天然一致，不需要发消息。
//
// ⚠️ 脚本体是 core/systems/Scripts.js:83 的
//      `(world, app, fetch, props, setTimeout) => { ... }`
//    所以 props / world / app / fetch / setTimeout 都是**函数参数**，
//    千万别再写 `const props = ...`（SyntaxError: already been declared）。
//
// GLB 节点（tools/make-boat.mjs 生成）：
//   Boat      —— rigidbody(type=kinematic)，脚本里就是 app.get('Boat')
//   BoatBody  —— collider（单 primitive、无材质）
//   BoatVisual—— 视觉（3 个材质：Hull / Trim / Tar）
// 本地坐标：y = 0 是水线，+Z 船头，+X 右舷。实体摆在 y=0 就是水线高度。

app.configure([
  { key: 'motion', type: 'toggle', label: '随波浮动', initial: true },
  { key: 'amount', type: 'number', label: '起伏高度（米）', initial: 0.035, min: 0, max: 0.2, step: 0.005 },
  { key: 'roll', type: 'number', label: '横摇（度）', initial: 1.2, min: 0, max: 8, step: 0.1 },
  { key: 'pitch', type: 'number', label: '纵摇（度）', initial: 0.9, min: 0, max: 8, step: 0.1 },
])

const MOTION = props.motion !== false
const AMOUNT = typeof props.amount === 'number' ? props.amount : 0.035
const ROLL = ((typeof props.roll === 'number' ? props.roll : 1.2) * Math.PI) / 180
const PITCH = ((typeof props.pitch === 'number' ? props.pitch : 0.9) * Math.PI) / 180

// 找那个运动学刚体节点。
// 注意：**别用 app.get('Boat')** —— 引擎给节点发 id 时会去重加后缀，
// 诊断实测 GLB 里的节点名 `Boat` 到运行时变成了 id `Boat_1`
// （三个 mesh primitive 也从 BoatVisual 变成 BoatVisual_1/_2/_3），
// 所以按名字查会扑空。改成按能力查：RigidBody 的代理才有 setKinematicTarget。
let body = null
app.traverse(n => {
  if (!body && typeof n.setKinematicTarget === 'function') body = n
})
if (!body) {
  console.error('[boat] 没找到运动学刚体节点（traverse 里没有任何节点带 setKinematicTarget）')
  return
}

// 锚点：读刚体 actor 当前的**世界**位姿。
// App.build 的顺序是 root.activate() 在前（:133，此时 mount() 已建好 actor）、
// script.exec 在后（:142），所以这里读到的就是实体在世界里被摆好的那个位置。
// （RigidBody.getPosition 在没 actor 时是 return vec3.set(0,0,0)，不会抛。）
const anchorPos = new Vector3()
const anchorQuat = new Quaternion()
body.getPosition(anchorPos)
body.getQuaternion(anchorQuat)

console.log(
  `[boat] 刚体 id=${body.id}，锚点 (${anchorPos.x.toFixed(2)}, ${anchorPos.y.toFixed(2)}, ${anchorPos.z.toFixed(2)})，` +
    `浮动 ${MOTION ? AMOUNT + ' 米' : '关'}`
)

const _pos = new Vector3()
const _quat = new Quaternion()
const _rot = new Quaternion()
const _euler = new Euler()

function computePose(t) {
  // 两个不共频正弦叠加：周期 ≈ 5.5s 与 3.3s，肉眼看着不规律，但算得出来
  const y = AMOUNT * (0.62 * Math.sin(t * 1.15) + 0.38 * Math.sin(t * 1.93 + 1.7))
  const roll = ROLL * Math.sin(t * 1.31 + 0.4)
  const pitch = PITCH * Math.sin(t * 1.71 + 2.1)
  _pos.set(anchorPos.x, anchorPos.y + y, anchorPos.z)
  _euler.set(pitch, 0, roll, 'XYZ')
  _rot.setFromEuler(_euler)
  _quat.copy(anchorQuat).multiply(_rot)
}

app.on('update', () => {
  if (!MOTION) return
  computePose(world.getTime())
  body.setKinematicTarget(_pos, _quat)
})
