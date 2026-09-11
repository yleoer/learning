import { defineConfig } from 'vitepress'

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
  { text: '第1章 设置你的Go环境', link: '/books/go-guide/chapter-01' },
  { text: '第2章 基础类型和变量声明', link: '/books/go-guide/chapter-02' },
  { text: '第3章 复合类型', link: '/books/go-guide/chapter-03' },
]

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
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: '技术学习笔记',
    nav: [
      { text: '首页', link: '/' },
      { text: 'Go 语言', link: '/books/go-guide/' },
      { text: 'Go 并发', link: '/books/go-concurrency/' },
      { text: 'MySQL', link: '/books/mysql/' },
      { text: 'Redis', link: '/books/redis/' },
      { text: '架构', link: '/books/architecture/' },
      { text: '图解系统', link: '/books/system/' },
      { text: '图解网络', link: '/books/network/' },
    ],
    sidebar: {
      '/books/go-guide/': [
        {
          text: 'Go语言学习指南',
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
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '目录' },
    footer: {
      message: '持续学习，持续输出。',
      copyright: 'Copyright © 2026 技术学习笔记',
    },
  },
})
