// 把小船蓝图切到新的脚本资产，并合并 props。
// 用法（服务器上）：node /root/boat-update.cjs <脚本sha256> '<props JSON>'
const Database = require('/www/wwwroot/hyperfy/node_modules/better-sqlite3')

const H = process.argv[2]
const PROPS = process.argv[3] ? JSON.parse(process.argv[3]) : {}
if (!H) {
  console.error('!! 缺少脚本 sha256 参数')
  process.exitCode = 1
} else {
  const db = new Database('/www/wwwroot/hyperfy/world2/db.sqlite')
  db.pragma('journal_mode = WAL')

  const row = db.prepare('select data from blueprints where id = ?').get('BoatSail01')
  if (!row) {
    console.error('!! 找不到蓝图 BoatSail01')
    process.exitCode = 1
  } else {
    const bp = JSON.parse(row.data)
    console.log('before script:', bp.script)
    console.log('before props :', JSON.stringify(bp.props))
    console.log('before keys  :', Object.keys(bp).join(','))

    bp.script = 'asset://' + H + '.js'
    bp.props = Object.assign({}, bp.props, PROPS)

    db.prepare('update blueprints set data = ?, updatedAt = ? where id = ?')
      .run(JSON.stringify(bp), new Date().toISOString(), 'BoatSail01')

    const a = JSON.parse(db.prepare('select data from blueprints where id = ?').get('BoatSail01').data)
    console.log('after  script:', a.script)
    console.log('after  props :', JSON.stringify(a.props))
    console.log('after  keys  :', Object.keys(a).join(','))
  }

  const e = db.prepare('select data from entities where id = ?').get('BoatSailE1')
  if (e) {
    const ed = JSON.parse(e.data)
    console.log('entity pos   :', JSON.stringify(ed.position), JSON.stringify(ed.quaternion))
    console.log('entity bp    :', ed.blueprint, '| type', ed.type)
  } else {
    console.error('!! 找不到实体 BoatSailE1')
    process.exitCode = 1
  }

  console.log('counts       : blueprints=' + db.prepare('select count(*) c from blueprints').get().c +
    ' entities=' + db.prepare('select count(*) c from entities').get().c)
  db.close()
}
