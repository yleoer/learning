---
title: 第 5 章 TCP 可靠传输、流量控制、拥塞控制与性能调优
description: 对齐 RFC 6298、RFC 8985、RFC 9438 与 Linux 6.12 LTS，系统梳理重传机制（含 RACK-TLP 与 SACK）、滑动窗口与流量控制、从 Reno 到 CUBIC/BBR 的拥塞控制演进，以及基于 BDP 的缓冲区调优。
---

# 第 5 章 TCP 可靠传输、流量控制、拥塞控制与性能调优

## 本章要点

连接建立之后，TCP 如何在高延迟、易丢包且多方共享的公网链路中，同时兼顾**数据可靠送达**、**不压垮接收端**与**不挤爆网络带宽**？这正是重传机制、滑动窗口/流量控制与拥塞控制三大核心机制协作回答的问题。本章整合原书《图解网络》4.2、4.3（传输抓包）、4.5（传输优化）与 4.22（可靠性边界）的相关内容，统一去重并按 **Linux 6.12 LTS** 与最新 RFC 校准：纠正原书 `RFC6289` 编号笔误、统一零窗口探测自相矛盾的描述、明确传输层可靠不等于应用层可靠，将丢包检测与拥塞控制从上世纪的 3 Dup ACK + Reno 升级至现代默认启用的 **RACK-TLP（RFC 8985）**、**CUBIC（RFC 9438）** 与 **BBR**，并纠偏 `tcp_mem` 压力阈值、2×BDP 记账及 `free` 命令观测误区。

读完本章后，应能准确推导 RTO、SACK/D-SACK 与 RACK-TLP 的工作逻辑，分析滑动窗口、零窗口探测与 Nagle/延迟确认冲突引发的延迟抖动，清晰对比 Reno、CUBIC 与 BBR 的控速哲学，并能基于 BDP 正确调优与观测 Linux TCP 缓冲区。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 6298、RFC 5681、RFC 7323、RFC 8985（RACK-TLP）、RFC 9438（CUBIC）及 Linux 6.12 LTS 内核网络栈。

## 5.1 重传机制、SACK 与现代 RACK-TLP {#ch5-1}

### 5.1.1 超时重传（RTO）与 RFC 6298 计算公式 {#ch5-1-1}

当数据包在途中丢失，或对端回复的 `ACK` 丢失时，发送方最基础的兜底机制是**超时重传（RTO，Retransmission Timeout）**。RTO 设得太大，丢包后恢复极慢；设得太小，正常延迟波动就会触发大量无谓重传加剧拥塞。

因为网络往返时延 **RTT（Round-Trip Time）** 会随路径波动，**RFC 6298**（纠正原书 4.2 节 `RFC6289` 编号笔误与 `DevRTR` 拼写错误）定义了指数加权移动平均的动态 RTO 估算模型：

```text
SRTT   = (1 - α) × SRTT + α × RTT               （平滑往返时间，推荐 α = 1/8 = 0.125）
RTTVAR = (1 - β) × RTTVAR + β × |SRTT - RTT|    （RTT 波动偏差，推荐 β = 1/4 = 0.25）
RTO    = SRTT + max(G, 4 × RTTVAR)              （G 为时钟粒度；Linux 最小 RTO 为 200 ms）
```

若重传后依然超时，触发**指数退避**（RTO 翻倍，Linux 上限 `TCP_RTO_MAX = 120 s`），且重传样本因无法区分 ACK 对应原始包还是重传包而不参与 RTT 采样（Karn 算法）。

### 5.1.2 快速重传、SACK 与 D-SACK {#ch5-1-2}

等待 RTO 动辄耗费数百毫秒，因此 TCP 引入了**数据驱动**的快速重传与选择性确认：

1. **快速重传（Fast Retransmit）**：接收方每收到一个乱序报文段，立即回复期望字节序号的重复 `ACK`；当发送方连续收到 **3 个重复 ACK**（即包含首个正常 ACK 在内共收到 **4 个相同 ACK 号**，校准原书 4.2 节措辞易混淆处）时，不等 RTO 到期便立刻重传该空洞报文段。
2. **SACK（Selective Acknowledgment，选择性确认）**：传统快速重传只知道“缺失了哪一个起始序号”，却不知道后续哪些段已安全到达，容易整批盲目重传。开启 SACK（Linux 默认 `net.ipv4.tcp_sack = 1`）后，接收方在 TCP 选项中附带最多 3–4 段已收到的乱序字节区间（如 `ACK=200, SACK=[300-500]`），发送方据此**只精准重传缺失空洞**（`200–299`）。
3. **D-SACK（Duplicate SACK，重复 SACK）**：Linux 默认 `net.ipv4.tcp_dsack = 1`。当 SACK 选项的第一个区间**位于当前累计 `ACK` 号之前**时，接收方即在告知发送方“这段数据被重复收到了”。发送方借此可判断：① 究竟是原始数据包丢了还是回程 ACK 丢了；② 是否发生了因网络延迟导致的**伪重传（Spurious Retransmission）**（借此可撤销误降的拥塞窗口）；③ 网络中是否存在设备复制数据包。

