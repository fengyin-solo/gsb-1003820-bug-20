<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。已作废记录不再计入待处理与异常量。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="sealing" @click="seal">
          {{ sealing ? '正在封存…' : `封存当前班次（${store.shiftLabel}）` }}
        </button>
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>

    <p v-if="sealMessage" :class="sealOk ? 'ok-text' : 'error-text'" class="seal-message">{{ sealMessage }}</p>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th><th>已作废</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
          <td>{{ row.voided }}</td>
        </tr>
      </tbody>
    </table>

    <section class="sealed-list">
      <h3>已封存班次（快照只读，不随后续口径变化）</h3>
      <p v-if="!seals.length" class="empty-state">还没有封存记录</p>
      <article v-for="seal in seals" :key="seal.shiftId" class="seal-card">
        <header class="seal-head">
          <strong>{{ seal.shiftLabel }}</strong>
          <span>{{ seal.operator }} · {{ formatTime(seal.sealedAt) }}</span>
        </header>
        <table class="data-table">
          <thead>
            <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th><th>已作废</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in seal.modules" :key="row.key">
              <td>{{ row.name }}</td>
              <td>{{ row.created }}</td>
              <td>{{ row.pending }}</td>
              <td>{{ row.abnormal }}</td>
              <td>{{ row.voided }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { listSealedShifts, loadOverview, sealCurrentShift } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { OverviewResult, ShiftSeal } from '@/data/types'

const store = useSessionStore()
const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const seals = ref<ShiftSeal[]>([])
const sealing = ref(false)
const sealMessage = ref('')
const sealOk = ref(false)

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  seals.value = listSealedShifts()
}

function shiftId(): string {
  // 班次标签 + 日期作为业务班次号：同一天同一班次只允许封存一次。
  const today = new Date().toISOString().slice(0, 10)
  return `${today}-${store.shiftLabel}`
}

async function seal() {
  if (sealing.value) {
    return
  }
  sealing.value = true
  sealMessage.value = ''
  try {
    const result = await sealCurrentShift({
      shiftId: shiftId(),
      shiftLabel: store.shiftLabel,
      operator: store.operator,
    })
    sealOk.value = result.ok
    sealMessage.value = result.message
  } finally {
    sealing.value = false
    refresh()
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

onMounted(refresh)
</script>
