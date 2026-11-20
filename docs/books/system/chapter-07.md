---
title: 第 7 章 网络协议栈、零拷贝与高性能网络模型
description: 剖析 Linux 网络协议栈收发包路径与 XDP 加速，系统梳理零拷贝与大文件传输、select/poll/epoll 多路复用，以及 Reactor 与基于 io_uring 的现代 Proactor 模型。
---

# 第 7 章 网络协议栈、零拷贝与高性能网络模型

## 本章要点

高并发后端系统的瓶颈往往集中于网络 I/O：成千上万条并发连接如何被单机高效托管？一个数据包从网线抵达网卡，要经过多少次中断、拷贝与调度才能交到业务代码？传输静态文件时怎样才能避免 CPU 在用户态与内核态之间反复搬运字节？本章整合原书《图解系统》第 8 章全部内容，剔除与前文重复的 DMA 与阻塞/异步基础铺垫，修正原书在 RX Ring Buffer 收包拷贝、发送分片和 `poll` 数据结构上的细节偏差，并补充 **eBPF/XDP**、**kTLS 加密零拷贝**、`EPOLLEXCLUSIVE`/`SO_REUSEPORT`、**Redis 6.0+ 多线程 I/O**、**Nginx `reuseport`**，以及依托 **Linux `io_uring`** 彻底改变“Linux 无高性能原生 Proactor”历史格局的现代演进。

读完本章后，应能完整追踪网络包经 DMA、NAPI、`sk_buff` 与协议栈的收发路径，量化对比传统传输与 `mmap`/`sendfile`/SG-DMA/kTLS 的拷贝与切换开销，深入解释 `epoll` 高效的根因与 ET/LT 边界，并准确选型 Reactor 与现代 Proactor 架构。

> 核对日期：2026 年 11 月 20 日；核对环境为 Linux 6.12 LTS 网络子系统文档、`epoll(7)`、`sendfile(2)` 及 `io_uring` 规范。

## 7.1 Linux 网络协议栈与数据包收发全路径 {#ch7-1}

