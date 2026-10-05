import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

// 纯前端数据层的离线集成验证：用 localStorage 垫片跑真实代码，
// 覆盖作废三处同步、旧残留清洗、封存不可变、并发封存失败、取数失败留快照。
const entry = `
import { resetModule, runAction, loadOverview, listEntries, exportEntries, sealCurrentShift, sealedShifts } from '/workspace/frontend/src/api/local-service.ts'
import { sealShift, SealConflictError, mutateRow, ConcurrentUpdateError } from '/workspace/frontend/src/data/local-store.ts'
import { normalizeRow } from '/workspace/frontend/src/data/caliber.ts'
import { MODULE_BY_KEY } from '/workspace/frontend/src/data/modules.ts'
export { resetModule, runAction, loadOverview, listEntries, exportEntries, sealCurrentShift, sealedShifts, sealShift, SealConflictError, mutateRow, ConcurrentUpdateError, normalizeRow, MODULE_BY_KEY }
`
writeFileSync('/tmp/test-entry.ts', entry)

const result = await build({
  entryPoints: ['/tmp/test-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  alias: { '@': '/workspace/frontend/src' },
  write: false,
})

// 全局注册表：各终端模块通过 window.addEventListener('storage') 订阅
const storageListeners = new Set()
function makeStore(initial = {}) {
  const shim = {
    _data: new Map(Object.entries(initial)),
    getItem(k) { return this._data.has(k) ? this._data.get(k) : null },
    setItem(k, v) {
      const old = this.getItem(k)
      this._data.set(k, String(v))
      // 浏览器里 storage 事件只派发给“其他”标签页：这里广播给全部订阅者，
      // 写入方自己在 setItem 后 cache 已是最新，收到事件最多做一次无害的重读。
      storageListeners.forEach((fn) => fn({ key: k, oldValue: old, newValue: String(v) }))
    },
    removeItem(k) { this._data.delete(k) },
    dump() { return Object.fromEntries(this._data) },
  }
  return shim
}

let bootCount = 0
function boot(store) {
  storageListeners.clear() // 每个终端场景独立，清掉上一场景模块注册的旧监听
  const win = {
    localStorage: store,
    addEventListener(type, fn) { if (type === 'storage') storageListeners.add(fn) },
  }
  globalThis.window = win
  // 每次换 store 都要全新模块图：写不同的临时文件路径绕过模块缓存
  bootCount++
  const file = `/tmp/test-bundle-${bootCount}.js`
  writeFileSync(file, result.outputFiles[0].text)
  return import('file://' + file)
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  PASS', name)
  } else {
    failures++
    console.error('  FAIL', name, detail)
  }
}

// ---- 场景 1-3：作废在明细 / 总览待办 / 导出三处同步，旧残留被清洗 ----
{
  console.log('场景 作废结论三处同步（浮选作废 / 接待取消）')
  // 先造一份「历史 localStorage」：已取消但仍 pending，模拟旧口径遗留数据
  const bootStore = makeStore()
  const bootstrap = await boot(bootStore)
  bootstrap.resetModule('visit')
  const legacy = JSON.parse(bootStore.getItem('field-archaeology-digital:entries'))
  legacy.visit[0].status = '已取消'
  legacy.visit[0].pending = true
  legacy.visit[0].abnormal = false
  const store = makeStore({ 'field-archaeology-digital:entries': JSON.stringify(legacy) })
  const api = await boot(store)

  const visitList = api.listEntries('visit').items
  const canceled = visitList.find((r) => r.status === '已取消')
  check('旧脏数据读取时已被纠正：已取消 => pending=false', canceled.pending === false)
  check('旧脏数据读取时已被纠正：已取消 => abnormal=true', canceled.abnormal === true)
  check('旧残留已回写 localStorage', (() => {
    const healed = JSON.parse(store.getItem('field-archaeology-digital:entries'))
    return healed.visit.find((r) => r.status === '已取消').pending === false
  })())

  // 浮选作废
  const before = api.loadOverview()
  const flotModBefore = before.modules.find((m) => m.name === '浮选采样')
  const res = api.runAction('flotation', 1, '作废样本')
  check('作废动作成功', res.ok, res.message)
  const row = api.listEntries('flotation').items.find((r) => r.id === 1)
  check('明细：状态=已作废', row.status === '已作废')
  check('明细：pending=false', row.pending === false)
  check('明细：abnormal=true', row.abnormal === true)
  const after = api.loadOverview()
  const flotModAfter = after.modules.find((m) => m.name === '浮选采样')
  check('总览待办减少 1', flotModBefore.pending - flotModAfter.pending === 1,
    `${flotModBefore.pending} -> ${flotModAfter.pending}`)
  check('总览异常增加 1', flotModAfter.abnormal - flotModBefore.abnormal === 1)
  check('总览异常量卡片同步', after.cards[3].value >= 1)
  const csv = api.exportEntries('flotation').content
  check('导出快照包含已作废', csv.includes('已作废'))
  check('导出快照不包含已采集(id=1)', !csv.split('\n').find((l) => l.startsWith('1,') && l.endsWith('已采集')))
  // 终态不能复活
  const revive = api.runAction('flotation', 1, '执行浮选')
  check('作废行不能被后续动作复活', !revive.ok)
}

