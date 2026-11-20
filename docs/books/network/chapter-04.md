---
title: 第 4 章 TCP 连接断开、TIME_WAIT 与边界异常处理
description: 系统梳理 TCP 四次挥手、三次挥手合并与 close/shutdown 差异，深度解析 TIME_WAIT/CLOSE_WAIT 治理、已建连与 TIME_WAIT 收到 SYN/RST 的内核状态机边界，以及断电、崩溃、拔网线与保活机制。
---

# 第 4 章 TCP 连接断开、TIME_WAIT 与边界异常处理

## 本章要点

如果说 TCP 建连考验的是队列容量，那么**连接断开与异常状态机边界**考验的则是对协议细节的真正掌握——线上大量的端口耗尽、FD 泄漏、`Connection reset by peer` 与僵尸连接，几乎全源自挥手和异常边界处理不当。本章整合原书《图解网络》中分散且高度重复的挥手与状态机章节（4.1 后半、4.5 挥手、4.9–4.14、4.16、4.23 与 4.24 挥手部分），以 **RFC 9293**、**RFC 5961** 与 **Linux 6.12 LTS** 为准绳进行全面校准：重点纠正原书 4.11 节将 `TIME_WAIT` 收到 `SYN` 的内核源码条件 `||` 误读为 `&&` 的关键错误，更新 `tcp_tw_reuse` 默认值（`2`）与 `tcp_tw_recycle` 移除事实，并补齐进程崩溃有未读数据发 `RST`、`TCP_USER_TIMEOUT` 与原生 `ss -K` 断连工具。

读完本章后，应能完整推导四次挥手（含同时关闭与合并为三次挥手）及乱序 `FIN` 处理，精准诊断并治理服务端海量 `TIME_WAIT` 与 `CLOSE_WAIT`，准确判断 `ESTABLISHED` / `TIME_WAIT` 收到 `SYN` 或 `RST` 时的内核响应，并能清晰区分进程崩溃、主机断电、拔网线与 TCP/HTTP 保活机制。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 9293、RFC 5961、RFC 5482（`TCP_USER_TIMEOUT`）、RFC 1337 及 Linux 6.12 LTS 内核 TCP 状态机源码。

## 4.1 四次挥手、三次挥手合并与 `close`/`shutdown` {#ch4-1}

### 4.1.1 四次挥手状态机、同时关闭与三次挥手条件 {#ch4-1-1}

TCP 是**全双工**协议，双向数据流独立关闭，因此正常断开需要四次交互：

```text
主动关闭方 (ESTABLISHED)                               被动关闭方 (ESTABLISHED)
  │                                                         │
  │ ─── 1. FIN (seq = u) ─────────────────────────────────> │ 进 CLOSE_WAIT (向应用递交 EOF)
  │ (进 FIN_WAIT_1)                                          │
  │ <── 2. ACK (ack = u + 1) ────────────────────────────── │
  │ (进 FIN_WAIT_2)                                          │  (继续发完剩余数据，再调 close)
  │ <── 3. FIN (seq = w, ack = u + 1) ───────────────────── │ 进 LAST_ACK
  │                                                         │
  │ ─── 4. ACK (seq = u + 1, ack = w + 1) ────────────────> │ 进 CLOSED
  │ (进 TIME_WAIT，等待 2MSL = 60s 后进 CLOSED)               │
```

- **为何通常需要四次？** 被动关闭方内核收到第 1 次 `FIN` 后，会立刻回复第 2 次 `ACK` 并将 `EOF` 放入接收缓冲区通知应用层；但何时发送第 3 次 `FIN` 取决于被动方应用进程何时处理完待发数据并调用 `close()`，因此内核的 `ACK` 与应用的 `FIN` 通常分开发送。
- **何时合并为三次挥手？** 当被动关闭方同时满足两个条件——① **没有待发送的响应数据**；② **开启了 TCP 延迟确认（Delayed ACK，默认开启）**——内核收到 `FIN` 后暂缓 40–200 ms 发 `ACK`，若在此窗口内被动方应用迅速读到 `EOF` 并调用 `close()`，内核就会把第 2 次 `ACK` 与第 3 次 `FIN` 合并为一个 `FIN+ACK` 发出，抓包表现为**三次挥手**。若在读到 `0` 后立即设置 `TCP_QUICKACK`（注意该选项在 Linux 中**非永久生效**，仅单次有效），则会强制拆回标准四次挥手。
- **同时关闭（Simultaneous Close）**：若两端同时调用 `close()` 互发 `FIN`，双方先后进入 `FIN_WAIT_1` → 收到对方 `FIN` 后不进 `FIN_WAIT_2`，而是双双进入 **`CLOSING`** 状态 → 各自回复 `ACK` 并收到对端 `ACK` 后双双进入 **`TIME_WAIT`**。

