// 世界控制面板
//
// 干什么：列出所有世界、看运行状态、开 / 关。
// 怎么起：pm2 start server.mjs --name worlds-panel
// 怎么访问：https://myiuan.xin/worlds/  （nginx 代理到 127.0.0.1:8791）
//
// 设计要点：
// - 用 pm2 命令行而不是 pm2 模块，省得处理 node_modules 解析路径。
// - 每个世界是一个预先建好的 pm2 进程，这里只 start/stop，不改它的环境变量。
// - 开新世界前先看可用内存，不够就直接拒绝 —— 这台机器一共只有 1870MB。
// - 鉴权复用「小铺的门禁登录态」（见 hasAccess），面板自己不要再要一遍密码。
//
// 为什么不用 nginx 的 auth_basic：那是浏览器的原生弹框，跟小铺的登录是两套
// 密码，每次都要重输。nginx 又没编译 auth_request 模块（nginx -V 里没有），
// 所以在面板进程里自己查一次小铺的会话更简单。
//
// 查的是哪一张会话：/api/site/status，也就是你在 /login 用 SITE_USERNAME /
// SITE_PASSWORD 登录出来的那张 star_bottle_access。刻意**不**用
// /api/owner/status（那张要 OWNER_PASSWORD），因为 /login 页面走的是
// /api/site/login，只会发 site 会话 —— 拿 owner 会话当门禁会让用户
// 「登录了又被弹回登录页」死循环。

import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PANEL_PORT || 8791)
// 低于这个可用内存就不让开新世界（留出系统和其他服务的余量）
const MIN_FREE_MB = Number(process.env.PANEL_MIN_FREE_MB || 250)
// 单个世界大致占用，用来预估
const PER_WORLD_MB = 380
// 小铺：登录态的唯一来源。每次请求都重读，方便自测脚本换端口 / 换端点。
const shopPort = () => Number(process.env.PANEL_SHOP_PORT || 8787)
const authPath = () => process.env.PANEL_AUTH_PATH || '/api/site/status'
// 面板挂在公网上的路径前缀，用来拼登录回跳地址
const PREFIX = process.env.PANEL_PREFIX || '/worlds'

const WORLDS = JSON.parse(fs.readFileSync(path.join(HERE, 'worlds.json'), 'utf8'))

// 把小铺发给浏览器的会话 cookie 原样转给本机小铺，让它回答
// {"authenticated":true|false}。小铺的会话是内存里的 Map，所以这只是一次
// 本机 HTTP 往返，很快；不复用缓存，免得退出登录后面板还能用。
//
// 返回 { ok, unreachable }：
//   ok          —— 小铺确认这个 cookie 是有效会话
//   unreachable —— 小铺没应答（挂了/端口变了），跟「没登录」要分开报
function hasAccess(cookie) {
  return new Promise((resolve) => {
    if (!cookie) return resolve({ ok: false, unreachable: false })
    const port = shopPort()
    const path = authPath()
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { cookie, host: `127.0.0.1:${port}` },
      },
      (r) => {
        let body = ''
        r.setEncoding('utf8')
        r.on('data', (c) => { body += c })
        r.on('end', () => {
          try {
            done({ ok: r.statusCode === 200 && JSON.parse(body).authenticated === true, unreachable: false })
          } catch {
            done({ ok: false, unreachable: false })
          }
        })
        r.on('error', () => done({ ok: false, unreachable: true }))
      },
    )
    req.on('error', () => done({ ok: false, unreachable: true }))
    req.setTimeout(4000, () => { req.destroy(); done({ ok: false, unreachable: true }) })
    req.end()
  })
}

async function pm2List() {
  const { stdout } = await run('pm2', ['jlist'], { maxBuffer: 16 << 20 })
  const out = {}
  for (const p of JSON.parse(stdout)) {
    out[p.name] = {
      status: p.pm2_env?.status || 'unknown',
      rssMb: Math.round((p.monit?.memory || 0) / 1048576),
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }
  }
  return out
}

async function memInfo() {
  const { stdout } = await run('free', ['-m'])
  const line = stdout.split('\n').find((l) => l.startsWith('Mem:'))
  if (!line) return { total: 0, available: 0 }
  const f = line.trim().split(/\s+/)
  return { total: Number(f[1]), available: Number(f[6]) }
}

