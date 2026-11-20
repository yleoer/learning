---
title: 第 3 章 TCP 基础、连接建立与半/全连接队列
description: 对齐 RFC 9293 与 Linux 6.12 LTS，系统梳理 TCP 面向字节流本质、三次握手状态机与 ISN/PAWS 安全机制、半/全连接队列溢出排查、SYN Flood 防御及 TFO 现代现状。
---

# 第 3 章 TCP 基础、连接建立与半/全连接队列

## 本章要点

TCP 是互联网可靠传输的基石，也是面试与线上故障排查的重灾区。原书《图解网络》TCP 篇将三次握手、队列溢出、SYN 丢弃、ISN 随机化、无 `listen`/`accept` 建连与 TFO 分散在 4.1、4.4、4.5、4.6–4.8、4.20–4.21 与 4.24 等近十个小节中，存在大面积四重复制，且多处沿用早已过时的 RFC 793 与 Linux 2.6.32 默认参数。本章将所有“TCP 基础与连接建立”相关内容去重合并，统一升级至 **RFC 9293** 与 **Linux 6.12 LTS** 基线，彻底纠正“TCP 粘包”术语、HTTP 报文边界、ISN 生成算法、`somaxconn`/`tcp_syn_retries`/`tcp_syncookies` 默认值以及 Linux 4.4+ 半连接队列数据结构演进。

读完本章后，应能准确界定 TCP 面向字节流语义与应用层分帧方式，推导三次握手及各阶段丢包的状态变迁与序号公式，深入剖析半/全连接队列在现代 Linux 内核中的协作与溢出排查，并客观评估 SYN Cookies 与 TCP Fast Open 的适用边界。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 9293（取代 RFC 793）、RFC 7323、RFC 7413（TFO）及 Linux 6.12 LTS 内核网络栈源码与 `tcp(7)` 手册。

## 3.1 TCP 基础、面向字节流与 UDP 对比 {#ch3-1}

### 3.1.1 TCP 核心定义、首部字段与四元组 {#ch3-1-1}

依据 **RFC 9293**，TCP 是**面向连接、可靠、基于字节流**的传输层协议。所谓“连接”，并非物理电路，而是通信双方内核共同维护的一组状态（`struct tcp_sock` 控制块），包含 Socket（IP + 端口）、序列号、接收/发送窗口与拥塞控制上下文。

TCP 基本首部固定 **20 字节**（加扩展选项最长 **60 字节**），核心控制字段包括：
- **源端口 / 目的端口**（各 16 bit）：定位两端应用进程；
- **序列号（Sequence Number，32 bit）**：建连时初始化为随机 **ISN**，此后每发送 1 字节应用数据递增 1（`SYN` 与 `FIN` 标志各消耗 1 个序号），用于按序重组与去重；
- **确认应答号（Acknowledgment Number，32 bit）**：期望对方下一次发送的第一个字节序号（累计确认），配合重传保证可靠交付；
- **控制标志位**：`SYN`（同步建连）、`ACK`（确认有效）、`FIN`（优雅断连）、`RST`（强制复位）、`PSH`（提示尽快上交应用）等；
- **窗口大小（Window，16 bit）**：接收方通告的当前可用接收窗口，配合 RFC 7323 窗口缩放因子（最大右移 14 位）可扩至约 1 GiB。

内核以**四元组 `{源 IP, 源端口, 目的 IP, 目的端口}`** 唯一标识一条 TCP 连接。IPv4 下单个服务端监听端口理论最大连接数为 2<sup>32</sup> × 2<sup>16</sup> = 2<sup>48</sup>，实际受限于**文件描述符上限**（`fs.file-max`、`fs.nr_open` 与 `ulimit -n`）和**内核内存占用**（每条空闲 TCP 连接约占数 KB 内存）。

