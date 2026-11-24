---
title: 导读与速查索引
description: 基于 Linux 6.12 LTS 与现代 x86-64/ARM64 架构重组精简的硬件微架构、内核隔离、虚拟内存、EEVDF 调度、并发同步、存储网络 I/O 与线上排障全景指南。
---

# 图解系统：导读与速查索引

本指南以小林 coding《图解系统（v1.0）》的问题脉络为基础，结合 **Linux 6.12 LTS** 内核实现、现代 x86-64/ARM64 硬件体系与云原生生产实践，按**知识域与因果依赖**将原书零散的 11 章去重精炼为 **3 大模块、8 章**。整理中彻底剔除了公众号合集中的生活段子、跨章自我重复（如存储金字塔、调度算法、信号量与 I/O 模型的多处反复）及过时的旧内核结论，并与站内[《图解网络》](../network/)、[《Go 语言并发之道》](../go-concurrency/)、[《MySQL 是怎样运行的》](../mysql/)、[《Redis 核心技术与实战》](../redis/)、[《凤凰架构》](../architecture/)按“唯一主场、锚点互引”衔接成网。

## 版本基线与现代演进对照 {#version-policy}

原书 v1.0 整理自 2020 年前后的文章，多处机制停留在 Linux 2.6～4.x 或单队列机械盘时代。本指南统一对齐 **Linux 6.12 LTS** 与现代多核/NVMe/容器化环境，核心勘误与现代化升级汇总如下：

