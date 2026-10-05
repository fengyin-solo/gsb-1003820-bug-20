<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
        <button class="btn primary" type="button" :disabled="shiftSealed" @click="seal">
          {{ shiftSealed ? `本班次已封存（${session.shiftLabel}）` : `封存本班次（${session.shiftLabel}）` }}
        </button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <p v-if="actionMessage" :class="actionOk ? 'ok-text' : 'error-text'">{{ actionMessage }}</p>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="sealed-title">已封存班次（冻结快照，只读）</h3>
    <table class="data-table" v-if="sealed.length">
      <thead>
        <tr><th>班次</th><th>封存时间</th><th>操作人</th><th>登记总量</th><th>待处理</th><th>异常量</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="shift in sealed" :key="shift.id">
          <td>{{ shift.shiftLabel }}</td>
          <td>{{ formatTime(shift.sealedAt) }}</td>
          <td>{{ shift.operator }}</td>
          <td>{{ shift.overview.cards[1]?.value ?? 0 }}</td>
          <td>{{ shift.overview.cards[2]?.value ?? 0 }}</td>
          <td>{{ shift.overview.cards[3]?.value ?? 0 }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="exportShift(shift.id)">导出封存快照</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">还没有封存班次；封存后会冻结一份完整的逐模块明细与汇总快照。</p>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadSealedShift,
  loadOverview,
  sealCurrentShift,
  sealedShifts,
} from '@/api/local-service'
import { onStorageChange } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { OverviewResult } from '@/data/types'

const session = useSessionStore()
const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const sealed = ref(sealedShifts())
const actionMessage = ref('')
const actionOk = ref(true)

const shiftSealed = computed(() =>
  sealed.value.some((shift) => shift.shiftLabel === session.shiftLabel),
)

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  sealed.value = sealedShifts()
}

function seal() {
  const result = sealCurrentShift({
    shiftLabel: session.shiftLabel,
    operator: session.operator,
  })
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    refresh()
  }
}

function exportShift(id: string) {
  try {
    downloadSealedShift(id)
  } catch (error) {
    actionOk.value = false
    actionMessage.value = error instanceof Error ? error.message : '封存快照导出失败'
  }
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

// 另一个终端（浏览器标签页）写入或封存后，本页立即放弃缓存重新取数。
const off = onStorageChange(() => refresh())

onMounted(refresh)
onUnmounted(off)
</script>

<style scoped>
.sealed-title { margin: 20px 0 8px; font-size: 15px; }
.ok-text { color: #1a7f37; }
</style>