### 4.1.2 `close()` 与 `shutdown()` 的本质差异及各步丢包 {#ch4-1-2}

| 对比维度 | `close(fd)`（粗暴关闭） | `shutdown(fd, how)`（优雅关闭） |
| --- | --- | --- |
| **多进程/引用计数** | 仅将 Socket 引用计数减 1，归零时才真正发 `FIN` | 无视引用计数，立即对底层连接生效 |
| **方向控制** | 同时关闭读、写双向；若对端后续又发来数据，本机内核直接回 **`RST`** | 支持精确半关闭：`SHUT_WR` 只发 `FIN` 关闭写方向，**仍可继续读取对端剩余数据**；`SHUT_RD` 仅关读，不发 `FIN` |
| **孤儿连接与超时** | 进程释放了 fd，内核留存的连接成为**孤儿连接（Orphan）**，受 `tcp_orphan_retries`、`tcp_fin_timeout`（默认 60 s）与 `tcp_max_orphans` 强制兜底 | 进程仍持有 fd，**不是孤儿连接**；`FIN_WAIT_2` 状态**不受 `tcp_fin_timeout` 限制**，可无限等待对端发 `FIN` |

> **关键校准**：原书 4.5 节称 `tcp_orphan_retries` 对所有 `FIN_WAIT_1` 连接都有效。实际上在 Linux 内核 `tcp_write_timeout()` 中，仅当 Socket 标记了 `SOCK_DEAD`（即由 `close()` 产生的孤儿连接）时，才受 **`net.ipv4.tcp_orphan_retries`**（默认 `0`，源码中 `0` 特指重传 **8 次**）约束；若由 `shutdown(SHUT_WR)` 进入 `FIN_WAIT_1`，FIN 重传走的是常规 **`tcp_retries2`**（默认 15 次）逻辑。此外，第 3 次 `FIN` 丢包由被动方重传，第 4 次 `ACK` 丢包时被动方在 `LAST_ACK` 重传 `FIN`，处于 `TIME_WAIT` 的主动方收到重传 `FIN` 后会重发 `ACK` 并**重置 2MSL 定时器**。

### 4.1.3 乱序 `FIN` 的内核处理 {#ch4-1-3}

假设客户端通过 `shutdown(SHUT_WR)` 进入 `FIN_WAIT_2`（仍可读），此时服务端连续发出的“数据包 1”和“第 3 次挥手 `FIN`”在网络中发生乱序，`FIN` 抢先抵达客户端。客户端内核**绝不会**立刻进入 `TIME_WAIT` 丢失数据包 1：内核检测到 `FIN` 的序列号大于期望值 `RCV.NXT`，会将其插入该连接的**乱序队列（红黑树 `out_of_order_queue`）**暂存；待迟到的数据包 1 抵达并被按序消费后，内核立即扫描乱序队列（`tcp_ofo_queue()`），取出连续的 `FIN` 交付 `EOF`、回复第 4 次 `ACK` 并安全转入 `TIME_WAIT`。

## 4.2 `TIME_WAIT` 深度剖析与工程治理 {#ch4-2}

### 4.2.1 为什么主动关闭方必须等待 `2MSL`？ {#ch4-2-1}

**只有主动关闭连接的一方（先发 `FIN` 者，或同时关闭的双方）才会进入 `TIME_WAIT`**，持续时间为 **2MSL**。MSL（Maximum Segment Lifetime）是报文在网络中的最大生存时间（与以跳数计量的 IP TTL 不同，TTL 无法严格保证 MSL）。Linux 内核将 `TCP_TIMEWAIT_LEN` 硬编码为 **`60 * HZ`（60 秒，不可通过 sysctl 修改）**，即默认 MSL 为 30 秒。

`TIME_WAIT` 承担两项不可替代的协议保障：
1. **防止历史连接延迟报文污染同四元组新连接**：等待 2MSL 足以让旧连接双向在途的所有延迟报文在网络中自然消亡，避免后续迅速复用的相同四元组新连接误收旧数据；
2. **保证被动关闭方可靠关闭**：若主动方发出的第 4 次 `ACK` 丢失，被动方会在 `LAST_ACK` 超时重传第 3 次 `FIN`。2MSL（去程 1 MSL + 回程 1 MSL）确保主动方仍在 `TIME_WAIT` 能够重发 `ACK`；若主动方发完第 4 次 `ACK` 就立刻 `CLOSED`，收到重传 `FIN` 时会回 **`RST`**，导致被动方异常报错。

### 4.2.2 服务端大量 `TIME_WAIT` 与 `CLOSE_WAIT` 的根因对比 {#ch4-2-2}

