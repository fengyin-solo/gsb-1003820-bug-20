import type { EntryRow, ModuleMeta } from './types'

// 状态口径是唯一事实来源：待处理/异常量不再信任写入时拍死的布尔标志，
// 而是从当前状态实时推导。旧数据里残留的 pending/abnormal 会在读取时被这里纠正，
// 因此作废结论在明细、总览待办、导出快照三处永远一致，也不会留下旧状态残留。

export function terminalStatuses(meta: ModuleMeta): Set<string> {
  const list = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  return new Set(list)
}

export function abnormalStatuses(meta: ModuleMeta): Set<string> {
  return new Set(meta.abnormalStatuses ?? [])
}

export function isTerminal(meta: ModuleMeta, status: string): boolean {
  return terminalStatuses(meta).has(status)
}

// 列表页模板用的别名，语义相同。
export const isTerminalStatus = isTerminal

export function isAbnormal(meta: ModuleMeta, status: string): boolean {
  return abnormalStatuses(meta).has(status)
}

/** 按当前状态重算 pending/abnormal，返回新行；与原行一致时原样返回（引用稳定）。 */
export function normalizeRow(meta: ModuleMeta, row: EntryRow): EntryRow {
  const status = String(row.status)
  const pending = !isTerminal(meta, status)
  const abnormal = isAbnormal(meta, status)
  if (row.pending === pending && row.abnormal === abnormal) {
    return row
  }
  return { ...row, pending, abnormal }
}