### 5.1.3 现代丢包检测升级：RACK-TLP 与可靠性边界 {#ch5-1-3}

传统的“3 个重复 ACK”机制存在两大短板：**尾包丢失**（连接突发最后 1–2 个包丢失时，后续根本没有新包触发 3 个重复 ACK，只能干等 200 ms+ 的 RTO）以及**轻微乱序误触发重传**（无线网/多路径 ECMP 乱序超过 3 个包即误判丢包）。

自 **Linux 4.15** 起（含 6.12 LTS），内核默认启用 **RACK-TLP（RFC 8985，`net.ipv4.tcp_recovery`）**取代单纯基于重复 ACK 计数的检测逻辑：
- **RACK（Recent ACK，基于时间检测丢包）**：如果较晚发送的报文已经被 ACK（或 SACK），而较早发送的报文在经过“最近 RTT + 自适应乱序容忍窗口（`reo_wnd`）”后仍未获确认，则直接判定该早期报文丢失并重传，极大降低乱序误判率且兼容重传包再丢场景；
- **TLP（Tail Loss Probe，尾包探测）**：当发送队列无新数据可发时，在极短超时（约 `2 × SRTT`，远小于 RTO）后主动重发最后一个在途报文段作为探针，若收到回复即可借 RACK 立刻触发快速恢复，彻底消除尾包等待 RTO 的长尾卡顿。

> **重要工程边界：TCP 可靠 ≠ 应用层可靠**。TCP 保证的是“A 端传输层内核缓冲 → B 端传输层内核缓冲”的有序无损交付。若 B 端内核将收到的数据写入 Socket 接收缓冲区并回复了 `ACK`，但 B 端应用进程在调用 `read()` 消费之前发生崩溃或机器断电，**该批数据依然会永久丢失**！因此涉及资金、订单或消息队列的核心业务，必须在应用层实现**业务级 ACK、消息 ID 幂等去重与持久化对账**。

## 5.2 滑动窗口、流量控制与 Nagle/延迟确认冲突 {#ch5-2}

### 5.2.1 滑动窗口模型与窗口缩放因子 {#ch5-2-1}

若采用“发一个包等一个 ACK”的停等模式，高延迟链路的吞吐将惨不忍睹。**滑动窗口（Sliding Window）**允许发送方在未收到确认前连续发送窗口允许范围内的多批数据，配合累计确认机制大幅提升链路利用率：

```text
发送端字节流缓冲区:
|  #1 已发且已确认  |  #2 已发未确认  |  #3 未发但可发  |  #4 不可发送  |
                   ^                ^                 ^
               SND.UNA          SND.NXT       SND.UNA + SND.WND
                   |<──────── 发送窗口 SND.WND ────────>|
```

- **可用窗口**：`SND.WND - (SND.NXT - SND.UNA)`；接收端则维护 `RCV.NXT`（期望下一字节）与 `RCV.WND`（当前接收缓冲区空闲容量）。
- **窗口缩放（Window Scale，RFC 7323）**：TCP 基本首部的 Window 字段仅 16 bit（最大 65535 字节），远不够百兆/万兆网络使用。双方在三次握手 `SYN` 中协商 **Window Scale Shift Count（0–14）**（Linux 默认 `net.ipv4.tcp_window_scaling = 1`），后续报文中的真实窗口 = `Window 字段值 × 2^shift`（最大约 **1 GiB**）。注意 Wireshark 抓包时若漏抓三次握手，将无法得知缩放因子从而显示出偏小的未缩放窗口值。

### 5.2.2 流量控制、零窗口探测与糊涂窗口综合征 {#ch5-2-2}

流量控制的核心目标是**让发送速率匹配接收端应用层的消费能力**，防止溢出接收缓冲区：