本节聚焦 Linux 内核协议栈的数据结构、收发包执行路径与网卡加速机制；关于端到端网络分层封装与一次完整请求的多跳流转，可对照阅读[《图解网络》第 1 章 Linux 内核收发网络包全路径](../network/chapter-01#ch1-3)。

### 7.1.1 协议分层与 `struct sk_buff` 零拷贝设计 {#ch7-1-1}

Linux 网络协议栈按实用的 **TCP/IP 四层模型**（应用层、传输层、网络层、网络接口层）实现；日常工程常说的“四层负载均衡”与“七层负载均衡”则沿用 OSI 七层编号，分别对应**传输层（TCP/UDP）**与**应用层（HTTP/gRPC）**。

数据自顶向下发送时依次封装 TCP 头、IP 头、以太网帧头/尾，单帧负载受链路最大传输单元 **MTU**（以太网默认 1500 字节）约束。如果在每一层之间都重新分配缓冲区并拷贝数据，CPU 很快会被耗尽。Linux 内核为此统一使用 **`struct sk_buff`（Socket Buffer）** 描述各层数据包，仅通过移动内部数据指针 `skb->data` 实现零拷贝加/脱头部：

- **发包封装**：分配 `sk_buff` 时在头部预留充足 `headroom`，逐层向下传递时**减小 `skb->data`** 向前写入 TCP 头、IP 头与帧头；
- **收包解封**：自网卡向上传递时**增大 `skb->data`** 逐步跳过帧头、IP 头与 TCP 头，全程不搬运载荷。

### 7.1.2 接收与发送全路径（纠偏原书细节） {#ch7-1-2}

```text
【接收路径】
物理网卡 ──DMA 直写驱动预分配内存──> RX Ring Buffer ──硬中断(NAPI关该队列中断)──> NET_RX 软中断 poll
  ──> 链路层/IP层/TCP层(移动 skb->data，按四元组查 Socket) ──> Socket 接收队列 ──> 唤醒进程 read()

【发送路径】
应用 send()/write() ──> 拷入 Socket 发送队列 ──> TCP(按 MSS 或 TSO/GSO 分段) ──> IP(路由查下一跳)
  ──> 链路层(ARP 查 MAC) ──> qdisc 队列 ──> 网卡驱动填 TX Ring Buffer ──> 网卡 DMA 发包 ──> 硬中断/NET_TX 回收 skb
```

需要修正和补充原书 8.1 节的四处关键内核机制细节：

1. **RX Ring Buffer 收包并非整包拷贝**：网卡驱动初始化时已预先分配好内存页（`page pool` / `sk_buff` 缓冲区）并把物理地址填入 RX Ring Buffer。网卡收包时通过 **DMA 直接把报文写入这些内核内存**；NAPI 轮询阶段主要是摘取已填满的缓冲区、组装 `sk_buff` 元数据并补充新的空闲页，并不存在“从 Ring Buffer 整包拷贝到 `sk_buff`”的冗余搬运。
2. **NAPI（中断 + 轮询混合）**：若高流量下每来一个包都触发一次硬中断，CPU 会陷入中断风暴。Linux NAPI 机制在首个包到达触发硬中断后，**暂时关闭该网卡队列的硬中断**并触发 `NET_RX` 软中断（见[第 2 章中断上下半部](./chapter-02#ch2-3-2)），在软中断中循环 `poll()` 一口气收割一批数据包（受单次预算 `budget` 限制），队列收空后再重新打开硬中断。
3. **发包优先使用 TSO/GSO 而非 IP 分片**：TCP 会在传输层按对端通告的 **MSS** 切分报文，现代系统更普遍开启 **TSO（TCP Segmentation Offload）/ GSO**，直接把高达 64 KB 的大块合并报文交给网卡硬件在发送前自动切分为符合 MTU 的以太网帧，既大幅减少协议栈遍历次数，也避免了低效易丢包的 IP 层分片。此外，`qdisc` 排队规则在队列不忙时直接由发送线程调用驱动发送，仅当队列阻塞或发送完毕需释放 `sk_buff` 时才借助 `NET_TX` 软中断。
4. **现代高速网络加速三驾马车**：
   - **RSS（Receive Side Scaling）**：多队列网卡通过硬件对五元组哈希，把不同连接的数据包分散到多个 RX 队列与不同 CPU 核心上并行处理，避免单核 `NET_RX` 成为瓶颈；
   - **eBPF / XDP（eXpress Data Path）**：允许经验证的 eBPF 程序直接挂载在**网卡驱动最底层**（尚未分配 `sk_buff` 之前）对原始数据帧执行纳秒级丢弃（抗千万级 PPS DDoS）或转发（如 Cloudflare / Cilium 负载均衡）；
   - **DPDK**：彻底绕过内核协议栈，在用户态独占物理网卡与 CPU 核心死循环轮询收发包，用于极致低延迟网关与 NFV。

## 7.2 零拷贝与大文件传输策略 {#ch7-2}

### 7.2.1 传统传输 vs `mmap` vs `sendfile`（SG-DMA） {#ch7-2-1}

服务端将磁盘文件通过网络发送给客户端，最朴素的写法是 `read(file_fd, buf, len)` 后紧跟 `write(sock_fd, buf, len)`。由于文件传输并不在用户态修改内容，这份数据被迫经历了 **4 次用户态/内核态切换（模式切换，Mode Switch）**与 **4 次数据拷贝**（2 次 DMA 拷贝 + 2 次昂贵的 CPU 拷贝：PageCache → 用户缓冲 → Socket 发送缓冲）。

> **概念区分（态切换 ≠ 线程上下文切换）**：不少资料会把系统调用触发的“用户态 ↔ 内核态切换”笼统称为“上下文切换”，容易与调度器的**线程上下文切换（Thread Context Switch）**混淆。实际上，`read` + `write` 产生的 **4 次切换**指的是系统调用陷入内核与返回用户态的**模式切换**（单次系统调用对应 2 次态切换）；只要调用过程中未因阻塞而触发调度器切走 CPU，**同一线程全程可能发生 0 次线程上下文切换**。

**零拷贝（Zero-Copy）**的核心目标就是**消除不必要的 CPU 内存拷贝，并尽量减少系统调用导致的态切换次数**：

| 传输方式 | 系统调用 | 用户态/内核态切换（模式切换） | DMA 拷贝 | CPU 拷贝 | 总拷贝次数 | 核心机制与适用边界 |
| --- | --- | --- | --- | --- | --- | --- |
| **传统 I/O** | `read` + `write` | 4 次 | 2 次 | 2 次 | 4 次 | 通用，可在用户态任意加工数据 |
| **`mmap` + `write`** | `mmap` + `write` | 4 次 | 2 次 | 1 次 | 3 次 | 将 PageCache 映射进用户空间，省去内核→用户拷贝（写前仍需 CPU 拷到 Socket 缓冲） |
| **`sendfile`（无 SG-DMA）** | `sendfile` | 2 次 | 2 次 | 1 次 | 3 次 | 单次系统调用在内核内完成 PageCache → Socket 拷贝 |
| **`sendfile` + SG-DMA** | `sendfile` | **2 次** | **2 次** | **0 次** | **2 次** | **真正零 CPU 拷贝（Linux 2.4+）**：仅将 PageCache 缓冲区描述符与长度交给 Socket，由网卡 SG-DMA 直接从 PageCache 搬运发送 |

**典型工业实践**：Kafka 消费端拉取分区日志调用 Java NIO `FileChannel.transferTo()`，在 Linux 下直接映射为 `sendfile()`；Nginx 配置 `sendfile on;` 同样启用该路径，可将静态文件传输吞吐提升一倍以上。通过 `ethtool -k eth0 | grep scatter-gather` 可检查网卡是否开启 SG-DMA。

### 7.2.2 现代零拷贝演进：kTLS、`splice` 与 `MSG_ZEROCOPY` {#ch7-2-2}

经典 `sendfile` 有一个长期痛点：**不兼容用户态 HTTPS/TLS 加密**（用户态 OpenSSL 必须先把明文读进用户空间加密，零拷贝随即失效），且无法直接加速“用户态动态生成数据”的发送。现代 Linux 补齐了三项关键扩展：

1. **kTLS（Kernel TLS，Linux 4.13+）**：TLS 握手仍在用户态完成，握手后将对称会话密钥下发给内核 Socket。此后调用 `sendfile()` 发送静态文件时，由内核（甚至支持 TLS 卸载的智能网卡）在发送路径上直接加密，让 **HTTPS 流量重新享受零拷贝**（Nginx、Netflix CDN 已大规模落地）。
2. **`splice()`**：在任意两个文件描述符之间（至少一端为管道 `pipe`）通过转移内存页引用实现内核态零拷贝转发，常用于高性能代理与网关。
3. **`MSG_ZEROCOPY`（Linux 4.14+）与 `io_uring` 零拷贝发送（Linux 6.0+ `IORING_OP_SEND_ZC`）**：允许内核直接锁定并 DMA 发送用户态大块内存页（适合 ≥ 10 KB 的大数据包），发送完成后通过完成通知告知用户态安全复用缓冲。

### 7.2.3 PageCache 权衡与大文件传输策略 {#ch7-2-3}

`sendfile` 依赖内核 **PageCache**，对频繁访问的中小静态文件（如图片、JS、Kafka 近期热日志）收益巨大——既可内存命中免读盘，又享受内核顺序预读。

但在并发传输**GB 级超大冷文件**（如视频点播、镜像下载）时，一味使用走 PageCache 的 `sendfile` 反而会引发性能雪崩：冷大文件极少被二次命中，却瞬间塞满 PageCache，把真正热点的中小文件全部挤出内存！

工程上针对文件大小的混合策略（如 Nginx 的 `directio` 阈值切换）：
- **中小/热点文件**：启用 **`sendfile` 零拷贝**，吃满 PageCache 命中与预读红利；
- **超大冷文件**：改用 **`O_DIRECT`（直接 I/O）+ 异步 I/O**（现代 Linux 推荐 `io_uring`），绕开 PageCache 防止缓存污染；若仍需复用缓存路径，也可在读取后调用 `posix_fadvise(..., POSIX_FADV_DONTNEED)` 提示内核立即回收对应页缓存。

> **口径校准**：原书 8.2 节称“异步 I/O 只支持直接 I/O”，那是早期 Linux `libaio` 的历史局限；在 **Linux 5.1+ `io_uring`** 中，缓冲 I/O 与直接 I/O 均支持原生异步。大文件选择 `O_DIRECT` 的真正目的是主动避免污染 PageCache。

## 7.3 I/O 多路复用：`select`、`poll` 与 `epoll` {#ch7-3}

### 7.3.1 TCP Socket 队列与 C10K 挑战 {#ch7-3-1}

服务端 TCP 编程依次经历 `socket()` → `bind()` → `listen()` → `accept()`。内核为每个监听 Socket 维护两个核心队列：
- **半连接队列（SYN Queue）**：存放已收到 `SYN`、发出 `SYN+ACK`、处于 `SYN_RCVD` 状态的连接；
- **全连接队列（Accept Queue）**：存放已完成三次握手、处于 `ESTABLISHED` 状态等待应用调用 `accept()` 取走的连接（队列溢出排查实战见[第 8 章 TCP 全连接队列溢出排障](./chapter-08#ch8-3-2)）。

注意区分**监听 Socket**（只负责接收新连接）与 `accept()` 返回的**已连接 Socket**（用于 `read`/`write` 传输业务数据）。虽然 IPv4 下单个监听端口理论可区分 2<sup>32</sup> × 2<sup>16</sup> = 2<sup>48</sup> 个四元组连接，现实中受制于**进程最大文件描述符数（`ulimit -n` / `fs.nr_open`）**与**内核/应用内存占用**。

要让单机同时服务上万并发连接（**C10K 问题**），传统的“一连接一进程”或“一连接一线程”模型会因海量栈内存与上下文切换彻底瘫痪；而改用固定线程池配合阻塞 `read()` 又会导致一个慢连接卡死整个线程。解决方案是**I/O 多路复用**——由单个线程通过一个系统调用同时监听成千上万个 Socket 的读写事件，仅对真正就绪的连接发起处理。

### 7.3.2 `select`、`poll` 与 `epoll` 深度对比 {#ch7-3-2}

| 对比维度 | `select` | `poll` | `epoll`（Linux 专用） |
| --- | --- | --- | --- |
| **监控集合结构** | 固定长度位图 `fd_set`（受 `FD_SETSIZE = 1024` 限制） | 用户态连续 `struct pollfd` 数组（内核内按页拆链，**无 1024 硬上限**） | 内核长期维护**红黑树**（`epoll_ctl` 增删改 `O(log n)`） |
| **用户↔内核拷贝** | 每次调用需来回拷贝全部 fd 集合 | 每次调用需来回拷贝全部 `pollfd` 数组 | `epoll_ctl` 仅增量注册一次；`epoll_wait` **仅拷贝就绪的 k 个事件** |
| **事件检测机制** | 内核与用户态均需全量线性扫描 `O(n)` | 内核与用户态均需全量线性扫描 `O(n)` | **事件驱动回调**：网卡数据到达 Socket 时回调函数将其插入**就绪链表**，`epoll_wait` 复杂度 `O(k)` |
| **触发模式** | 仅水平触发（LT） | 仅水平触发（LT） | 支持**水平触发（LT，默认）**与**边缘触发（ET）** |
| **高并发表现** | 连接数大且活跃率低时急剧退化 | 同 `select`，仅突破 1024 限制 | 监控数万连接且活跃稀疏时性能近乎恒定（C10K/C100K 利器） |

> **两大高频误区辟谣**：
> 1. **`epoll` 没有使用共享内存**：网传“`epoll_wait` 通过内核/用户共享内存零拷贝返回就绪事件”是错误的。Linux 内核源码中 `ep_send_events()` 明确通过 `__put_user()` / `copy_to_user()` 将就绪事件拷贝到用户态数组；`epoll` 快的真正原因是把拷贝与扫描规模从“全部连接 N”压缩到了“仅活跃连接 k”。
> 2. **`poll` 的数据结构**：原书称“`poll` 用动态数组、以链表形式组织”表述较模糊——实际用户态传入的是连续 `pollfd` 数组，内核为避免给百万连接分配超大连续内存，才在内核内部把数组分段拷贝到按页链接的 `poll_list` 链表中。

### 7.3.3 水平触发（LT）、边缘触发（ET）与惊群治理 {#ch7-3-3}

- **水平触发（Level-Triggered, LT）**：只要 Socket 接收缓冲区**还有未读数据**（或发送缓冲区仍有空位），每次调用 `epoll_wait()` 都会持续上报该 fd 就绪，编写简单不易漏事件。
- **边缘触发（Edge-Triggered, ET）**：仅在状态发生**从无到有（或新数据到来）的跃变瞬间**通知一次。若一次未读完剩余字节，`epoll_wait()` 不会再次提醒，因此 **ET 必须搭配非阻塞 Socket（`O_NONBLOCK`）**，在收到事件后循环调用 `read()`/`write()` 直至返回 `EAGAIN` / `EWOULDBLOCK`。ET 能减少重复就绪通知，降低 `epoll_wait` 次数与无效唤醒。
- **安全实践**：即便在 **LT 模式**下，也应为多路复用托管的 Socket 设置 `O_NONBLOCK`——因为 Linux 手册明确警示，极少数情况下（例如数据到达触发就绪通知后，因校验和错误被内核丢弃，或多线程竞争读空），后续 `read()` 若为阻塞模式仍可能意外卡死整个事件循环。
- **惊群效应（Thundering Herd）治理**：多个进程/线程同时 `epoll_wait()` 监听同一个监听 Socket 时，一个新连接可能唤醒全部等待者却只有一个能 `accept()` 成功。现代 Linux 提供两种零锁方案：
  1. **`EPOLLEXCLUSIVE`（Linux 4.5+）**：注册监听 fd 时附加该标志，内核每次只唤醒一个等待线程；
  2. **`SO_REUSEPORT`（Linux 3.9+，推荐）**：允许多个工作进程/线程各自绑定并监听同一 `IP:Port` 的独立 Socket，由内核在协议栈层直接按五元组哈希均衡分发新连接，彻底消除共享监听队列的锁争用与惊群。

## 7.4 高性能网络模式：Reactor 与 Proactor {#ch7-4}

直接裸写 `epoll` 循环繁琐易错，工程界将其抽象为面向对象的事件驱动模式：**Reactor**（同步非阻塞，感知**就绪事件**）与 **Proactor**（真异步，感知**完成事件**）。

### 7.4.1 Reactor 模式的三种演进与现代开源软件校准 {#ch7-4-1}

Reactor（又称 Dispatcher 模式）由 **Reactor（监听与分发事件）** 与 **处理资源池（执行 `read → 业务 → send`）** 组成，工程落地的三种经典架构如下：

```text
1. 单 Reactor 单线程/进程:   [Reactor + Acceptor + Handler(read/业务/send)]  (极简无锁，单核瓶颈)
2. 单 Reactor 多线程:        [Reactor + Acceptor + Handler(read/send)] <---> [业务线程池]
3. 多 Reactor 多线程/进程:   [MainReactor(accept)] ──派发连接──> [SubReactor 1..N (各自 epoll + read/业务/send)]
```

| 模式 | 核心特点 | 优势与局限 | 开源代表（2026 现状校准） |
| --- | --- | --- | --- |
| **单 Reactor 单线程/进程** | 所有事件监听、I/O 与业务在同一执行流完成 | 无锁、无跨线程通信；但无法利用多核，慢业务会阻塞全部连接 | 早期 Redis（≤ 5.x）；**现代校准：Redis 6.0+ 已引入多线程网络 I/O（`io-threads`）并行处理网络读写与协议解析，命令执行核心仍保持单线程** |
| **单 Reactor 多线程** | 主线程专责 `epoll` 监听与收发，耗时业务交由 Worker 线程池 | 利用多核处理重业务；但高并发短连接下单个 Reactor 的 `epoll` 与收发会成为瓶颈，且线程间结果回传需加锁同步 | 部分轻量 RPC / 自研网关 |
| **多 Reactor 多线程** | `MainReactor` 专责 `accept`，`SubReactor` 线程组各自持有独立 `epoll` 负责连接全生命周期 | 分工清晰、跨线程交互极简（仅移交新连接 fd），可线性扩展至多核高并发 | **Netty**（BossGroup + WorkerGroup）、Memcached |
| **多 Reactor 多进程** | 多 Worker 进程各自运行独立 `epoll` 循环 | 进程间内存强隔离，单 Worker 崩溃不影响全局 | **Nginx**（**现代校准**：Nginx 1.11.3+ 默认关闭古老的 `accept_mutex` 全局锁，现代 Linux 生产环境普遍启用 `listen ... reuseport;` 借助内核 `SO_REUSEPORT` 无锁分流） |

### 7.4.2 Proactor 模式与 Linux `io_uring` 时代更新 {#ch7-4-2}

Reactor 与 Proactor 的核心分水岭在于谁来执行实际的数据搬运：
- **Reactor（就绪驱动）**：内核通知“数据可读了” → 应用程序主动调用 `read()` 同步把数据从内核拷贝到用户空间 → 处理业务；
- **Proactor（完成驱动）**：应用程序提前把用户缓冲区地址交给内核发起异步读 → 内核全权完成数据接收**并拷贝入用户缓冲区** → 通知应用程序“数据已就位，直接处理”。

**重大版本校准（更新原书 8.4 节过时结论）**：原书写作时期，Linux 只有缺陷重重的 POSIX `aio`（用户态线程模拟、不支持 Socket）与 `libaio`（仅限直接文件 I/O），因此原书断定“Linux 下异步 I/O 不完善，只能用 Reactor，只有 Windows IOCP 才是真 Proactor”。

如今这一格局已经彻底改写：**Linux 5.1 引入、在 6.x 全面成熟的 `io_uring`**（见[第 6 章 `io_uring`](./chapter-06#ch6-4-3)）原生且高效地支持全套异步网络操作（`IORING_OP_ACCEPT`、`RECV`、`SEND`、一次注册持续收包的 **Multishot Accept/Recv**、内核托管缓冲池 **Provided Buffer Rings** 以及零拷贝发送 `SEND_ZC`）。借助共享无锁 SQ/CQ 环形队列，Linux 已拥有不逊于甚至在批量系统调用削减上超越 Windows IOCP 的原生 Proactor 底座，已被新一代网络运行时（如 Rust `monoio`/`tokio-uring`、Netty `io_uring` 传输层）广泛采用。

## 练习 {#ch7-exercises}

本节包含 4 道练习，覆盖网络收包与零拷贝量化计算、`epoll` ET 模式编码排错以及现代高并发网络架构选型。请先独立分析，再展开核对。

### 练习 1：量化对比三种静态文件传输方案的开销

一台 Linux 6.x HTTPS 文件下载服务器（网卡支持 SG-DMA 与 kTLS）需要向客户端发送一个 4 MB 的热点静态资源（已命中 PageCache）：

1. 若采用传统 `read()` + 用户态 TLS 加密 + `write()`，经历几次用户态/内核态切换（模式切换）与几次数据拷贝（忽略循环分片次数，按单次逻辑传输计）？这是否意味着必然发生了 4 次调度器线程上下文切换？
2. 若在 HTTP 明文下改用 `sendfile()`（网卡开启 SG-DMA），用户态/内核态切换与数据拷贝分别降为几次？
3. 在 HTTPS 下如何避免因为加密而退回传统拷贝路径？如果改发一个 20 GB 的冷门系统镜像，又该如何调整策略？

<details>
<summary>查看参考答案</summary>

1. **传统路径（带用户态 TLS）**：**4 次用户态/内核态切换（模式切换）**（`read` 与 `write` 系统调用陷入与返回各 2 次）；**并不必然发生线程上下文切换**——若数据已命中 PageCache 且 Socket 发送缓冲区未满、未触发阻塞调度，同一线程全程可能发生 **0 次**调度器线程上下文切换。数据拷贝方面，在已命中 PageCache 的情况下省去了磁盘 DMA 读，但仍有 **3 次拷贝**（CPU 将 PageCache 拷至用户明文缓冲 → 用户态加密写入密文缓冲并由 CPU 拷入 Socket 缓冲 → 网卡 DMA 发包；若未命中 PageCache 则还要加 1 次磁盘 DMA 拷贝）。
2. **明文 `sendfile()` + SG-DMA**：**2 次用户态/内核态切换（模式切换）**（单次 `sendfile` 系统调用）、**0 次 CPU 拷贝**；已命中 PageCache 时仅 **1 次网卡 SG-DMA 拷贝**（未命中时为磁盘 DMA + 网卡 SG-DMA 共 2 次 DMA 拷贝）。
3. **HTTPS 零拷贝与冷大文件策略**：
   - HTTPS 下启用 **kTLS**（握手在用户态完成，会话密钥注入内核），即可重新对加密连接调用 `sendfile()` 避免数据往返用户态；
   - 20 GB 冷镜像不应走默认 PageCache 零拷贝，防止挤爆热点 PageCache；应通过 `O_DIRECT` + `io_uring` 异步 I/O（或 Nginx `directio` 阈值配置）绕开 PageCache 传输。

</details>

### 练习 2：找出 `epoll` 边缘触发（ET）读循环中的两处致命缺陷

以下是一段使用 `epoll` 边缘触发（`EPOLLET`）读取客户端 TCP 数据的 C 伪码，存在两处经典线上故障隐患，请指出并修复：

```c
// 假设 conn_fd 注册时设置了 EPOLLIN | EPOLLET，但未修改 fd 阻塞属性
char buf[1024];
if (events[i].events & EPOLLIN) {
    ssize_t n = read(conn_fd, buf, sizeof(buf));
    if (n > 0) {
        process_data(buf, n);
    }
}
```

<details>
<summary>查看参考答案</summary>

**两处致命缺陷**：
1. **未循环读尽缓冲区导致数据“饿死”**：ET 模式只在数据到达时触发一次通知。若客户端一次发来 3000 字节，上述代码只 `read()` 了 1024 字节，剩余 1976 字节留在内核接收缓冲区；只要客户端不再发新包，`epoll_wait()` 将**永远不再唤醒**，导致请求卡死超时。
2. **未设置 `O_NONBLOCK` 导致事件循环卡死**：为了读尽数据必须改为 `while` 循环 `read()`；若 `conn_fd` 保持默认阻塞模式，读完最后一批数据后的下一次 `read()` 会永久阻塞，彻底冻住整个 Reactor 线程！

**修复方案**：先将 `conn_fd` 设为 `O_NONBLOCK`，再循环读取直至 `EAGAIN`/`EWOULDBLOCK`（并妥善处理 `n == 0` 对端关闭与 `EINTR`）：

```c
while (1) {
    ssize_t n = read(conn_fd, buf, sizeof(buf));
    if (n > 0) {
        process_data(buf, n);
    } else if (n == 0) {
        close_connection(conn_fd); // 对端关闭连接
        break;
    } else {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break; // 本轮数据已读尽
        handle_error(conn_fd);
        break;
    }
}
```

</details>

### 练习 3：追踪多核网卡收包时为何只有 CPU 0 跑满 100%

某高流量网关服务器配备 16 核 CPU 和万兆网卡，压测时业务吞吐远未达预期，观测发现 CPU 0 的 `si`（软中断占比）飙至 100%，而 CPU 1–15 几乎全部空闲。请结合 7.1 节的网络收包路径说明可能原因及两项核心排查/优化方向。

<details>
<summary>查看参考答案</summary>

- **可能原因**：网卡未开启多队列 **RSS**（或仅启用了 1 个 RX 队列），或者所有网卡队列的硬中断（IRQ）亲和性都被默认绑定到了 CPU 0，导致全部网络包的硬中断与 `NET_RX` 软中断都集中砸在 CPU 0 上处理。
- **排查与优化方向**：
  1. 检查 `/proc/interrupts` 确认网卡 IRQ 触发是否全落在 CPU 0，用 `ethtool -l eth0` 查看并调大网卡组合队列数（如匹配核心数），通过 `/proc/irq/<irq>/smp_affinity`（或 `irqbalance`）将各队列 IRQ 均匀绑到不同物理核；
  2. 若硬件网卡不支持多队列（如老旧虚拟网卡），可在内核开启 **RPS（Receive Packet Steering）**，由软件层根据哈希把数据包分发到其他 CPU 核心的软中断队列执行协议栈解析。

</details>

### 练习 4：为不同业务场景选型网络并发模型

针对以下三个服务端程序，分别选择最匹配的并发网络模式（单 Reactor / 多 Reactor / Proactor）并说明依据：

1. 一个极简的内存 KV 缓存（核心逻辑纯内存微秒级操作，但面临极高网络小包并发读写）；
2. 一个需要同时承载 5 万长连接、且每条消息需做较重 JSON 解析与加密运算的 Java 即时通讯网关；
3. 一个运行在 Linux 6.12 上、同时追求极致磁盘读取与网络发送吞吐的新一代 Rust 存储节点。

<details>
<summary>查看参考答案</summary>

1. **单核心业务线程 + 多线程网络 I/O（Redis 6.0+ 模式）**：纯内存指令执行极快，单线程执行数据结构操作可彻底避免锁竞争与上下文切换；网络读写与协议编解码容易成为瓶颈，交给多线程网络 I/O 并行处理即可。
2. **多 Reactor 多线程（Netty 模式，辅以独立业务线程池）**：`MainReactor` 专责 `accept`，多个 `SubReactor` 线程分摊 5 万连接的 `epoll` 监听与收发；较重的加解密与业务逻辑可按需卸载至业务线程池，避免阻塞 `SubReactor` I/O 循环。
3. **基于 `io_uring` 的 Proactor 模型（每核一线程 Thread-per-Core）**：存储节点同时存在大量磁盘文件 I/O 与网络 Socket I/O，`epoll` 无法异步处理磁盘文件，而 `io_uring` 可在每核独立事件循环中统一以真异步、低系统调用开销驱动磁盘与网络，配合每核分片最大化缓存亲和性。

</details>

## 面试题 {#ch7-interview}

本节精选 5 道高频网络系统面试题，聚焦底层机制辨析与常见网传误区纠偏。

### 面试题 1：`epoll` 为什么比 `select` 和 `poll` 快？`epoll_wait` 返回就绪事件时用了共享内存吗？

<details>
<summary>查看参考答案</summary>

**结论**：`epoll` 快在于**增量注册（红黑树）+ 事件驱动回调（就绪链表）**，避免了每次全量拷贝与 `O(n)` 轮询；**`epoll_wait` 并没有使用共享内存**。

**关键依据**：
- `select`/`poll` 每次调用都要把全部监控的 fd 集合从用户态拷入内核、内核线性遍历一遍再全量拷回，连接数大且活跃率低时开销呈线性暴涨；
- `epoll` 通过 `epoll_ctl` 把连接长期存在内核红黑树中，Socket 有数据时通过回调自动挂入就绪链表，`epoll_wait` 只需把就绪的 k 个事件经 `__put_user`/`copy_to_user` 拷贝回用户态，复杂度降为 `O(k)`。

</details>

### 面试题 2：在 Linux 网络协议栈中，为什么传输大块应用数据时各层加头/去头不会触发多次整包拷贝？

<details>
<summary>查看参考答案</summary>

**结论**：内核用统一的数据结构 **`struct sk_buff`** 贯穿整个网络协议栈，仅通过前后移动指针 `skb->data` 来添加或剥离各层协议头。

**关键依据**：
- 发送时预先在缓冲区前部留出足够 `headroom`，经 TCP、IP、链路层时依次将 `skb->data` 前移并写入各层头部；
- 接收时自底向上只需依次将 `skb->data` 后移跳过帧头、IP 头、TCP 头，载荷字节在内存中保持原地不动。

</details>

### 面试题 3：为什么 Nginx 现代版本默认关闭了 `accept_mutex`，线上如何解决多进程监听同一端口的惊群问题？

<details>
<summary>查看参考答案</summary>

**结论**：`accept_mutex` 本质是用户态全局锁，高并发建连下会串行化所有 Worker 进程；现代 Linux 直接依靠内核级 **`EPOLLEXCLUSIVE`** 或 **`SO_REUSEPORT`** 彻底解决惊群。

**关键依据**：
- 开启 **`SO_REUSEPORT`**（Nginx `listen 80 reuseport;`）后，每个 Worker 进程各自创建并绑定同一端口的独立监听 Socket，内核收到新连接时直接按五元组哈希派发给某一个 Worker 的全连接队列，既无惊群又消除了共享监听 Socket 的锁争用。

</details>

### 面试题 4：“Linux 下没有真正高性能的异步网络 I/O，所以只能用 Reactor，不能用 Proactor”——这个说法现在还正确吗？

<details>
<summary>查看参考答案</summary>

**结论**：**已经过时。** Linux 5.1 引入并在 6.x 全面成熟的 **`io_uring`** 已提供原生、高性能的全功能异步文件与网络 I/O。

**关键依据**：
- 过去 POSIX `aio` 靠用户态线程池模拟且不支持 Socket，`libaio` 仅支持直接文件 I/O，因此长期只有 Windows IOCP 适合做 Proactor；
- 现代 **`io_uring`** 通过用户/内核共享的提交队列（SQ）与完成队列（CQ）原生支持异步 `accept`/`recv`/`send`、Multishot 持续收包与零拷贝发送，不仅在 Linux 上完整支撑 Proactor 模式，还能通过批量提交大幅削减系统调用开销。

</details>

### 面试题 5：为什么 `sendfile` 零拷贝不适合直接用来传输几十 GB 的冷门大文件？

<details>
<summary>查看参考答案</summary>

**结论**：因为 `sendfile` 依赖内核 **PageCache**，超大冷文件会迅速占满 PageCache 并把高频访问的热点小文件全部驱逐出去，且自身几乎无法享受二次缓存命中，反而拖垮整机磁盘性能。

**关键依据**：
- 正确做法是根据文件大小区分策略：热点中小文件用 `sendfile` 吃满 PageCache 与零拷贝优势；GB 级超大冷文件改用 **`O_DIRECT` 直接 I/O + 异步 I/O**（如 `io_uring`）绕开 PageCache。

</details>

## 参考资料

- [Linux Kernel Documentation: Networking & NAPI](https://docs.kernel.org/networking/napi.html)
- [Linux Kernel Documentation: Kernel TLS (kTLS)](https://docs.kernel.org/networking/tls.html)
- [Linux Kernel Documentation: `MSG_ZEROCOPY`](https://docs.kernel.org/networking/msg_zerocopy.html)
- [Linux Programmer's Manual: `epoll(7)`、`sendfile(2)`、`splice(2)`](https://man7.org/linux/man-pages/man7/epoll.7.html)
- [XDP (eXpress Data Path) Project Documentation](https://docs.kernel.org/networking/af_xdp.html)
- [Nginx Official Blog: Socket Sharding (`SO_REUSEPORT`) & Thread Pools](https://nginx.org/en/docs/http/ngx_http_core_module.html#listen)
