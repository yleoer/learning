<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import ChapterOutline from './ChapterOutline.vue'
import HomeTopics from './HomeTopics.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #aside-outline-before><ChapterOutline /></template>
    <template #home-hero-after><HomeTopics /></template>
  </Layout>
</template>
