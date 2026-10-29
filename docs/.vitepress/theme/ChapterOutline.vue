<script setup lang="ts">
import { getScrollOffset, onContentUpdated, useData } from 'vitepress'
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'

interface Heading {
  id: string
  title: string
  element: HTMLElement
  children: Heading[]
}

const { frontmatter } = useData()
const sections = shallowRef<Heading[]>([])
const activeId = ref('')
const activeSection = ref('')
const expandedSection = ref('')
let frame = 0

function updateActive() {
  frame = 0
  const headings = sections.value.flatMap((section) => [section, ...section.children])
  const offset = getScrollOffset() + 8
  let active = headings[0]

  for (const heading of headings) {
    if (heading.element.getBoundingClientRect().top > offset) break
    active = heading
  }
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
    active = headings[headings.length - 1]
  }

  activeId.value = active?.id ?? ''
  const section = sections.value.find((item) =>
    item.id === activeId.value || item.children.some((child) => child.id === activeId.value),
  )?.id ?? ''
  if (activeSection.value !== section) {
    activeSection.value = section
    expandedSection.value = section
  }
}

function scheduleUpdate() {
  if (!frame) frame = requestAnimationFrame(updateActive)
}

onContentUpdated(() => {
  sections.value = []
  activeSection.value = ''
  expandedSection.value = ''
  if (frontmatter.value.outline === false) return

  const items: Heading[] = []
  document.querySelectorAll<HTMLElement>('.vp-doc h2[id], .vp-doc h3[id]').forEach((element) => {
    if (element.closest('details') || element.classList.contains('ignore-header')) return
    const title = Array.from(element.childNodes)
      .filter((node) => !(node instanceof Element && node.matches('.header-anchor, .VPBadge')))
      .map((node) => node.textContent)
      .join('').trim()
    const heading: Heading = { id: element.id, title, element, children: [] }
    if (element.tagName === 'H2') items.push(heading)
    else items[items.length - 1]?.children.push(heading)
  })
  sections.value = items
  scheduleUpdate()
})

onMounted(() => {
  window.addEventListener('scroll', scheduleUpdate, { passive: true })
  window.addEventListener('resize', scheduleUpdate)
})

onUnmounted(() => {
  window.removeEventListener('scroll', scheduleUpdate)
  window.removeEventListener('resize', scheduleUpdate)
  cancelAnimationFrame(frame)
})
</script>

<template>
  <nav v-if="sections.length" class="chapter-outline" aria-label="本页目录">
    <h2>目录</h2>
    <ul class="outline-sections">
      <li v-for="section in sections" :key="section.id">
        <div class="outline-row" :class="{ 'is-current': activeSection === section.id }">
          <a :href="`#${section.id}`" :aria-current="activeId === section.id ? 'location' : undefined">
            {{ section.title }}
          </a>
          <button
            v-if="section.children.length"
            type="button"
            :aria-label="`${expandedSection === section.id ? '收起' : '展开'}${section.title}的子目录`"
            :aria-expanded="expandedSection === section.id"
            :aria-controls="`outline-${section.id}`"
            @click="expandedSection = expandedSection === section.id ? '' : section.id"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
        </div>
        <ul
          v-if="section.children.length"
          v-show="expandedSection === section.id"
          :id="`outline-${section.id}`"
          class="outline-children"
        >
          <li v-for="child in section.children" :key="child.id">
            <a :href="`#${child.id}`" :aria-current="activeId === child.id ? 'location' : undefined">
              {{ child.title }}
            </a>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
