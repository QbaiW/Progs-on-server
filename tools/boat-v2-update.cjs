// 把小船蓝图从 v1 脚本切到 v2（缆绳拖动），并补齐 9 项 props。
// 用法（服务器上）：node /root/boat-v2-update.cjs
const Database = require('/www/wwwroot/hyperfy/node_modules/better-sqlite3');

const DB = '/www/wwwroot/hyperfy/world2/db.sqlite';
const H = '11e55c80d20310f1a1e75681f0c09db7c7d5ea63edc3c4a9fbaa729c6d821623';
const PROPS = { motion: true, amount: 0.035, roll: 1.2, pitch: 0.9, tow: true, rope: 3.2, speed: 1.6, turn: 1.5, depth: 0.55 };

const db = new Database(DB);
db.pragma('journal_mode = WAL');

const row = db.prepare('select data from blueprints where id = ?').get('BoatSail01');
if (!row) {
  console.error('!! 找不到蓝图 BoatSail01');
  process.exitCode = 1;
} else {
  const bp = JSON.parse(row.data);
  console.log('before script:', bp.script);
  console.log('before props :', JSON.stringify(bp.props));
  console.log('before keys  :', Object.keys(bp).join(','));

  bp.script = 'asset://' + H + '.js';
  bp.props = Object.assign({}, bp.props, PROPS);

  const now = new Date().toISOString();
  db.prepare('update blueprints set data = ?, updatedAt = ? where id = ?').run(JSON.stringify(bp), now, 'BoatSail01');

  const a = JSON.parse(db.prepare('select data from blueprints where id = ?').get('BoatSail01').data);
  console.log('after  script:', a.script);
  console.log('after  props :', JSON.stringify(a.props));
  console.log('after  keys  :', Object.keys(a).join(','));
}

const e = db.prepare('select data from entities where id = ?').get('BoatSailE1');
if (e) {
  const ed = JSON.parse(e.data);
  console.log('entity pos   :', JSON.stringify(ed.position), JSON.stringify(ed.quaternion));
  console.log('entity bp    :', ed.blueprint, '| type', ed.type);
} else {
  console.error('!! 找不到实体 BoatSailE1');
  process.exitCode = 1;
}

console.log('counts       : blueprints=' + db.prepare('select count(*) c from blueprints').get().c +
            ' entities=' + db.prepare('select count(*) c from entities').get().c);
db.close();