async function pm2Action(action, name) {
  const { stdout, stderr } = await run('pm2', [action, name], { maxBuffer: 4 << 20 })
  return (stdout + stderr).split('\n').slice(-6).join('\n')
}

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function shopDownPage() {
  return `<!doctype html><meta charset="utf-8"><title>连不上小铺</title>
<style>body{background:#05060f;color:#e8ecff;font:16px/1.7 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
div{max-width:520px;text-align:center;border:1px solid rgba(150,180,255,.22);border-radius:18px;
background:rgba(12,16,40,.55);padding:34px 30px}
code{color:#cfe0ff}</style>
<div><h2>连不上小铺</h2>
<p>面板要问本机小铺（<code>127.0.0.1:${shopPort()}</code>）你的登录态，但它没有应答。</p>
<p>多半是 <code>pm2 status</code> 里 <code>qe-star-bottle</code> 不在跑了。修好之后刷新本页即可。</p></div>`
}

// 导出是为了让 tools/check-panel-auth.mjs 能把它收干净（正常 pm2 跑法不受影响）
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  try {
    // —— 鉴权：先问小铺 ——
    const auth = await hasAccess(req.headers.cookie || '')
    if (auth.unreachable) {
      if (p.startsWith('/api/')) return json(res, 503, { error: '连不上小铺，无法验证登录态', code: 'SHOP_UNREACHABLE' })
      return html(res, 503, shopDownPage())
    }
    if (!auth.ok) {
      if (p.startsWith('/api/')) {
        return json(res, 401, { error: '需要先登录小铺', code: 'SHOP_LOGIN_REQUIRED' })
      }
      // 浏览器：送去小铺的登录页，登录完自己回到本页
      res.writeHead(302, {
        Location: `/login?return=${encodeURIComponent(PREFIX + '/')}`,
        'Cache-Control': 'no-store',
      })
      return res.end()
    }

    if (p === '/api/worlds' && req.method === 'GET') {
      const [procs, mem] = await Promise.all([pm2List(), memInfo()])
      return json(res, 200, {
        memory: mem,
        minFreeMb: MIN_FREE_MB,
        perWorldMb: PER_WORLD_MB,
        worlds: WORLDS.map((w) => {
          const proc = procs[w.name]
          return {
            ...w,
            managed: !!proc,
            status: proc?.status || 'not-created',
            rssMb: proc?.rssMb ?? 0,
            restarts: proc?.restarts ?? 0,
            uptimeMs: proc?.uptime ?? 0,
          }
        }),
      })
    }

    const m = p.match(/^\/api\/worlds\/([^/]+)\/(start|stop|restart)$/)
    if (m && req.method === 'POST') {
      const name = decodeURIComponent(m[1])
      const action = m[2]
      const world = WORLDS.find((w) => w.name === name)
      if (!world) return json(res, 404, { error: '没有这个世界的记录: ' + name })

      if (action === 'start') {
        const mem = await memInfo()
        if (mem.available < MIN_FREE_MB) {
          return json(res, 409, {
            error: `可用内存只剩 ${mem.available}MB，低于安全线 ${MIN_FREE_MB}MB。` +
              `先关掉一个世界再开。`,
          })
        }
        if (mem.available < PER_WORLD_MB) {
          return json(res, 409, {
            error: `可用内存 ${mem.available}MB 可能不够再开一个世界（约需 ${PER_WORLD_MB}MB）。` +
              `先关掉一个再试。`,
          })
        }
      }

      const output = await pm2Action(action, name)
      return json(res, 200, { ok: true, action, name, output })
    }

    if (p === '/' || p === '/index.html') {
      return html(res, 200, fs.readFileSync(path.join(HERE, 'index.html'), 'utf8'))
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[worlds-panel] listening on 127.0.0.1:${PORT}, ${WORLDS.length} 个世界，鉴权走小铺 :${shopPort()}`)
})

// 给自己留个最小自检：worlds.json 必须能被解析出 name
if (!Array.isArray(WORLDS) || WORLDS.some((w) => !w.name || !w.port)) {
  console.error('[worlds-panel] worlds.json 格式不对，每项至少要有 name 和 port')
  process.exit(1)
}