> **严谨口径**：原书 4.1 节称“无论链路如何变化，TCP 都可以保证报文一定到达接收端”过于绝对。TCP 保证的是在**重传上限内实现无差错、不丢失、不重复、按序的传输层交付**；若物理链路长期中断超过重传上限，TCP 会主动中止连接并向应用返回超时错误（详见[第 5 章传输层与应用程序可靠性边界](./chapter-05#ch5-1-3)）。

### 3.1.2 TCP 与 UDP 对比及端口复用 {#ch3-1-2}

| 对比维度 | TCP | UDP |
| --- | --- | --- |
| **连接与服务模型** | 面向连接（一对一单播） | 无连接（支持一对一、一对多组播、广播） |
| **可靠性与流控** | 内置确认重传、滑动窗口流控与拥塞控制 | 尽力而为、无内置可靠保障（但可在用户态构建可靠传输，如 **QUIC**） |
| **首部开销** | 20–60 字节 | 固定 **8 字节**（源/目的端口、总长度、校验和） |
| **传输语义** | **面向字节流**（无天然消息边界） | **面向报文**（保留应用层每次 `sendto` 边界） |
| **分片策略** | 传输层按 **MSS** 分段，尽量避免 IP 分片 | 传输层不分段，超 MTU 时由 IP 层分片（易丢包，应用层应自行控包大小） |
| **典型场景** | HTTP/1.1–2、数据库连接、SSH、文件传输 | DNS、QUIC/HTTP/3、音视频实时通信（WebRTC）、游戏同步 |

**TCP 与 UDP 可以使用同一个端口号**（例如 DNS 同时使用 TCP 53 与 UDP 53，HTTP/2 与 HTTP/3 同用 443）：内核收到 IP 包后先依据 IP 头部的**协议号**（`6` 为 TCP、`17` 为 UDP）分发给完全独立的两个传输层模块，再在各自模块内按端口号查找 Socket。

### 3.1.3 面向字节流本质、应用层分帧与 MSS {#ch3-1-3}

UDP 面向报文，发送端调用一次 `sendto()` 对应接收端一次 `recvfrom()` 读出完整消息；而 **TCP 面向字节流**——内核将应用写入的数据视为一条连续无边界的字节管道。发送端两次 `write("hello")` 和 `write("world")` 可能因 Nagle 算法、窗口大小或缓冲区状态被合并为一个段发走，也可能一次大 `write()` 被拆成多个 MSS 段；接收端 `read()` 同样只返回接收缓冲区中当前已按序到达的任意连续字节。

> **纠偏两处常见误区**：
> 1. **不存在所谓“TCP 粘包”缺陷**：原书 4.6 节将其归因于“发送方机制”并沿用“粘包”称呼。严谨来说，TCP 规范（RFC 9293）本就不承诺保留应用层消息边界，发送端合包/拆包与接收端流式读取都是字节流协议的正常行为，应用层**必须自行定义分帧（Framing）协议**。
> 2. **HTTP/1.1 并非只靠回车换行划分报文**：原书 4.6 节称“HTTP 通过 `\r\n` 作为报文边界”并不准确——`\r\n` 仅分隔起始行与各个首部行，`\r\n\r\n` 仅分隔**头部与消息体**；完整 HTTP/1.1 报文体的结束边界必须依靠 **`Content-Length`**、**`Transfer-Encoding: chunked`** 或连接关闭（EOF）来确定（详见[第 6 章 HTTP 报文边界](./chapter-06#ch6-1-3)）。

主流应用层分帧方案有三类：**定长消息**（浪费空间，少用）、**特殊分隔符**（如 Redis RESP 的 `\r\n`，载荷含分隔符需转义或配长度）、**长度前缀（Length-Prefixed）**（最常用，如 HTTP/2 帧、gRPC、MySQL 协议：固定头部携带大端字节序的长度字段，再紧跟变长载荷）。

**为何有 IP 分片还需要 TCP MSS？** IP 层本身没有重传机制：如果一个 4000 B 的 TCP 段被 IP 层切成 3 个分片，只要中途丢了 1 个分片，接收方 IP 层就必须丢弃整组 3 个分片，触发 TCP 重传全部 4000 B；而 TCP 提前按 **MSS**（约 1460/1448 B）分段后，每个段独立封装在单个 MTU 内，丢包时只需精准重传丢失的那 1 个段。

### 3.1.4 序列号与确认号递推规则 {#ch3-1-4}

在无乱序的正常收发场景下，序列号（`seq`）与确认号（`ack`）遵循统一的消耗规律：**每 1 字节应用载荷消耗 1 个序号，`SYN` 与 `FIN` 各消耗 1 个序号，纯 `ACK` 不消耗序号**（若 `SYN`/`FIN` 同时携数据如 TFO，则总消耗为 `len + 1`）。

- **发送方下一个新段**：`next_seq = prev_sent_seq + prev_sent_len + (prev_is_SYN_or_FIN ? 1 : 0)`；重传时 `seq` 保持不变。
- **接收方确认号**：始终等于**连续按序收到的最大字节序号 + 1**（即内核 `RCV.NXT`），遇到乱序到达的后续段时确认号保持停留在空洞起点，绝不越过空洞确认。

## 3.2 三次握手状态机、ISN 安全与异常丢包 {#ch3-2}

### 3.2.1 三次握手流程与“为何是三次” {#ch3-2-1}

```text
客户端 (CLOSED)                                        服务端 (LISTEN)
  │                                                         │
  │ ─── 1. SYN (seq = c_isn) ─────────────────────────────> │ 进 SYN_RCVD
  │ (进 SYN_SENT)                                            │ (入半连接队列)
  │ <── 2. SYN+ACK (seq = s_isn, ack = c_isn + 1) ───────── │
  │                                                         │
  │ ─── 3. ACK (seq = c_isn + 1, ack = s_isn + 1) [可携数据]─> │ 进 ESTABLISHED
  │ (进 ESTABLISHED)                                         │ (移入全连接队列)
```

TCP 建连为何必须是**三次握手**，而不是两次或四次？核心原因有三（第一条为 RFC 9293 强调的根本原因）：

1. **阻止历史重复连接初始化（最核心）**：网络拥堵时，客户端旧的 `SYN(seq=90)` 滞留，客户端超时重发或重启后发新 `SYN(seq=100)`；若旧 `SYN(90)` 抢先到达服务端，服务端回 `SYN+ACK(ack=91)`。在三次握手下，客户端比对上下文发现期望的是 `101` 而非 `91`，立即回复 **`RST`** 终止历史连接，防止服务端建立僵尸连接并误收旧数据。若只有两次握手，服务端一收到旧 `SYN` 就直接进入 `ESTABLISHED` 开始分配资源发数据，无法借助客户端上下文拦截历史连接。
2. **可靠同步双方初始序列号（ISN）**：双方向各自发送 `SYN` 并获得对端 `ACK` 确认（原本是四步，因服务端可将自己的 `SYN` 与对客户端的 `ACK` 合并在第二次握手中，故收敛为三次，无需四次）。
3. **避免服务端资源浪费**：两次握手下若客户端因网络慢重传多次 `SYN`，每次滞留的 `SYN` 都会让服务端多建一条无效连接。

### 3.2.2 随机 ISN 生成与时间戳 PAWS 保护 {#ch3-2-2}

若每次建连都从固定序号（如 `0` 或 `1`）起步，一旦旧连接异常中断（未经历 `TIME_WAIT`）后迅速建立同四元组新连接，网络中滞留的旧数据包极易落入新连接的接收窗口造成数据污染；同时固定序号也极易被盲目伪造 RST/数据注入攻击。

因此 **RFC 6528 / RFC 9293** 规定 ISN 必须不可预测且单调演进：`ISN = M + F(local_ip, local_port, remote_ip, remote_port, secret_key)`。
- **校准原书 4.1/4.7 节**：原书将上述哈希公式归于 RFC 793 并推荐 MD5。实际上 RFC 793 仅有每 4 µs 加 1 的时钟项 `M`（无哈希）；现代 Linux（4.12+ `secure_tcp_seq()`）采用密码学安全的 **SipHash** 配合 **64 ns 高精度时钟**生成 ISN。

由于 32 位序列号空间仅 4 GiB，在高速网络（如 10 Gbps 链路）下数秒即可回绕一圈。为此 RFC 7323 引入 **TCP Timestamps** 选项（选项本身 10 字节，对齐后占 12 字节，Linux 默认 `net.ipv4.tcp_timestamps = 1`；Linux 4.10+ 采用 1 ms 单调时钟叠加每连接随机偏移）与 **PAWS（防回绕序列号算法）**：接收方记录 `TS.Recent`，直接丢弃时间戳小于已收最新时间戳的过期报文。注意内核 `tcp_paws_check()` 为防止超长空闲连接（超过 24 天，即 32 位毫秒时间戳回绕一半的 `TCP_PAWS_24DAYS`）被误杀，对连续 24 天无流量的首个报文会放行跳过 PAWS 检查。

### 3.2.3 三次握手各阶段丢包行为（Linux 6.12 校准） {#ch3-2-3}

| 丢包阶段 | 触发行为与内核控制参数 | Linux 6.12 LTS 默认行为（纠正原书 2.6.32 旧值） |
| --- | --- | --- |
| **第 1 次 `SYN` 丢包** | 客户端 `SYN_SENT` 收不到 `SYN+ACK`，指数退避重传 `SYN` | `net.ipv4.tcp_syn_retries` **默认值为 `6`**（原书基于 CentOS 6.5 写为 `5`），退避间隔 1, 2, 4, 8, 16, 32 s，再等 64 s 后报错 `ETIMEDOUT`，总耗时约 **127 秒**（原书 `5` 次对应 63 秒） |
| **第 2 次 `SYN+ACK` 丢包** | 双端同时超时重传：客户端重传 `SYN`，服务端在 `SYN_RCVD` 重传 `SYN+ACK` | 客户端受 `tcp_syn_retries`（默认 `6`）控制；服务端受 `net.ipv4.tcp_synack_retries`（默认 **`5`**，约 63 秒后销毁半连接）控制 |
| **第 3 次 `ACK` 丢包** | 纯 `ACK` 本身**绝不重传**；服务端因停在 `SYN_RCVD` 超时重传 `SYN+ACK`（受 `tcp_synack_retries` 控制） | 客户端此时已进入 `ESTABLISHED`：若客户端紧接着发送首个应用数据包（自带 `ACK=1` 且 `seq`/`ack` 与第 3 次握手完全一致），**服务端在 `SYN_RCVD` 收到该数据包即可自动完成建连并接收数据**；若双方均不发数据，服务端 5 次重传 `SYN+ACK` 后单方面清理半连接，客户端则保持假存活直至发数据超时（`tcp_retries2`）或 Keepalive 探测失败 |

## 3.3 半连接队列、全连接队列与 SYN Flood 防御 {#ch3-3}

### 3.3.1 Socket 建连时序与无 `accept` / 无 `listen` 边界 {#ch3-3-1}

服务端标准调用链为 `socket()` → `bind()` → `listen()` → `accept()`；客户端为 `socket()` → `connect()`。两个高频认知边界必须清晰区分：

- **`connect` 与 `accept` 发生时机**：客户端 `connect()` 发出第 1 次 `SYN` 后阻塞，收到第 2 次 `SYN+ACK` 并发出第 3 次 `ACK` 后即返回成功；服务端 `accept()` 并不参与三次握手，它只负责在三次握手完成后，从内核**全连接队列**队头取出一条已建好连接的 Socket 返回给进程。
- **没有 `accept()` 能建立连接吗？** **可以。**只要服务端调用了 `listen()`，三次握手全权由内核协议栈完成并入全连接队列；在队列未满前，客户端甚至能正常向已建连接发送数据（缓存在内核接收缓冲区中，待 `accept()` 后读出）。
- **没有 `listen()` 能建立连接吗？** 常规情况下，服务端仅 `bind()` 不 `listen()` 时，内核查不到监听 Socket 会直接回 **`RST`**。但存在两个协议级特例可以不经 `listen()` 建连：**TCP 自连接（Self-Connect）**（客户端 `connect` 自己分配的同 IP 同端口）与 **TCP 同时打开（Simultaneous Open）**（双方互相 `connect` 对方端口）。原理在于 `connect()` 会先把本地 Socket 注册进内核全局哈希表 `ehash`，入站 `SYN` 命中该 `SYN_SENT` 态 Socket 后即可完成四次对称握手（无 `SYN+ACK` 合并或双方各发 `SYN` 与 `SYN+ACK`）。

### 3.3.2 半连接队列与全连接队列的现代内核实现 {#ch3-3-2}

```text
客户端 SYN ──> [半连接队列 (SYN Queue, SYN_RCVD)] ──收到第3次ACK──> [全连接队列 (Accept Queue, ESTABLISHED)] ──accept()──> 应用进程
```

1. **全连接队列（Accept Queue）**：本质为挂载在监听 Socket 下的链表（队头 `accept()` 取连接为 `O(1)`），队列最大长度由两参数取较小值决定：
   ```text
   全连接队列最大长度 = min(listen() 的 backlog 参数, net.core.somaxconn)
   ```
   - **Linux 5.4+ 重大默认值更新**：原书 4.4 节实验基于 Linux 2.6.32，`net.core.somaxconn` 默认仅 `128`。自 **Linux 5.4+**（含 6.12 LTS）起，`somaxconn` 默认值已大幅提高至 **`4096`**（Nginx 默认 `backlog=511`，若未调大 Nginx 配置的 `listen ... backlog=4096`，仍会被应用层 `backlog` 卡在 511；修改 `somaxconn` 后必须重启服务重新调用 `listen()` 才生效）。
   - **队列观测**：用 **`ss -lnt`** 查看 `LISTEN` 态 Socket——此时 `Recv-Q` 表示**当前全连接队列排队数**，`Send-Q` 表示**全连接队列最大容量**（注意：非 `LISTEN` 态下这两列分别表示接收/发送缓冲区字节数）。溢出计数用现代命令 **`nstat -az TcpExtListenOverflows TcpExtListenDrops`** 查看（替代原书 `netstat -s`）。
   - **溢出策略 `net.ipv4.tcp_abort_on_overflow`**：默认 `0`（静默丢弃第 3 次握手 `ACK` 并按定时器重传 `SYN+ACK`，给突发流量留出消化窗口）；设为 `1` 时直接回 `RST`（客户端报 `Connection reset by peer`，适合确认持续溢出时快速失败）。

2. **半连接队列（SYN Queue）的现代演进**：
   - 原书 4.4 节花了大量篇幅分析 Linux 2.6.32 中每监听 Socket 独立哈希表 `syn_table` 及其 `max_qlen_log` 移位公式。自 **Linux 4.4** 起，内核已**彻底重构 SYN 处理路径**：移除了每监听 Socket 独立的 `syn_table`，半连接请求对象（`TCP_NEW_SYN_RECV`）直接**无锁插入全局 `ehash` 哈希表**，极大地提升了多核建连吞吐；其逻辑排队上限直接受监听队列容量（`sk_max_ack_backlog`）与 `net.ipv4.tcp_max_syn_backlog`（现代大内存主机默认常为 `4096` 或更高）协同约束。
   - 当**全连接队列已满**时，新到达的 `SYN` 也会触发 `TcpExtListenDrops` 被丢弃；因此 `SYNs to LISTEN sockets dropped`（即 `ListenDrops`）递增可能是半连接满、全连接满或内存不足所致，不可单一归因于半连接队列溢出。

### 3.3.3 SYN 丢弃全场景与 SYN Flood 防御 {#ch3-3-3}

除了半/全连接队列满导致 `SYN` 被丢弃外，历史上还有一个著名生产大坑：**Linux 4.12 之前同时开启 `tcp_tw_recycle = 1` 与 `tcp_timestamps = 1`** 会激活 **per-host PAWS**（按源 IP 而非四元组校验时间戳），导致 NAT 网关后的多台客户端因各自系统时钟不同而触发服务端静默丢弃合法 `SYN`。由于 Linux 4.10+ 引入了每连接随机时间戳偏移，per-host PAWS 彻底失效，**`tcp_tw_recycle` 已于 Linux 4.12 被彻底移除**（详见[第 4 章 `TIME_WAIT` 治理](./chapter-04#ch4-2-3)）。

面对伪造海量源 IP 填满半连接队列的 **SYN Flood 攻击**，核心防御组合如下：
1. **启用 SYN Cookies（Linux 6.12 默认 `net.ipv4.tcp_syncookies = 1`）**：
   - 取值含义：`0` 关闭、`1` **仅在半连接队列满时自动启用**（校准原书 4.21 节误称 `1` 为无条件启用）、`2` 无条件启用。
   - **原理**：半连接队列满时，内核不再分配半连接内存，而是将四元组、MSS 索引与时间戳经密码学哈希算出 24 位 Cookie 编码进 `SYN+ACK` 的 `ISN` 中返回；收到合法第 3 次 `ACK` 后重算哈希校验通过，直接创建连接塞入全连接队列。
   - **为何不直接用 SYN Cookies 取代半连接队列？** ① 服务端不保存状态，无法重传丢失的 `SYN+ACK`；② 若未开启 `tcp_timestamps`，Cookie 仅能编码极有限的 MSS，会**丢失 Window Scale、SACK、ECN 等高性能 TCP 扩展选项**；③ 每次收到伪造 `ACK` 都需做哈希校验消耗 CPU（易遭 ACK Flood 放大）。
2. **联动扩容队列与加速回收**：同步调大 `net.core.netdev_max_backlog`、`net.ipv4.tcp_max_syn_backlog`、`net.core.somaxconn` 与应用层 `listen backlog`，并适当调小 `net.ipv4.tcp_synack_retries`（如降至 `2`–`3`）加快清理伪造半连接。
3. **网卡前置卸载**：高强度 DDoS（千万 PPS 级）应在网关或网卡驱动层结合 **eBPF/XDP SYN Proxy** 直接拦截，不让攻击包进入内核协议栈。

## 3.4 建连性能优化与 TCP Fast Open 现状 {#ch3-4}

常规 TCP 建连至少消耗 **1 RTT**，叠加 TLS 1.3 还需额外 **1 RTT**。为压榨建连延迟，Linux 3.7+ 实现了 **TCP Fast Open（TFO，RFC 7413）**：

```text
首次建连 (仍需 1 RTT):  Client ──SYN (含 Fast Open Cookie 请求)──> Server
                       Client <──SYN+ACK (返回加密 TFO Cookie)──── Server
                       Client ──ACK + HTTP 请求──────────────────> Server

后续建连 (0-RTT 携数据): Client ──SYN + TFO Cookie + HTTP 请求────> Server (校验Cookie合法直接交应用)
                       Client <──SYN+ACK + HTTP 响应────────────── Server (1 RTT 拿到响应!)
```

- **内核参数**：`net.ipv4.tcp_fastopen` 是位掩码，**Linux 6.12 默认值为 `1`**（仅客户端开启）；`2` 为服务端开启、`3` 为双端开启、`0x400` 可全局强制所有监听 Socket 启用 TFO 而无需应用调用 `setsockopt(TCP_FASTOPEN)`。
- **2026 生产现状校准**：尽管原书 4.3/4.5/4.15 节大力推崇 TFO（及 TFO + TLS 1.3 并行握手），但在真实公网上，大量老旧防火墙、NAT 网关和运营商中间盒会**直接丢弃携带数据载荷或 TFO 选项的 `SYN` 包**（协议僵化，Ossification），引发长达数秒的重传回退，且 TFO 首包数据存在重放攻击风险（仅限幂等请求）。因此 **Chrome、Firefox、Safari 等主流浏览器与移动端系统已普遍默认禁用或移除了 TFO**；在可控的内网/专线机房中 TFO 仍有微秒至毫秒级收益，而公网场景下的低延迟建连已被基于 UDP 的 **QUIC（HTTP/3）** 全面接棒（见[第 6 章 QUIC](./chapter-06#ch6-4)）。

## 练习 {#ch3-exercises}

本节包含 4 道递进练习，覆盖三次握手与数据传输序号计算、半/全连接队列容量与溢出排查、无 `accept`/SYN 丢包边界分析以及 TCP 分帧协议设计。请先独立推演，再展开参考答案核对。

### 练习 1：推导三次握手与首批数据传输的 `seq` 与 `ack`

客户端与服务端建立 TCP 连接，设客户端随机 `ISN = 1000`，服务端随机 `ISN = 5000`。建连完成后，客户端立即发送一条 120 字节的 HTTP 请求，服务端收到后回复确认并携带 350 字节的 HTTP 响应：

1. 写出三次握手 3 个报文及上述 2 个数据报文的 `(标志位, seq, ack, len)`。
2. 若第 3 次握手的纯 `ACK` 在网络中丢失，但客户端紧接着发出的 120 字节 HTTP 请求成功到达服务端，连接能否正常建立并收到数据？为什么？

<details>
<summary>查看参考答案</summary>

1. **5 个报文的参数**：
   - 第 1 次握手（C → S）：`[SYN], seq = 1000, ack = 0, len = 0`（消耗 1 序号）
   - 第 2 次握手（S → C）：`[SYN, ACK], seq = 5000, ack = 1001, len = 0`（消耗 1 序号）
   - 第 3 次握手（C → S）：`[ACK], seq = 1001, ack = 5001, len = 0`（纯 ACK 不消耗序号）
   - 客户端发请求（C → S）：`[PSH, ACK], seq = 1001, ack = 5001, len = 120`（`seq` 与第 3 次握手相同）
   - 服务端回响应（S → C）：`[PSH, ACK], seq = 5001, ack = 1121, len = 350`（`ack = 1001 + 120`）
2. **第 3 次握手丢包仍可建连**：**可以正常建立并接收数据。**因为第 3 次握手纯 `ACK` 长度为 0，不消耗序列号；客户端发出的 120 字节请求报文同样置位了 `ACK=1` 且携带完全相同的 `seq = 1001, ack = 5001`。处于 `SYN_RCVD` 的服务端收到该报文后，确认了 `ack = 5001`，随即将其推进至 `ESTABLISHED` 状态并正常把 120 字节载荷写入接收缓冲区。

</details>

### 练习 2：诊断 Nginx 压测下的全连接队列溢出

某 Linux 6.12 服务器（`net.core.somaxconn = 4096`）运行 Nginx 服务（`listen 80;` 未显式配置 `backlog`，Nginx 默认 `backlog = 511`）。高并发压测时客户端出现大量偶发建连卡顿 1 秒、3 秒的现象，执行以下命令观察到如下输出：

```text
$ ss -lnt 'sport = :80'
State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port
LISTEN  512     511     0.0.0.0:80           0.0.0.0:*

$ nstat -az TcpExtListenOverflows TcpExtListenDrops
TcpExtListenOverflows           1842
TcpExtListenDrops               1842
```

1. 为何 `somaxconn` 已经是 4096，`Send-Q` 却依然停留在 `511`？为何 `Recv-Q` 出现了 `512`（比 `Send-Q` 多 1）？
2. 为何客户端表现为“偶发卡顿 1 秒、3 秒”而不是立即报 `Connection reset by peer`？
3. 给出完整的修复步骤。

<details>
<summary>查看参考答案</summary>

1. **上限受限于 `backlog`**：全连接队列上限为 `min(somaxconn, listen backlog) = min(4096, 511) = 511`，因此仅调大内核 `somaxconn` 而不调大 Nginx `backlog` 无效。Linux 内核判定全连接队列满的条件是 `sk_ack_backlog > sk_max_ack_backlog`（严格大于），故满队时 `Recv-Q` 可达 `Send-Q + 1 = 512`。
2. **卡顿 1 s / 3 s 的根因**：Linux 默认 `net.ipv4.tcp_abort_on_overflow = 0`，全连接队列满时服务端静默丢弃第 3 次握手 `ACK` 并按 1 s、2 s（累计 3 s）指数退避重传 `SYN+ACK`，直到队列空出或超时，因此客户端不会立刻收到 `RST`，而是表现为建连慢。
3. **修复步骤**：
   - 修改 Nginx 配置为 `listen 80 backlog=4096;` 并重载/重启使 `listen()` 重新生效（同时确认 `somaxconn >= 4096`）；
   - 更关键的是排查 Nginx Worker 进程为何 `accept()` 消费变慢（如 Worker 数量不足、同步阻塞逻辑或 CPU 跑满），因为单纯调大队列只能吸收短时突发，无法解决长期消费能力不足。

</details>

### 练习 3：设计简洁可靠的 TCP 应用层二进制分帧格式

现需基于裸 TCP Socket 在 C/Go 微服务间传输变长 JSON 或 Protobuf 消息，单条消息最大 16 MiB。请设计一个具备版本演进能力且避免字节序与对齐陷阱的帧头格式，并写出接收端解码状态机的核心步骤。

<details>
<summary>查看参考答案</summary>

- **推荐长度前缀（Length-Prefixed）帧头（8 字节定长，大端网络字节序）**：

```text
+------------------+------------------+-----------------------------------+
| Magic/Ver (2 B)  | MsgType (2 B)    | PayloadLength (4 B, uint32 大端)   |
+------------------+------------------+-----------------------------------+
|                     Payload (PayloadLength 字节)                         |
+-------------------------------------------------------------------------+
```

- **解码核心步骤**：
  1. 维护每连接接收字节缓冲，循环 `read()` 追加新到达字节；
  2. 若缓冲可读字节 `< 8`，继续等待下次 `read()`（处理拆包）；
  3. 读取前 8 字节，使用 `ntohs`/`ntohl`（或 Go `binary.BigEndian`）解析 `Magic/Ver`、`MsgType` 和 `PayloadLength`，并校验 `PayloadLength <= 16 MiB`（防止恶意超大长度头引发 OOM）；
  4. 若缓冲剩余字节 `< PayloadLength`，保留缓冲继续等待；
  5. 凑齐后切片取出完整 `Payload` 交付业务解码，并将缓冲读指针后移 `8 + PayloadLength` 字节，回到步骤 2 继续循环处理缓冲区中可能紧邻的下一条消息（处理合包）。

</details>

### 练习 4：辨析无 `accept` 与无 `listen` 下的建连表现

分别写出以下两个实验的现象及内核依据：
1. 服务端调用 `socket() → bind() → listen(fd, 128)` 后直接 `sleep(60)` 不调用 `accept()`，此时 1 个客户端发起 `connect()` 并立即 `write("hello", 5)`；
2. 服务端调用 `socket() → bind()` 后直接 `sleep(60)` 不调用 `listen()`，此时客户端向该端口发起 `connect()`。

<details>
<summary>查看参考答案</summary>

1. **有 `listen` 无 `accept`**：客户端 `connect()` **立即成功**（进入 `ESTABLISHED`），`write("hello", 5)` 也能成功发送并收到服务端内核回复的 `ACK`。该连接安静地停留在服务端全连接队列中，`hello` 停留在其内核接收缓冲区里；60 秒后服务端唤醒并调用 `accept()` 取出 fd，调用 `read()` 可完整读出 `"hello"`。
2. **有 `bind` 无 `listen`**：服务端 Socket 仍停留在 `CLOSE` 态，未加入内核监听哈希表。客户端发出 `SYN` 后，服务端内核查找不到匹配连接与监听 Socket，立即回复 **`RST`**；客户端 `connect()` 迅速失败并报错 `ECONNREFUSED`（Connection refused）。

</details>

## 面试题 {#ch3-interview}

本节精选 5 道高频 TCP 建连与队列面试题，聚焦底层依据与版本边界；请先独立作答，再展开核对。

### 面试题 1：为什么 TCP 建立连接需要三次握手？两次握手不行吗？

<details>
<summary>查看参考答案</summary>

**结论**：核心原因是**阻止历史重复连接初始化（防旧 `SYN` 建僵尸连接）**，同时可靠同步双方初始序列号（ISN）并避免服务端资源浪费。

**关键依据**：
- 网络中滞留的旧 `SYN` 若在两次握手下到达服务端，服务端收到即刻进入 `ESTABLISHED` 分配资源甚至发数据，无法分辨这是历史包；
- 三次握手引入客户端的“回执确认”步骤：客户端收到针对旧 `SYN` 的 `SYN+ACK` 时，根据本地上下文发现确认号不匹配，直接回复 **`RST`** 取消该历史连接，服务端只有在收到合法第 3 次 `ACK` 后才真正建立连接。

</details>

### 面试题 2：为什么说“TCP 粘包”是个伪命题？实际开发中如何解决？

<details>
<summary>查看参考答案</summary>

**结论**：TCP 是**面向字节流**的无边界传输协议，协议本身只保证字节顺序与可靠送达，不承诺“一次 `send` 对应一次 `recv`”，所谓“粘包/拆包”只是应用层未定义消息边界的表现。

**关键依据**：
- 内核发送端会依据 MSS、Nagle 算法与拥塞/接收窗口自由合包或拆包，接收端按缓冲区已有字节连续交付；
- 解决思路全在应用层定义**分帧（Framing）**：最主流的是**长度前缀**（如 HTTP/2 帧头、gRPC、自定义 `Header(len)+Body`），其次是**明确分隔符**（如 `\r\n` 配合转义，或 HTTP/1.1 的 `\r\n\r\n` + `Content-Length`/`chunked`）与**定长消息**。

</details>

### 面试题 3：既然 SYN Cookies 不占半连接队列内存就能抗 SYN Flood，为什么 Linux 不直接用它彻底取代半连接队列？

<details>
<summary>查看参考答案</summary>

**结论**：SYN Cookies 是队列溢出时的**降级兜底机制**，因为无状态设计会牺牲重传能力、丢弃多项 TCP 高性能选项并带来 CPU 计算开销。

**关键依据**：
1. **无法重传 `SYN+ACK`**：不保留半连接状态，第 2 次握手丢失时只能等客户端超时重传 `SYN`，拉长弱网建连耗时；
2. **丢失 TCP 扩展选项**：32 位序列号编码空间极小，若未开启 `tcp_timestamps` 借位存放，将丢失 **Window Scale、SACK、ECN** 等关键选项，严重制约大带宽吞吐；
3. **易受 ACK 攻击放大**：无条件校验每个伪造 `ACK` 的加密哈希会白白消耗大量 CPU，因此 Linux 默认 `tcp_syncookies = 1`（仅在半连接队列满时触发）。

</details>

### 面试题 4：在 Linux 6.12 上，如果客户端发出的第 1 次 `SYN` 被丢弃，`connect()` 默认大概会阻塞多久才报超时？怎么排查是半连接溢出还是全连接溢出？

<details>
<summary>查看参考答案</summary>

**结论**：Linux 6.12 默认 `net.ipv4.tcp_syn_retries = 6`，按 1, 2, 4, 8, 16, 32 s 重传并再等 64 s，总计约 **127 秒**后返回 `ETIMEDOUT`（注意：老旧 Linux 2.6.32 默认为 `5` 次约 63 秒）。

**关键依据（溢出排查）**：
- 查全连接队列：`ss -lnt` 对比 `Recv-Q`（当前排队）与 `Send-Q`（上限 `min(somaxconn, backlog)`），配合 `nstat -az TcpExtListenOverflows` 看全连接溢出增量；
- 查半连接压力：统计 `ss -nt state syn-recv | wc -l` 与 `nstat -az TcpExtListenDrops TcpExtSyncookiesSent`（注意 `ListenDrops` 同时包含全连接满、半连接满与内存不足，需结合 `ListenOverflows` 与 `SyncookiesSent` 交叉判定）。

</details>

### 面试题 5：TCP Fast Open（TFO）能省去 1 RTT 建连时间，为什么现代公网浏览器基本都不默认启用它？

<details>
<summary>查看参考答案</summary>

**结论**：受困于公网**中间盒协议僵化（Ossification）**导致的丢包退化与首包重放风险，公网低延迟建连已被 **QUIC（HTTP/3）** 取代。

**关键依据**：
- 大量企业防火墙、老旧 NAT 与运营商设备会对携带数据载荷或未知 TCP 选项的 `SYN` 包直接丢弃，引发数秒超时回退，收益反成负优化；
- TFO 依赖双端内核升级且仅限幂等请求防重放；而基于 UDP 的 **QUIC** 运行在用户态、全加密避开了中间盒干扰，原生集成 TLS 1.3 实现 1-RTT/0-RTT 建连，成为公网标准解法。

</details>

## 参考资料

- [RFC 9293: Transmission Control Protocol (TCP)（正式取代 RFC 793）](https://datatracker.ietf.org/doc/html/rfc9293)
- [RFC 7323: TCP Extensions for High Performance（Window Scale / Timestamps / PAWS）](https://datatracker.ietf.org/doc/html/rfc7323)
- [RFC 6528: Defending against Sequence Number Attacks](https://datatracker.ietf.org/doc/html/rfc6528)
- [RFC 7413: TCP Fast Open](https://datatracker.ietf.org/doc/html/rfc7413)
- [Linux Kernel Documentation: IP Sysctl (`tcp_syn_retries`, `tcp_syncookies`, `tcp_fastopen`, `somaxconn`)](https://docs.kernel.org/networking/ip-sysctl.html)
- [Linux Programmer's Manual: `tcp(7)` 与 `ss(8)`](https://man7.org/linux/man-pages/man7/tcp.7.html)
