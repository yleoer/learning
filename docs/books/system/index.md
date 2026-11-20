---
title: 图解系统
description: 以《图解系统》为主线，结合 Linux 6.12 LTS 与现代硬件架构，重组并精简梳理 CPU 缓存、内核中断、虚拟内存、EEVDF 调度、并发同步、Ext4/blk-mq、零拷贝/io_uring 与线上排障体系。
---

# 图解系统

本指南以小林 coding 的《图解系统》（v1.0）为主线，结合 **Linux 6.12 LTS** 内核实现、现代 x86-64/ARM64 硬件体系与 POSIX 规范，对原书 11 章内容进行了系统性的**去重、精简、勘误与现代知识重组**。整理的目标不是复刻公众号合集的零散章节与生活段子，而是消除跨章重复（如存储金字塔、调度算法、信号量与 I/O 模型的多处反复），把硬件执行、操作系统内核、存储网络栈与线上排障串成一套自底向上、可直接查证和自测的知识体系。

全专题围绕四个核心工程问题展开：**硬件微架构如何约束程序性能、内核如何隔离并调度有限的 CPU 与内存资源、数据如何穿过存储与网络协议栈、线上系统异常如何顺着内核指标定位根因**。

## 章节导航

原书第 1–9 章的核心技术知识经去重与重新归类后，重组为以下 8 章（原书第 10 章开头的高质量 TCP 全连接队列溢出排障案例已并入第 8 章，其余自媒体书单与第 11 章画图经验已精简移除）：

| 章节 | 核心问题 | 整合原书来源 |
| --- | --- | --- |
| [第 1 章 硬件基础、CPU 执行与缓存架构](./chapter-01) | CPU 如何执行指令？缓存局部性、分支预测、MESI 一致性与伪共享如何决定性能？为什么 `0.1 + 0.2 != 0.3`？ | 1.1–1.4、1.5（前半）、1.7 |
| [第 2 章 操作系统内核、中断与系统调用](./chapter-02) | 内核如何隔离用户态与内核态？`syscall`/`sysret`、vDSO、硬中断与 Linux 软中断如何协作？ | 2.1、1.6（机制）、7.1（中断） |
| [第 3 章 内存管理与页面回收](./chapter-03) | 虚拟内存如何通过多级页表、TLB、大页、COW 与 MGLRU 实现安全隔离与高效复用？ | 3.1、5.1（缺页与页面置换） |
| [第 4 章 进程、线程与 CPU 调度](./chapter-04) | 进程与线程底层有何差异？经典调度如何演进至 Linux 6.6+ 默认的 EEVDF 与 `sched_ext`？ | 4.1、1.5（后半）、5.1（进程调度） |
| [第 5 章 进程间通信与并发同步](./chapter-05) | 进程间如何通信？多线程如何借助 `futex` 互斥锁、自旋锁、读写锁、RCU、条件变量与乐观锁避免竞态与死锁？ | 4.2–4.5 |
| [第 6 章 文件系统与存储 I/O](./chapter-06) | 数据如何穿过 VFS、Ext4、PageCache、通用块层与 DMA 落盘？NVMe `blk-mq` 与 `io_uring` 改变了什么？ | 6.1、7.1（设备与块层）、5.1（磁盘调度） |
| [第 7 章 网络协议栈、零拷贝与高性能网络模型](./chapter-07) | 网络包如何在协议栈与 `sk_buff` 中流转？`sendfile`/kTLS、`epoll`、Reactor 与 `io_uring` Proactor 如何支撑高并发？ | 8.1–8.4 |
| [第 8 章 Linux 系统观测、性能排查与实战命令](./chapter-08) | 面对软中断飙高、多线程死锁、TCP 全连接队列溢出与海量日志，如何用现代 Linux 工具链快速定因？ | 9.1–9.2、1.6/4.4/10 实战案例 |

## 版本基线与现代演进对照 {#version-policy}

原书 v1.0 整理自 2020 年前后的公众号文章。过去数年间，Linux 内核（6.x）、现代硬件（NVMe SSD、多核 Mesh 互联）与主流基础软件（Redis、Nginx、Go/Java 运行时）都发生了显著演进，原书部分表述亦存在历史局限或概念偏差。本指南以 **Linux 6.12 LTS** 及现代 x86-64/ARM64 为核对基线，汇总关键勘误与现代化更新如下：