// ---- 场景 4：接待取消同样口径 ----
{
  console.log('场景 接待取消')
  const store = makeStore()
  const api = await boot(store)
  api.runAction('visit', 1, '取消接待')
  const r = api.listEntries('visit').items.find((x) => x.id === 1)
  check('取消后 pending=false', r.pending === false)
  check('取消后 abnormal=true', r.abnormal === true)
  const ov = api.loadOverview().modules.find((m) => m.name === '工地接待')
  check('总览接待待办不含已取消', ov.pending === 1) // 只剩 待接待=1 条
  check('总览接待异常含已取消', ov.abnormal === 1)
  const blocked = api.runAction('visit', 1, '完成接待')
  check('取消行不能再操作', !blocked.ok)
}

// ---- 场景 5：封存快照不可变、历史班次不被新口径/新写入改写 ----
{
  console.log('场景 封存快照冻结')
  const store = makeStore()
  const api = await boot(store)
  const sealRes = api.sealCurrentShift({ shiftLabel: '白班 08:00-20:00', operator: '甲' })
  check('封存成功', sealRes.ok, sealRes.message)
  const sealedAtSeal = JSON.parse(JSON.stringify(api.sealedShifts()[0]))

  // 封存后继续作废/流转
  api.runAction('flotation', 1, '作废样本')
  api.runAction('visit', 2, '提交归档')
  const sealedAfter = api.sealedShifts()[0]
  check('封存汇总不被新写入改写', JSON.stringify(sealedAfter.overview) === JSON.stringify(sealedAtSeal.overview))
  check('封存明细不被新写入改写', JSON.stringify(sealedAfter.rows.flotation) === JSON.stringify(sealedAtSeal.rows.flotation))

  // 同一班次重复封存必须失败
  const again = api.sealCurrentShift({ shiftLabel: '白班 08:00-20:00', operator: '乙' })
  check('同班次重复封存失败', !again.ok && /已经封存/.test(again.message), again.message)
}

// ---- 场景 6：两个终端同时封存，后一个失败（版本 CAS）----
{
  console.log('场景 两个终端并发封存')
  const store = makeStore()
  const apiA = await boot(store)
  const apiB = await boot(store)
  // A、B 同时基于版本 0 发起封存；A 先提交成功
  const resA = apiA.sealCurrentShift({ shiftLabel: '白班 08:00-20:00', operator: 'A终端' })
  check('A 终端封存成功', resA.ok, resA.message)
  // 用 store 层的乐观锁复现 B“带着封存前看到的版本 0 提交”的最后时间窗
  let casFailed = false
  try {
    apiB.sealShift(0, { shiftLabel: '夜班 20:00-08:00', operator: 'B终端' }, (entries) => ({
      overview: { cards: [], modules: [] },
      rows: entries,
    }))
  } catch (e) {
    casFailed = e instanceof apiB.SealConflictError
  }
  check('B 终端封存失败（版本已被推进，CAS 冲突）', casFailed)
  check('只留下 A 的一份快照', apiA.sealedShifts().length === 1)
  check('B 失败后快照仍是 A 的完整快照', apiA.sealedShifts()[0].operator === 'A终端')
  // B 刷新后再封存（新版本）可以成功，证明失败的是“并发”而非“不能再封存”
  const resBRetry = apiB.sealCurrentShift({ shiftLabel: '夜班 20:00-08:00', operator: 'B终端' })
  check('B 刷新后用新版本封存成功', resBRetry.ok, resBRetry.message)
}

