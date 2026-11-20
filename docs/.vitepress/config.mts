import { defineConfig } from 'vitepress'
import { topics as books } from './topics'

const siteUrl = 'https://learning.yxuefeng.com'

const goGuideChapters = [
  { text: '前言', link: '/books/go-guide/' },
  { text: '第 1 章 设置 Go 环境', link: '/books/go-guide/chapter-01' },
  { text: '第 2 章 基础类型和变量声明', link: '/books/go-guide/chapter-02' },
  { text: '第 3 章 复合类型', link: '/books/go-guide/chapter-03' },
  { text: '第 4 章 代码块、变量隐藏和控制结构', link: '/books/go-guide/chapter-04' },
  { text: '第 5 章 函数', link: '/books/go-guide/chapter-05' },
  { text: '第 6 章 指针', link: '/books/go-guide/chapter-06' },
  { text: '第 7 章 类型、方法和接口', link: '/books/go-guide/chapter-07' },
  { text: '第 8 章 泛型', link: '/books/go-guide/chapter-08' },
  { text: '第 9 章 错误处理', link: '/books/go-guide/chapter-09' },
  { text: '第 10 章 模块、包和导入', link: '/books/go-guide/chapter-10' },
  { text: '第 11 章 Go 工具集', link: '/books/go-guide/chapter-11' },
  { text: '第 12 章 Go 中的并发性', link: '/books/go-guide/chapter-12' },
  { text: '第 13 章 标准库', link: '/books/go-guide/chapter-13' },
  { text: '第 14 章 context', link: '/books/go-guide/chapter-14' },
  { text: '第 15 章 编写测试', link: '/books/go-guide/chapter-15' },
  { text: '第 16 章 恶龙禁区：反射、unsafe 和 cgo', link: '/books/go-guide/chapter-16' },
]

const goConcurrencyChapters = [
  { text: '前言与章节导航', link: '/books/go-concurrency/' },
  { text: '第 1 章 并发概述', link: '/books/go-concurrency/chapter-01' },
  { text: '第 2 章 对代码建模：通信顺序进程', link: '/books/go-concurrency/chapter-02' },
  { text: '第 3 章 Go 语言并发组件', link: '/books/go-concurrency/chapter-03' },
  { text: '第 4 章 Go 语言的并发模式', link: '/books/go-concurrency/chapter-04' },
  { text: '第 5 章 大规模并发', link: '/books/go-concurrency/chapter-05' },
  { text: '第 6 章 goroutine 和 Go 语言运行时', link: '/books/go-concurrency/chapter-06' },
  { text: '附录 A 并发诊断与测试', link: '/books/go-concurrency/appendix-a' },
]

const systemChapters = [
  { text: '前言与章节导航', link: '/books/system/' },
  { text: '第 1 章 硬件基础、CPU 执行与缓存架构', link: '/books/system/chapter-01' },
  { text: '第 2 章 操作系统内核、中断与系统调用', link: '/books/system/chapter-02' },
  { text: '第 3 章 内存管理与页面回收', link: '/books/system/chapter-03' },
  { text: '第 4 章 进程、线程与 CPU 调度', link: '/books/system/chapter-04' },
  { text: '第 5 章 进程间通信与并发同步', link: '/books/system/chapter-05' },
  { text: '第 6 章 文件系统与存储 I/O', link: '/books/system/chapter-06' },
  { text: '第 7 章 网络协议栈、零拷贝与高性能网络模型', link: '/books/system/chapter-07' },
  { text: '第 8 章 Linux 系统观测、性能排查与实战命令', link: '/books/system/chapter-08' },
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
      '/books/go-concurrency/': [
        {
          text: 'Go 语言并发之道',
          items: goConcurrencyChapters,
        },
      ],
      '/books/go-guide/': [
        {
          text: 'Go 语言学习指南',
          items: goGuideChapters,
        },
      ],
      '/books/system/': [
        {
          text: '图解系统',
          items: systemChapters,
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
    outline: { level: 2, label: '目录' },
    footer: {
      message: '持续学习，持续输出。',
      copyright: 'Copyright © 2026 技术学习笔记',
    },
  },
})