| 现象 | 真实含义 | 危害 | 常见线上根因 |
| --- | --- | --- | --- |
| **大量 `TIME_WAIT`** | **本机主动关闭了大量连接** | **客户端**：占满 `ip_local_port_range`（Linux 默认 **`32768 60999`**，共 28232 个端口）导致无法向**同一目的 IP:端口**发起新连接（仍可连其他目标）；<br>**服务端**：不占独立端口，但占用内核 `tw_sock` 内存（约几百字节/条）与哈希槽查找开销 | ① HTTP 短连接（`Connection: close`）下 Web 服务器发完响应主动断连；<br>② HTTP 长连接空闲超过 `keepalive_timeout` 被服务端回收；<br>③ 单条长连接请求数达到上限（Nginx `keepalive_requests`，自 **Nginx 1.19.10** 起默认已从 100 升至 **1000**）被服务端关闭；<br>④ 反向代理（如 Nginx）作为上游客户端频繁短连后端服务 |
| **大量 `CLOSE_WAIT`** | **对端已发 `FIN`，本机应用进程迟迟未调用 `close()`** | 无内核超时清理机制，长期堆积最终耗尽进程 FD 上限导致拒绝服务 | **几乎必定是应用代码 Bug**：读到 `EOF`（`read() == 0`）后漏调 `close()`、异常分支忘记释放 HTTP Response Body、线程池死锁或慢逻辑卡死导致无暇处理关闭事件 |

### 4.2.3 `TIME_WAIT` 参数治理与两大风险辨析 {#ch4-2-3}

1. **`net.ipv4.tcp_tw_reuse`（仅对客户端 `connect()` 生效）**：
   - **作用**：配合 `net.ipv4.tcp_timestamps = 1`，允许客户端 `connect()` 复用处于 `TIME_WAIT` 超过 **1 秒**的端口。
   - **Linux 6.12 默认值校准**：原书 4.14 节称其“默认关闭（`0`）”。实际上自 **Linux 4.12** 起，该参数新增了状态 `2` 并将其设为**默认值（`2`：仅对 `lo` 回环流量开启复用，`0` 完全关闭，`1` 全局开启）**。
   - **为何不默认全局开启（`1`）？** 缩短 `TIME_WAIT` 存在两个经典协议风险：① 内核 PAWS 检查按规范**对 `RST` 报文放行**（不因时间戳旧而丢弃），历史连接残余的延迟 `RST` 若恰好精确匹配新连接 `RCV.NXT`（遵循 RFC 5961）可能误杀新连接；② 若第 4 次 `ACK` 丢失导致被动方停在 `LAST_ACK`，主动方提前复用端口发 `SYN` 会收到被动方的 Challenge ACK 或重传 `FIN`，随即回 `RST` 破坏被动方优雅关闭。
2. **`tcp_tw_recycle` 历史教训**：该参数试图在服务端快速回收 `TIME_WAIT`，却因与 `tcp_timestamps` 联用触发按 IP 维度的 per-host PAWS，导致 NAT 环境下大规模丢弃合法 `SYN`；**Linux 4.12 已彻底删除该参数**，切勿再照搬旧文档配置。
3. **`net.ipv4.tcp_max_tw_buckets`**：按系统内存动态初始化（大内存服务器常见为 180,000 等，原书误少一个零写作 18000）；超限时内核强行清理旧 `TIME_WAIT` 并打印告警，属最后兜底手段而非根治方案。
4. **`SO_LINGER` 强关风险**：设置 `l_onoff = 1, l_linger = 0` 会让 `close()` 直接发 `RST` 跳过四次挥手与 `TIME_WAIT`，可能截断未发完数据并引发对端报错，正常业务严禁使用。

**工程最佳实践**：尽量让客户端主动发起关闭；在网关/反向代理访问后端服务时，务必开启**上游 HTTP 长连接池**（如 Nginx `upstream keepalive`），从源头消灭高频短连接；若高并发短连客户端仍遇端口紧张，可适度扩宽 `ip_local_port_range`（如 `10240 65000`）并开启 `tcp_tw_reuse = 1`。

## 4.3 异常状态机边界：已建连与 `TIME_WAIT` 收到 `SYN`/`RST` {#ch4-3}

### 4.3.1 `ESTABLISHED` 收到 `SYN` 与 RFC 5961 Challenge ACK {#ch4-3-1}