| 原书 v1.0 内容或历史背景 | 本指南的校准与现代写法 |
| --- | --- |
| “64 位软件代表指令占 64 位”“PC 自增由 CPU 位宽决定” | 明确硬件位宽与 64 位 ABI（LP64/LLP64）的区别，纠正指令长度认知（ARM64 定长 4 B，x86-64 变长 1–15 B），见[第 1 章](./chapter-01#ch1-1-3) |
| 将排序后分支变快归因于“把指令缓存到 iCache” | 纠偏为**动态分支预测减少流水线冲刷**，阐明 `likely`/`unlikely` 编译期代码布局作用，见[第 1 章](./chapter-01#ch1-3-2) |
| 系统调用“内核处理完主动触发中断返回”、软中断“始终在 `ksoftirqd` 执行” | 校准为现代 `syscall`/`sysret` 与 vDSO，明确软中断优先在 `irq_exit()` 直接执行、超预算才交由 `ksoftirqd` 兜底，见[第 2 章](./chapter-02#ch2-3-2) |
| 分段“内部碎片”定义混淆，64 位仅介绍 4 级页表，缺失页面回收现代机制 | 纠偏内/外部碎片定义，补齐 **5 级页表（P4D）**、ASLR、大页（THP）、伙伴系统/SLUB、`malloc` 底层、COW 及 **Linux 6.1+ MGLRU / Folio**，见[第 3 章](./chapter-03#ch3-4-2) |
| 进程调度分散 3 处重复；Linux 默认调度器仅讲 CFS | 三合一去重，更新至 **Linux 6.6+ 默认 EEVDF 调度器**与 **Linux 6.12+ `sched_ext`**，衔接 Go GMP / Java 虚拟线程，见[第 4 章](./chapter-04#ch4-4-2) |
| 互斥锁隐含“每次加锁陷入内核”；缺失条件变量与 ABA | 剖析 Linux **`futex` 无竞争纯用户态快速路径**，补齐条件变量（虚假唤醒）、RCU、CAS ABA 问题与 `eventfd` 等现代 IPC，见[第 5 章](./chapter-05#ch5-2-2) |
| 文件系统止步 Ext2/3 略过 Ext4；列举已移除的旧单队列磁盘调度器（CFQ 等） | 补齐 **Ext4 Extent Tree / Journaling** 与三层打开文件结构，更新 **Linux 5.0+ `blk-mq`（已移除 CFQ）** 与 NVMe 调度策略，见[第 6 章](./chapter-06#ch6-3-2) |
| “Linux 异步 I/O 不完善，只能用 Reactor”；Redis 单进程、Nginx 依赖 `accept_mutex` | 更新原生高性能 **`io_uring`** 构成 Linux Proactor 底座，补充 **eBPF/XDP**、**kTLS 加密零拷贝**、Redis 6.0+ 多线程 I/O 与 Nginx `reuseport`，见[第 7 章](./chapter-07#ch7-4) |
| 并列讲解已停维的 `ifconfig`/`netstat`，日志分析沿用全量 `sort \| uniq` | 确立 `ip`/`ss`/`nstat`/`perf`/`bpftrace` 现代排障工具链，收拢软中断、死锁与全连接队列溢出三大实战闭环，并优化为单趟 `awk` 聚合，见[第 8 章](./chapter-08#ch8-4-2) |

## 阅读与自测约定

首次系统梳理建议从 [第 1 章](./chapter-01) 按自底向上的顺序阅读；若以面试复盘或线上排障为目标，也可按专题直达[缓存一致性与伪共享](./chapter-01#ch1-4)、[页表与页面回收](./chapter-03#ch3-4)、[EEVDF 调度](./chapter-04#ch4-4)、[`futex` 与并发同步](./chapter-05#ch5-2)、[`epoll` 与高性能网络](./chapter-07#ch7-3)或[线上排障实战](./chapter-08#ch8-2)。

每章均遵循“本章要点 → 机制推导与校准 → 练习 → 面试题 → 参考资料”结构，所有参考答案默认折叠，建议先独立完成推导再展开核对。

## 延伸参考资料

- [Linux Kernel Official Documentation](https://docs.kernel.org/)
- [Linux man-pages project (man7.org)](https://man7.org/linux/man-pages/)
- [Operating Systems: Three Easy Pieces (OSTEP, 免费在线版)](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Intel 64 and IA-32 Architectures Software Developer Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
- [Brendan Gregg's Linux Performance Resources](https://www.brendangregg.com/linuxperf.html)