| 原书 v1.0 表述或历史局限 | 本指南校准与现代生产基线 |
| --- | --- |
| “64 位软件代表指令占 64 位”“PC 自增由 CPU 位宽决定”；分支变快归因于“指令缓存在 iCache” | 厘清硬件位宽、ISA 指令长度（ARM64 定长 4B，x86-64 变长 1–15B）与 64 位 ABI；纠偏为**动态分支预测减少流水线冲刷**及 `likely`/`unlikely` 编译期布局作用，见[第 1 章](./chapter-01#ch1-1-3) |
| 系统调用“内核主动触发中断返回”；软中断“始终在 `ksoftirqd` 执行”；缺失容器安全边界 | 校准为现代 `syscall`/`sysret`（及慢路径 `iret`）与常用时钟 **vDSO**；明确软中断优先在 `irq_exit()` 就地执行、每轮后检查时间/次数/`need_resched()` 才交 `ksoftirqd`；补齐容器 `/proc` 视图陷阱、**Capabilities** 与 **`seccomp-bpf`**，见[第 2 章](./chapter-02#ch2-3-2) |
| 分段“内部碎片”定义混淆；仅讲 4 级页表与旧置换算法；缺失大内存 `fork()` 隐患 | 纠偏内/外部碎片，补齐 **5 级页表（高低各 64 PiB）**、ASLR、Linux 6.12 THP 拆分映射边界、SLUB、`malloc` 双路径、大内存 `fork()` 页表拷贝与 **Overcommit/memcg `ENOMEM`（`vfork`/`posix_spawn`）**，升级至 **Linux 6.1+ MGLRU / Folio**，见[第 3 章](./chapter-03#ch3-4) |
| 进程调度分散 3 处重复；“杀父进程连带杀子进程”；默认调度器停留在 CFS | 三合一去重，区分孤儿/僵尸进程及同呈 `D` 态的 `TASK_UNINTERRUPTIBLE` 与 `TASK_KILLABLE`；升级至 **Linux 6.6+ 默认 EEVDF 调度器**、**Linux 6.12+ `sched_ext`** 及 cgroups v2 `cpu.max` 限流治理，见[第 4 章](./chapter-04#ch4-4-2) |
| 互斥锁隐含“每次加锁陷入内核”；信号量与锁多处重复；缺失条件变量与无锁陷阱 | 剖析 **`futex` 无竞争纯用户态快速路径**（区分 OS 线程锁与 Go 协程信号量）、`RWMutex` 真共享计数争用与 **RCU**、条件变量虚假唤醒、CAS **ABA vs 节点安全回收**及 `eventfd`/`signalfd`，见[第 5 章](./chapter-05#ch5-2-2) |
| 止步 Ext2/3 略过 Ext4；列举已移除的 CFQ 单队列调度；桌面键盘回显边缘铺垫 | 补齐 **Ext4 Extent Tree / Journaling**、容器 **OverlayFS（`copy_up` 边界）** 与三层打开文件表；校准 **Linux 3.13+ 引入、5.0+ 移除旧单队列层的 `blk-mq`**、`fdatasync` 刷盘/Flush 持久化与 **`io_uring`**，见[第 6 章](./chapter-06#ch6-2-2) |
| RX Ring Buffer“整包拷贝到 `sk_buff`”；“Linux 无高性能异步 I/O，只能用 Reactor” | 校准 DMA 直写内存页、NAPI 批量上交并在收空队列后重开中断、TCP `skb_clone()` 零载荷拷贝；厘清软件/硬件卸载 **kTLS**、`SO_REUSEPORT`（含 `tcp_migrate_req`）、Redis 多线程 I/O 与 **`io_uring` 原生 Proactor**，见[第 7 章](./chapter-07#ch7-1-2) |
| 混用已停维的 `ifconfig`/`netstat`；日志统计依赖全量 `sort \| uniq`；缺容器限额排查 | 统一 `ip`/`ss`/`nstat`/`iostat`/`perf`/`bpftrace` 工具链，对齐 `ss -tin`（`snd_wnd`/`notsent`）真实字段与 `gcore` STW 风险，补齐 **cgroup v2 + PSI 内存压力证据链**与可控基数单趟 `awk` 聚合，见[第 8 章](./chapter-08#ch8-3) |

## 三大模块与八章路线 {#roadmap}

| 模块 | 覆盖章节 | 核心解决的工程问题 |
| --- | --- | --- |
| **一、硬件微架构与内核基石** | [第 1 章](./chapter-01)～[第 2 章](./chapter-02) | 理解指令流水线、CPI 性能公式、Cache Line 组相联映射、分支预测冲刷、MESI/MOESI/目录协议、伪共享填充与 IEEE 754 精度边界；打通 Ring/EL 特权级、`syscall`/vDSO、`irq_exit()` 软中断循环条件、eBPF Verifier 及容器 Namespace/cgroups/`seccomp-bpf` 隔离底座 |
| **二、内存、调度与并发同步** | [第 3 章](./chapter-03)～[第 5 章](./chapter-05) | 掌握 4/5 级页表、TLB/PCID/Shootdown、THP 边界、伙伴系统/SLUB、`malloc` 延迟分配、COW/Overcommit 与 MGLRU/OOM 回收；厘清 `task_struct`、`D`/`Z` 状态、1:1 vs M:N 模型、EEVDF 虚拟截止期调度与 CPU Throttling；吃透 IPC 选型、`futex`、RCU、条件变量、ABA/延迟回收与死锁破环 |
| **三、存储栈、网络 I/O 与生产排障** | [第 6 章](./chapter-06)～[第 8 章](./chapter-08) | 串联 VFS 三层文件表、Ext4/XFS/OverlayFS、NVMe `blk-mq`、`fdatasync` 持久化与 `io_uring`；剖析内核 `sk_buff`/NAPI/XDP 收发主干、`sendfile`/kTLS 零拷贝、`epoll` ET/惊群与 Reactor/Proactor 选型；闭环演练软中断、死锁、全连接队列溢出、容器 PSI/OOM 与大日志分析 |

## 高频机制与线上排障速查索引 {#quick-index}

| 想查的问题 / 核心机制 / 线上故障表征 | 主场位置 |
| --- | --- |
| 64 位指令长度误区、数据局部性与硬件预取、热点循环分支预测失败优化（Branchless / `likely`） | [1.1.3 位宽与 ABI](./chapter-01#ch1-1-3) · [1.3 缓存与流水线友好代码](./chapter-01#ch1-3) |
| MESI 四状态流转、Store Buffer 内存重排、多核伪共享（False Sharing）填充与雪花 ID 浮点精度丢失 | [1.4.2 MESI 与现代演进](./chapter-01#ch1-4-2) · [1.4.3 伪共享规避](./chapter-01#ch1-4-3) · [1.5.2 IEEE 754](./chapter-01#ch1-5-2) |
| `syscall` vs 进程切换、vDSO 适用时钟与 Time Namespace 边界、`top` 中 `si` 高但 `ksoftirqd` 为 0 | [2.2 系统调用与 vDSO](./chapter-02#ch2-2) · [2.3.2 上下半部与 `irq_exit`](./chapter-02#ch2-3-2) |
| eBPF 有界校验、容器内 `/proc/cpuinfo` 宿主规格泄漏、Capabilities 与 `seccomp-bpf` 系统调用过滤 | [2.4.3 eBPF、容器隔离与系统调用沙箱](./chapter-02#ch2-4-3) |
| 4/5 级页表计算、TLB Shootdown、Linux 6.12 透明大页（THP）拆分与整理抖动、`malloc` 与 RSS 差异 | [3.2 多级页表、TLB 与大页](./chapter-03#ch3-2) · [3.3.2 伙伴系统、SLUB 与 `malloc`](./chapter-03#ch3-3-2) |
| 大内存进程 `fork()` 页表拷贝卡顿与 Overcommit/memcg `ENOMEM`（`vfork`）、MGLRU 分代回收与 OOM 评分 | [3.4.1 缺页、COW 与 `fork` 边界](./chapter-03#ch3-4-1) · [3.4.2 MGLRU 与 OOM](./chapter-03#ch3-4-2) |
| `D` 状态（`UNINTERRUPTIBLE` vs `KILLABLE`）与 `Z` 态处置、M:N 协程禁混用 TLS、EEVDF 调度、容器 CPU Throttling | [4.1.2 `D`/`Z` 状态](./chapter-04#ch4-1-2) · [4.4.2 EEVDF](./chapter-04#ch4-4-2) · [4.4.3 `sched_ext` 与 `cpu.max`](./chapter-04#ch4-4-3) |
| 本机高性能 IPC 选型（共享内存/`AF_UNIX SCM_RIGHTS`/`eventfd`）、`futex` 快速路径、`RWMutex` 争用 vs RCU | [5.1 IPC 全景对比](./chapter-05#ch5-1) · [5.2.2 `futex` 互斥锁](./chapter-05#ch5-2-2) · [5.2.3 读写锁、条件变量与 RCU](./chapter-05#ch5-2-3) |
| 条件变量虚假唤醒（`while` 铁律）、CAS ABA vs 延迟节点回收、锁顺序防死锁与线程信号掩码继承 | [5.2.4 CAS 与 ABA](./chapter-05#ch5-2-4) · [5.4 死锁成因与治理](./chapter-05#ch5-4) |
| `rm` 大文件后 `df` 仍满（`lsof +L1` 与 `truncate` 空洞警示）、Ext4 Extent、容器 OverlayFS `copy_up`、NVMe `blk-mq` | [6.1.3 链接与空间回收](./chapter-06#ch6-1-3) · [6.2.2 Ext4/XFS/OverlayFS](./chapter-06#ch6-2-2) · [6.3.2 `blk-mq`](./chapter-06#ch6-3-2) |
| `fdatasync` + Flush 断电落盘与原子替换三步法、InnoDB `O_DIRECT`、`io_uring` 共享无锁队列与 `inotify ENOSPC` | [6.3.3 落盘全过程](./chapter-06#ch6-3-3) · [6.4.2 PageCache 与 `O_DIRECT`](./chapter-06#ch6-4-2) · [6.4.3 `io_uring`](./chapter-06#ch6-4-3) |
| `sk_buff` 零拷贝头操作、NAPI 批量轮询、`sendfile`+SG-DMA+kTLS、`epoll` ET 陷阱、`SO_REUSEPORT` 与 Proactor | [7.1 协议栈收发全路径](./chapter-07#ch7-1) · [7.2 零拷贝与大文件](./chapter-07#ch7-2) · [7.3 `epoll`](./chapter-07#ch7-3) · [7.4 Reactor 与 Proactor](./chapter-07#ch7-4) |
| `si` 飙高、`gdb`/`gcore` 死锁取证闭环、`ss -tin`（`snd_wnd`/`notsent`）判读、全连接队列溢出、容器 PSI 与日志管道 | [8.2 软中断与死锁排查](./chapter-08#ch8-2) · [8.3 全连接队列排障](./chapter-08#ch8-3) · [8.4 PSI、NVMe `%util` 与日志管道](./chapter-08#ch8-4) |

## 阅读与自测约定 {#conventions}

- **学习顺序**：建议按第 1 章至第 8 章自底向上通读，构建完整的操作系统底层心智模型，为后续学习语言运行时、存储引擎与 Kubernetes/Agent 基础设施打牢地基。
- **自测方式**：每章统一遵循“本章要点 → 正文机制与工程边界 → 实战练习 → 深度追问面试题 → 一手参考资料”结构，答案默认折叠；请务必先独立推演根因与方案，再展开对照。

## 参考资料

- [Linux Kernel Official Documentation (6.12 LTS)](https://docs.kernel.org/)
- [Linux man-pages project (man7.org)](https://man7.org/linux/man-pages/)
- [Operating Systems: Three Easy Pieces (OSTEP)](https://pages.cs.wisc.edu/~remzi/OSTEP/)
- [Intel 64 and IA-32 Architectures Software Developer Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
- [Brendan Gregg's Linux Performance Resources](https://www.brendangregg.com/linuxperf.html)