场景：客户端与服务端处于 `ESTABLISHED`，客户端突然断电重启（丢失所有连接状态），随后再次向服务端发起 `SYN`。
- **新 `SYN` 源端口不同**：服务端视作一条全新连接正常完成三次握手；旧连接在服务端下一次发数据时收到客户端 `RST` 销毁（或由 Keepalive 清理）。
- **新 `SYN` 源端口相同（四元组完全一致）**：依据 **RFC 5961**（并入 RFC 9293），Linux `tcp_validate_incoming()` 检查序列号落入窗口后发现 `SYN` 标志，**不会直接重置连接**（防盲目伪造 `SYN` 攻击），而是回复一个携带正确当前 `seq` 与 `ack` 的 **Challenge ACK**（受 `tcp_challenge_ack_limit` 限速）；重启后的客户端收到该非预期 `ACK`，立即回复精确匹配序号的 **`RST`**，服务端收到后安全释放旧连接，随后客户端重传 `SYN` 建立新连接。

> **源码顺序校准与现代断连工具**：原书 4.9 节解读 `tcp_validate_incoming()` 时把窗口外检查与 `SYN` 检查顺序写反。实际内核先执行 PAWS 检查，再检查序列号是否在窗口内——**不在窗口内**（且非 RST）直接回 ACK 丢弃并返回；**在窗口内**才依次处理 `RST`（遵循 RFC 5961：仅当 `seq == rcv_nxt` 才直接复位，否则也回 Challenge ACK）和 `SYN`（发 Challenge ACK）。
>
> 若运维需在 Linux 4.9+ 本机强行断开某条僵尸连接，优先使用内核原生 `SOCK_DESTROY` 接口——**`ss -K dst <IP> dport = <PORT>`**，无需借助 `killcx`（主动伪造 SYN 诱发 Challenge ACK 拿序号再发 RST，可杀空闲连接）或 `tcpkill`（被动抓包拿序号发 RST，仅能杀活跃连接）等抓包伪造工具。

### 4.3.2 `TIME_WAIT` 收到 `SYN` 与 `RST`（重点勘误原书 4.11 节） {#ch4-3-2}

很多老教材误称“`TIME_WAIT` 收到同四元组 `SYN` 会直接回 `RST`”。实际上 Linux 内核在 `tcp_timewait_state_process()` 中遵循 **RFC 1122 / RFC 7323** 支持合法重用，但**原书 4.11 节在解读以下核心内核代码时出现了逻辑符号误读**：

```c
// Linux 内核 net/ipv4/tcp_minisocks.c: tcp_timewait_state_process() 关键判断
if (!paws_reject &&
    (after(TCP_SKB_CB(skb)->seq, tcptw->tw_rcv_nxt) ||
     (tmp_opt.saw_tstamp &&
      (s32)(tcptw->tw_ts_recent - tmp_opt.rcv_tsval) < 0))) {
    // 判定为合法新连接 SYN，跳过剩余 2MSL 直接复用并回复 SYN+ACK (返回 TCP_TW_SYN)
}
```

- **精准结论（纠正原书 `&&` 误读）**：源码中括号内连接两个条件的是**逻辑或 `||`**，并非原书结论写的“序列号大于 `rcv_nxt` **并且**时间戳大于 `ts_recent`”！
  - **合法重用（返回 `TCP_TW_SYN`）**：只要未触发 `paws_reject`（即 `rcv_tsval >= tw_ts_recent`），满足 **`seq > tw_rcv_nxt`** **或** **`rcv_tsval > tw_ts_recent`** **两者之一**，服务端就会立即销毁旧 `TIME_WAIT` 控制块，直接转为 `SYN_RCVD` 回复 `SYN+ACK` 完成新连接建立！（原书 4.11 节给出的“`seq=200 < 301` 但 `TSval=30 > 21` 判为非法”的示例，在 Linux 实际源码下恰恰是**合法重用**的。）
  - **非法 `SYN`（返回 `TCP_TW_ACK`）**：当时间戳回退触发 `paws_reject`，或同时满足 `seq <= tw_rcv_nxt` 且时间戳未严格递增时，服务端会重发第 4 次挥手 `ACK`（客户端收到非预期 `ACK` 后回 `RST`）。
- **`TIME_WAIT` 收到 `RST`**：受 **`net.ipv4.tcp_rfc1337`**（默认 `0`）控制。为 `0` 时，收到合法 `RST` 会提前终止 `TIME_WAIT` 销毁连接，可能引发 **TIME-WAIT Assassination**（提前销毁后若历史数据包到达会污染新连接）；设为 **`1`** 时，内核遵循 RFC 1337 丢弃 `TIME_WAIT` 期间的 `RST`，坚持走完 2MSL（高并发安全敏感场景建议设为 `1`）。

## 4.4 进程崩溃、主机断电、拔网线与保活机制 {#ch4-4}

### 4.4.1 进程崩溃 vs 主机断电 vs 拔网线 {#ch4-4-1}

TCP 连接本质是内核维护的状态机，物理链路中断或对端死机不会凭空发送报文，因此不同故障对连接状态的影响截然不同：

