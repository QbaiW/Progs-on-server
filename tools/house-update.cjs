// 把两个世界里的两层小房子（蓝图 HousTwFl01）换成新版 GLB。
//
// 用法（在服务器上跑，better-sqlite3 只装在服务器上）：
//   node /root/house-update.cjs <glb 的 sha256> [world world2 ...]
//
// 只改蓝图 data 里的 model 字段，别的字段（props.collision = false、
// 脚本、位置）原样保留 —— 新房子和旧房子的墙体尺寸、楼梯、碰撞体位置都一样，
// 唯一变大的是门外那道门廊，所以实体不用挪。
const path = require('path')
const fs = require('fs')
const Database = require('/www/wwwroot/hyperfy/node_modules/better-sqlite3')

const ROOT = '/www/wwwroot/hyperfy'
const [, , sha, ...rest] = process.argv
if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
  console.error('用法: node house-update.cjs <glb sha256> [world|world2 ...]')
  process.exit(2)
}
const targets = rest.length ? rest : ['world', 'world2']

for (const world of targets) {
  const dir = path.join(ROOT, world)
  const asset = path.join(dir, 'assets', sha + '.glb')
  if (!fs.existsSync(asset)) {
    console.error('缺少资产:', asset)
    process.exit(1)
  }
  const db = new Database(path.join(dir, 'db.sqlite'))
  const row = db.prepare('select data from blueprints where id = ?').get('HousTwFl01')
  if (!row) {
    console.error(world, '里找不到蓝图 HousTwFl01')
    db.close()
    process.exit(1)
  }
  const data = JSON.parse(row.data)
  const before = data.model
  data.model = 'asset://' + sha + '.glb'
  db.prepare('update blueprints set data = ?, updatedAt = ? where id = ?')
    .run(JSON.stringify(data), Date.now(), 'HousTwFl01')
  const after = JSON.parse(db.prepare('select data from blueprints where id = ?').get('HousTwFl01').data)
  console.log(
    world,
    JSON.stringify({
      model: { before, after: after.model },
      script: after.script,
      props: after.props,
      assetsKB: (fs.statSync(asset).size / 1024).toFixed(0),
    }),
  )
  db.close()
}
