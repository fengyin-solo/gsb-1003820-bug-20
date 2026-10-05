import { SEED_ROWS } from './seed'
import type { EntryRow, SealedModuleSummary, ShiftSeal } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：业务明细、导出快照、封存班次放在同一个文档里，一次写入整体落盘，
// 避免明细已改、快照没跟上的半份数据；v1 老数据首次读取时自动迁移。
const STORAGE_KEY = 'field-archaeology-digital:entries'
const DOC_KEY = 'field-archaeology-digital:doc:v2'
const DOC_VERSION = 2

export type ExportFile = { filename: string; content: string }

export type RootDoc = {
  version: typeof DOC_VERSION
  /** 每次成功提交自增：封存时用它做乐观锁，识别另一个终端是否抢先落盘。 */
  revision: number
  entries: Record<string, EntryRow[]>
  /** 每个模块最近一次提交后同步生成的导出快照，与明细同生共死。 */
  exports: Record<string, ExportFile>
  /** 已封存班次：一经写入永不重算、不改写，取数直接回放。 */
  seals: ShiftSeal[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function seedEntries(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function emptyDoc(): RootDoc {
  return { version: DOC_VERSION, revision: 0, entries: seedEntries(), exports: {}, seals: [] }
}

/** 老格式（v1：只有一份按模块分桶的明细）迁移成 v2 文档。 */
function migrateLegacy(raw: string): RootDoc {
  const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  const doc = emptyDoc()
  doc.entries = { ...seedEntries(), ...parsed }
  return doc
}

function readDoc(): RootDoc {
  if (!hasStorage()) {
    return emptyDoc()
  }
  const raw = window.localStorage.getItem(DOC_KEY)
  if (raw) {
    try {
      const doc = JSON.parse(raw) as RootDoc
      if (doc && doc.version === DOC_VERSION && doc.entries) {
        return doc
      }
    } catch {
      // 落盘内容损坏时不能带着半份数据继续跑，落回示例数据。
    }
  }
  // v1 -> v2：迁完立刻整体落盘，后续只读新 key。
  const legacy = window.localStorage.getItem(STORAGE_KEY)
  const doc = legacy ? migrateLegacy(legacy) : emptyDoc()
  writeDoc(doc)
  return doc
}

function writeDoc(doc: RootDoc): void {
  if (!hasStorage()) {
    return
  }
  // 单 key 单次 setItem：浏览器对同一键的写入是原子替换，调用方读到的永远是整份文档。
  window.localStorage.setItem(DOC_KEY, JSON.stringify(doc))
}

let cache: RootDoc | null = null

function doc(): RootDoc {
  if (cache === null) {
    cache = readDoc()
  }
  return cache
}

/** 另一个标签页写盘时让缓存失效，封存前的重读因此一定拿到最新版本。 */
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === DOC_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  return doc().entries
}

export function listRows(key: string): EntryRow[] {
  return doc().entries[key] ?? []
}

/**
 * 提交一个模块的明细，并在同一次写入里更新它的导出快照：
 * 明细与快照要么一起更新，要么都不动，不允许只改一半。
 */
export function commitModule(
  key: string,
  rows: EntryRow[],
  exportFile: ExportFile | null,
): void {
  const current = doc()
  const next: RootDoc = {
    ...current,
    revision: current.revision + 1,
    entries: { ...current.entries, [key]: rows },
    exports: { ...current.exports },
  }
  if (exportFile) {
    next.exports[key] = exportFile
  }
  writeDoc(next)
  cache = next
}

export function exportSnapshot(key: string): ExportFile | null {
  return doc().exports[key] ?? null
}

export function sealedShifts(): ShiftSeal[] {
  // 封存快照只读回放：绝不在读取侧重算，历史口径因此不会被新算法改写。
  return clone(doc().seals)
}

// ---- 封存的并发互斥 -------------------------------------------------------

type ExclusiveLocks = Pick<LockManager, 'query'> & {
  runExclusive: <T>(name: string, task: () => T | Promise<T>) => Promise<T>
}

function webLocks(): ExclusiveLocks | null {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return null
  }
  // 旧版 DOM 类型里没有 runExclusive，运行时支持（Chrome/Edge/Safari 现代版本）就直接用。
  const locks = navigator.locks as unknown as ExclusiveLocks
  return typeof locks.runExclusive === 'function' ? locks : null
}

/**
 * 不支持 Web Locks 的环境（老浏览器/测试桩）退化成进程内互斥。
 * 队列挂在 globalThis 上：同一页面里即使加载了多份模块实例，互斥仍然成立。
 */
type LockState = { held: boolean; waits: Array<() => void> }
const lockRegistryName = '__fieldArchSealLocks__'

function lockRegistry(): Map<string, LockState> {
  const host = globalThis as unknown as Record<string, unknown>
  let registry = host[lockRegistryName] as Map<string, LockState> | undefined
  if (!registry) {
    registry = new Map<string, LockState>()
    host[lockRegistryName] = registry
  }
  return registry
}

async function withFallbackLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const registry = lockRegistry()
  let state = registry.get(name)
  if (!state) {
    state = { held: false, waits: [] }
    registry.set(name, state)
  }
  if (state.held) {
    await new Promise<void>((resolve) => state!.waits.push(resolve))
  }
  state.held = true
  try {
    return await task()
  } finally {
    state.held = false
    const next = state.waits.shift()
    if (next) {
      next()
    } else {
      registry.delete(name)
    }
  }
}