1. **窗口收缩原则**：操作系统动态缩减接收缓冲区时，绝不允许在缩小接收窗口的同时立刻释放已有缓冲区（否则在途合法报文到达会因缓冲不足被丢弃，发送方可用窗口也会变成负数）；正确顺序是先通过通告缩小窗口，待发送方消化完毕后再释放内核缓冲。
2. **零窗口死锁与持续定时器（Persist Timer）**：若接收方应用读取极慢导致接收窗口降至 `0`（通告 Zero Window），发送方暂停发数据；随后接收方消化了数据并发出非零窗口更新报文，但该报文在网络中丢失，双方就会陷入互相干等的死锁。为此发送方在收到零窗口后启动**持续定时器**，定期发送 1 字节的**窗口探测（Window Probe）**报文获取最新窗口。
   - **口径校准**：原书 4.2 节称“一般探测 3 次、每次 30–60 秒后部分实现发 RST”，却在 4.3 节抓包中测出 `3.4 s → 6.8 s → 13.5 s` 递增，前后自相矛盾。实际上在 **Linux 内核**中，零窗口探测同样按 RTO **指数退避**（上限 `TCP_RTO_MAX = 120 s`），默认受 `tcp_retries2`（15 次）与 `TCP_USER_TIMEOUT` 共同约束，而非固定 3 次就发 `RST`。
3. **糊涂窗口综合征（Silly Window Syndrome）**：当接收方每次仅腾出几个字节就立刻通告小窗口、发送方又立刻发这几个字节时，40 字节 TCP+IP 首部仅承载几字节载荷，带宽严重浪费。双端共同治理：
   - **接收方（Clark 算法）**：当空闲空间小于 `min(MSS, 接收缓冲区/2)` 时直接通告窗口为 **`0`**，待腾出足够空间再一次性通告；
   - **发送方（Nagle 算法）**：默认开启，仅当 **`可用窗口 >= MSS && 待发数据 >= MSS`** 或 **当前无已发未确认数据**时才发包，否则将小块数据攒成大包一起发。

### 5.2.3 Nagle 算法与延迟确认（Delayed ACK）的经典冲突 {#ch5-2-3}

接收方为了减少纯 ACK 报文数量，默认开启**延迟确认（Delayed ACK）**：收到数据后不立刻回 ACK，若有业务响应数据则捎带 ACK；若无数据则延迟等待（Linux 范围为 **40 ms – 200 ms**），期间若收到第 2 个满载数据段则立即回 ACK。

当发送端连续执行两次小写入（`write(header)` + `write(body)`，如早期 HTTP 请求头与体分两次写）且**同时开启了发送端 Nagle 与接收端延迟确认**时，就会发生著名的“死等”延迟放大：
1. 发送端发完第 1 块小数据 `header`；
2. 紧接着写第 2 块小数据 `body`（小于 MSS），**Nagle 算法阻止其发出**，必须等第 1 块的 ACK；
3. 接收端收到 `header` 后数据不完整无法生成业务响应，**延迟确认阻止其立刻回 ACK**，坐等第 2 个包或 40–200 ms 定时器超时；
4. 于是每次请求都白白卡死 **40–200 ms**！

