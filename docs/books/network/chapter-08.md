---
title: 第 8 章 现代应用通信协议与网络排障实战
description: 系统梳理 HTTP 与 RPC 的融合演进、服务端实时通信全景（轮询、SSE、WebSocket 与 WebTransport），以及基于 iproute2、tcpdump、ethtool 与 mtr 的 Linux 全链路丢包与故障排查闭环。
---

# 第 8 章 现代应用通信协议与网络排障实战

## 本章要点

掌握了 TCP、IP、HTTP 与 TLS 的核心原理后，最后需要回答两个高频工程落地问题：**面对微服务内部调用和实时双向推送，如何在 HTTP、RPC、SSE、WebSocket 与 WebTransport 之间正确选型？面对线上突发的丢包、超时与连接重置，如何沿着网卡到应用的全链路用现代 Linux 工具快速定位根因？**本章整合原书《图解网络》3.8、3.9、4.3（抓包实战）与 4.22（全链路丢包排查）的全部精华，升级至 2026 视角：阐明现代 RPC（gRPC/Triple/ConnectRPC）与 HTTP/2/3 的深度融合，补齐原书缺失的 **SSE（LLM 流式输出事实标准）**、**WebSocket over HTTP/2/3（RFC 8441/9220）**与 **WebTransport**，纠正 WebSocket 帧长度上限（2<sup>63</sup> - 1 而非 2<sup>64</sup>）与缺失掩码字段，同时以 **`iproute2`（`ip`/`ss`/`nstat`/`tc`）** 全面替代过时的 `net-tools`，并修正原书 4.22 节严重的万兆带宽算术错误、`sar` 单位误读与全双工概念偏差。

读完本章后，应能清晰对比 RPC 与 REST/HTTP、轮询/SSE/WebSocket/WebTransport 的适用边界与底层帧机制，熟练编写 `tcpdump` 过滤条件并结合 `nftables`/`iptables` 钩子顺序分析抓包，并能按“队列 → qdisc → 网卡 → 软中断 → Socket 缓冲 → 链路逐跳”六步闭环排查线上丢包。

> 核对日期：2026 年 11 月 20 日；核对环境为 RFC 6455（WebSocket）、RFC 8441/9220（WebSocket over H2/H3）、W3C WebTransport / SSE 规范及 Linux 6.12 LTS（`iproute2`、`ethtool`、`tcpdump`、`mtr`）。

## 8.1 HTTP 与 RPC 的演进与融合 {#ch8-1}

### 8.1.1 从裸 TCP 分帧到 RPC 与 HTTP 的分工 {#ch8-1-1}

