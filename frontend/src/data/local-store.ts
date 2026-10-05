import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { normalizeRow } from './caliber'
import type { EntryRow, SealedShift } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'
const META_KEY = 'field-archaeology-digital:meta'
const SEALED_KEY = 'field-archaeology-digital:sealed-shifts'

// 数据层版本号：每次业务写入都自增。两个终端（浏览器标签页）同时封存时，
// 后一个在提交瞬间会发现版本号已被前一个推进，从而失败，不会产生第二份封存。
type DbState = {
  entries: Record<string, EntryRow[]>
  version: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readRaw(key: string): unknown {
  if (!hasStorage()) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// 按模块元数据口径重算所有行的 pending/abnormal：旧版本数据里写死的布尔残留
// （比如已取消仍 pending、需重测却不 pending）在进缓存前就被纠正。
function normalizeAll(raw: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const healed: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(raw)) {
    const meta = MODULE_BY_KEY.get(key)
    // 单模块数据损坏不拖垮整库：无元数据或不是数组时原样保留，由封存取数那一步显式失败。
    healed[key] = meta && Array.isArray(rows) ? rows.map((row) => normalizeRow(meta, row)) : rows
  }
  return healed
}

function readEntries(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const parsed = (readRaw(STORAGE_KEY) ?? {}) as Record<string, EntryRow[]>
  const merged: Record<string, EntryRow[]> = { ...fallback, ...parsed }
  const normalized = normalizeAll(merged)
  // 读到了脏标志就把纠正后的口径回写一次，避免 localStorage 里残留旧状态。
  if (hasStorage() && JSON.stringify(normalized) !== JSON.stringify(merged)) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  }
  return normalized
}

function readVersion(): number {
  const meta = readRaw(META_KEY) as { version?: unknown } | null
  return typeof meta?.version === 'number' ? meta.version : 0
}

function readSealed(): SealedShift[] {
  const list = readRaw(SEALED_KEY)
  return Array.isArray(list) ? (list as SealedShift[]) : []
}

let cache: DbState | null = null
let sealedCache: SealedShift[] | null = null

function loadDb(): DbState {
  if (cache === null) {
    cache = { entries: readEntries(), version: readVersion() }
  }
  return cache
}

// 每次写操作前先和 localStorage 对账：另一个标签页的写入在这里被拉进当前缓存，
// 避免本终端用陈旧快照覆盖新数据。
function syncFromStorage(): DbState {
  if (!hasStorage()) {
    return loadDb()
  }
  const storedVersion = readVersion()
  const db = loadDb()
  if (storedVersion !== db.version) {
    db.entries = readEntries()
    db.version = storedVersion
  }
  sealedCache = null
  return db
}

export function allRows(): Record<string, EntryRow[]> {
  return loadDb().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整库一次写入：localStorage 的 setItem 是同步原子的，明细、总览、导出读的是
// 同一份数据，状态写入要么整体生效要么不生效，不存在半条新状态半条旧状态。
function commitEntries(next: Record<string, EntryRow[]>): void {
  const db = loadDb()
  db.entries = next
  db.version += 1
  cache = db
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(META_KEY, JSON.stringify({ version: db.version }))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const db = syncFromStorage()
  commitEntries({ ...db.entries, [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 单条记录的事务式更新：先对账取最新库，再原子整库写回。
// 作废结论靠这一条路径落到明细；总览待办与导出都从同一份状态实时取数。
// expectedStatus 是乐观锁：提交瞬间该行状态已被别的终端改掉就放弃本次写入。
export function mutateRow(
  key: string,
  id: number,
  produce: (row: EntryRow) => EntryRow,
  expectedStatus?: string,
): EntryRow | undefined {
  const db = syncFromStorage()
  const rows = db.entries[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return undefined
  }
  if (expectedStatus !== undefined && String(rows[index].status) !== expectedStatus) {
    throw new ConcurrentUpdateError('该记录刚被其他终端更新，请刷新后重试')
  }
  const nextRows = [...rows]
  nextRows[index] = produce(nextRows[index])
  commitEntries({ ...db.entries, [key]: nextRows })
  return nextRows[index]
}

export class ConcurrentUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrentUpdateError'
  }
}

export function currentVersion(): number {
  return syncFromStorage().version
}

export function listSealedShifts(): SealedShift[] {
  if (sealedCache === null) {
    sealedCache = readSealed()
  }
  return sealedCache
}

export function getSealedShift(id: string): SealedShift | undefined {
  return listSealedShifts().find((shift) => shift.id === id)
}

// 封存班次：先在内存里把逐模块明细与汇总整份取全，任何一步抛错都直接放弃，
// localStorage 里上一份完整封存快照原样保留，绝不会落下半份数据。
// expectedVersion 是发起封存时看到的版本号；提交瞬间版本被其他终端推进即判冲突。
export function sealShift(
  expectedVersion: number,
  info: { shiftLabel: string; operator: string },
  buildSnapshot: (entries: Record<string, EntryRow[]>) => Pick<SealedShift, 'overview' | 'rows'>,
): SealedShift {
  const db = syncFromStorage()
  if (db.version !== expectedVersion) {
    throw new SealConflictError('数据已被其他终端更新，请刷新后重试封存')
  }

  // 取数与汇总全部完成后才允许写存储；中途失败不动任何已有快照。
  const snapshot = buildSnapshot(clone(db.entries))

  // 提交前再次核对版本号，堵住并发封存最后的时间窗。
  const latestVersion = readVersion()
  const existing = readSealed()
  if (latestVersion !== expectedVersion) {
    throw new SealConflictError('另一个终端已先完成封存，本次封存失败')
  }
  if (existing.some((shift) => shift.shiftLabel === info.shiftLabel)) {
    throw new SealConflictError(`班次「${info.shiftLabel}」已经封存，不能重复封存`)
  }

  const sealed: SealedShift = {
    id: `shift-${Date.now()}-${db.version + 1}`,
    shiftLabel: info.shiftLabel,
    operator: info.operator,
    sealedAt: new Date().toISOString(),
    version: expectedVersion + 1,
    overview: snapshot.overview,
    rows: snapshot.rows,
  }
  const nextSealed = [...existing, sealed]

  // 封存快照是完整对象，单次 setItem 原子落库；随后才推进版本号。
  if (hasStorage()) {
    // 首次封存前明细可能还只在内存里（懒播种未落盘），封存时一并持久化，
    // 否则版本号被推进而 entries 缺失，刷新会误判成“已有数据”而重新播种。
    if (window.localStorage.getItem(STORAGE_KEY) === null) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db.entries))
    }
    window.localStorage.setItem(SEALED_KEY, JSON.stringify(nextSealed))
    db.version += 1
    window.localStorage.setItem(META_KEY, JSON.stringify({ version: db.version }))
    cache = db
  } else {
    db.version += 1
  }
  sealedCache = nextSealed
  return sealed
}

export class SealConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealConflictError'
  }
}

// 跨终端同步：别的标签页写入后，本标签页放弃缓存，下一次读取拿到最新库。
const storageListeners = new Set<(key: string) => void>()

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === META_KEY) {
      cache = null
    }
    if (event.key === SEALED_KEY) {
      sealedCache = null
    }
    if (event.key && [STORAGE_KEY, META_KEY, SEALED_KEY].includes(event.key)) {
      storageListeners.forEach((listener) => listener(event.key as string))
    }
  })
}

export function onStorageChange(listener: (key: string) => void): () => void {
  storageListeners.add(listener)
  return () => storageListeners.delete(listener)
}

export function storageKey(): string {
  return STORAGE_KEY
}
