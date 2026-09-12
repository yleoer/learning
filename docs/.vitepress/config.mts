import { defineConfig } from 'vitepress'

const siteUrl = 'https://learning.yxuefeng.com'

const books = [
  { text: 'Go 语言', link: '/books/go-guide/' },
  { text: 'Go 并发', link: '/books/go-concurrency/' },
  { text: 'MySQL', link: '/books/mysql/' },
  { text: 'Redis', link: '/books/redis/' },
  { text: '架构', link: '/books/architecture/' },
  { text: '图解系统', link: '/books/system/' },
  { text: '图解网络', link: '/books/network/' },
]

const goGuideChapters = [
  { text: '前言', link: '/books/go-guide/' },
  { text: '第 1 章 设置你的 Go 环境', link: '/books/go-guide/chapter-01' },
  { text: '第 2 章 基础类型和变量声明', link: '/books/go-guide/chapter-02' },
  { text: '第 3 章 复合类型', link: '/books/go-guide/chapter-03' },
]

function tokenizeSearchText(text: string): string[] {
  const terms: string[] = []
  const cjkPattern = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/u
  const segments = text.toLocaleLowerCase().match(
    /[a-z0-9_]+|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+|[^\s\p{P}]/gu,
  ) ?? []

  for (const segment of segments) {
    if (!cjkPattern.test(segment)) {
      terms.push(segment)
      continue
    }

    const characters = Array.from(segment)
    terms.push(...characters)
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.push(characters.slice(index, index + 2).join(''))
    }
  }

  return terms
}

function canonicalPath(page: string): string {
  if (page === 'index.md') return '/'
  if (page.endsWith('/index.md')) return `/${page.slice(0, -'/index.md'.length)}/`
  return `/${page.replace(/\.md$/, '')}`
}

function pageCategory(page: string): 'article' | 'website' {
  return page.includes('/chapter-') ? 'article' : 'website'
}

export default defineConfig({
  lang: 'zh-CN',
  title: '技术学习笔记',
  description: '记录原文、思考、实践与问答，让知识变成可以复习的系统。',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.loli.net/css2?family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&display=swap',
      },
    ],
  ],
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: siteUrl },
  transformHead({ page, title, description }) {
    const url = new URL(canonicalPath(page), siteUrl).href
    const tags = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: pageCategory(page) }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:image', content: `${siteUrl}/logo.svg` }],
      ['meta', { property: 'og:image:alt', content: '技术学习笔记' }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: `${siteUrl}/logo.svg` }],
    ] as [string, Record<string, string>][]

    if (page === '404.md') {
      tags.push(['meta', { name: 'robots', content: 'noindex' }])
    }

    return tags
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: '技术学习笔记',
    nav: [
      { text: '首页', link: '/' },
      ...books,
    ],
    sidebar: {
      '/books/go-guide/': [
        {
          text: 'Go 语言学习指南',
          items: goGuideChapters,
        },
      ],
      '/books/': [
        {
          text: '书籍与专题',
          items: books,
        },
      ],
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            displayDetails: '显示详细结果',
            resetButtonTitle: '清空搜索',
            backButtonTitle: '返回搜索',
            noResultsText: '未找到',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车键',
              navigateText: '导航',
              navigateUpKeyAriaLabel: '向上箭头',
              navigateDownKeyAriaLabel: '向下箭头',
              closeText: '关闭',
              closeKeyAriaLabel: '退出键',
            },
          },
        },
        miniSearch: {
          options: { tokenize: tokenizeSearchText },
          searchOptions: {
            prefix: true,
            fuzzy: 0.2,
            combineWith: 'AND',
            boost: { title: 4, text: 2, titles: 1 },
          },
        },
      },
    },
    lastUpdated: {
      text: '最后更新',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short', forceLocale: true },
    },
    docFooter: { prev: '上一页', next: '下一页' },
    notFound: {
      code: '404',
      title: '页面不存在',
      quote: '你访问的页面不存在，可能已被移动或尚未发布。',
      linkLabel: '返回首页',
      linkText: '返回首页',
    },
    skipToContentLabel: '跳转到正文',
    sidebarMenuLabel: '打开侧边栏',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '切换主题',
    lightModeSwitchTitle: '切换到浅色主题',
    darkModeSwitchTitle: '切换到深色主题',
    outline: { level: [2, 3], label: '目录' },
    footer: {
      message: '持续学习，持续输出。',
      copyright: 'Copyright © 2026 技术学习笔记',
    },
  },
})
