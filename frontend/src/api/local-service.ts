import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import {
  ConcurrentUpdateError,
  SealConflictError,
  currentVersion,
  getSealedShift,
  listRows,
  listSealedShifts,
  mutateRow,
  resetRows,
  sealShift,
} from '@/data/local-store'
import { isAbnormal, isTerminal, normalizeRow } from '@/data/caliber'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SealShiftResult,
  SealedShift,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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
  const matched = filterRows(listRows(key), filters)
  return {
    items: matched.map((row) => normalizeRow(meta, row)),
    total: matched.length,
    page: 1,
    size: matched.length,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const status = String(current.status)
  if (status === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 终态（含作废、取消、停用等）记录不再允许流转，作废行不能被后续动作「复活」。
  if (isTerminal(meta, status)) {
    return { ok: false, message: `${meta.entity}已处于终态「${status}」，不能再执行${action}` }
  }
  // 单条记录事务式整库写回；pending/abnormal 完全由目标状态口径推导，不残留旧标志。
  // expectedStatus 乐观锁：另一终端恰好也改了这条时本次操作失败，而不是覆盖对方结论。
  let updated: EntryRow | undefined
  try {
    updated = mutateRow(
      key,
      id,
      (row) => normalizeRow(meta, { ...row, status: target }),
      status,
    )
  } catch (error) {
    if (error instanceof ConcurrentUpdateError) {
      return { ok: false, message: error.message }
    }
    throw error
  }
  if (!updated) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${updated.status}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvLine(values: Array<string | number | boolean>): string {
  return values
    .map((value) => {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

// 明细导出：与列表、总览读同一状态，作废结论即时进入快照，不存在第二份口径。
function moduleCsv(meta: ModuleMeta, rows: EntryRow[]): string {
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [csvLine(header)]
  for (const row of rows) {
    lines.push(
      csvLine([row.id, ...meta.fields.map((field) => row[field] ?? ''), String(row.status)]),
    )
  }
  return `﻿${lines.join('\n')}`
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  return { filename: `${meta.name}-清单.csv`, content: moduleCsv(meta, listRows(key)) }
}

// 封存快照导出：冻结的是封存那一刻的明细与汇总，历史班次不被新口径改写。
export function exportSealedShift(id: string): { filename: string; content: string } {
  const sealed = getSealedShift(id)
  if (!sealed) {
    throw new Error(`没有找到封存班次 ${id}`)
  }
  const lines: string[] = []
  lines.push(csvLine(['运营概览封存快照']))
  lines.push(csvLine(['班次', sealed.shiftLabel, '封存时间', sealed.sealedAt, '操作人', sealed.operator]))
  lines.push('')
  lines.push(csvLine(['业务模块', '登记总量', '待处理', '异常量']))
  for (const item of sealed.overview.modules) {
    lines.push(csvLine([item.name, item.created, item.pending, item.abnormal]))
  }
  lines.push(
    csvLine([
      '合计',
      sealed.overview.cards[1]?.value ?? 0,
      sealed.overview.cards[2]?.value ?? 0,
      sealed.overview.cards[3]?.value ?? 0,
    ]),
  )
  for (const meta of MODULES) {
    lines.push('')
    lines.push(csvLine([`模块：${meta.name}`]))
    lines.push(csvLine(['编号', ...meta.fields, '当前状态']))
    for (const row of sealed.rows[meta.key] ?? []) {
      lines.push(
        csvLine([row.id, ...meta.fields.map((field) => row[field] ?? ''), String(row.status)]),
      )
    }
  }
  return { filename: `班次封存-${sealed.shiftLabel}.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadCsv(filename: string, content: string): void {
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

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadCsv(filename, content)
}

export function downloadSealedShift(id: string): void {
  const { filename, content } = exportSealedShift(id)
  downloadCsv(filename, content)
}

// 逐模块汇总：待处理/异常量只从当前状态口径取数，不信任行里写死的布尔位，
// 因此作废结论在明细页、总览待办与导出里永远同一份结论。
export function buildOverview(
  rowsByModule: Record<string, EntryRow[]>,
): OverviewResult {
  const modules = MODULES.map((meta) => {
    const entries = rowsByModule[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => !isTerminal(meta, String(row.status))).length,
      abnormal: entries.filter((row) => isAbnormal(meta, String(row.status))).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export function loadOverview(): OverviewResult {
  const rowsByModule: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    rowsByModule[meta.key] = listRows(meta.key)
  }
  return buildOverview(rowsByModule)
}

// 封存当前班次：整份快照在内存取全后一次性落库；
// 两个终端同时封存时，版本号先变的胜出，后一个失败；
// 任一模块取数失败都不会动到 localStorage 里的上一份封存快照。
export function sealCurrentShift(session: { shiftLabel: string; operator: string }): SealShiftResult {
  // 取数/对账/构建任何一步抛错都走失败分支：不会写入第二份封存，上一份完整快照原样保留。
  let expectedVersion: number
  try {
    expectedVersion = currentVersion()
  } catch {
    return { ok: false, message: '封存失败：汇总取数异常，已保留上一份完整快照' }
  }
  try {
    const sealed = sealShift(
      expectedVersion,
      { shiftLabel: session.shiftLabel, operator: session.operator },
      (entries) => {
        const overview = buildOverview(entries)
        // rows 再冻结一份按口径校正过的明细，确保快照内部与汇总自洽。
        const rows: Record<string, EntryRow[]> = {}
        for (const meta of MODULES) {
          rows[meta.key] = (entries[meta.key] ?? []).map((row) => normalizeRow(meta, row))
        }
        return { overview, rows }
      },
    )
    return { ok: true, message: `班次「${sealed.shiftLabel}」已封存`, sealed }
  } catch (error) {
    if (error instanceof SealConflictError) {
      return { ok: false, message: error.message }
    }
    return {
      ok: false,
      message: error instanceof Error ? `封存失败，已保留上一份快照：${error.message}` : '封存失败，已保留上一份快照',
    }
  }
}

export function sealedShifts(): SealedShift[] {
  return listSealedShifts()
}
