import { MODULES, MODULE_BY_KEY } from '@/data/modules'
import { SEED_ROWS } from '@/data/seed'
import {
  allRows,
  commitModule,
  exportSnapshot,
  listRows,
  resetRows as storeResetRows,
  sealShift,
  sealedShifts,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  ModuleSummary,
  OverviewResult,
  PageResult,
  SealResult,
  ShiftSeal,
} from '@/data/types'

// 作废是唯一的「业务终止」结论：命中这个状态的记录既不是待办，也不计异常。
export const VOID_STATUS = '已作废'

// 各模块登记的收尾状态：走到这些状态业务即结束，不再是待办。
// 与 modules.ts 里的状态机一一对应；「已作废」对所有模块统一追加。
const TERMINAL_STATUSES: Record<string, string[]> = {
  trench: ['已回填'],
  stratum: ['已校核'],
  feature: ['已归档'],
  artifact: ['已入库', '借出展示'],
  flotation: ['已返回'],
  dating: ['已归档'],
  photography: ['已归档'],
  drawing: ['已数字化'],
  diary: ['已归档'],
  survey: ['已审核'],
  human_bone: ['已归档'],
  animal_bone: ['已归档'],
  pottery: ['已归档'],
  conservation: ['已完成', '已稳定'],
  coordinate: ['已归档'],
  storage: ['临时封存', '已满'],
  material: ['已停用'],
  visit: ['已归档', '已取消'],
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 统一终态口径：作废永远是终态，其余取模块登记的收尾状态。 */
export function isRowTerminal(meta: ModuleMeta, status: string): boolean {
  if (status === VOID_STATUS) {
    return true
  }
  return (TERMINAL_STATUSES[meta.key] ?? []).includes(status)
}

/** 待处理 = 非终态；已作废/已取消等终态结论一律不再是待办。 */
export function isPending(meta: ModuleMeta, status: string): boolean {
  return !isRowTerminal(meta, status)
}

/** 异常 = 落在模块登记的异常状态上；作废与任何终态都不算异常。 */
export function isAbnormal(meta: ModuleMeta, status: string): boolean {
  if (status === VOID_STATUS || isRowTerminal(meta, status)) {
    return false
  }
  return meta.abnormalStatuses.includes(status)
}

/**
 * 按统一口径重算一行的标志位：
 * 明细页、概览、封存都走这里，老数据上残留的 pending/abnormal 在读取时被清掉。
 */
export function reconcileRow(meta: ModuleMeta, row: EntryRow): EntryRow {
  const status = String(row.status)
  return {
    ...row,
    status,
    pending: isPending(meta, status),
    abnormal: isAbnormal(meta, status),
  }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const meta = moduleMeta(key)
  // 明细展示前先对齐口径：作废结论在明细上立即生效，旧的待处理标记不残留。
  const canonical = listRows(key).map((row) => reconcileRow(meta, row))
  const matched = filterRows(canonical, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function buildExport(key: string, rows: EntryRow[]) {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 已作废是终态结论：不能再流转，也不能对同一条重复作废。
  if (current === VOID_STATUS) {
    return { ok: false, message: `${meta.entity}已作废，结论已同步到明细与总览，不能再变更或重复作废` }
  }

  // 内存里先把明细、标志位、导出快照三样改齐，再一次提交：
  // 任何一样没准备好都不写盘，杜绝半份状态。
  const updated = reconcileRow(meta, { ...rows[index], status: target })
  const next = [...rows]
  next[index] = updated
  const exportFile = buildExport(key, next)
  // 事务提交：明细状态 + 待办/异常口径 + 导出快照同一次写入落盘。
  commitModule(key, next, exportFile)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  const meta = moduleMeta(key)
  const rows = (SEED_ROWS[key] ?? []).map((row) => reconcileRow(meta, row))
  storeResetRows(key, rows, buildExport(key, rows))
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  // 导出读事务里同步写好的快照：作废结论在提交那一刻已进快照，不再现场拼装旧状态。
  const snapshot = exportSnapshot(key)
  if (snapshot) {
    return snapshot
  }
  const meta = moduleMeta(key)
  const canonical = listRows(key).map((row) => reconcileRow(meta, row))
  return buildExport(key, canonical)
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 逐模块汇总：明细、概览、封存三处共用同一份取数口径。 */
export function summarizeModule(meta: ModuleMeta, entries: EntryRow[]): ModuleSummary {
  const canonical = entries.map((row) => reconcileRow(meta, row))
  return {
    key: meta.key,
    name: meta.name,
    created: canonical.length,
    pending: canonical.filter((row) => row.pending).length,
    abnormal: canonical.filter((row) => row.abnormal).length,
    voided: canonical.filter((row) => row.status === VOID_STATUS).length,
  }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = MODULES.map((meta) => summarizeModule(meta, rows[meta.key] ?? []))
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    // 已作废的取样/接待不再计入待处理。
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    // 作废是正常业务结论，不是异常，不再抬升异常量。
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export function listSealedShifts(): ShiftSeal[] {
  // 封存快照只读回放：绝不在读取侧重算，历史口径不会被新算法改写。
  return sealedShifts()
}

export type SealRequest = {
  shiftId: string
  shiftLabel: string
  operator: string
}

/**
 * 封存当前班次：逐模块汇总与导出快照必须全部集齐才算成功，
 * 任一模块取数失败就整体放弃并保住上一份完整快照；
 * 已封存班次不可重封，两个终端同时封存时后一个失败。
 */
export async function sealCurrentShift(request: SealRequest): Promise<SealResult> {
  const rows = allRows()
  const outcome = await sealShift({
    shiftId: request.shiftId,
    shiftLabel: request.shiftLabel,
    operator: request.operator,
    moduleKeys: MODULES.map((meta) => meta.key),
    collect: (key) => {
      const meta = moduleMeta(key)
      const entries = (rows[key] ?? []).map((row) => reconcileRow(meta, row))
      return {
        summary: summarizeModule(meta, entries),
        exportFile: buildExport(key, entries),
      }
    },
  })
  if (!outcome.ok) {
    return { ok: false, message: outcome.message }
  }
  return { ok: true, message: `班次「${request.shiftLabel}」已封存，汇总与导出快照已固化` }
}