| 故障场景 | 双方无数据传输、未开 Keepalive | 发送方有数据发送 |
| --- | --- | --- |
| **一端进程崩溃（`kill -9`）** | 崩溃端**操作系统内核存活**，自动回收进程 FD 并代发 **`FIN`** 完成正常四次挥手（**边界校准**：若崩溃时该 Socket 内核接收缓冲区中**仍有未读数据**，Linux 内核会直接发送 **`RST`** 而非 `FIN`） | 同左，对端收到 `FIN` 或 `RST` 立即感知断连 |
| **一端主机突然断电/内核宕机** | 对端完全无感知，连接**永久停留在 `ESTABLISHED`** | ① 若断电端**迅速重启**：收到重传包后因无连接上下文，立即回 **`RST`** 断连；<br>② 若断电端**未重启**：发送方按指数退避持续重传，达到 **`net.ipv4.tcp_retries2`**（默认 `15` 次，配合 `TCP_RTO_MIN=200ms` / `TCP_RTO_MAX=120s` 换算总时长约 **924.6 秒 / 15 分钟**，RTT 较大时重传次数会少于 15 次即达总时间上限）后断开并报错 |
| **拔掉网线 / 断开 Wi-Fi** | 连接依然保持 **`ESTABLISHED`**；在未超时的前提下插回网线（且 IP 与中间 NAT 状态未失效），连接无缝恢复 | 在达到 `tcp_retries2` 超时前插回网线，重传成功确认，连接无感存活；若超时后才插回，发包收到对端 `RST` 断开 |

> **工程建议**：生产环境控制已建连接的发送超时，不应盲目全局修改影响整机的 `tcp_retries2`，而应使用 **Socket 级选项 `TCP_USER_TIMEOUT`（RFC 5482）** 为单个连接精确指定最大未确认等待毫秒数（例如设为 15–30 秒实现快速故障摘除）。

### 4.4.2 TCP Keepalive 与 HTTP Keep-Alive 本质辨析 {#ch4-4-2}

两者名称相近，却分属不同层级、解决完全不同的问题：

| 对比维度 | TCP Keepalive（传输层保活） | HTTP Keep-Alive（应用层长连接） |
| --- | --- | --- |
| **所在层级与实现** | 传输层，操作系统**内核态**实现 | 应用层，Web 客户端与服务器**用户态**实现 |
| **核心目的** | 空闲连接无数据交互时，**定期发探测包检测对端主机是否存活**，清理死连接 | 在**同一条 TCP 连接上复用串行收发多个 HTTP 请求/响应**，避免每次请求重复三次握手与慢启动 |
| **开启方式与默认参数** | 默认关闭，需应用显式设置 `SO_KEEPALIVE`；Linux 默认空闲 **`7200 s`**（`tcp_keepalive_time`）后每隔 **`75 s`**（`tcp_keepalive_intvl`）发探测，连续 **`9`** 次（`tcp_keepalive_probes`）无响应断开——默认至少 **2 小时 11 分 15 秒** | HTTP/1.1 默认开启（关闭需 `Connection: close`；HTTP/2 与 HTTP/3 原生多路复用，禁止使用 `Connection: Keep-Alive` 头）；服务端通过 `keepalive_timeout`（如 60 s）主动关闭超期空闲连接 |

由于内核默认 TCP Keepalive 探测周期超过 2 小时且无法探测“进程卡死/死锁但内核仍存活”的假活状态，主流后端中间件与 RPC 框架通常会在**应用层自行实现心跳机制**（如 WebSocket Ping/Pong、gRPC HTTP/2 PING 帧、Redis 心跳），探测周期精确到秒级。

## 练习 {#ch4-exercises}

本节包含 4 道递进练习，依次覆盖三次/四次挥手边界、线上 `TIME_WAIT`/`CLOSE_WAIT` 根因诊断、`TIME_WAIT` 收到 `SYN` 源码判定以及断电/崩溃/保活时间推算。请先独立分析，再展开核对。

### 练习 1：判断以下四种关闭情形各产生几次挥手及最终状态

1. 客户端调用 `close()` 发送 `FIN`，服务端无待发数据、开启默认延迟确认，在 10 ms 内读到 `EOF` 并调用 `close()`；
2. 客户端调用 `shutdown(SHUT_WR)` 发送 `FIN`，服务端回复 `ACK` 后由于业务逻辑阻塞，一直没有调用 `close()`，120 秒后客户端连接处于什么状态？
3. 服务端 Socket 接收缓冲区中还积压着客户端发来的 100 字节未读数据，此时服务端进程意外被 `kill -9` 杀掉，内核会向客户端发什么报文？
4. 客户端与服务端同时调用 `close()` 互发 `FIN`，双方在收到对方 `FIN` 后但尚未收到对方 `ACK` 前，处于什么 TCP 状态？