async function withSealLock<T>(shiftId: string, task: () => Promise<T>): Promise<T> {
  const locks = webLocks()
  if (locks) {
    // 同名锁在多标签页/多终端（同源）之间互斥：后一个封存等前一个放锁，
    // 放锁后重读到已封存班次，必然失败。
    return locks.runExclusive(`seal:${shiftId}`, task)
  }
  return withFallbackLock(`seal:${shiftId}`, task)
}

// 测试用故障注入：让第 N 个模块的汇总取数抛错，验证半份快照不落盘。
let failCollectAt = -1
export function __setFailCollectAt(index: number): void {
  failCollectAt = index
}

export type CollectedModule = {
  summary: SealedModuleSummary
  exportFile: ExportFile
}

export type SealInput = {
  shiftId: string
  shiftLabel: string
  operator: string
  moduleKeys: string[]
  /** 逐模块汇总 + 导出快照取数；任一模块抛错则整个封存失败。 */
  collect: (key: string, index: number) => CollectedModule
}

export type SealOutcome =
  | { ok: true; seal: ShiftSeal }
  | { ok: false; message: string }

/**
 * 封存当前班次：
 * 1. 同名班次已封存直接失败（历史封存不可改写）；
 * 2. 全程持锁，两个终端同时封存时后一个在锁内重读并失败；
 * 3. 所有模块的汇总与导出快照先在内存里集齐，任一取数抛错就整体放弃，
 *    已有的上一份封存/快照原样保留，绝不写入半份数据。
 */
export async function sealShift(input: SealInput): Promise<SealOutcome> {
  return withSealLock(input.shiftId, async () => {
    const fresh = readDoc()
    cache = fresh
    if (fresh.seals.some((seal) => seal.shiftId === input.shiftId)) {
      return { ok: false, message: `班次「${input.shiftLabel}」已封存，封存结论不能重复提交或改写` }
    }

    // 先在内存里收集整份快照：中途抛错不会触碰已落盘文档，
    // 上一份完整快照（其它班次封存 + 当前导出）自然保住。
    const modules: SealedModuleSummary[] = []
    const exports: Record<string, ExportFile> = {}
    for (let index = 0; index < input.moduleKeys.length; index += 1) {
      const key = input.moduleKeys[index]
      let collected: CollectedModule
      try {
        if (index === failCollectAt) {
          throw new Error(`模块 ${key} 汇总取数失败（注入）`)
        }
        collected = input.collect(key, index)
      } catch (error) {
        return {
          ok: false,
          message: `班次「${input.shiftLabel}」封存中止：${
            error instanceof Error ? error.message : '汇总取数失败'
          }，已保留上一份完整快照`,
        }
      }
      modules.push(collected.summary)
      exports[key] = collected.exportFile
    }

    // 放锁前再重读一次：同名锁保证了同一班次没有第二个封存能插进来，
    // 这里挡住锁外其它路径（或未来多实例）造成的重复封存。
    const latest = readDoc()
    if (latest.seals.some((item) => item.shiftId === input.shiftId)) {
      return { ok: false, message: `班次「${input.shiftLabel}」已被另一个终端封存，本次提交作废` }
    }

    const seal: ShiftSeal = {
      shiftId: input.shiftId,
      shiftLabel: input.shiftLabel,
      operator: input.operator,
      sealedAt: new Date().toISOString(),
      baseVersion: latest.revision,
      modules,
      exports,
    }
    const next: RootDoc = {
      ...latest,
      revision: latest.revision + 1,
      seals: [...latest.seals, seal],
    }
    writeDoc(next)
    cache = next
    return { ok: true, seal }
  })
}

export function resetRows(key: string, rows: EntryRow[], exportFile: ExportFile | null): EntryRow[] {
  commitModule(key, rows, exportFile)
  return rows
}
