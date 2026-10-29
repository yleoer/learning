<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'
import { data } from '../topics.data'

const available = computed(() => data.filter((topic) => topic.chapters.length > 0))
const planned = computed(() => data.filter((topic) => topic.chapters.length === 0))
</script>

<template>
  <section class="home-topics" aria-label="专题内容状态">
    <div class="home-topics-inner">
      <div v-if="available.length" class="available-topics">
        <h2>可阅读的专题</h2>
        <div v-for="topic in available" :key="topic.link" class="available-topic">
          <div class="topic-heading">
            <a :href="withBase(topic.link)">{{ topic.text }}</a>
            <span class="topic-status">已发布 {{ topic.chapters.length }} 章</span>
          </div>
          <p>
            最新章节：
            <a :href="withBase(topic.chapters[topic.chapters.length - 1].url)">
              {{ topic.chapters[topic.chapters.length - 1].title }}
            </a>
          </p>
        </div>
      </div>
      <div v-if="planned.length" class="planned-topics">
        <h2>待整理的专题</h2>
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
