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
  /** 需要关注/退回的异常状态；终态口径之外的状态都不算异常。 */
  abnormalStatuses: string[]
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

export type ModuleSummary = {
  key: string
  name: string
  created: number
  pending: number
  abnormal: number
  voided: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: ModuleSummary[]
}

/** 一次封存产出的模块汇总行；封存后永不再算，直接回放。 */
export type SealedModuleSummary = {
  key: string
  name: string
  created: number
  pending: number
  abnormal: number
  voided: number
}

/** 封存班次的完整快照：汇总与导出内容同生共死，缺一块都不允许落盘。 */
export type ShiftSeal = {
  shiftId: string
  shiftLabel: string
  operator: string
  sealedAt: string
  /** 乐观锁版本：封存放回文档时用它判断有没有被别的终端抢先。 */
  baseVersion: number
  modules: SealedModuleSummary[]
  exports: Record<string, { filename: string; content: string }>
}

export type SealResult = {
  ok: boolean
  message: string
  seal?: ShiftSeal
}
