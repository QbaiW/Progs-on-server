// 临时诊断脚本：把小船的节点树原样打印出来，搞清 app.get('Boat') 为什么找不到。
// 用完就把蓝图的 script 换回正式版本。
console.log('[diag] isServer =', world.isServer)
console.log('[diag] app.id =', app.id, '| app.name =', app.name)

const kids = app.children
console.log('[diag] app.children 个数 =', kids ? kids.length : 'undefined')
if (kids) {
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    console.log('[diag] child[' + i + '] name=' + c.name + ' id=' + c.id + ' type=' + c.type)
  }
}

console.log('[diag] 开始 traverse')
app.traverse(n => {
  let extra = ''
  try {
    extra = ' geometry=' + (n.geometry ? 'yes' : 'no')
  } catch (e) {
    extra = ''
  }
  console.log('[diag] node name=' + n.name + ' | id=' + n.id + ' | type=' + n.type + extra)
})

const b = app.get('Boat')
console.log('[diag] app.get(Boat) ->', b ? 'FOUND type=' + b.type + ' name=' + b.name : 'null')
const anyKin = app.get('Boat')
if (anyKin) {
  console.log('[diag] kin 有 setKinematicTarget?', typeof anyKin.setKinematicTarget)
}
