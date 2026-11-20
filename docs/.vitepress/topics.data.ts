import { createContentLoader } from 'vitepress'
import { topics } from './topics'

interface Chapter {
  title: string
  url: string
}

export interface TopicStatus {
  text: string
  fullTitle: string
  link: string
  group: string
  baseline: string
  summary: string
  chapters: Chapter[]
}

interface TopicMeta {
  fullTitle: string
  group: string
  baseline: string
  summary: string
}

const topicMetaMap: Record<string, TopicMeta> = {
  '/books/go-guide/': {
    fullTitle: 'Go 语言学习指南',
    group: '语言与并发',
    baseline: 'Go 1.27.4',
    summary: '从语法、类型与接口泛型，到工程工具链、并发、核心标准库、测试与运行时底层。',
  },
  '/books/go-concurrency/': {
    fullTitle: 'Go 语言并发之道',
    group: '语言与并发',
    baseline: 'Go 1.27.4',
    summary: '聚焦内存模型、通道所有权、有界流水线编排、大规模容错治理与 GMP 调度诊断。',
  },
  '/books/mysql/': {
    fullTitle: 'MySQL 是怎样运行的',
    group: '数据与存储',
    baseline: 'MySQL 8.4 LTS',
    summary: '拆解 InnoDB 行页结构、Buffer Pool、B+ 树索引、执行计划、Redo/Undo、MVCC 与锁。',
  },
  '/books/redis/': {
    fullTitle: 'Redis 核心技术与实战',
    group: '数据与存储',
    baseline: 'Redis 8.10',
    summary: '涵盖 RESP/ACL 与多线程 I/O、底层编码、持久化、延迟诊断、哨兵集群、缓存治理与秒杀实战。',
  },
  '/books/system/': {
    fullTitle: '图解系统',
    group: '系统、网络与架构',
    baseline: 'Linux 6.12 LTS',
    summary: '自底向上打通 CPU 缓存一致性、中断与虚拟内存、EEVDF 调度、Ext4/io_uring 与排障工具链。',
  },
  '/books/network/': {
    fullTitle: '图解网络',
    group: '系统、网络与架构',
    baseline: 'RFC 9110–9846 · Linux 6.12',
    summary: '沿请求路径梳理分层协议栈、IP/ICMP、TCP 状态机与拥塞控制、HTTP/3/QUIC、TLS 1.3 与抓包排障。',
  },
  '/books/architecture/': {
    fullTitle: '凤凰架构：分布式与云原生系统',
    group: '系统、网络与架构',
    baseline: 'RFC 9700 · K8s 1.32+',
    summary: '覆盖架构演进、RPC 契约、分布式事务与共识、多级分流、限流安全、可观测性与容器网格。',
  },
}

declare const data: TopicStatus[]
export { data }

export default createContentLoader('books/**/*.md', {
  transform(pages): TopicStatus[] {
    return topics.map((topic) => {
      const indexPage = pages.find((page) => page.url === topic.link)
      const meta = topicMetaMap[topic.link]
      return {
        ...topic,
        fullTitle: meta?.fullTitle ?? topic.text,
        group: meta?.group ?? '其他专题',
        baseline: meta?.baseline ?? '',
        summary: meta?.summary ?? indexPage?.frontmatter?.description ?? '',
        chapters: pages
          .filter((page) => page.url.startsWith(topic.link) && page.url !== topic.link)
          .sort((a, b) => a.url.localeCompare(b.url, 'en', { numeric: true }))
          .map((page) => ({ title: page.frontmatter.title, url: page.url })),
      }
    })
  },
})
