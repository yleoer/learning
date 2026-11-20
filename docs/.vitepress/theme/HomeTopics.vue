<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import { data, type TopicStatus } from '../topics.data'

interface TopicGroup {
  name: string
  items: TopicStatus[]
}

const groupOrder = ['语言与并发', '数据与存储', '系统、网络与架构']

const available = computed(() => data.filter((topic) => topic.chapters.length > 0))
const planned = computed(() => data.filter((topic) => topic.chapters.length === 0))

const totalChapters = computed(() =>
  available.value.reduce((sum, topic) => sum + topic.chapters.length, 0),
)

const groupedAvailable = computed<TopicGroup[]>(() => {
  const buckets = new Map<string, TopicStatus[]>()
  for (const topic of available.value) {
    const list = buckets.get(topic.group) ?? []
    list.push(topic)
    buckets.set(topic.group, list)
  }

  const orderedNames = [
    ...groupOrder.filter((name) => buckets.has(name)),
    ...Array.from(buckets.keys()).filter((name) => !groupOrder.includes(name)),
  ]

  return orderedNames.map((name) => ({
    name,
    items: buckets.get(name) ?? [],
  }))
})
</script>

<template>
  <section id="topics" class="home-topics" aria-label="专题书架">
    <div class="home-topics-inner">
      <div v-if="available.length" class="shelf-header">
        <div>
          <h2>专题书架</h2>
          <p class="shelf-subtitle">
            全部专题按知识域归类，支持从导读速查直达或按章节系统通读。
          </p>
        </div>
        <p class="shelf-stats">
          共 <strong>{{ available.length }}</strong> 个专题 ·
          <strong>{{ totalChapters }}</strong> 章
        </p>
      </div>

      <div
        v-for="group in groupedAvailable"
        :key="group.name"
        class="shelf-group"
      >
        <h3 class="shelf-group-title">{{ group.name }}</h3>
        <div
          class="shelf-grid"
          :class="{ 'is-three-col': group.items.length >= 3 }"
        >
          <article
            v-for="topic in group.items"
            :key="topic.link"
            class="shelf-card"
          >
            <div class="shelf-card-head">
              <a class="shelf-card-title" :href="withBase(topic.link)">
                {{ topic.fullTitle }}
              </a>
              <span class="shelf-card-count">{{ topic.chapters.length }} 章</span>
            </div>
            <p class="shelf-card-summary">{{ topic.summary }}</p>
            <div class="shelf-card-foot">
              <span v-if="topic.baseline" class="shelf-card-baseline">
                {{ topic.baseline }}
              </span>
              <div class="shelf-card-links">
                <a :href="withBase(topic.link)">导读与索引</a>
                <a
                  v-if="topic.chapters[0]"
                  :href="withBase(topic.chapters[0].url)"
                >
                  第 1 章 →
                </a>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div v-if="planned.length" class="planned-topics">
        <h3>待整理的专题</h3>
        <p>暂未发布章节，以下入口可查看整理规划。</p>
        <ul>
          <li v-for="topic in planned" :key="topic.link">
            <a :href="withBase(topic.link)">{{ topic.text }}</a>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