<details>
<summary>查看参考答案</summary>

1. **三次挥手**：服务端在延迟确认窗口（40–200 ms）内无数据待发即调用 `close()`，内核将第 2 次 `ACK` 与第 3 次 `FIN` 合并为 `FIN+ACK` 发出；客户端最终进入 `TIME_WAIT`（60 s），服务端收到最后 `ACK` 后进入 `CLOSED`。
2. **客户端一直停留在 `FIN_WAIT_2`**：因为客户端用的是 `shutdown(SHUT_WR)` 而非 `close()`，Socket 未成为孤儿连接，**不受 `tcp_fin_timeout`（60 s）约束**，会持续停留在 `FIN_WAIT_2` 等待服务端数据或 `FIN`。
3. **发送 `RST` 而非 `FIN`**：Linux 内核在 `tcp_close()` 中检测到接收缓冲区尚有未读字节（`data_was_unread > 0`），为避免客户端误以为数据已被应用消费，会直接发送 **`RST`** 强制复位连接。
4. **`CLOSING` 状态**：同时关闭路径为 `ESTABLISHED → FIN_WAIT_1 → CLOSING → TIME_WAIT → CLOSED`，双方最终都会进入 `TIME_WAIT`。

</details>

### 练习 2：依据 `ss` 统计定位两台服务器的连接状态异常

某微服务集群中两台 Linux 6.12 机器出现告警，执行 `ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c` 得到如下统计：

- **节点 A（API 网关，向上游订单服务发起 HTTP 请求）**：`ESTAB: 300`，`TIME-WAIT: 28100`，日志频繁报错 `Cannot assign requested address`。
- **节点 B（后端业务服务，对外监听 8080 端口）**：`ESTAB: 400`，`CLOSE-WAIT: 12500`，客户端报连接超时，日志报 `Too many open files`。

请分别给出两台节点的故障根因与优先修复方案。

<details>
<summary>查看参考答案</summary>

- **节点 A（客户端端口耗尽）**：
  - **根因**：API 网关作为上游服务的 TCP 客户端，高频发起 HTTP 短连接（或未配置上游长连接池）并由网关主动断连，导致大量连接涌入 `TIME_WAIT`，耗尽了发往同一上游 `IP:Port` 的全部本地临时端口（默认 `32768–60999` 仅 28232 个），新 `connect()` 报 `EADDRNOTAVAIL`（`Cannot assign requested address`）。
  - **修复**：首选在网关开启**上游 HTTP 长连接池**（如 Nginx `upstream { keepalive 256; }` 并设 `proxy_http_version 1.1; proxy_set_header Connection "";`）；次选扩宽 `ip_local_port_range` 并在确认安全的前提下开启 `net.ipv4.tcp_tw_reuse = 1`。
- **节点 B（应用层 FD 泄漏）**：
  - **根因**：对端已关闭连接发出 `FIN`，但节点 B 进程处理完或异常退出时**忘记调用 `close()`**（常见如 Go `http.Response.Body` 未 `Close()`、异常处理漏释放连接或死锁），导致 `CLOSE_WAIT` 无限堆积并撑爆进程最大 FD 上限。
  - **修复**：`CLOSE_WAIT` 无法靠内核参数消除，必须通过 `lsof -p <pid>` / 线程堆栈 / 代码审查定位未关闭 Socket 的代码路径并修复（同时临时止血可重启释放）。

</details>

### 练习 3：按 Linux 内核真实逻辑判断 `TIME_WAIT` 收到 `SYN` 的结果

服务端某连接正处于 `TIME_WAIT` 状态，记录的期望下一序号 `tw_rcv_nxt = 5000`，最近时间戳 `tw_ts_recent = 100`。现在收到同四元组的以下 3 个客户端 `SYN` 报文（均开启 `tcp_timestamps`），请分别判断内核会判定为“合法重用（`TCP_TW_SYN`）”还是“非法丢弃并重发 `ACK`（`TCP_TW_ACK`）”：

1. `SYN A`：`seq = 6000, TSval = 100`
2. `SYN B`：`seq = 3000, TSval = 120`
3. `SYN C`：`seq = 6000, TSval = 90`

<details>
<summary>查看参考答案</summary>

依据 Linux `tcp_timewait_state_process()` 真实判断条件：
`!paws_reject && (after(seq, tw_rcv_nxt) || (saw_tstamp && rcv_tsval > tw_ts_recent))`（其中 `paws_reject` 在 `rcv_tsval < tw_ts_recent` 时为真）：

