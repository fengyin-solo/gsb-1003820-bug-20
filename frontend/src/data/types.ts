/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 终态：落在这些状态上的记录不再计入待处理；缺省取 statuses 最后一个。 */
  terminalStatuses?: string[]
  /** 异常/作废类结论：落在这些状态上的记录计入异常量，且不得再流转。 */
  abnormalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 班次封存档案：封存那一刻逐模块取数与汇总结果的完整冻结快照。 */
export type SealedShift = {
  id: string
  shiftLabel: string
  operator: string
  sealedAt: string
  /** 封存时数据层的版本号，用于并发封存的乐观锁。 */
  version: number
  overview: OverviewResult
  rows: Record<string, EntryRow[]>
}

export type SealShiftResult = ActionResult & {
  sealed?: SealedShift
}
