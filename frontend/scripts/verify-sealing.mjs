/* 端到端行为验证：在 Node 里给浏览器存储打桩，直接跑数据层/服务层真实代码。
 * 覆盖：
 * 1. 作废后明细终态、总览待处理/异常量下降、导出快照同步、不可重复作废
 * 2. 旧 v1 数据迁移后旧标志残留被统一口径清掉
 * 3. 已封存班次不可被新数据/新口径改写
 * 4. 两个终端同时封存，后一个失败
 * 5. 汇总取数失败时保住上一份完整快照，不写入半份数据
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

// ---- 浏览器环境桩 -----------------------------------------------------------
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
}

function installWindow(storage) {
  globalThis.window = { localStorage: storage, addEventListener() {} }
}

let checks = 0
function assert(cond, msg) {
  checks += 1
  if (!cond) throw new Error(`断言失败: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function buildBundle() {
  const result = await build({
    entryPoints: [path.join(root, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    alias: { '@': path.join(root, '..', 'src') },
  })
  const file = path.join(os.tmpdir(), `seal-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, result.outputFiles[0].text)
  return file
}

async function freshBundle(storage) {
  installWindow(storage)
  const file = await buildBundle()
  try {
    return await import(`${pathToFileUrl(file)}?t=${Date.now()}-${Math.random()}`)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function pathToFileUrl(p) {
  return new URL(`file://${path.resolve(p)}`).href
}

// ---- 场景 1 & 2：作废三处同步 + 旧标志迁移 ----------------------------------
{
  const storage = new MemoryStorage()

  // 造一份 v1 老数据：取样 id=2 已经是「已作废」状态，但残留 pending=true、abnormal=true
  const legacy = {
    flotation: [
      { id: 1, status: '已采集', pending: true, abnormal: false, 样本编号: 'FLOT-0001' },
      { id: 2, status: '已作废', pending: true, abnormal: true, 样本编号: 'FLOT-0002' },
      { id: 3, status: '已返回', pending: false, abnormal: false, 样本编号: 'FLOT-0003' },
    ],
    visit: [
      { id: 1, status: '待接待', pending: true, abnormal: false, 来访编号: 'VISI-0001' },
      { id: 2, status: '已接待', pending: true, abnormal: false, 来访编号: 'VISI-0002' },
    ],
  }
  storage.setItem('field-archaeology-digital:entries', JSON.stringify(legacy))

  const svc = await freshBundle(storage)

  console.log('场景1: v1 迁移 + 已作废旧残留被统一口径清除')
  const overview1 = svc.loadOverview()
  const flot1 = overview1.modules.find((m) => m.key === 'flotation')
  assert(flot1.created === 3, '取样登记总量仍为 3（作废记录保留在明细）')
  assert(flot1.pending === 1, '已作废取样不再计入待处理（仅剩 id=1 待处理）')
  assert(flot1.abnormal === 0, '已作废取样不再计入异常量')
  assert(flot1.voided === 1, '取样已作废数为 1')

  const flotList = svc.listEntries('flotation').items
  const voidedRow = flotList.find((r) => r.id === 2)
  assert(voidedRow.pending === false && voidedRow.abnormal === false, '明细页已作废行标志位已对齐（旧残留清除）')
  assert(voidedRow.status === '已作废', '明细页作废结论生效，状态为已作废')

  console.log('场景2: 接待作废 -> 明细/总览待办/导出快照三处事务同步')
  const before = svc.loadOverview()
  const visitBefore = before.modules.find((m) => m.key === 'visit')
  assert(visitBefore.pending === 2, '作废前接待待处理为 2')

  const act = svc.runAction('visit', 1, '作废来访')
  assert(act.ok === true, '作废来访动作成功')

  const row = svc.listEntries('visit').items.find((r) => r.id === 1)
  assert(row.status === '已作废' && row.pending === false && row.abnormal === false, '明细：作废行终态且无旧标志')

  const after = svc.loadOverview()
  const visitAfter = after.modules.find((m) => m.key === 'visit')
  assert(visitAfter.pending === 1, '总览待办同步下降为 1')
  assert(visitAfter.abnormal === 0, '总览异常量不含作废')
  assert(visitAfter.voided === 1, '总览已作废列为 1')

  const exp = svc.exportEntries('visit')
  assert(exp.content.includes('已作废'), '导出快照已写入作废结论')
  const csvRow = exp.content.split('\n').find((l) => l.startsWith('1,'))
  assert(csvRow && csvRow.endsWith('已作废'), '导出快照中该行为已作废，无旧状态残留')

  const again = svc.runAction('visit', 1, '作废来访')
  assert(again.ok === false, '同一条记录不能重复作废')
  const other = svc.runAction('visit', 1, '完成接待')
  assert(other.ok === false, '已作废记录不能再流转')

  console.log('场景3: 正向动作清除历史异常标志')
  svc.runAction('stratum', 2, '退回补录')
  const sBack = svc.listEntries('stratum').items.find((r) => r.id === 2)
  assert(sBack.status === '需补录' && sBack.abnormal === true && sBack.pending === true, '退回补录后置为异常+待处理')
  svc.runAction('stratum', 2, '完成校核')
  const s2 = svc.listEntries('stratum').items.find((r) => r.id === 2)
  assert(s2.status === '已校核' && s2.abnormal === false && s2.pending === false, '完成校核后旧异常标志被清掉，且不再待处理')

  // 落盘文档里导出快照与明细同时更新（同一次提交）
  const doc = JSON.parse(storage.getItem('field-archaeology-digital:doc:v2'))
  assert(doc.exports.visit.content.includes('已作废'), '文档内导出快照随明细同一事务落盘')
  assert(doc.exports.stratum.content.includes('已校核'), 'stratum 导出快照同步为最新状态')
}

// ---- 场景 4：封存快照不被新数据/新口径改写 -----------------------------------
{
  const storage = new MemoryStorage()
  const svc = await freshBundle(storage)

  console.log('场景4: 历史已封存班次不被新数据改写')
  const r1 = await svc.sealCurrentShift({ shiftId: '2026-10-05-白班', shiftLabel: '白班', operator: '甲' })
  assert(r1.ok, '首次封存成功')
  const seals1 = svc.listSealedShifts()
  assert(seals1.length === 1 && seals1[0].modules.length === 18, '封存快照含全部 18 个模块')
  const sealedVisit = seals1[0].modules.find((m) => m.key === 'visit')
  assert(sealedVisit.pending === 2, '封存时接待待处理为 2（已接待非终态，待接待+已接待）')
  assert(Object.keys(seals1[0].exports).length === 18, '封存导出快照 18 份齐全')

  // 封存后再作废一条接待：实时总览变化，但封存快照原样
  svc.runAction('visit', 1, '作废来访')
  const live = svc.loadOverview().modules.find((m) => m.key === 'visit')
  assert(live.pending === 1, '实时总览待处理已变为 1')
  const seals2 = svc.listSealedShifts()
  const frozen = seals2[0].modules.find((m) => m.key === 'visit')
  assert(frozen.pending === 2, '封存快照仍为 2，历史班次未被新数据改写')
  assert(seals2[0].exports.visit.content.includes('待接待'), '封存的导出快照保留封存时状态')
  const frozenRow1 = seals2[0].exports.visit.content.split('\n').find((l) => l.startsWith('1,'))
  assert(frozenRow1.endsWith('待接待'), '封存导出快照没有被事后作废污染')

  const r2 = await svc.sealCurrentShift({ shiftId: '2026-10-05-白班', shiftLabel: '白班', operator: '乙' })
  assert(!r2.ok, '同一班次重复封存被拒绝')
  assert(svc.listSealedShifts()[0].operator === '甲', '被拒封存没有覆盖原封存人')
}

// ---- 场景 5：两终端同时封存，后一个失败 --------------------------------------
{
  const storage = new MemoryStorage()
  // 两个独立 bundle 实例模拟两个终端：各自有模块缓存，但共享存储与全局锁注册表。
  const svcA = await freshBundle(storage)
  const svcB = await freshBundle(storage)

  console.log('场景5: 两个终端同时封存同一班次，后一个必须失败')
  const [a, b] = await Promise.all([
    svcA.sealCurrentShift({ shiftId: 'S-1', shiftLabel: '夜班', operator: '终端A' }),
    svcB.sealCurrentShift({ shiftId: 'S-1', shiftLabel: '夜班', operator: '终端B' }),
  ])
  const winners = [a, b].filter((x) => x.ok)
  const losers = [a, b].filter((x) => !x.ok)
  assert(winners.length === 1, '恰有一个终端封存成功')
  assert(losers.length === 1, '另一个终端封存失败')
  assert(/已封存|已被另一个终端封存/.test(losers[0].message), '失败原因是班次已被封存')
  assert(svcA.listSealedShifts().length === 1, '只落了一份封存，没有重复')
}

// ---- 场景 6：取数失败保住上一份完整快照 --------------------------------------
{
  const storage = new MemoryStorage()
  const svc = await freshBundle(storage)

  console.log('场景6: 汇总取数失败 -> 整体中止，上一份完整快照保留')
  const ok0 = await svc.sealCurrentShift({ shiftId: 'DAY1', shiftLabel: '白班1', operator: '甲' })
  assert(ok0.ok, '前置：白班1 封存成功')

  // 注入：第 5 个模块取数抛错
  svc.__setFailCollectAt(5)
  const bad = await svc.sealCurrentShift({ shiftId: 'DAY2', shiftLabel: '白班2', operator: '甲' })
  assert(!bad.ok, '取数失败时封存失败')
  assert(/汇总取数失败|封存中止/.test(bad.message), '失败信息说明取数中止')
  svc.__setFailCollectAt(-1)

  const seals = svc.listSealedShifts()
  assert(seals.length === 1 && seals[0].shiftId === 'DAY1', '失败的封存没有写入，上一份封存完整保留')
  assert(seals[0].modules.length === 18, '保留的快照模块齐全（非半份）')
  assert(Object.keys(seals[0].exports).length === 18, '保留的快照导出齐全（非半份）')

  const retry = await svc.sealCurrentShift({ shiftId: 'DAY2', shiftLabel: '白班2', operator: '甲' })
  assert(retry.ok, '故障排除后新班次封存成功')
  assert(svc.listSealedShifts().length === 2, '两份完整封存并存')
}

console.log(`\n全部 ${checks} 条断言通过`)