1. **`SYN A`（`seq=6000, TSval=100`）**：**合法重用（`TCP_TW_SYN`）**。`TSval=100 >= 100` 未触发 PAWS 拒绝，且满足 `seq(6000) > tw_rcv_nxt(5000)`。
2. **`SYN B`（`seq=3000, TSval=120`）**：**合法重用（`TCP_TW_SYN`）**。`TSval=120 >= 100` 未触发 PAWS 拒绝，尽管 `seq(3000) < 5000`，但满足括号内 `||` 右侧的 `TSval(120) > tw_ts_recent(100)`（注意：这正是原书 4.11 节误读 `||` 为 `&&` 而判错的情形！）。
3. **`SYN C`（`seq=6000, TSval=90`）**：**非法，重发第 4 次 `ACK`（`TCP_TW_ACK`）**。`TSval=90 < tw_ts_recent(100)` 直接触发 `paws_reject` 为真，尽管 `seq` 更大仍被判定为过期历史 `SYN`。

</details>

### 练习 4：对比对端断电场景下的感知耗时与快速摘除方案

客户端与服务端通过 TCP 保持空闲长连接，客户端未开启 `SO_KEEPALIVE`，也未配置应用层心跳。现服务端机房突发断电：
1. 若客户端一直不发送数据，客户端何时能发现连接已断？
2. 若断电 5 秒后客户端向该连接发送一条 50 字节消息，在服务端**一直未恢复通电**与**10 秒后快速重启开机**两种情况下，客户端分别如何以及大约多久感知断连？
3. 业务希望在 10 秒内快速感知对端失联，应如何改造？

<details>
<summary>查看参考答案</summary>

1. **一直不发数据**：客户端**永远无法发现**，连接会无限停留在 `ESTABLISHED`。
2. **5 秒后发送 50 字节数据**：
   - **服务端一直未通电**：客户端持续指数退避重传数据包，达到 `net.ipv4.tcp_retries2`（默认 15 次）对应的总超时阈值（约 **924.6 秒 / 15 分钟**）后，内核断开连接并向上层返回 `ETIMEDOUT`；
   - **服务端 10 秒后重启开机**：重启后的服务端内核丢失了该连接状态，收到客户端后续重传的数据包后立即回复 **`RST`**，客户端在收到 `RST` 的瞬间（约断电后十余秒）即感知断连并报 `ECONNRESET`。
3. **10 秒内快速感知方案**：
   - **空闲连接**：引入**应用层心跳**（例如每 3 秒发一次 Ping，连续 3 次未收到 Pong 即主动断连），或将 `SO_KEEPALIVE` 配合 `TCP_KEEPIDLE`/`TCP_KEEPINTVL`/`TCP_KEEPCNT` 调小至秒级；
   - **有数据发送的连接**：为 Socket 设置 **`TCP_USER_TIMEOUT = 10000`**（10 秒），只要已发数据超过 10 秒未获确认即由内核直接超时返回，无需苦等 15 分钟。

</details>

## 面试题 {#ch4-interview}

本节精选 5 道高频 TCP 断连与异常面试题，聚焦原理辨析与内核边界；请先独立作答，再展开核对。

### 面试题 1：为什么四次挥手有时会变成三次？必须满足哪两个条件？

<details>
<summary>查看参考答案</summary>

**结论**：当被动关闭方**没有待发送数据**且**开启了 TCP 延迟确认（Delayed ACK）**时，内核会将第 2 次挥手的 `ACK` 与第 3 次挥手的 `FIN` 合并为一个 `FIN+ACK` 发送，从而变为三次挥手。

**关键依据**：
- 正常四次挥手是因为内核收到 `FIN` 后先回 `ACK`，被动方应用进程稍后发完残余数据再调 `close()` 发 `FIN`；
- 开启延迟确认（Linux 默认开启，延迟 40–200 ms）后，若被动方应用在延迟窗口内无数据可发并立刻调用 `close()`，内核便顺势将 `ACK` 捎带在 `FIN` 报文上发出。

</details>

### 面试题 2：为什么服务端出现大量 `CLOSE_WAIT` 通常要查业务代码，而出现大量 `TIME_WAIT` 通常要查连接复用策略？

<details>
<summary>查看参考答案</summary>

**结论**：`CLOSE_WAIT` 停留在等待**本机应用调用 `close()`** 的阶段（无内核超时兜底），几乎必为代码泄漏；`TIME_WAIT` 是**本机主动关闭连接**后内核正常停留 60 秒的保护状态，往往反映短连接过于频繁。

**关键依据**：
- `CLOSE_WAIT` 持续堆积意味着收到对端 `FIN` 后未释放 FD，应排查遗漏 `close()`、未关闭 HTTP Response Body 或线程卡死；
- `TIME_WAIT` 堆积说明本机频繁扮演主动关闭方（如禁用 HTTP Keep-Alive、反向代理未开上游连接池或 `keepalive_timeout`/`keepalive_requests` 触发回收），应优先改用长连接池并尽量由客户端主动断连。

