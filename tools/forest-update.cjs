// 森林小屋入库脚本 —— 在「世界一」的 db 里把 $scene 换成森林地形，
// 从世界二搬来两层小屋的蓝图 + 实体，并把出生点挪到小屋前。
//
// 在服务器上跑（better-sqlite3 只在服务器上装过）：
//   node /root/forest-update.cjs <forestGlbSha> <forestJsSha> <houseGlbSha> \
//        <cabinX> <cabinY> <cabinZ> <fireX> <fireY> <fireZ> '<props JSON>'
//
// 资产文件名规则：sha256 十六进制 + 扩展名，放在 world/assets/ 下。
// 脚本先确认资产文件都在，缺了直接退出，不动数据库。
//
// 为什么搬蓝图而不是新造一份：世界二的两层小屋（含 13 级楼梯和碰撞体）已经上线
// 验证过，坐标与摆放结论都算数，复制 data JSON 即可，不用重新生成。

const path = require('path')
const fs = require('fs')
const Database = require('/www/wwwroot/hyperfy/node_modules/better-sqlite3')

const ROOT = '/www/wwwroot/hyperfy'
const W1 = path.join(ROOT, 'world')
const W2 = path.join(ROOT, 'world2')
const ASSETS = path.join(W1, 'assets')

const [, , forestGlb, forestJs, houseGlb, cabinX, cabinY, cabinZ, fireX, fireY, fireZ, propsJson] = process.argv
if (!propsJson) {
  console.error('用法: node forest-update.cjs <forestGlb> <forestJs> <houseGlb> <cx> <cy> <cz> <fx> <fy> <fz> \'<props JSON>\'')
  process.exit(2)
}

const need = [
  [path.join(ASSETS, forestGlb + '.glb'), '森林地形 GLB'],
  [path.join(ASSETS, forestJs + '.js'), '森林场景脚本'],
  [path.join(ASSETS, houseGlb + '.glb'), '小屋 GLB'],
  [path.join(ASSETS, '448d865815800831237e06e9d5817d74cb600dfa8e7fec74eb209d63fc46f0aa.js'), 'Model app 脚本'],
]
for (const [file, label] of need) {
  if (!fs.existsSync(file)) {
    console.error('缺少资产：' + label + ' → ' + file)
    process.exit(1)
  }
}

const props = JSON.parse(propsJson)

// ---- 从世界二取小屋蓝图与实体（只读） ----
const db2 = new Database(path.join(W2, 'db.sqlite'), { readonly: true })
const houseBpRow = db2.prepare('select * from blueprints where id = ?').get('HousTwFl01')
const houseEntRow = db2.prepare('select * from entities where id = ?').get('HousTwEn01')
db2.close()
if (!houseBpRow || !houseEntRow) {
  console.error('世界二里找不到 HousTwFl01 蓝图或 HousTwEn01 实体')
  process.exit(1)
}

// ---- 写世界一 ----
const db1 = new Database(path.join(W1, 'db.sqlite'))
const now = Date.now()

function describe(prefix, data) {
  const d = JSON.parse(data)
  console.log(
    prefix,
    JSON.stringify({ name: d.name, model: d.model, script: d.script, props: d.props, position: d.position, quaternion: d.quaternion }),
  )
}

const sceneRow = db1.prepare('select data from blueprints where id = ?').get('$scene')
if (!sceneRow) {
  console.error('世界一里找不到 $scene 蓝图')
  process.exit(1)
}

const scene = JSON.parse(sceneRow.data)
describe('改动前 $scene', sceneRow.data)

scene.name = '森林小屋'
scene.desc = '林间小岛：松林、一间小屋和一堆篝火'
scene.model = 'asset://' + forestGlb + '.glb'
scene.script = 'asset://' + forestJs + '.js'
scene.props = { ...(scene.props || {}), ...props }

// 小屋实体：搬到山顶台地，朝正前方（quaternion 保持单位阵）
const houseEnt = JSON.parse(houseEntRow.data)
const cx = Number(cabinX)
const cy = Number(cabinY)
const cz = Number(cabinZ)
houseEnt.position = [cx, cy, cz]
houseEnt.quaternion = [0, 0, 0, 1]
houseEnt.scale = [1, 1, 1]

const houseData = JSON.parse(houseBpRow.data)
// 蓝图 data 里的 id 保持 HousTwFl01（世界二已经这么存的）
houseData.id = 'HousTwFl01'

// 出生点：门廊前 8.5 米，朝向小屋（门廊和门在 -Z 一侧，别把人丢在屋后）
const spawn = {
  position: [+(cx + 0.9).toFixed(3), +(cy + 1.9).toFixed(3), +(cz - 8.5).toFixed(3)],
  quaternion: [0, 0, 0, 1],
}
{
  const dx = cx - spawn.position[0]
  const dz = cz - spawn.position[2]
  const yaw = Math.atan2(-dx, -dz)
  spawn.quaternion = [0, +Math.sin(yaw / 2).toFixed(6), 0, +Math.cos(yaw / 2).toFixed(6)]
}

db1
  .transaction(() => {
    db1
      .prepare('update blueprints set data = ?, updatedAt = ? where id = ?')
      .run(JSON.stringify(scene), now, '$scene')

    if (db1.prepare('select 1 from blueprints where id = ?').get('HousTwFl01')) {
      db1.prepare('update blueprints set data = ?, updatedAt = ? where id = ?').run(JSON.stringify(houseData), now, 'HousTwFl01')
    } else {
      db1
        .prepare('insert into blueprints (id, data, createdAt, updatedAt) values (?, ?, ?, ?)')
        .run('HousTwFl01', JSON.stringify(houseData), now, now)
    }

    if (db1.prepare('select 1 from entities where id = ?').get('HousTwEn01')) {
      db1.prepare('update entities set data = ?, updatedAt = ? where id = ?').run(JSON.stringify(houseEnt), now, 'HousTwEn01')
    } else {
      db1
        .prepare('insert into entities (id, data, createdAt, updatedAt) values (?, ?, ?, ?)')
        .run('HousTwEn01', JSON.stringify(houseEnt), now, now)
    }

    const spawnRow = db1.prepare('select value from config where key = ?').get('spawn')
    if (spawnRow) {
      db1.prepare('update config set value = ? where key = ?').run(JSON.stringify(spawn), 'spawn')
    } else {
      db1.prepare('insert into config (key, value) values (?, ?)').run('spawn', JSON.stringify(spawn))
    }
  })
  .immediate()

console.log('--- 写入后 ---')
describe('$scene', db1.prepare('select data from blueprints where id = ?').get('$scene').data)
console.log('blueprints', db1.prepare('select id from blueprints').all().map((r) => r.id).join(','))
for (const row of db1.prepare('select id, data from entities').all()) {
  const d = JSON.parse(row.data)
  console.log('entity', row.id, d.blueprint, JSON.stringify(d.position))
}
console.log('spawn', db1.prepare('select value from config where key = ?').get('spawn').value)

db1.close()
