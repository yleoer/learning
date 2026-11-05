import { createContentLoader } from 'vitepress'
import { topics } from './topics'

interface Chapter {
  title: string
  url: string
}

export interface TopicStatus {
  text: string
  link: string
  chapters: Chapter[]
}

declare const data: TopicStatus[]
export { data }

export default createContentLoader('books/**/*.md', {
  transform(pages): TopicStatus[] {
    return topics.map((topic) => ({
      ...topic,
      chapters: pages
        .filter((page) => page.url.startsWith(topic.link) && page.url !== topic.link)
        .sort((a, b) => a.url.localeCompare(b.url, 'en', { numeric: true }))
        .map((page) => ({ title: page.frontmatter.title, url: page.url })),
    }))
  },
})