**工程解法（关闭其一，优先发送端）**：
- 对低延迟敏感的交互式协议、RPC、数据库客户端与现代 Web 服务器，普遍通过 `setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one))` **关闭 Nagle 算法**（并在应用层使用 `writev` 或缓冲合并小写入）；
- 接收端若需临时关闭延迟确认可设置 `TCP_QUICKACK`，但须牢记其在 Linux 中**不是永久开关**（见[第 4 章挥手延迟确认](./chapter-04#ch4-1-1)），内核会在后续收发中自动重新进入延迟确认模式。

## 5.3 拥塞控制演进：从经典 Reno 到 CUBIC 与 BBR {#ch5-3}

流量控制只管“接收端吃不吃得消”，而**拥塞控制（Congestion Control）**管的是“共享网络链路堵不堵车”。发送方维护**拥塞窗口 `cwnd`**，实际允许在途的数据量取两者较小值：

```text
实际发送窗口 swnd = min(拥塞窗口 cwnd, 接收方通告窗口 rwnd)
```

现代 Linux（遵循 RFC 6928）将新连接的初始拥塞窗口设为 **`initcwnd = 10` 个 MSS**（约 14.6 KB，可用 `ss -tin` 查看实时 `cwnd` 与 `ssthresh`）。

### 5.3.1 经典基线：TCP Reno 四阶段模型 {#ch5-3-1}

理解所有现代算法的基础是经典的 **RFC 5681（取代原书引用的 RFC 2581）** 四阶段模型（以慢启动阈值 `ssthresh` 分界；注意 Linux 新连接初始 `ssthresh` 设为极大值 `TCP_INFINITE_SSTHRESH`，并非原书 4.2 节所述早期 BSD 的 65535 字节）：

1. **慢启动（Slow Start，`cwnd < ssthresh`）**：每收到 1 个有效新 ACK，`cwnd` 增加 1 个 MSS，因此**每经过 1 个 RTT，`cwnd` 指数翻倍**，快速探测可用带宽；
2. **拥塞避免（Congestion Avoidance，`cwnd >= ssthresh`）**：每收到 1 个 ACK，`cwnd += 1 / cwnd`，即**每经过 1 个 RTT，`cwnd` 线性仅增加 1 个 MSS**，小心试探上限；
3. **拥塞发生（丢包降速）**：
   - **收到 3 个重复 ACK（轻度拥塞）**：`ssthresh = cwnd / 2`，`cwnd = ssthresh`（乘性减半），进入**快速恢复**；
   - **发生 RTO 超时（严重拥塞）**：`ssthresh = cwnd / 2`，`cwnd` 直接骤降至 **`1` 个 MSS**，重新慢启动；
4. **快速恢复（Fast Recovery）**：`cwnd = ssthresh + 3` → 立刻重传丢包 → 每再收到 1 个重复 ACK 则 `cwnd += 1`（保持管道中在途包数量稳定）→ 收到新数据的确认 ACK 后，将 `cwnd` 重置回 `ssthresh`，转入拥塞避免。

### 5.3.2 现代 Linux 默认算法：CUBIC（RFC 9438） {#ch5-3-2}

经典 Reno 在高带宽、长延迟链路（“长肥管道”，LFN）下表现极差：单次丢包减半后，靠每 RTT `+1 MSS` 的龟速线性爬坡，在 10 Gbps / 100 ms 链路上恢复满速可能需要数十分钟！

**CUBIC**（自 Linux 2.6.19 起成为**默认拥塞控制算法**，并于 2023 年升格为标准轨道 **RFC 9438**）解决了这一瓶颈：
- **更温和的丢包减窗**：发生丢包时乘性降窗系数 β = **0.7**（只缩减 30%，而非 Reno 粗暴砍半 50%），并记下丢包前最大值 `W_max`；
- **三次函数曲线增长（与 RTT 解耦）**：恢复阶段按距上次丢包的时间 `t` 呈三次函数增长——初期快速逼近 `W_max`（凹函数），接近 `W_max` 时放缓斜率细致探测，越过 `W_max` 且仍无丢包后转为凸函数加速探索新带宽，摆脱了对短 RTT 流的偏袒；
- **HyStart / HyStart++（RFC 9406）**：监测慢启动期间 RTT 突增，提前安全退出慢启动，避免指数翻倍瞬间打爆路由器队列引发连片丢包。

### 5.3.3 范式变革：基于带宽-延迟模型的 BBR {#ch5-3-3}

Reno 与 CUBIC 均属于**基于丢包（Loss-Based）**的算法——它们把“丢包”等同于“网络拥塞”。在现代网络中这一假设面临两大困境：
1. **无线/跨国弱网随机丢包**：链路明明还有充裕带宽，仅 1% 的随机丢包就让 CUBIC 不断减窗，吞吐暴跌；
2. **缓冲膨胀（Bufferbloat）**：现代交换机/路由器配备超大缓冲队列，基于丢包的算法会持续加窗直到把中间队列彻底塞满溢出才肯降速，导致吞吐没多涨，排队延迟却暴涨至数百毫秒。

Google 提出的 **BBR（Bottleneck Bandwidth and Round-trip propagation time）**（BBRv1 自 **Linux 4.9** 合入主线；BBRv2/v3 进一步融合丢包与 ECN 信号改善与 CUBIC 共存公平性，并已广泛部署于 YouTube、Cloudflare 与主流云服务）彻底改变了思路：

```text
最佳工作点（Kleinrock 最优点）: 在途数据量 Inflight = BtlBw（瓶颈带宽） × RTprop（最小传播时延）
```

BBR 不再等丢包，而是周期性地主动测量链路的**最大瓶颈带宽（`BtlBw`）**与**最小物理传播时延（`RTprop`）**，通过 **Pacing（平滑发包速率）**精准将发送速率锚定在 `BtlBw`、将队列积压控制在极低水平，在弱网丢包与长距离跨洋链路上可同时实现**高吞吐与低延迟**。可在 Linux 中查看和切换拥塞算法：

```bash
sysctl net.ipv4.tcp_available_congestion_control net.ipv4.tcp_congestion_control
# 启用 BBR（需配合 fq 排队规则实现精准 Pacing）
# sysctl -w net.core.default_qdisc=fq
# sysctl -w net.ipv4.tcp_congestion_control=bbr
```

> **前沿趋势**：针对数据中心与低延迟互动业务，IETF 推出了结合显式拥塞通知的 **L4S（Low Latency, Low Loss, Scalable Throughput，RFC 9330–9332）**，允许支持 ECN 的路由器在队列刚萌芽时即打标记通知端点微调降速，将排队延迟压至毫秒级。

## 5.4 带宽时延积（BDP）与 TCP 缓冲区调优 {#ch5-4}

### 5.4.1 BDP 计算与 2×BDP 缓冲配置法则 {#ch5-4-1}

要让一条高速远距链路跑满吞吐，滑动窗口至少需要容纳链路管道里的全部在途字节，即**带宽时延积（BDP，Bandwidth-Delay Product）**：

```text
BDP = 链路带宽（Byte/s） × RTT（s）
```

例如：一条 **1 Gbps（125 MB/s）**、**RTT = 50 ms（0.05 s）** 的跨地域专线，`BDP = 125 MB/s × 0.05 s = 6.25 MB`。如果单连接接收窗口上限被默认 `tcp_rmem`（常见上限 6 MB）卡死，吞吐就永远无法跑满 1 Gbps。

> **口径校准（纠正原书 4.5 节两处偏差）**：
> 1. **缓冲区上限不应卡死在 1×BDP，而应设为约 `2 × BDP`**：原书 4.5 节称“发送缓冲区不能超过 BDP”。实际上 Linux `tcp_rmem`/`tcp_wmem` 的内存记账基于 `sk_buff->truesize`（含内核元数据结构与页对齐开销，约为有效载荷的 1.25–2 倍），且发送端还需缓存突发写入与应用重传数据；真正防止网络过载的是拥塞控制 `cwnd` 与 Pacing，因此工程调优常将最大缓冲区设为 **`2 × BDP`**。
> 2. **TCP 缓冲区不计入 `free` 的 `buff/cache`**：原书 4.5 节称“连接多时可通过 `free` 观察 `buff/cache` 增大”，**这是错误的**。`buff/cache` 仅统计块设备 Buffers、文件 PageCache 与可回收 Slab；TCP Socket 缓冲区属于内核不可回收内存，应查看 **`/proc/net/sockstat`** 中的 `TCP: mem <页数>`（乘以 4 KiB 换算为字节）或 `/proc/meminfo` 的 `Slab`/`SUnreclaim`。

### 5.4.2 Linux TCP 缓冲区三组核心参数与避坑指南 {#ch5-4-2}

| 参数 | 单位与三元组含义（min / default / max） | 核心规则与纠偏说明 |
| --- | --- | --- |
| **`net.ipv4.tcp_wmem`** | 字节（常见 `4096 16384 4194304`） | 单连接发送缓冲区自动动态调节范围（默认自动开启） |
| **`net.ipv4.tcp_rmem`** | 字节（常见 `4096 131072 6291456`） | 单连接接收缓冲区动态调节范围，须保持 **`net.ipv4.tcp_moderate_rcvbuf = 1`**（默认开启）才自动扩容 |
| **`net.ipv4.tcp_mem`** | **内存页（每页通常 4 KiB）**（`min / pressure / max`） | **全局所有 TCP 连接**总内存阈值。**校准原书描述**：全局 TCP 内存**超过第 2 值 `pressure`** 时内核才进入内存压力模式并收紧各连接缓冲，直到降回**第 1 值 `min` 以下**才退出压力模式；超过第 3 值 `max` 时拒绝继续分配内存导致丢包或建连失败 |

**关键编程避坑**：业务代码**不要轻易手动调用 `setsockopt` 设置 `SO_SNDBUF` / `SO_RCVBUF`**——一旦显式设置，Linux 内核会认为应用自行接管缓冲管理，从而**关闭该连接的缓冲区自动动态调节机制**，反而容易造成大带宽跑不满或海量空闲连接浪费内存。

## 练习 {#ch5-exercises}

本节包含 4 道递进练习，依次覆盖 RFC 6298 RTO 计算、Nagle 与延迟确认交互排查、CUBIC 与 BBR 吞吐瓶颈辨析及 BDP 缓冲区调优计算。请先独立推演，再展开参考答案核对。

### 练习 1：按 RFC 6298 手工推演 RTO 变化

某 TCP 连接当前平滑往返时间 `SRTT = 100 ms`，波动偏差 `RTTVAR = 20 ms`（参数 `α = 0.125`, `β = 0.25`，时钟粒度可忽略）。紧接着测得一次新的有效样本 `RTT = 180 ms`：

1. 请计算更新后的 `RTTVAR`、`SRTT` 和新的 `RTO`（注意 RFC 6298 先用旧 `SRTT` 算 `RTTVAR` 再更新 `SRTT`）。
2. 若该连接随后重传了一个超时报文段并收到了确认，这次重传样本应不应该代入上述公式更新 `SRTT`？为什么？

<details>
<summary>查看参考答案</summary>

1. **按 RFC 6298 §2.3 顺序计算**：
   - `RTTVAR' = (1 - 0.25) × 20 + 0.25 × |100 - 180| = 15 + 20 = 35 ms`
   - `SRTT' = (1 - 0.125) × 100 + 0.125 × 180 = 87.5 + 22.5 = 110 ms`
   - `RTO = SRTT' + 4 × RTTVAR' = 110 + 4 × 35 = 250 ms`
2. **不应代入（Karn 算法）**：在未开启 TCP Timestamps 时，发送方收到重传段的 ACK 后无法分辨该 ACK 是对原始包还是对重传包的确认（重传歧义），代入计算会严重扭曲 RTT 估算。（注：开启 `tcp_timestamps` 后可借助回显的 `TSecr` 消除重传歧义，而 QUIC 通过单调递增 Packet Number 从协议层根除了该问题。）

</details>

### 练习 2：定位内网 RPC 固定的 40 ms 尾延迟毛刺

某部署在同机房（RTT < 0.5 ms）的自定义 TCP 服务，客户端每次发请求习惯分两次调用 `write()`：先 `write(header, 16)`，紧接着 `write(body, 200)`，随后阻塞 `read()` 等服务端返回。压测发现单次请求耗时离奇地稳定在 **40 ms 左右**，但服务端 CPU 和网络带宽均极空闲。

1. 解释为何同机房 0.5 ms RTT 会出现稳定的 40 ms 耗时？
2. 给出两种立竿见影的修复方案。

<details>
<summary>查看参考答案</summary>

1. **根因（Nagle 算法 + Linux 延迟确认死等）**：
   - 客户端发送 16 字节 `header`（发完处于已发未确认状态）；
   - 紧接着调用 `write(body, 200)`（小于 MSS），**客户端默认开启的 Nagle 算法扣住 `body` 不发**，等待 `header` 的 ACK；
   - 服务端收到 16 字节 `header` 后未凑齐完整请求无法回业务响应，同时**服务端默认开启的延迟确认（Linux 最小 40 ms）暂缓发送纯 ACK**，坐等下一个数据包；
   - 直到 40 ms 延迟确认定时器超时，服务端回发 `header` 的 ACK → 客户端 Nagle 放行发出 `body` → 服务端在 0.5 ms 内返回业务响应，造成稳定 40 ms 延迟。
2. **修复方案**：
   - **方案一（推荐）**：客户端设置 **`TCP_NODELAY = 1`** 禁用 Nagle 算法；
   - **方案二（推荐合并实施）**：在应用层将 `header` 与 `body` 拼接到同一缓冲（或使用 `writev()` 聚集写），单次系统调用完整发出，同时省去一次系统调用开销。

</details>

### 练习 3：跨洋专线吞吐跑不满的 BDP 诊断与调优

一家企业租用了一条北京到法兰克福的 **1 Gbps（1000 Mbps）**专线，实测稳定 **RTT = 160 ms**，几乎无丢包。两台 Linux 6.12 机器之间跑单条 TCP 连接传大文件，实测吞吐死活卡在 **约 300 Mbps（~37.5 MB/s）**上不去。查看配置发现：
- `net.ipv4.tcp_window_scaling = 1`
- `net.ipv4.tcp_rmem = 4096 131072 6291456`（max = 6 MiB）
- `net.ipv4.tcp_wmem = 4096 16384 4194304`（max = 4 MiB）

1. 计算该专线的 **BDP**（以 MB 计），并解释为何单连接吞吐被卡死在约 37.5 MB/s 附近。
2. 应如何调整缓冲区上限以打满 1 Gbps 带宽？

<details>
<summary>查看参考答案</summary>

1. **BDP 计算与瓶颈定位**：
   - 带宽 = `1000 Mbps = 125 MB/s`，`RTT = 0.16 s`。
   - `BDP = 125 MB/s × 0.16 s = 20 MB`。
   - 当前受限于 `tcp_wmem` 最大值 4 MiB 与 `tcp_rmem` 最大值 6 MiB（且 `sk_buff->truesize` 记账开销还会吃掉一部分有效窗口，6 MiB 缓冲实际通告接收窗口常仅约 3–4.5 MiB）。理论吞吐上限 = `有效窗口 / RTT ≈ 4~6 MB / 0.16 s ≈ 25~37.5 MB/s`（约 200–300 Mbps），正好吻合观测值！
2. **调优方案**：
   - 考虑 `truesize` 记账开销，按 **`2 × BDP ≈ 40 MB`**（如设为 `41943040` 或 `67108864` 字节）同步调大两端的 `net.ipv4.tcp_rmem` 与 `net.ipv4.tcp_wmem` 第三个值（同时调大 `net.core.rmem_max`、`net.core.wmem_max`，并确保 `tcp_moderate_rcvbuf = 1` 且业务代码未手动固定 `SO_SNDBUF`/`SO_RCVBUF`）；
   - 若跨洋链路存在少量随机丢包，进一步将拥塞控制切换为 **`bbr`** 配合 `fq` 队列。

</details>

### 练习 4：为三种典型网络场景选择合适的丢包/拥塞控制策略

面对以下三种场景，分别判断传统 **Reno / CUBIC** 为何表现不佳，以及现代 Linux 的对应机制如何改善：
1. 某交易系统每次请求仅回复 2 个小包，偶发第 2 个尾包丢失，延迟毛刺高达 200 ms+；
2. 4G/5G 移动弱网存在 2% 的随机无线丢包，下载视频速度暴跌；
3. 数据中心内部高吞吐同步流量经过大缓存交换机，延迟从 0.2 ms 飙升到 30 ms（Bufferbloat）。

<details>
<summary>查看参考答案</summary>

1. **尾包丢失**：传统 3 Dup ACK 依赖后续新包触发，尾包之后无新包只能干等 ≥ 200 ms 的 RTO。Linux 4.15+ 默认的 **RACK-TLP** 通过 TLP 在约 `2 × SRTT` 后主动发探测包，迅速触发快速恢复，将 200 ms+ 毛刺压缩至数毫秒。
2. **移动弱网随机丢包**：Reno/CUBIC 将一切丢包视为网络拥塞，2% 随机丢包会持续触发乘性降窗导致吞吐腰斩。改用 **BBR** 后，其基于瓶颈带宽与最小 RTT 控速，不因少量随机丢包盲目缩减发送速率，弱网吞吐可提升数倍。
3. **大缓存交换机 Bufferbloat**：基于丢包的算法会把交换机队列彻底填满溢出才降速，人为制造高排队延迟。采用 **BBR**（主动将队列控制在最小 RTT 附近）或开启 **ECN / L4S**（队列刚起势即显式降速通知）可显著压低排队延迟。

</details>

## 面试题 {#ch5-interview}

本节精选 5 道高频 TCP 传输与性能面试题，聚焦底层辨析与现代演进；请先独立作答，再展开核对。

### 面试题 1：TCP 流量控制和拥塞控制有什么本质区别？两者如何共同决定发送速率？

<details>
<summary>查看参考答案</summary>

**结论**：**流量控制是端到端保护接收方缓冲区不被撑爆**，**拥塞控制是全局视角保护共享网络链路不发生崩溃**；发送方实际允许在途的数据量取两者较小值：`swnd = min(cwnd, rwnd)`。

**关键依据**：
- **流量控制**由接收方在每个 TCP 首部的 `Window` 字段显式通告当前可用接收窗口 `rwnd`（随应用 `read()` 速度动态变化）；
- **拥塞控制**由发送方独立维护拥塞窗口 `cwnd`，通过监测丢包、RTT 增长或 ECN 信号动态推断共享网络的承载能力。

</details>

### 面试题 2：为什么开启 SACK 之后仍需要 Linux 现代默认的 RACK-TLP？

<details>
<summary>查看参考答案</summary>

**结论**：SACK 解决了“知道该重传哪些空洞”，但传统触发重传的时机仍死板依赖“收到 3 个重复 ACK”；**RACK-TLP（RFC 8985）**将丢包判定从**计数驱动**升级为**时间驱动 + 尾包探测**，兼治尾包卡顿与乱序误判。

**关键依据**：
- **尾包丢失**：最后 1–2 个包丢失时没有后续包来触发 3 个 Dup ACK，传统机制只能苦等 200 ms+ 的 RTO；TLP 会在约 `2 × SRTT` 后发探针快速触发恢复；
- **多路径乱序**：ECMP 或无线链路乱序超过 3 个包时，旧算法会误触发快速重传并降窗；RACK 动态跟踪乱序时间窗，显著减少伪重传。

</details>

### 面试题 3：现代 Linux 默认的 CUBIC 和 Google 的 BBR 相比经典 TCP Reno 分别改进了什么？

<details>
<summary>查看参考答案</summary>

**结论**：**CUBIC** 仍基于丢包但用三次函数曲线与 0.7 倍温和降窗解决了高带宽长延迟链路的慢恢复问题；**BBR** 则跳出“以丢包判拥塞”的旧范式，直接按测得的瓶颈带宽与最小 RTT 控速，同时解决弱网随机丢包限速与 Bufferbloat 高延迟。

**关键依据**：
- **Reno**：丢包减半（0.5×），恢复靠每 RTT `+1 MSS` 线性爬坡，在高 BDP 链路上几乎不可用；
- **CUBIC（RFC 9438）**：丢包仅缩至 0.7×，按时间三次函数快速逼近 `W_max` 且与 RTT 解耦；
- **BBR**：测量 `BtlBw` 与 `RTprop`，以 `Inflight ≈ BtlBw × RTprop` 配合 `fq` Pacing 平滑发包，弱网不误降速、满载不塞爆交换机队列。

</details>

### 面试题 4：为什么说“用了 TCP 协议，业务数据依然可能丢失”？举出一个典型场景。

<details>
<summary>查看参考答案</summary>

**结论**：TCP 只保证**发送端内核到接收端内核**的传输层可靠交付，无法保证接收端**应用进程**真正完成读取与持久化落盘。

**关键依据**：
- 典型场景：发送端发出订单数据 → 接收端内核收到后写入 Socket 接收缓冲区并立刻向发送端回复了 `ACK`（发送端据此认为发送成功并释放了原始 `sk_buff`）→ 在接收端业务进程尚未调用 `read()`（或刚读入内存尚未落库）的瞬间，接收端进程 OOM 崩溃或服务器断电，内存中的数据随之丢失。
- **工程对策**：关键业务必须依赖应用层确认机制（持久化落盘后再回业务 ACK + 幂等重试）。

</details>

### 面试题 5：为什么在 Linux 调优 TCP 吞吐时，通常不建议在业务代码中手动调用 `setsockopt` 固定 `SO_SNDBUF` / `SO_RCVBUF`？

<details>
<summary>查看参考答案</summary>

**结论**：手动设置 `SO_SNDBUF` 或 `SO_RCVBUF` 会**直接禁用 Linux 内核对该连接的缓冲区自动动态调节（Auto-Tuning）机制**。

**关键依据**：
- Linux 默认依据 `tcp_wmem`/`tcp_rmem`（配合 `tcp_moderate_rcvbuf = 1`）按每条连接的实时吞吐与 RTT 自动伸缩缓冲：空闲连接只占几 KB，大流量高速连接自动扩至数 MB；
- 一旦代码写死固定值，设小了无法打满高 BDP 带宽，设大了则成千上万条低速/空闲连接会瞬间耗尽整机物理内存。正确做法是调大内核 sysctl 的上限值，把动态分配权留给内核。

</details>

## 参考资料

- [RFC 6298: Computing TCP's Retransmission Timer](https://datatracker.ietf.org/doc/html/rfc6298)
- [RFC 5681: TCP Congestion Control](https://datatracker.ietf.org/doc/html/rfc5681)
- [RFC 8985: The RACK-TLP Loss Detection Algorithm for TCP](https://datatracker.ietf.org/doc/html/rfc8985)
- [RFC 9438: CUBIC for Fast and Long-Distance Networks](https://datatracker.ietf.org/doc/html/rfc9438)
- [RFC 9330: Low Latency, Low Loss, and Scalable Throughput (L4S) Internet Service](https://datatracker.ietf.org/doc/html/rfc9330)
- [BBR: Congestion-Based Congestion Control (ACM Queue / Google)](https://queue.acm.org/detail.cfm?id=3022184)
- [Linux Kernel Documentation: IP Sysctl (`tcp_rmem`, `tcp_wmem`, `tcp_mem`, `tcp_recovery`)](https://docs.kernel.org/networking/ip-sysctl.html)
