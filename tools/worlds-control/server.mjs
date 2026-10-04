// 世界控制面板
//
// 干什么：列出所有世界、看运行状态、开 / 关。
// 怎么起：pm2 start server.mjs --name worlds-panel
// 怎么访问：https://myiuan.xin/worlds  （nginx 代理到 127.0.0.1:8791，带 basic auth）
//
// 设计要点：
// - 用 pm2 命令行而不是 pm2 模块，省得处理 node_modules 解析路径。
// - 每个世界是一个预先建好的 pm2 进程，这里只 start/stop，不改它的环境变量。
// - 开新世界前先看可用内存，不够就直接拒绝 —— 这台机器一共只有 1870MB。

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

const WORLDS = JSON.parse(fs.readFileSync(path.join(HERE, 'worlds.json'), 'utf8'))

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  try {
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
      const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(html),
      })
      return res.end(html)
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[worlds-panel] listening on 127.0.0.1:${PORT}, ${WORLDS.length} 个世界`)
})

// 给自己留个最小自检：worlds.json 必须能被解析出 name
if (!Array.isArray(WORLDS) || WORLDS.some((w) => !w.name || !w.port)) {
  console.error('[worlds-panel] worlds.json 格式不对，每项至少要有 name 和 port')
  process.exit(1)
}
