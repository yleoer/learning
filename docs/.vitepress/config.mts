import { defineConfig } from 'vitepress'
import { topics as books } from './topics'

const siteUrl = 'https://learning.yxuefeng.com'

const goGuideSidebar = [
  {
    text: 'Go 语言学习指南',
    items: [
      { text: '导读与速查索引', link: '/books/go-guide/' },
    ],
  },
  {
    text: '一、上手与基础语法',
    items: [
      { text: '第 1 章 环境与快速上手', link: '/books/go-guide/chapter-01' },
      { text: '第 2 章 基础类型、常量与变量', link: '/books/go-guide/chapter-02' },
      { text: '第 3 章 数组、切片、映射与结构体', link: '/books/go-guide/chapter-03' },
      { text: '第 4 章 作用域与控制结构', link: '/books/go-guide/chapter-04' },
    ],
  },
  {
    text: '二、函数与类型抽象',
    items: [
      { text: '第 5 章 函数、闭包与 defer', link: '/books/go-guide/chapter-05' },
      { text: '第 6 章 指针与值传递', link: '/books/go-guide/chapter-06' },
      { text: '第 7 章 自定义类型、方法与组合', link: '/books/go-guide/chapter-07' },
      { text: '第 8 章 接口与解耦设计', link: '/books/go-guide/chapter-08' },
      { text: '第 9 章 泛型', link: '/books/go-guide/chapter-09' },
    ],
  },
  {
    text: '三、错误与工程工具',
    items: [
      { text: '第 10 章 错误处理与 panic', link: '/books/go-guide/chapter-10' },
      { text: '第 11 章 模块、包与依赖管理', link: '/books/go-guide/chapter-11' },
      { text: '第 12 章 构建、生成与静态检查', link: '/books/go-guide/chapter-12' },
    ],
  },
  {
    text: '四、并发与核心标准库',
    items: [
      { text: '第 13 章 Goroutine、通道与同步', link: '/books/go-guide/chapter-13' },
      { text: '第 14 章 context 取消与超时', link: '/books/go-guide/chapter-14' },
      { text: '第 15 章 I/O、文件与时间', link: '/books/go-guide/chapter-15' },
      { text: '第 16 章 JSON、HTTP 与日志', link: '/books/go-guide/chapter-16' },
    ],
  },
  {
    text: '五、测试、运行时与底层',
    items: [
      { text: '第 17 章 测试、模糊测试与基准', link: '/books/go-guide/chapter-17' },
      { text: '第 18 章 内存、逃逸分析与 GC', link: '/books/go-guide/chapter-18' },
      { text: '第 19 章 反射、unsafe 与 cgo', link: '/books/go-guide/chapter-19' },
    ],
  },
]

const goConcurrencySidebar = [
  {
    text: 'Go 语言并发之道',
    items: [
      { text: '导读与速查索引', link: '/books/go-concurrency/' },
    ],
  },
  {
    text: '一、理论基石与进阶原语',
    items: [
      { text: '第 1 章 并发缺陷、内存模型与 CSP 建模', link: '/books/go-concurrency/chapter-01' },
      { text: '第 2 章 进阶同步原语与通道所有权', link: '/books/go-concurrency/chapter-02' },
    ],
  },
  {
    text: '二、通道编排与系统治理',
    items: [
      { text: '第 3 章 词法约束、流水线与通道组合子', link: '/books/go-concurrency/chapter-03' },
      { text: '第 4 章 大规模并发系统的容错与治理', link: '/books/go-concurrency/chapter-04' },
    ],
  },
  {
    text: '三、运行时调度与诊断',
    items: [
      { text: '第 5 章 GMP 调度器与并发性能诊断', link: '/books/go-concurrency/chapter-05' },
    ],
  },
]