</details>

### 面试题 3：既然 `tcp_tw_reuse` 能缓解 `TIME_WAIT` 端口紧张，为什么 Linux 默认不将其全局开启（设为 `1`）？`tcp_tw_recycle` 又为什么被移除了？

<details>
<summary>查看参考答案</summary>

**结论**：Linux 4.12+ 将 `tcp_tw_reuse` 默认设为 `2`（仅回环生效）而非 `1`（全局），是因为提前复用 `TIME_WAIT` 会带来**历史延迟 `RST` 误杀新连接**和**破坏被动关闭方 `LAST_ACK` 正常关闭**两大风险；`tcp_tw_recycle` 则因在 NAT 环境下大规模误杀合法 `SYN` 而被彻底移除。

**关键依据**：
- **`tcp_tw_reuse` 风险**：PAWS 校验按 RFC 规范放行 `RST` 报文，且若第 4 次 `ACK` 丢失，提前复用端口会导致停留在 `LAST_ACK` 的被动方收到 `RST` 异常终止；
- **`tcp_tw_recycle` 致命缺陷**：其开启 per-host PAWS（按对端 IP 而非四元组比对时间戳），NAT 后多台客户端共享公网 IP 但时间戳不同，导致时间戳较小的客户端 `SYN` 被服务端静默丢弃，Linux 4.12 已删除该选项。

</details>

### 面试题 4：网线被拔掉后，原本已建立的 TCP 连接会立刻断开吗？

<details>
<summary>查看参考答案</summary>

**结论**：**不会。**TCP 连接是内核态状态机，拔网线仅断开物理链路，双方内核均未收到 `FIN`/`RST`，连接仍停留在 `ESTABLISHED`。

**关键依据**：
- 若期间**无数据交互且未开启保活**，连接将无限保持 `ESTABLISHED`；只要在 IP 与中间 NAT 状态未失效前插回网线，即可继续正常通信；
- 若期间**有数据发送**，发送方会触发超时重传，在达到 `tcp_retries2`（约 15 分钟）或 `TCP_USER_TIMEOUT` 之前插回网线仍可恢复，超时后则断连；若开启了 `SO_KEEPALIVE`，默认需约 **2 小时 11 分 15 秒**探测失败后才断开。

</details>

### 面试题 5：TCP Keepalive 和 HTTP Keep-Alive 是同一个东西吗？线上为什么通常不用默认 TCP Keepalive 替代应用层心跳？

<details>
<summary>查看参考答案</summary>

**结论**：**不是。**HTTP Keep-Alive 是应用层**长连接复用**机制（一条 TCP 发多个 HTTP 请求），TCP Keepalive 是传输层**内核保活探测**机制（检测死连接）。

**关键依据**：
- 默认 TCP Keepalive 空闲 2 小时才开始发探测，总耗时超 **2 小时 11 分**，远远无法满足秒级故障发现要求；
- 更本质的局限在于：TCP Keepalive 由内核协议栈自动应答，即使对端**应用进程已死锁、OOM 卡顿或线程池耗尽**，只要操作系统内核还活着就能回复 Keepalive ACK，因此无法反映业务真实健康度，生产环境仍需结合应用层心跳（或调小 Keepalive 参数 + `TCP_USER_TIMEOUT`）。

</details>

## 参考资料

- [RFC 9293: Transmission Control Protocol (TCP)](https://datatracker.ietf.org/doc/html/rfc9293)
- [RFC 5961: Improving TCP's Robustness to Blind In-Window Attacks (Challenge ACK)](https://datatracker.ietf.org/doc/html/rfc5961)
- [RFC 1337: TIME-WAIT Assassination Hazards in TCP](https://datatracker.ietf.org/doc/html/rfc1337)
- [RFC 5482: TCP User Timeout Option (`TCP_USER_TIMEOUT`)](https://datatracker.ietf.org/doc/html/rfc5482)
- [Linux Kernel Source: `tcp_timewait_state_process()` (`net/ipv4/tcp_minisocks.c`)](https://elixir.bootlin.com/linux/v6.12/source/net/ipv4/tcp_minisocks.c)
- [Linux Kernel Documentation: IP Sysctl (`tcp_tw_reuse`, `tcp_orphan_retries`, `tcp_fin_timeout`, `tcp_rfc1337`)](https://docs.kernel.org/networking/ip-sysctl.html)
- [Coping with the TCP TIME-WAIT state on busy Linux servers (Vincent Bernat)](https://vincent.bernat.ch/en/blog/2014-tcp-time-wait-state-linux)
