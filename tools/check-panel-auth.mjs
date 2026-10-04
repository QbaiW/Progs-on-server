// 面板鉴权自测：用一个「替身小铺」验证面板的各条分支，不需要真的登录小铺。
//
// 为什么需要它：面板不再用 nginx basic auth，而是把小铺发的那张 owner 会话
// cookie 转给本机 8787 问一句「这人是主人吗」。这条链路如果写错了，要么谁都
// 进不去，要么谁都能开 / 关世界 —— 两种情况都得在部署前先证明。
//
// 跑法：node tools/check-panel-auth.mjs
// 原理：把替身小铺和面板起在同一个进程里（面板 import 即 listen），全程不 spawn
// 子进程，所以不受沙箱命名管道限制。

import http from 'node:http'

const STUB_PORT = Number(process.env.TEST_STUB_PORT || 7899)
const DEAD_PORT = Number(process.env.TEST_DEAD_PORT || 7898) // 没人监听，用来造 ECONNREFUSED
const PANEL_PORT = Number(process.env.TEST_PANEL_PORT || 8792)
const TOKEN = 'stub-token-123'
const COOKIE = `star_bottle_access=${TOKEN}`

// yes   = 认得这张 cookie
// no    = 不认
// abort = 连上了但应答中途断线（模拟小铺崩了）
let mode = 'yes'
const seenPaths = []

const stub = http.createServer((req, res) => {
  seenPaths.push(req.url)
  if (mode === 'abort') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' })
    res.write('{"authenticated":')
    res.socket.destroy()
    return
  }
  const authed = mode === 'yes' && String(req.headers.cookie || '').includes(TOKEN)
  const body = JSON.stringify({ authenticated: authed })
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
})
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))

process.env.PANEL_PORT = String(PANEL_PORT)
process.env.PANEL_SHOP_PORT = String(STUB_PORT)
const panel = await import('./worlds-control/server.mjs')
await new Promise((r) => setTimeout(r, 300))

let pass = 0
let fail = 0
function check(label, actual, want) {
  const ok = actual === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}  →  ${JSON.stringify(actual)}${ok ? '' : `  (期望 ${JSON.stringify(want)})`}`)
}

async function probe(path, { cookie, method = 'GET' } = {}) {
  const r = await fetch(`http://127.0.0.1:${PANEL_PORT}${path}`, {
    method,
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  })
  return { status: r.status, loc: r.headers.get('location'), body: await r.text() }
}

console.log('—— 已登录（替身小铺认这张 cookie）——')
{
  const r = await probe('/', { cookie: COOKIE })
  check('首页 200', r.status, 200)
  check('首页确实是面板本身', r.body.includes('api/worlds'), true)
  check('问的是小铺门禁端点（不是要 owner 密码的那张）', seenPaths.at(-1), '/api/site/status')
  const r2 = await probe('/api/nope', { cookie: COOKIE })
  check('过了门禁后未知路径 404', r2.status, 404)
  const r3 = await probe('/api/worlds/不存在的世界/start', { cookie: COOKIE, method: 'POST' })
  check('过了门禁后真的走到了路由（没这个世界的记录 → 404）', r3.status, 404)
}

console.log('—— 没登录 ——')
{
  const r = await probe('/')
  check('首页 302', r.status, 302)
  check('回跳到小铺登录页并带回跳地址', r.loc, '/login?return=%2Fworlds%2F')
  const r2 = await probe('/', { cookie: 'star_bottle_owner=wrong' })
  check('错误 cookie 首页仍 302（替身说 false 时不能放行）', r2.status, 302)
  const r3 = await probe('/api/worlds', { cookie: 'star_bottle_owner=wrong' })
  check('接口 401', r3.status, 401)
  check('接口给出机器可读码', JSON.parse(r3.body).code, 'SHOP_LOGIN_REQUIRED')
  const r4 = await probe('/api/worlds', { cookie: COOKIE, method: 'POST' })
  check('登录了也不能用 GET/POST 混用打错接口（404）', r4.status, 404)
}

console.log('—— 小铺应答中途断线（要跟「没登录」分开报）——')
{
  mode = 'abort'
  const r = await probe('/', { cookie: COOKIE })
  check('首页 503', r.status, 503)
  check('页面说明是小铺没应答', r.body.includes('连不上小铺'), true)
  const r2 = await probe('/api/worlds', { cookie: COOKIE })
  check('接口 503', r2.status, 503)
  check('接口给出机器可读码', JSON.parse(r2.body).code, 'SHOP_UNREACHABLE')
}

console.log('—— 小铺端口没人听（连接被拒）——')
{
  mode = 'yes'
  process.env.PANEL_SHOP_PORT = String(DEAD_PORT)
  const r = await probe('/', { cookie: COOKIE })
  check('首页 503', r.status, 503)
  const r2 = await probe('/api/worlds', { cookie: COOKIE })
  check('接口 503', r2.status, 503)
  check('接口给出机器可读码', JSON.parse(r2.body).code, 'SHOP_UNREACHABLE')
  process.env.PANEL_SHOP_PORT = String(STUB_PORT)
}

console.log(`\n${fail === 0 ? '全部通过 ✓' : '有失败项 ✗'}  ${pass} 通过 / ${fail} 失败`)
console.log(`面板问过小铺的端点：${[...new Set(seenPaths)].join(', ')}`)

// 收干净再退出：直接 process.exit() 在 Windows 上会撞上 libuv 的
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，退出码也会变脏。
panel.server.closeAllConnections?.()
panel.server.close()
stub.closeAllConnections?.()
stub.close()
process.exitCode = fail === 0 ? 0 : 1