const mysqlSidebar = [
  {
    text: 'MySQL 是怎样运行的',
    items: [
      { text: '导读与速查索引', link: '/books/mysql/' },
    ],
  },
  {
    text: '一、架构、存储与缓冲管理',
    items: [
      { text: '第 1 章 体系架构、配置变量与字符集链路', link: '/books/mysql/chapter-01' },
      { text: '第 2 章 InnoDB 行格式与数据页结构', link: '/books/mysql/chapter-02' },
      { text: '第 3 章 数据目录、表空间与 Buffer Pool', link: '/books/mysql/chapter-03' },
    ],
  },
  {
    text: '二、索引原理与查询优化',
    items: [
      { text: '第 4 章 B+ 树索引原理与高效设计规范', link: '/books/mysql/chapter-04' },
      { text: '第 5 章 单表访问方法、连接原理与 Hash Join', link: '/books/mysql/chapter-05' },
      { text: '第 6 章 统计信息、成本模型与查询重写优化', link: '/books/mysql/chapter-06' },
      { text: '第 7 章 执行计划（EXPLAIN / ANALYZE）与优化追踪', link: '/books/mysql/chapter-07' },
    ],
  },
  {
    text: '三、事务、日志、MVCC 与锁',
    items: [
      { text: '第 8 章 事务机制、Redo 日志与 Undo 日志', link: '/books/mysql/chapter-08' },
      { text: '第 9 章 事务隔离级别与 MVCC 多版本并发控制', link: '/books/mysql/chapter-09' },
      { text: '第 10 章 InnoDB 锁机制、加锁规则与死锁诊断', link: '/books/mysql/chapter-10' },
    ],
  },
]

const redisSidebar = [
  {
    text: 'Redis 核心技术与实战',
    items: [
      { text: '导读与速查索引', link: '/books/redis/' },
    ],
  },
  {
    text: '一、核心架构、数据结构与持久化',
    items: [
      { text: '第 1 章 体系架构、RESP 协议与事件驱动 I/O 模型', link: '/books/redis/chapter-01' },
      { text: '第 2 章 底层数据结构、对象编码与扩展数据类型', link: '/books/redis/chapter-02' },
      { text: '第 3 章 AOF 多文件日志、RDB 快照与混合持久化', link: '/books/redis/chapter-03' },
    ],
  },
  {
    text: '二、高性能调优、内存治理与高可用集群',
    items: [
      { text: '第 4 章 阻塞治理、内存碎片、缓冲区与延迟诊断全景', link: '/books/redis/chapter-04' },
      { text: '第 5 章 主从复制、哨兵高可用与脑裂防护', link: '/books/redis/chapter-05' },
      { text: '第 6 章 切片集群（Redis Cluster）、数据倾斜与大容量演进', link: '/books/redis/chapter-06' },
    ],
  },
  {
    text: '三、缓存架构、并发控制与场景实战',
    items: [
      { text: '第 7 章 缓存读写模式、淘汰算法（LRU / LFU）与异常治理', link: '/books/redis/chapter-07' },
      { text: '第 8 章 原子操作、分布式锁、事务 ACID 与高并发秒杀实战', link: '/books/redis/chapter-08' },
    ],
  },
]

const architectureSidebar = [
  {
    text: '凤凰架构：分布式与云原生系统',
    items: [
      { text: '导读与速查索引', link: '/books/architecture/' },
    ],
  },
  {
    text: '一、架构演进、通信契约与数据一致性',
    items: [
      { text: '第 1 章 架构演进史、微服务边界与模块化单体方法论', link: '/books/architecture/chapter-01' },
      { text: '第 2 章 远程服务调用（RPC）与 REST / GraphQL 契约设计', link: '/books/architecture/chapter-02' },
      { text: '第 3 章 分布式事务（2PC / TCC / SAGA）与共识算法（Paxos / Raft）', link: '/books/architecture/chapter-03' },
    ],
  },
  {
    text: '二、多级分流、流量治理、安全与可观测性',
    items: [
      { text: '第 4 章 透明多级分流：HTTP/3、CDN、四七层均衡与多级缓存', link: '/books/architecture/chapter-04' },
      { text: '第 5 章 服务发现、网关路由、容错隔离与自适应限流', link: '/books/architecture/chapter-05' },
      { text: '第 6 章 认证授权（OAuth 2.1）、传输密码学（TLS 1.3）与零信任架构', link: '/books/architecture/chapter-06' },
      { text: '第 7 章 可观测性体系：OpenTelemetry、日志、链路追踪与聚合度量', link: '/books/architecture/chapter-07' },
    ],
  },
  {
    text: '三、云原生不可变基础设施与服务网格',
    items: [
      { text: '第 8 章 容器隔离原语（cgroups v2）、CRI 运行时与 Kubernetes 调度模型', link: '/books/architecture/chapter-08' },
      { text: '第 9 章 容器网络（CNI / eBPF）、持久化存储（CSI）与无边车服务网格', link: '/books/architecture/chapter-09' },
    ],
  },
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
      '/books/go-guide/': goGuideSidebar,
      '/books/go-concurrency/': goConcurrencySidebar,
      '/books/mysql/': mysqlSidebar,
      '/books/redis/': redisSidebar,
      '/books/architecture/': architectureSidebar,
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