裸 TCP 只提供无边界字节流，任何业务通信都必须在应用层定义分帧与编解码格式（见[第 3 章应用层分帧](./chapter-03#ch3-1-3)）。首先必须厘清一个基本概念：**HTTP 是具体的应用层协议，而 RPC（Remote Procedure Call，远程过程调用）是一种调用范式**——目标是让开发者像调用本地函数 `orderSvc.Create(req)` 一样透明地调用远端机器上的服务，gRPC、Apache Dubbo、Thrift、ConnectRPC 才是其具体实现框架与协议。

两者并非简单的替代关系，在传统微服务与跨端架构中各自发挥优势：

| 对比维度 | 传统 REST / HTTP/1.1（JSON） | 现代 RPC 框架（如 gRPC / Dubbo Triple / ConnectRPC） |
| --- | --- | --- |
| **定位与生态** | 对外开放 API、浏览器与多端统一接入，可读性强、工具链通用 | 内部微服务间高频通信，强调强契约、高性能与一站式治理 |
| **契约与序列化** | 文本协议为主，多配 JSON（冗余字段名占空间、解析耗 CPU），弱接口契约 | **IDL 强类型接口定义**（`.proto` / `.thrift`）自动生成多语言桩代码，默认采用 **Protobuf** 等紧凑二进制序列化 |
| **服务发现与治理** | 通常依赖 DNS + 反向代理/网关 | 原生集成服务注册中心（Etcd / Consul / Nacos / Kubernetes DNS）与客户端负载均衡、超时传播、熔断重试与链路追踪 |
| **流式通信** | 经典请求-响应为主 | 原生支持**服务端流、客户端流与全双工双向流** |

### 8.1.2 2026 现状：不是对立，而是基于 HTTP/2 与 HTTP/3 融合 {#ch8-1-2}

原书 3.8 节把“HTTP/2 出现后为何仍不取代 RPC”主要归因于“HTTP/2 2015 年才出、历史存量惯性”，这一解释在 2026 年早已过时。今天的主流 RPC 框架**并没有与 HTTP 对立，而是全面拥抱 HTTP/2（乃至 HTTP/3）作为底层传输载体**：
- **gRPC** 原生运行在 **HTTP/2**（`h2` / 内网 `h2c`）之上，直接复用 HTTP/2 的二进制多路复用、HPACK 头部压缩与流控，载荷采用 5 字节长度前缀 + Protobuf 二进制；
- **Apache Dubbo 3（Triple 协议）** 与 **ConnectRPC** 进一步做到单端口同时兼容标准浏览器 HTTP/1.1–3 JSON 请求与高性能 gRPC 二进制流式调用，让内部 RPC 也能无缝穿透云原生网关（Envoy/Nginx/CDN）与 Service Mesh。

因此现代架构选型的分水岭早已不是“HTTP 还是 TCP”，而是**“面向外部浏览器/开放生态的 REST/JSON”** vs **“面向内部高频强契约服务的 IDL + Protobuf + HTTP/2/3 RPC 治理体系”**。

## 8.2 服务端实时通信全景：轮询、SSE、WebSocket 与 WebTransport {#ch8-2}

传统 HTTP 遵循“客户端发起请求 → 服务端被动响应”的交互模型。面对实时聊天、行情推送、协同编辑、网页游戏与 **AI 大模型逐字流式输出**等需要服务端主动下发数据的场景，衍生出四代演进方案：

### 8.2.1 短轮询、长轮询与 SSE（Server-Sent Events） {#ch8-2-1}

1. **短轮询（Short Polling）**：客户端每隔 1–2 秒发一次 HTTP 请求问“有新消息吗”。实现最简单，但绝大部分请求空跑，浪费带宽与服务端连接，且存在平均半个周期的延迟。
2. **长轮询（Long Polling）**：客户端发请求后服务端故意挂起连接（如超时 30 秒），一旦有新数据立刻返回，客户端收到后再发起下一次挂起（如扫码登录状态监听、消息队列消费者拉取）。大幅减少了无效空轮询，但仍受限于请求-响应往返，高并发消息下需频繁重建请求。
3. **SSE（Server-Sent Events，补齐原书缺失）**：基于标准 HTTP（完整兼容 HTTP/1.1、HTTP/2、HTTP/3），服务端返回 `Content-Type: text/event-stream` 后保持响应流不断开，持续以 `data: ...\n\n` 文本块向客户端**单向推送**事件；浏览器内置 `EventSource` 原生支持断线自动重连与 `Last-Event-ID` 断点续传。
   - **2024–2026 核心地位**：无需协议升级、完美穿透各类代理防火墙且天然契合单向推送需求，**SSE 已成为 ChatGPT/LLM 大模型流式生成、实时通知与监控告警推送的事实标准**。

### 8.2.2 WebSocket 协议解析与现代 HTTP/2/3 复用 {#ch8-2-2}

当业务需要低延迟的**全双工双向实时通信**（聊天室、协同文档、实时对战）时，**WebSocket（RFC 6455）** 通过一次 HTTP 握手“升级”切换至持久化二进制帧通道：

1. **HTTP/1.1 Upgrade 握手（补齐缺失字段）**：客户端发起 `GET` 请求，携带关键头部：
   - `Connection: Upgrade`、`Upgrade: websocket`；
   - **`Sec-WebSocket-Version: 13`**（原书 3.9 节遗漏的必选头）；
   - `Sec-WebSocket-Key: <16 字节随机数的 Base64>`。
   - 服务端将 `Sec-WebSocket-Key` 拼接固定魔术串 `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` 后计算 SHA-1 再做 Base64，填入 **`Sec-WebSocket-Accept`** 并回复 **`HTTP/1.1 101 Switching Protocols`**，此后该 TCP 连接脱离 HTTP 语义，进入全双工 WebSocket 帧传输。
2. **WebSocket 二进制帧结构（纠偏原书 3.9 节错误与遗漏）**：
   - `FIN`（1 bit）：标识是否为一条完整消息的最后一帧（支持分片）；
   - `opcode`（4 bit）：`1` 文本（UTF-8）、`2` 二进制、`8` 关闭连接、**`9` Ping / `10` Pong（协议内置应用层心跳帧）**；
   - **`MASK`（1 bit）与 `Masking-key`（4 字节，原书遗漏的安全关键机制）**：**RFC 6455 §5.3 强制要求客户端发往服务端的每一帧都必须掩码混淆**（防恶意构造类似 HTTP 报文的字节流污染中间透明代理缓存），而服务端发往客户端的帧**不得掩码**；
   - `Payload len`（变长编码）：`0–125` 直接表示字节数；`126` 表示后接 16 bit 长度；`127` 表示后接 64 bit 长度——**纠正原书 3.9 节错误**：RFC 6455 §5.2 规定 64 位扩展长度的最高位（MSB）必须为 `0`，因此单帧理论最大长度为 **2<sup>63</sup> - 1 字节**，而非原书写的 2<sup>64</sup> 字节！
3. **现代升级——WebSocket over HTTP/2 & HTTP/3（修正“彻底脱离 HTTP”的旧认知）**：原书断言升级后就与 HTTP 无关，且每条 WebSocket 独占一条 TCP 连接。如今 **RFC 8441（HTTP/2）** 与 **RFC 9220（HTTP/3）** 定义了 **Extended `CONNECT`** 方法（附 `:protocol: websocket` 伪头部），允许直接把 WebSocket 跑在现有 HTTP/2 或 HTTP/3 的单条 Stream 上复用连接，无需 `101 Upgrade` 和独立 TCP 握手。

### 8.2.3 WebTransport：消除 WebSocket 队头阻塞的新一代方案 {#ch8-2-3}

基于 TCP 的 WebSocket 依然逃不过单连接字节流队头阻塞——对于原书 3.9 节开头举例的“实时网页游戏位置同步”或低延迟音视频，前 1 帧丢包会卡住后面所有最新位置帧。构建在 **HTTP/3 / QUIC** 之上的 **WebTransport** 同时提供了**多条独立有序可靠流**与**不可靠低延迟数据报（QUIC Datagrams）**，丢弃过期位置包不阻塞新帧，已成为 Web 端实时游戏、云桌面与互动直播的新一代演进方向。

| 方案 | 方向性 | 底层传输 | 队头阻塞 | 典型适用场景 |
| --- | --- | --- | --- | --- |
| **长轮询** | 伪服务端推送 | HTTP/1.1+ | 有 | 极低频状态变更（扫码登录）、老旧兼容环境 |
| **SSE** | **服务端 → 客户端单向** | 标准 HTTP/1.1–3 | 随底层 HTTP | **AI/LLM 流式输出**、行情看板、站内消息通知 |
| **WebSocket** | **全双工双向** | TCP（或 H2/H3 Stream） | 单连接/单流内有 | 即时聊天、在线协作编辑、中高频双向指令 |
| **WebTransport** | **全双工多流 + 数据报** | **HTTP/3（QUIC / UDP）** | **无跨流/数据报阻塞** | 实时网页游戏、低延迟音视频与云渲染控制 |

## 8.3 现代 Linux 网络抓包与诊断工具链 {#ch8-3}

### 8.3.1 网络层与路由流控诊断命令（`iproute2`） {#ch8-3-1}

现代 Linux 生产环境已全面淘汰停维的 `net-tools`（`ifconfig`/`netstat`/`route`/`arp`；主机全栈观测工具对照详见[《图解系统》第 8 章现代观测工具图谱](../system/chapter-08#ch8-1-2)）。在网络协议栈与路由流控定界中，重点掌握以下专有诊断参数：

| 网络排障目标 | 推荐命令与高频参数示例 | 关键观测输出 |
| --- | --- | --- |
| **网卡详细丢包细分** | `ip -s -s link show eth0` / `ethtool -S eth0` | 区分物理 CRC 错包、Ring Buffer `overruns` 与驱动丢弃 |
| **内核选路精确模拟** | `ip route get 203.0.113.10 from 10.0.1.5` | 直接让内核返回实际命中的路由出口网卡、源 IP 与下一跳网关（含策略路由） |
| **ARP / IPv6 邻居状态** | `ip neigh show` | 检查下一跳 MAC 是否处于 `REACHABLE`、`STALE` 或解析失败 `FAILED` |
| **TCP 内部窗口与强断连接** | `ss -tin` / `ss -K dst 10.0.0.8 dport = 8080` | 观测实时 `cwnd`/`rtt`/`notsent`，或经 Netlink 直接注入 `RST` 清理僵死连接 |
| **协议栈异常计数与 qdisc** | `nstat -az 'TcpExt*'` / `tc -s qdisc show dev eth0` | 核查队列溢出、乱序丢包（`TCPOFODrop`）及出站流控队列 `dropped` |

### 8.3.2 `tcpdump` 实战与防火墙钩子先后顺序 {#ch8-3-2}

`tcpdump` 借助 BPF 过滤器直接从内核抓包，排查疑难连接问题的标准起手式为：

```bash
# -i 指定网卡(-i any 抓全网卡)  -nn 禁用DNS/端口名解析  -s0 抓完整包不截断  -w 存 pcap 供 Wireshark 分析
tcpdump -i eth0 -nn -s0 'host 10.0.0.12 and tcp port 443' -w capture.pcap
```

**排查丢包必知的钩子顺序**（结合 Linux 协议栈验证规则是否拦包）：
- **入站方向（Inbound）**：`网卡 → tcpdump（AF_PACKET） → netfilter（nftables / iptables INPUT）`。因此**即便本机防火墙在 INPUT 链丢弃了数据包，`tcpdump` 依然能抓到它**！
- **出站方向（Outbound）**：`协议栈 → netfilter（OUTPUT） → tcpdump → 网卡`。因此**若本机防火墙在 OUTPUT 链丢弃了出包，`tcpdump` 是抓不到的**！

将 `.pcap` 拖入 **Wireshark** 后，善用 `Statistics → Flow Graph → TCP Flows` 一览握手/挥手/重传全局时序，结合 `Expert Information` 快速定位 Retransmission、Dup ACK、ZeroWindow 与 RST；而在动用 `tcpdump` 抓全量包之前，遇到域名访问失败应先做**轻量分层定界**：用 **`dig`** 核查 DNS 状态码（如 `NXDOMAIN` vs `SERVFAIL`）与 `HTTPS` 记录，用 **`curl -v --resolve host:443:IP https://host/...`** 在保留 SNI、证书校验与 `Host` 头的前提下绕过 DNS 直连目标节点对照，再配合 **`curl -v --http3-only`** 与 **`openssl s_client -connect host:443 -tls1_3 -showcerts`** 覆盖从 L2 到 L7 的完整观测能力。

## 8.4 线上全链路丢包与连接故障排查闭环 {#ch8-4}

“用了 TCP 还是出现超时、重传甚至断连，包到底丢在了哪里？”顺着数据包穿越主机与公网的完整路径，按 **6 个排查检查点**自内向外逐层排除，可快速定位 95% 以上的线上网络故障：

### 8.4.1 主机内部 5 大丢包检查点（纠偏原书 4.22 节算术错误） {#ch8-4-1}

```text
应用 write ──> [① 建连队列] ──> [⑤ Socket 缓冲] ──> [② qdisc 流控] ──> [③ 网卡 RingBuffer/带宽]
                                                                               │ (公网链路 ⑥)
应用 read  <── [⑤ 接收缓冲] <── [④ 软中断队列]   <──────────────────── [③ 网卡 RingBuffer]
```

1. **检查点 ①：半连接 / 全连接队列溢出**
   - 命令：`ss -lnt` 核对 `LISTEN` 态 `Recv-Q` vs `Send-Q`，并执行 `nstat -az TcpExtListenOverflows TcpExtListenDrops TcpExtSyncookiesSent`。
   - 处置：联动调大 `somaxconn`、`listen backlog`、`tcp_max_syn_backlog` 并排查应用 `accept()` 阻塞（详见[第 3 章队列溢出](./chapter-03#ch3-3-2)）。
2. **检查点 ②：发包流控队列（`qdisc`）溢出**
   - 命令：`tc -s qdisc show dev eth0` 查看 `dropped` 与 `overlimits`，配合 `ip -s link show eth0` 查看 `TX dropped`。
   - 处置：若发送突发远超队列长度，可用 `ip link set dev eth0 txqueuelen 2000` 适度调大，或切换至 `fq` / `fq_codel` 队列管理算法。
3. **检查点 ③：网卡 Ring Buffer 溢出与物理带宽打满（重点勘误原书 4.22 节）**
   - **Ring Buffer 溢出**：执行 `ip -s -s link show eth0` 查看 `RX overruns` / `fifo` 及 `ethtool -S eth0 | grep -iE 'drop|miss|err'`；用 `ethtool -g eth0` 对比当前与硬件最大 Ring Buffer 槽位数，必要时用 `ethtool -G eth0 rx 4096 tx 4096` 扩容（同时检查多队列 RSS 绑定，避免单核软中断打满来不及收割 Ring Buffer）。
   - **带宽打满与单位换算纠偏**：先用 `ethtool eth0 | grep Speed` 查网卡速率，再用 `sar -n DEV 1` 查实时流量。
     - **纠正原书 4.22 节三处连续错误**：① `10000Mb/s` 是**万兆（10 Gbps）**，除以 8 理论单向带宽为 **`1250 MB/s`**，原书将其错写成千兆 `1000Mb/s` 与 `125 MB/s`；② `sar -n DEV` 的 `rxkB/s` 与 `txkB/s` 单位是 **千字节/秒（kB/s）**而非字节/秒（千兆满速约为 `125,000 kB/s`）；③ 现代以太网均为**全双工（Full Duplex）**，千兆网卡的收（RX）与发（TX）理论上限为**各自独立 125 MB/s**，并非“RX + TX 之和等于 125 MB/s”！
4. **检查点 ④：内核软中断收包队列溢出**
   - 命令：查看 **`/proc/net/softnet_stat`**（每行对应一个 CPU 核心，第 2 列为因 `net.core.netdev_max_backlog` 队列满导致的丢包计数，第 3 列为 NAPI `time_squeeze` 超预算次数，均为十六进制）。
   - 处置：开启网卡多队列 **RSS**（或软件 **RPS**）打散中断核，适度调大 `netdev_max_backlog` 与 `netdev_budget`。
5. **检查点 ⑤：TCP Socket 接收/乱序缓冲区丢包**
   - 命令：`nstat -az TcpExtTCPRcvQDrop TcpExtTCPBacklogDrop TcpExtTCPOFODrop`（`TCPRcvQDrop` 自 Linux 5.9+ 引入，反映应用 `read()` 过慢致接收缓冲彻底打满后的丢包；`TCPOFODrop` 反映乱序队列超内存限制丢包）。
   - 处置：首要排查应用消费阻塞或死锁，其次按 BDP 合理放宽 `tcp_rmem` 与 `tcp_mem` 上限（见[第 5 章缓冲区调优](./chapter-05#ch5-4)）。

### 8.4.2 端到端与公网逐跳排查：`ping` 与 `mtr` 判读法则 {#ch8-4-2}

若本机与目标主机内部 5 个检查点均无异常丢包，问题即落在**检查点 ⑥：中间网络设备或公网链路**。使用 `mtr`（融合 `ping` 与 `traceroute`）进行持续采样：

```bash
# -r 报告模式  -c 100 发 100 轮  -n 禁反向 DNS  (-T -P 443 可切为穿透防火墙的 TCP 443 模式)
mtr -r -c 100 -n -T -P 443 <目标IP或域名>
```

**核心判读法则（防误判）**：
- **仅中间某一跳显示 30%–100% 丢包，但后续所有跳数及最终目标跳丢包率为 0%**：这是**正常现象（ICMP 限速虚报）**！公网核心路由器优先硬件转发业务包，对控制面生成 ICMP 超时响应严格限速，不代表该跳真的在丢弃你的业务流量。
- **从第 k 跳开始出现持续丢包（如 5%），且第 k+1 跳直至最终目标跳都维持 ≥ 5% 丢包或延迟阶跃暴涨**：这才是**真实链路拥塞或故障点**，根因就在第 `k - 1` 跳与第 `k` 跳之间的链路上！

## 练习 {#ch8-exercises}

本节包含 5 道递进练习，依次覆盖实时通信协议选型、WebSocket 帧格式与安全校验、`tcpdump` 与防火墙抓包诊断、`mtr` + `iproute2` 全链路丢包定位及 DNS + `curl --resolve` 分级故障排查。请先独立推演，再展开参考答案核对。

### 练习 1：为四个真实业务场景选择最优通信协议并说明理由

从 **REST/HTTP（JSON）**、**gRPC（Protobuf over HTTP/2）**、**SSE**、**WebSocket**、**WebTransport** 中，为以下四个场景分别选出最合适的协议并给出关键依据：

1. 订单服务与库存、优惠券、风控 3 个内部微服务之间的高并发低延迟调用（每秒 5 万 QPS，跨 Go/Java 两套语言）；
2. AI 助手网页端实时逐字流式展示大语言模型生成的回答；
3. 多人在线文档协同编辑（高频率双向发送编辑操作与光标位置）；
4. 浏览器端实时动作对战游戏（每秒 60 次同步角色坐标，允许丢弃过期旧位置以换取极致低延迟）。

<details>
<summary>查看参考答案</summary>

1. **gRPC（Protobuf over HTTP/2）**：强类型 `.proto` IDL 契约自动生成 Go/Java 桩代码，二进制序列化体积小、解析快，HTTP/2 多路复用免除频繁建连，且与云原生网关/Service Mesh 天然兼容。
2. **SSE（`text/event-stream`）**：典型的服务端向客户端**单向流式文本推送**；基于标准 HTTP 无需协议升级、穿透代理零障碍且原生支持断线自动重连，比 WebSocket 轻量得多。
3. **WebSocket（优先支持 RFC 8441/9220 over H2/H3）**：需要高频、低延迟、可靠有序的**全双工双向通信**，每条操作指令都不能丢，非常适合 WebSocket 持久化双向帧。
4. **WebTransport（over HTTP/3 / QUIC）**：实时动作游戏对延迟极度敏感，WebSocket 受 TCP 队头阻塞影响，丢一个旧坐标包会卡住后续最新位置；WebTransport 原生支持 **QUIC 不可靠数据报（Datagrams）**，旧坐标丢了直接跳过不阻塞新状态。

</details>

### 练习 2：剖析 WebSocket 客户端帧为何必须开启 `MASK` 掩码

某开发者手写了一个简易 WebSocket 客户端，在完成 `101 Switching Protocols` 握手后，直接构造了一帧 `FIN=1, opcode=1, MASK=0` 的文本帧发给标准 Nginx/Go WebSocket 服务端，结果连接立刻被服务端以状态码 `1002 Protocol Error` 断开。

1. 解释服务端为何必须断开该连接？`MASK` 掩码机制防范的是什么安全攻击？
2. 若一条超长 WebSocket 帧的 7 位长度字段填了 `127`，后续紧跟的扩展长度字段占多少位？其合法最大值是多少？

<details>
<summary>查看参考答案</summary>

1. **断开原因与安全原理**：**RFC 6455 §5.1 / §5.3** 强制规定，**客户端发往服务端的所有帧必须设置 `MASK = 1`** 并携带 4 字节随机 `Masking-key` 对载荷做异或掩码，服务端收到未掩码帧必须立即断开连接（报 `1002`）。该机制旨在防止恶意网页脚本在 WebSocket 载荷中刻意构造伪造的明文 `GET /evil HTTP/1.1` 字节流，从而欺骗路径上不识别 WebSocket 的老旧透明 HTTP 缓存代理引发**代理缓存投毒（Cache Poisoning）**。
2. **长度字段**：填 `127` 时后接 **64 bit（8 字节）**无符号整数，但 RFC 6455 §5.2 规定最高有效位（MSB）必须为 `0`，因此单帧最大合法载荷长度为 **2<sup>63</sup> - 1 字节**。

</details>

### 练习 3：结合 `tcpdump` 与防火墙钩子顺序判断故障点

运维人员在一台 Linux 6.12 服务器（IP `10.0.1.20`）上排查客户端（`10.0.1.10`）无法访问 `8080` 端口的问题，执行了以下操作并观察到现象：
- 在服务端执行 `ss -lnt 'sport = :8080'` 确认进程正在正常监听 `0.0.0.0:8080`，`Recv-Q = 0, Send-Q = 4096`；
- 在服务端执行 `tcpdump -i eth0 -nn 'host 10.0.1.10 and port 8080'`，清晰看到了客户端不断发来的 `[S]`（SYN）包，但服务端**没有任何回复包**（既无 `SYN+ACK` 也无 `RST`）。

请结合入站包在 Linux 内核中的经过顺序，指出最可能的原因及验证命令。

<details>
<summary>查看参考答案</summary>

- **最可能原因**：**服务端本机防火墙（`nftables` 或 `iptables` 的 `INPUT` 链）配置了 `DROP` 规则拦掉了 8080 端口的入站流量**。
- **推理依据**：
  1. 服务端 `tcpdump` 抓到了 `SYN`，证明包已经穿过公网/交换机并被本机网卡接收（排除外部路由与上游安全组拦截）；
  2. 服务进程正常监听且全连接队列为空，按理内核一定会回 `SYN+ACK`；如今彻底静默无回复，正是因为 Linux 入站路径为 **`网卡 → tcpdump → netfilter (INPUT)`**——包先被 `tcpdump` 抓到，随后被 `INPUT` 链的 `DROP` 规则静默丢弃，根本没到达 TCP 协议栈！
- **验证命令**：执行 `nft list ruleset` 或 `iptables -nvL INPUT` 检查匹配计数递增的 `DROP` 规则。

</details>

### 练习 4：判读一组综合线上丢包监控与 `mtr` 报告

某 Linux 6.12 千兆全双工服务器（`ethtool eth0` 显示 `Speed: 1000Mb/s`, `Duplex: Full`）出现业务间歇超时，收集到以下三组数据：

- **数据 1**：`sar -n DEV 1` 显示 `rxkB/s = 82000`，`txkB/s = 85000`；
- **数据 2**：`ip -s -s link show eth0` 显示 `RX overruns` 持续飙升，`nstat -az TcpExtListenOverflows` 为 `0`；
- **数据 3**：`mtr -r -c 100 -n <目标>` 显示第 3 跳 `Loss% = 45.0%`，第 4 跳至第 8 跳（终点）`Loss%` 均为 `0.0%`。

请逐条判断：① 网卡物理带宽是否已打满？② 真正的丢包发生在哪里？③ `mtr` 第 3 跳的 45% 丢包是不是元凶？

<details>
<summary>查看参考答案</summary>

1. **物理带宽未打满**：千兆全双工网卡的理论上限是 **RX 125 MB/s（125,000 kB/s）与 TX 125 MB/s 各自独立**。当前 RX 82 MB/s、TX 85 MB/s 均未达到 125 MB/s 上限（切勿把两者相加算成 167 MB/s > 125 MB/s 而误判！）。
2. **真正丢包点在网卡 RX Ring Buffer（或收包软中断来不及处理）**：`RX overruns` 持续飙升表明网卡收包写入 Ring Buffer 时，内核软中断来不及取走导致旧槽位溢出丢包。应立即用 `ethtool -g eth0` 检查并调大 RX Ring Buffer，并检查 `/proc/interrupts` 与 `/proc/net/softnet_stat` 排查是否因未开多队列 RSS 导致单核 CPU 软中断打满。
3. **`mtr` 第 3 跳不是元凶**：第 4 跳至终点丢包率均为 `0.0%`，说明业务流量完整穿过了第 3 跳，45% 只是第 3 跳路由器对自身生成 ICMP 超时响应做了限速（典型虚报）。

</details>

### 练习 5：用 `dig` 与 `curl --resolve` 对域名访问失败做分级排障

线上反馈访问 `https://api.example.com/health` 失败。为避免一遇到访问异常就盲目抓全量包，请按“DNS 解析 → TCP 建连 → TLS 握手 → HTTP 响应”分级定界思路，分析以下三种现场：

- **现场 A**：执行 `dig api.example.com` 返回状态为 **`NXDOMAIN`**；
- **现场 B**：执行 `dig api.example.com` 返回状态为 **`SERVFAIL`**，而指定公共解析器执行 `dig @1.1.1.1 api.example.com` 正常返回 `203.0.113.50`；
- **现场 C**：`dig api.example.com` 正常返回 `203.0.113.50`，但直接 `curl https://api.example.com/health` 超时或报错（已知另一台健康节点 IP 为 `203.0.113.51`）。

请回答：
1. 现场 A 的 `NXDOMAIN` 与现场 B 的 `SERVFAIL` 有何本质区别？分别应优先排查哪一侧？
2. 在现场 B 或现场 C 中，为何应执行 `curl -v --resolve api.example.com:443:203.0.113.50 https://api.example.com/health` 做直连对照，而不是直接请求 `curl -v https://203.0.113.50/health`？
3. 如何依据 `curl -v --resolve` 的分段输出，快速判断问题落在“地址可达但 TCP 失败”“TLS 握手/证书失败”还是“HTTP 应用层异常”？

<details>
<summary>查看参考答案</summary>

1. **`NXDOMAIN` 与 `SERVFAIL` 的本质区别**：
   - **`NXDOMAIN`（Non-Existent Domain）**：表示权威 DNS 明确答复“该域名不存在”（常见于域名拼写错误、记录被误删、内网 Split-Horizon 视图未配置该记录，且可能受 SOA 负缓存影响）。应优先核查域名拼写、权威 DNS 记录及当前解析器命中的内/外网视图；
   - **`SERVFAIL`（Server Failure）**：表示递归解析器未能完成解析（**不代表域名不存在**），常见根因包括本地递归 DNS 故障、上游转发超时、权威服务器不可达或 **DNSSEC 验签失败**。现场 B 换 `@1.1.1.1` 可正常返回，进一步坐实问题出在默认本地递归解析器或其上游/DNSSEC 链路。
2. **为何用 `curl --resolve` 保留主机名直连对照**：
   - 直接访问 `https://203.0.113.50/health` 会丢失域名上下文：既不会在 TLS `ClientHello` 中发送正确的 **SNI**（多租户网关/CDN 会下发错误默认证书或直接断开），也会导致 **TLS 证书主机名（SAN）校验失败**，且 HTTP `Host` 头变为 IP 触发虚拟主机路由错配；
   - **`curl --resolve api.example.com:443:203.0.113.50 https://api.example.com/health`** 仅在本地绕过 DNS 解析将域名映射到指定 IP，同时**完整保留 TLS SNI、证书域名校验与 HTTP `Host` 头**，还可将 IP 替换为备用节点 `203.0.113.51` 快速比对单点故障与全局故障。
3. **借助 `curl -v --resolve` 分级定界**：
   - **停在 `Trying 203.0.113.50:443...` 后超时或报 `Connection refused`**：故障在网络可达性或 **TCP 建连层**（路由、防火墙拦截、端口未监听或队列溢出），此时再针对该 IP/端口动用 `ss`、`mtr` 或 `tcpdump`；
   - **已打印 `Connected to ...`，随后卡死或报 `SSL/TLS` 错误**：TCP 已通，故障在 **TLS 握手/证书层**（如中间证书缺失、SNI 错配、协议套件不兼容或 PMTUD 黑洞卡在证书大包），可进一步用 `openssl s_client -servername api.example.com -connect 203.0.113.50:443 -showcerts` 核验；
   - **TLS 握手成功并发送 `> GET /health`，随后超时或返回 `502`/`504`/`500`**：DNS、TCP 与 TLS 均正常，故障已收窄至七层反向代理或后端应用服务本身。

</details>

## 面试题 {#ch8-interview}

本节精选 5 道高频应用通信协议与线上排障面试题，聚焦架构选型与排障逻辑；请先独立作答，再展开核对。

### 面试题 1：既然有了 HTTP/2 和 HTTP/3，为什么微服务内部通信依然广泛使用 gRPC 等 RPC 框架，而不是全部裸用 REST/JSON？

<details>
<summary>查看参考答案</summary>

**结论**：现代 RPC 并非与 HTTP/2/3 对立，而是**在 HTTP/2/3 传输层之上叠加了强类型契约、高效二进制序列化、双向流与微服务治理生态**。

**关键依据**：
1. **IDL 强契约与代码生成**：`.proto` 一份定义自动生成多语言客户端/服务端代码，编译期拦截字段错误，省去手写大量 HTTP 拼装与校验模板代码；
2. **性能与带宽优势**：Protobuf 二进制编码免去 JSON 冗余键名与反射文本解析开销；
3. **开箱即用的治理能力**：原生集成服务发现、负载均衡、超时透传（Deadline Propagation）、双向流式调用与可观测拦截器。

</details>

### 面试题 2：AI 大模型对话的“打字机流式输出”为什么普遍采用 SSE 而不是 WebSocket？

<details>
<summary>查看参考答案</summary>

**结论**：大模型对话本质是**一次提问 + 服务端单向持续吐字**，SSE 精准匹配单向流需求且接入成本远低于 WebSocket。

**关键依据**：
- SSE 就是标准 HTTP 响应（`Content-Type: text/event-stream`），直接兼容 HTTP/2、HTTP/3 多路复用、CDN、WAF 与各类企业代理，无需 `101 Upgrade` 握手，也不必额外维护有状态双向连接与复杂心跳；
- 浏览器原生支持自动重连与断点 ID，客户端发送新一轮提问只需发起常规 `POST` 请求即可。

</details>

### 面试题 3：在 Linux 上用 `tcpdump` 抓包排查防火墙拦截问题时，入站包和出站包的行为有什么不同？

<details>
<summary>查看参考答案</summary>

**结论**：本机防火墙（`nftables`/`iptables`）拦截**入站包**时，`tcpdump` **依然能抓到**；拦截**出站包**时，`tcpdump` **抓不到**。

**关键依据**：
- **入站顺序**：`物理网卡 → tcpdump（AF_PACKET 旁路） → netfilter（INPUT 链）`，因此包在被防火墙丢弃前就已经被 `tcpdump` 捕获；
- **出站顺序**：`内核协议栈 → netfilter（OUTPUT 链） → tcpdump → 物理网卡`，因此包在到达 `tcpdump` 之前就已经被 `OUTPUT` 链丢弃。

</details>

### 面试题 4：用 `mtr` 排查公网丢包时，看到中间第 4 跳丢包 60%，但后面几跳和终点都是 0% 丢包，这说明网络有问题吗？

<details>
<summary>查看参考答案</summary>

**结论**：**不能说明网络有问题**，这通常是第 4 跳路由器的 **ICMP 控制面限速**造成的正常假象。

**关键依据**：
- 路由器数据面高速转发业务包与控制面 CPU 生成 ICMP Time Exceeded 响应是两条路径；出于防 DDoS 保护，骨干路由器会对 ICMP 响应严格限速；
- 判读 `mtr` 必须看**连续传递效应**：只有从某一跳开始丢包，并且**后续每一跳直到终点都持续维持该丢包率（或更高）**，才能确认该处存在真实链路丢包。

</details>

### 面试题 5：线上某台 Linux 服务器业务反馈偶发网络超时和丢包，请给出一套自内向外的系统排查步骤。

<details>
<summary>查看参考答案</summary>

**结论**：沿数据包收发全路径执行**“本机协议栈队列 → 网卡与软中断 → Socket 缓冲 → 外部链路”**四层闭环排查。

**关键依据（核心命令清单）**：
1. **查建连与协议栈计数**：`ss -lnt` 查全连接队列是否满，`nstat -az 'TcpExtListen*' 'TcpExtTCPRcvQDrop' 'TcpExtTCPTimeouts'` 查溢出、接收缓冲丢包与超时重传；
2. **查流控与网卡硬件**：`tc -s qdisc` 查发包排队丢包，`ip -s -s link` 与 `ethtool -S` 查 `RX overruns` / Ring Buffer 丢包，`sar -n DEV 1` 对照 `ethtool` 核实全双工带宽是否打满；
3. **查软中断瓶颈**：查看 `/proc/net/softnet_stat` 与 `mpstat -P ALL 1` 排查单核 `si` 软中断飙高（核查多队列 RSS）；
4. **查外部链路与抓包取证**：`mtr -r -c 100 -n -T -P <port>` 定位真实跨跳丢包点，必要时在双端同步 `tcpdump -w` 抓包对照 Wireshark 确认包是在发端、链路还是收端丢失。

</details>

## 参考资料

- [RFC 6455: The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [RFC 8441 (Bootstrapping WebSockets with HTTP/2) & RFC 9220 (with HTTP/3)](https://datatracker.ietf.org/doc/html/rfc9220)
- [WHATWG HTML Standard: Server-Sent Events (`EventSource`)](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [W3C / IETF WebTransport Specification](https://w3c.github.io/webtransport/)
- [gRPC over HTTP2 Protocol Specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)
- [Linux Kernel Documentation: Monitoring and Tuning the Linux Networking Stack](https://docs.kernel.org/networking/statistics.html)
- [Cloudflare Learning: Understanding `mtr` Output & ICMP Rate Limiting](https://www.cloudflare.com/learning/network-layer/what-is-mtr/)