// ---- 场景 7：汇总取数失败，保住上一份完整快照，不写半份 ----
{
  console.log('场景 取数失败保留上一份完整快照')
  const store = makeStore()
  const api = await boot(store)
  const first = api.sealCurrentShift({ shiftLabel: '白班 08:00-20:00', operator: '甲' })
  check('第一次封存成功', first.ok)
  check('首次封存把懒播种明细一并落盘', store.getItem('field-archaeology-digital:entries') !== null)
  const firstRaw = store.getItem('field-archaeology-digital:sealed-shifts')

  // 破坏某一模块数据（非数组），让封存快照构建/归一化时抛错
  const entries = JSON.parse(store.getItem('field-archaeology-digital:entries'))
  entries.flotation = { broken: true }
  store.setItem('field-archaeology-digital:entries', JSON.stringify(entries))

  const second = api.sealCurrentShift({ shiftLabel: '夜班 20:00-08:00', operator: '乙' })
  check('第二次封存失败', !second.ok)
  check('失败原因提示保留上一份快照', /保留上一份快照/.test(second.message), second.message)
  const secondRaw = store.getItem('field-archaeology-digital:sealed-shifts')
  check('存储里仍是上一份完整快照（字节一致）', secondRaw === firstRaw)
  const list = api.sealedShifts()
  check('没有半份快照混入', list.length === 1 && list[0].shiftLabel === '白班 08:00-20:00')
}

// ---- 场景 8：跨终端 storage 事件让另一终端缓存失效 ----
{
  console.log('场景 跨终端数据同步')
  const store = makeStore()
  const apiA = await boot(store)
  const apiB = await boot(store)
  apiA.runAction('flotation', 2, '完成分拣')
  // 浏览器 storage 事件广播后，B 的缓存应已失效并读到 A 的写入
  const bRowAfterWrite = apiB.listEntries('flotation').items.find((r) => r.id === 2)
  check('B 终端经 storage 事件读到 A 的「已分拣」', bRowAfterWrite.status === '已分拣', bRowAfterWrite.status)
  apiA.runAction('flotation', 2, '送出检测')
  const bRowAfter = apiB.listEntries('flotation').items.find((r) => r.id === 2)
  check('B 终端继续读到 A 的「已送检」', bRowAfter.status === '已送检', bRowAfter.status)
}

// ---- 场景 9：两个终端同时操作同一条，后一个的结论不能覆盖前一个（乐观锁）----
{
  console.log('场景 同一条记录并发流转')
  const store = makeStore()
  const apiA = await boot(store)
  // A 先把样本作废（终态结论）
  const a = apiA.runAction('flotation', 1, '作废样本')
  check('A 作废成功', a.ok)
  // B 终端错过 storage 事件、仍以为该行是「已采集」，按旧状态提交「执行浮选」：
  // 存储层 expectedStatus 乐观锁必须拒绝，A 的作废结论不被覆盖。
  const meta = apiA.MODULE_BY_KEY.get('flotation')
  let rejected = null
  try {
    apiA.mutateRow('flotation', 1, (row) =>
      apiA.normalizeRow(meta, { ...row, status: '已浮选' }), '已采集')
  } catch (e) {
    rejected = e
  }
  check('陈旧写入被乐观锁拒绝', rejected instanceof apiA.ConcurrentUpdateError)
  const row = apiA.listEntries('flotation').items.find((r) => r.id === 1)
  check('记录仍是 A 写入的已作废', row.status === '已作废' && row.pending === false && row.abnormal === true)
}

console.log(failures === 0 ? '\\n全部验证通过 ✅' : `\\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
