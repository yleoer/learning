---
title: 第 4 章 透明多级分流：HTTP/3、CDN、四七层均衡与多级缓存
description: 沿着请求全链路拆解 HTTP 缓存、加密 DNS、QUIC 跨流队首阻塞隔离、CDN、LVS 四层与七层负载均衡及 Caffeine W-TinyLFU 多级缓存。
---

# 第 4 章 透明多级分流：HTTP/3、CDN、四七层均衡与多级缓存

## 本章要点

支撑百万至千万级并发系统的秘诀并非造出一台性能无限的单体数据库，而是遵循“**层层漏斗削峰，保护末端单点有状态存储**”与“**奥卡姆剃刀按需演进**”两大准则，在客户端到数据库之间构筑业务无感知的透明多级分流防线。本章沿着一次网络请求的真实物理旅程依次推进：首先梳理浏览器强缓存/协商缓存（RFC 9111）、加密 DNS 与从 HTTP/1.1 到 **HTTP/3（QUIC）** 逐步消解队首阻塞的传输演进；随后对比 CDN 边缘加速及数据中心四层（LVS DR/TUN/NAT）与七层负载均衡协作；最后深入进程内 **Caffeine `W-TinyLFU`** 无锁高吞吐缓存与 L1/L2 透明多级缓存架构。

> 核对日期：2026 年 11 月 20 日；基于 RFC 9111 / RFC 9000 / RFC 9114、LVS 与 Caffeine 官方文档核对（本地参考环境为 Go 1.27.4、Linux/AMD64，未搭建真实 CDN 与多节点 LVS 集群实测）。

## 4.1 客户端缓存、DNS 调度与 HTTP/3 传输链路 {#ch4-1}

### 4.1.1 HTTP 强制缓存与协商缓存精确语义（RFC 9111） {#ch4-1-1}

最优的网络请求是根本不用发出的请求。现代 HTTP 缓存规范（RFC 9111，取代旧 RFC 7234）区分**私有缓存（浏览器本地）**与**共享缓存（CDN / 反向代理）**，并分两阶段拦截重复请求：

```text
浏览器发起请求 ──► [阶段 1：浏览器私有强制缓存] ── 命中且未过期 (仅看 max-age / Expires，忽略 s-maxage) ──► 零网络通信直读本地 (200 from cache)
                         │ 本地未命中、已过期或要求重验证 (no-cache)
                         ▼
                   [共享缓存 CDN / 反向代理] ── 命中且未过期 (优先看 s-maxage，否则回退 max-age) ──► 边缘直接响应，免回源
                         │ 边缘未命中或需重验证
                         ▼
                   [阶段 2：协商缓存 条件请求] 携带 If-None-Match (ETag) / If-Modified-Since 询问 CDN 或源站
                         ├── 资源未变 ──► 服务端仅回空包体 304 Not Modified，刷新缓存有效期
                         └── 资源已变 ──► 服务端回 200 OK + 最新完整表征与新 ETag
```

工程配置中需特别厘清三组高频混淆指令（订正原书对 `no-cache` 的模糊表述）：

- **`max-age` vs `s-maxage`（私有缓存与共享缓存分层新鲜期）**：`s-maxage` **仅约束共享缓存（CDN、反向代理）**，**浏览器本地私有缓存会直接忽略 `s-maxage`** 而只依据 `max-age` 判断新鲜期；在共享缓存上 `s-maxage` 则会覆盖 `max-age` 与 `Expires`。对公开内容可配置差异化新鲜期，例如 `Cache-Control: public, max-age=60, s-maxage=600`：用户浏览器最多本地缓存 `60 秒` 以较快感知内容更新，而 CDN 边缘节点可缓存 `600 秒`（配合发布或内容变更主动刷新 CDN），在新鲜度与回源削峰间取得平衡。
- **`Vary: Accept-Encoding`（多压缩表示缓存键隔离）**：同一 URL 常按客户端能力返回 `br`（Brotli）、`zstd`、`gzip` 或未压缩表征，响应头必须携带 `Vary: Accept-Encoding` 通知共享缓存与浏览器将该请求头纳入缓存键，防止将 Brotli 压缩副本错误命中并返回给仅支持 GZip 的客户端。
- **`no-cache` vs `no-store` 与 `ETag` vs `Last-Modified`**：**`Cache-Control: no-cache` 允许浏览器和 CDN 存储响应副本**，只是要求每次复用前必须走阶段 2 做 `ETag` 条件重验证（适合入口 `index.html`）；真正严禁任何节点落盘或缓存敏感报文的是 **`Cache-Control: no-store`**。校验器方面，`Last-Modified` 仅精确到秒级，基于内容哈希的 **`ETag` 优先级更高且精确无误**；带内容哈希指纹的静态产物（如 `app.8f3d2a.js`）标准配置为 `Cache-Control: public, max-age=31536000, immutable`。

### 4.1.2 加密 DNS、HTTP/3（QUIC）连接迁移与架构侧回退边界 {#ch4-1-2}

1. **DNS 智能调度与防劫持演进**：传统 UDP 53 端口明文递归解析易遭运营商 Local DNS 缓存超时失准或域名劫持，导致跨网调度失效。现代架构分两条路线治理：标准侧采用加密传输标准 DNS 报文的 **DoH**（DNS over HTTPS, RFC 8484）/ **DoQ**（over QUIC, RFC 9250）配合 **EDNS Client Subnet** 透传客户端网段；移动端 App 则常通过 HTTPS 直连云厂商权威调度接口（即国内通称的 **HTTPDNS**，注意勿与标准 DoH 混为一谈）直接拿到最优边缘 IP。
2. **HTTP/1.1 → HTTP/2 → HTTP/3（QUIC）对接入层架构的关键影响**：三代协议的底层帧结构、流控与压缩算法细节详见 [《图解网络》6.4 节](../network/chapter-06#ch6-4)，从分布式架构视角只需牢记其演进带来的分流与性能边界变化：
   - **HTTP/1.1 → HTTP/2（RFC 9113）**：单连接多路复用使域名分片、雪碧图合并退场，并将压缩演进至 **Brotli（`br`）** 与 **Zstandard（`zstd`）**；但多路复用把队首阻塞下移到了 TCP 传输层——一旦弱网丢包，单条 TCP 连接内核缓冲阻塞会拖住整页并发流（无固定 `2%` 触发门槛，约 `2%` 仅是部分基准下与多连接 HTTP/1.1 的经验交叉点）。
   - **HTTP/3 over QUIC（RFC 9000 / RFC 9114）**：基于 UDP 在用户态实现按流独立交付与重传，隔离了单流丢包对同连接其他流交付的阻塞（同连接各流仍共享连接级拥塞控制窗口），并内置 TLS 1.3 1-RTT/0-RTT 握手。在**连接迁移**机制上（依据 RFC 9000 §§7.2、9.5、17.2）：QUIC 长头包的 `Connection ID`（CID）长度为 **`0～20` 字节**；当手机从 Wi-Fi 主动切到 5G 等新本地地址时，为避免路径观察者跨网络关联追踪同一用户，客户端**不应**在切换后的地址间复用同一个旧 CID，而应**切换到对端预先下发的新未使用 CID（`NEW_CONNECTION_ID`）**，并在新路径上通过 `PATH_CHALLENGE` / `PATH_RESPONSE` 完成路径验证后正式迁移并退役旧 CID。
3. **架构侧 CDN 边界、多级分流与协议回退成本**：
   - **边缘终结与回源分层**：生产架构通常仅在 **CDN 边缘节点或最外层七层网关终结 HTTP/3（QUIC）**，而 CDN 回源与数据中心内部仍普遍复用成熟的 HTTP/2 或 HTTP/1.1 长连接池，避免内网高频 UDP 软中断开销与回源连接状态膨胀。
   - **四层分流与 UDP 阻断回退成本**：由于企业防火墙与部分运营商对 UDP 443 存在限速或封禁，服务端须通过 `Alt-Svc` 响应头与 DNS `HTTPS` 记录宣告能力，依赖客户端 Happy Eyeballs 并发竞速在 QUIC 受阻时无缝回退至 HTTP/2 over TCP；同时，前置四层负载均衡不能再仅靠源 IP:Port 四元组哈希分发 UDP，必须支持**基于 QUIC Connection ID 的一致性路由**（如结合 eBPF / QUIC-LB 规范编码后端节点标识），否则连接迁移换源 IP 后流量被打到另一台无会话状态的七层代理，会直接击穿迁移优势。

## 4.2 CDN 边缘分发与四层 / 七层多级负载均衡 {#ch4-2}

### 4.2.1 CDN 回源机制与四层负载均衡（LVS DR / TUN / NAT） {#ch4-2-1}

域名通过 `CNAME` 指向 **CDN** 全局负载均衡器（GSLB）后，90% 以上的静态与准动态读流量在离用户最近的省市边缘节点即被拦截消化，并充当抗 DDoS 清洗护城河（严禁暴露源站真实公网 IP）。穿透 CDN 回源的流量进入数据中心后，遵循“**低层大吞吐转发在前，高层富语义代理在后**”组成多级负载均衡漏斗：

```text
公网回源流量 ──► [第 1 级：L4 四层负载均衡 (LVS / IPVS / Katran eBPF，单集群千万并发连接)]
                       │
                       ▼
                [第 2 级：L7 七层反向代理集群 (Nginx / Envoy / Gateway API，TLS 终结、WAF、URL 路由)]
                       │
                       ▼
                [后端无状态业务微服务集群]
```

四层与七层四种经典转发模式的报文改写机制、回包路径与网络约束对比如下。注意补齐原书遗漏的 ARP 抑制生产前提，并订正原书表 4-3 将 IPv4 `ToS/DSCP` 误译为“分区类型”、将 `3 bit Flags + 13 bit 片偏移` 误写为 `4 + 12 bit` 的协议硬伤：

| 均衡模式 | 工作的 OSI 层与报文改写动作 | 响应回包路径 | 拓扑约束与生产必配内核前提 |
| --- | --- | --- | --- |
| **LVS-DR**（直接路由，二层链路层） | 仅将以太帧**目标 MAC** 改为后端 Real Server MAC，**源/目 IP 原封不动** | **DSR 三角传输**：后端直接经公网路由回包给客户端，不经过 LVS | 性能最高！要求 LVS 与后端**同处二层子网**；后端必须在 `lo` 绑 VIP 且设 **`arp_ignore=1`、`arp_announce=2`**！ |
| **LVS-TUN**（IP 隧道，三层网络层） | 在原 IP 包外再封一层 IPIP/GRE 新 IP 头发往后端 | **DSR 三角传输**：后端剥离外层头后看到原目标 VIP，直回客户端 | **支持跨机房/跨三层子网**；后端同样须绑 `lo` VIP 并开启 ARP 抑制 |
| **LVS-NAT / Full-NAT**（地址转换） | DNAT 改目标 IP 为后端私网 IP（Full-NAT 同步执行 SNAT 改源 IP 为内网跳板 IP） | **原路返回 LVS** 还原源 IP 为 VIP 后再发客户端 | 部署最灵活无需改后端路由，但进出双向流量全压在 LVS 网卡上，出口带宽易受限且 SNAT 会掩盖客户端真实 IP（需靠 **TOA / Proxy Protocol** 透传） |
| **七层反向代理**（Nginx / Envoy） | **终结客户端 TCP/TLS 连接**，解析 HTTP 头部与路径后另起后端连接池转发 | **原路经七层代理返回**（通过 `X-Forwarded-For` 传递源 IP） | 单机吞吐低于四层，但具备按域名/URI 路由、灰度分流、连接复用与异常状态码熔断能力 |

> [!CAUTION]
> **为什么 LVS-DR / TUN 模式下后端服务器必须抑制 ARP？** 因为 LVS 与所有后端服务器都配置了同一个虚拟 IP（VIP）以便后端能收下目标 IP 为 VIP 的数据包。若不给后端配 `net.ipv4.conf.all.arp_ignore = 1`（只响应配在入站物理网卡上的 IP 的 ARP 请求）与 `arp_announce = 2`，一旦交换机广播询问“谁是 VIP”，后端机器抢先应答自身 MAC，后续所有外部流量就会彻底绕开 LVS 直接打死单台后端！

## 4.3 进程内缓存（Caffeine W-TinyLFU）与透明多级缓存 {#ch4-3}

### 4.3.1 Caffeine 异步无锁化缓冲与 W-TinyLFU 高命中率算法 {#ch4-3-1}

分布式缓存（如 [Redis 专题第 7 章](../redis/chapter-07) 详述的穿透、击穿、雪崩防御与 Cache-Aside 双写规范）虽快，但每次查询仍需跨网络耗费约 `0.2～1ms` 与序列化 CPU。对于配置项、权限字典与极热商品元数据，在应用进程堆内构建 **L1 本地缓存**可将延迟再降三个数量级至百纳秒级。

现代 JVM 事实标准进程内缓存 **Caffeine**（Go 生态对应 **Ristretto / Otter**）之所以在吞吐量与命中率上全面碾压早期 LRU 与 Guava Cache，源于两项精妙架构创新：

1. **借鉴数据库日志的异步读写缓冲（消除锁争用）**：传统 LRU 每次并发 `get` 都必须加互斥锁把节点挪到双向链表头部，多核读并发越高锁冲突越重。Caffeine 在读路径上把访问事件直接塞入无锁分段环形缓冲 **Ring Buffer**（若瞬时打满则直接丢弃个别采样而不阻塞业务读线程！），由后台线程池异步批量排空更新淘汰状态，使并发读吞吐逼近原生 `ConcurrentHashMap`。
2. **`W-TinyLFU`（Window TinyLFU）准入与淘汰架构**：

```text
新写入条目 ──► [1% 容量：Window Cache (前端窗口 LRU，吸收短时突发稀疏热点)]
                    │ 窗口满滑出成为候选者 (Candidate)
                    ▼
          [TinyLFU 准入过滤器：基于 4-bit Count-Min Sketch 概率统计全局频次（周期全部右移减半防旧热点僵死）]
                    │ 对比候选者频次 vs 主缓存淘汰受害者 (Victim) 频次：频次更高者胜出留下！
                    ▼
          [99% 容量：Segmented LRU 主缓存（20% Probation 观察区 ──二次命中晋升──► 80% Protected 保护区）]
```

它用极小的内存（Count-Min Sketch 类比布隆过滤器的计数组）同时解决了纯 LRU 怕全量扫描冲刷、纯 LFU 怕突发流量进不来且历史老数据退不掉的两大顽疾。

### 4.3.2 L1（进程内）+ L2（Redis）透明多级缓存协同架构 {#ch4-3-2}

单用进程内 L1 缓存面临“容量受限于单机内存、多副本间状态各自为政、应用重启缓存全空”三大短板。生产级**透明多级缓存**（TMC）将 L1（Caffeine，存极热 Top 万级键，短 TTL）与 L2（Redis 集群，存全量百万至亿级热键，长 TTL）串联，并严格遵循两条协同铁律：

1. **读路径由近及远逐级回填**：先查本地 L1 -> 未命中查 Redis L2（命中则回填 L1）-> 仍未命中加分布式互斥锁查 DB 回填 L2 与 L1。
2. **写路径以 L2 为权威基准 + 消息广播驱逐全部节点 L1**：数据变更时，先更新数据库并删除 Redis L2 键，同时通过 **Redis `CLIENT TRACKING BCAST`**（见 [Redis 7.1.3 节](../redis/chapter-07#ch7-1-3)）或分片 Pub/Sub / MQ 向所有业务实例广播该键失效事件，各实例收到后立即执行 `caffeine.invalidate(key)` 清除本地旧副本，并以 L1 较短的物理 `expireAfterWrite`（如 `30～60s`）作为断连丢通知时的最终自愈底线。

## 练习 {#ch4-exercises}

以下 2 道练习分别检验全站动静分离 HTTP 缓存头与协议栈设计，以及四七层负载均衡拓扑排障。建议先独立作答，再展开核对参考答案。

### 练习 1：为 SPA 单页电商前端设计零脏读且极致高命中率的缓存与传输配置

某采用前后端分离构建的移动端 H5 商城包含三类响应：① 入口骨架文件 `/index.html`（每次发版里面引用的脚本哈希文件名会变，要求发版后用户刷新立即生效绝不白屏）；② 带构建内容指纹的静态资源 `/assets/vendor.a91c04.js`；③ 含用户实时余额与收货地址的接口 `/api/v1/me/wallet`。同时该商城大量海外东南亚用户在高丢包移动 4G 网络下访问首屏极慢。请分别为 ①、②、③ 写出精确的 `Cache-Control` 响应头组合，并给出传输层协议升级方案。

<details>
<summary>查看参考答案</summary>

1. **三类资源的精确缓存头策略**：
   - **`/index.html`（可存副本，但每次必做条件重验证）**：
     ```http
     Cache-Control: no-cache
     ETag: "673a9f-1a40"
     ```
     未发版时每次仅耗几百字节返回 `304 Not Modified`；一旦发版 `ETag` 改变立即返回新 HTML 拉取新 JS，彻底杜绝发版后旧页面调新接口报错。
   - **`/assets/vendor.a91c04.js`（内容不变文件名永不变，开启一年强缓存免验证）**：
     ```http
     Cache-Control: public, max-age=31536000, immutable
     ```
     连用户按刷新键都无需发条件请求，同时使用 **Brotli（`Content-Encoding: br`）** 静态预压缩最大化缩减体积。
   - **`/api/v1/me/wallet`（私密敏感实时资金，严禁任何客户端与共享代理落盘缓存）**：
     ```http
     Cache-Control: private, no-store
     ```
2. **高丢包移动弱网传输升级方案**：
   - 在 CDN 边缘节点全面开启 **HTTP/3（QUIC over UDP 443）** 并通过 `Alt-Svc: h3=":443"; ma=86400` 及 DNS **`HTTPS` 记录**引导客户端首包直连 QUIC（UDP 受阻时经 Happy Eyeballs 自动回退至 HTTP/2 over TCP）：利用 1-RTT/0-RTT 削减跨国建连延迟，利用按流独立交付隔离 4G 丢包空洞导致的跨流交付阻塞（同连接各流仍共享拥塞控制窗口），并借助 QUIC 连接迁移（切换对端下发的新未使用 `Connection ID` 并完成路径验证，配合接入层基于 CID 的一致性分流）保障电梯/基站切换不断连；同时为多压缩版本静态资源加上 `Vary: Accept-Encoding` 防止缓存串味。

</details>

### 练习 2：排查 LVS-DR 集群上线后“单台后端被打爆、其余机器零流量”事故

运维团队在同网段（`10.10.1.0/24`）搭建了一套 `1 台 LVS（DIP 10.10.1.2，VIP 10.10.1.100） + 4 台 Nginx（RIP 10.10.1.11 ～ .14）` 的 **LVS-DR** 四层负载均衡集群。为让 4 台 Nginx 接收目标为 VIP 的数据包，运维直接在每台 Nginx 的 `lo:0` 接口执行了 `ip addr add 10.10.1.100/32 dev lo` 即切入线上流量。结果上线 1 分钟后发现：LVS 监控转发计数几乎为 `0`，而 `10.10.1.13` 这一台 Nginx 独自承受了 100% 流量瞬间 CPU 跑满告警，其余 3 台 Nginx 流量全为 `0`！请解释底层网络成因并写出修复命令。

<details>
<summary>查看参考答案</summary>

1. **故障根因（Linux 内核全局 IP 模型引发二层 ARP 广播抢占）**：
   - Linux 内核默认将 IP 地址视为属于整台宿主机而非特定网卡（`arp_ignore = 0`）：哪怕 `10.10.1.100` 绑在回环网卡 `lo` 上，当上游接入路由器在 `10.10.1.0/24` 广播询问 `Who has 10.10.1.100?` 时，LVS 和 4 台 Nginx **全都会通过各自的物理网卡 `eth0` 抢答**！
   - 恰好 `10.10.1.13` 的 ARP 应答最后覆盖了上游路由器的 ARP 缓存表，使路由器将 `VIP -> 10.10.1.13 MAC` 锁死，后续所有公网入站数据包直接从交换机发给了 `.13` 这单台机器，完全绕开了 LVS！
2. **修复步骤**：
   - 在全部 4 台后端 Nginx 上**先配置 ARP 抑制内核参数，再绑定 `lo` VIP**，随后在上游交换机/路由器刷新一次 VIP 的 ARP 表（或在 LVS 上用 `arping` 发送免费 ARP 宣告刷新）：
     ```bash
     sysctl -w net.ipv4.conf.lo.arp_ignore=1
     sysctl -w net.ipv4.conf.lo.arp_announce=2
     sysctl -w net.ipv4.conf.all.arp_ignore=1
     sysctl -w net.ipv4.conf.all.arp_announce=2
     ```

</details>

## 面试题 {#ch4-interview}

以下 3 道面试题聚焦 HTTP/2 与 HTTP/3 核心演进、四层与七层负载均衡协作及 Caffeine 算法原理。建议先独立作答，再展开核对参考答案。

### 面试题 1：既然 HTTP/2 已经实现了单连接多路复用，为什么在弱网环境下有时候反而比 HTTP/1.1 的 6 条并发连接还慢？HTTP/3 是怎么根治的？

<details>
<summary>查看参考答案</summary>

1. **HTTP/2 弱网变慢根因——TCP 传输层队首阻塞放大**：HTTP/2 把原本分散在 6 条独立 TCP 连接上的所有并发请求收敛到了**唯一 1 条 TCP 连接**上。虽然应用层分帧不再阻塞，但操作系统内核的 TCP 协议栈不认识 HTTP/2 的 Stream 概念，只按严格递增的字节序列号向上层交付——一旦网络高丢包，单条 TCP 连接发生 1 个包丢失重传就会瞬间冻住**整页全部几十个并发资源流**，且单连接拥塞窗口（cwnd）减半的打击面远大于 HTTP/1.1 的 6 条独立连接。
2. **HTTP/3 改善机制与边界**：底层改用基于 **UDP 的 QUIC 协议**（底层帧与流控细节见 [《图解网络》6.4 节](../network/chapter-06#ch6-4)），把可靠重传、流控与 TLS 1.3 加密上移至用户态，在传输层原生感知多条独立 Stream——Stream A 丢包时仅需等待 Stream A 自身重传补齐空洞，Stream B 和 Stream C 已完整到达的数据可立即交付上层渲染，从而消除了跨流交付级的队首阻塞（但需注意，同一 QUIC 连接上的各流仍共享连接级拥塞控制窗口，且边缘部署须考虑 UDP 限速回退至 HTTP/2 与四层基于 CID 路由的架构成本）。

</details>

### 面试题 2：大型互联网接入层为什么不直接只摆一层 Nginx 七层负载均衡，而要在 Nginx 前面再架一层 LVS（或 eBPF 四层均衡）？

<details>
<summary>查看参考答案</summary>

核心在于突破**单点出口带宽墙、TCP/TLS 连接状态开销与平滑水平扩容**：

1. **吞吐量级差一个数量级以上**：Nginx 属于七层反向代理，必须与客户端完成完整 TCP 三次握手与昂贵的 TLS 握手加解密、解析 HTTP 报文并维护双向两条 Socket 连接，单机并发吞吐受限于 CPU 与双向网卡带宽；而 LVS-DR（或基于 XDP/eBPF 的四层均衡器如 Katran）工作在二/三/四层，不拆解应用层也不握手，且响应大流量走 **DSR 三角传输直接由后端回客户端**，单组四层集群即可轻松扛住数千万并发连接与百 Gbps 流量。
2. **为七层集群提供统一 VIP 与无损弹性**：有了前置四层集群承接公网 VIP（配合 BGP ECMP 多机高可用），后端的 Nginx / Envoy 七层网关层就可以像普通无状态服务一样随时横向扩缩容数十台机器而无需改动公网 DNS 记录。

</details>

### 面试题 3：为什么现代本地缓存全面使用 Caffeine 替代了 Guava Cache 和手写 LinkedHashMap LRU？

<details>
<summary>查看参考答案</summary>

主要赢在**并发读吞吐**（异步缓冲去锁）与**真实业务缓存命中率**（`W-TinyLFU`）两个维度：

1. **高并发无锁读路径**：手写 `LinkedHashMap` 需外包全局互斥锁，Guava Cache 虽分段但仍需在读路径同步维护队列指针；Caffeine 引入无锁分片 **Ring Buffer** 记录读事件并异步批量更新，多核争抢同一超热 Key 时吞吐高出数倍。
2. **`W-TinyLFU` 淘汰精度**：传统 LRU 遇到批量扫描即发生缓存污染；Caffeine 用 **1% Window LRU 接纳突发新热点 + 4-bit Count-Min Sketch（TinyLFU）对比频次把关准入 + 99% 双段 SLRU 保护高频项**，以极低的额外内存开销实现了接近理论最优（ Belady Optimal）的命中率。

</details>

## 参考资料

- [RFC 9111：HTTP Caching（IETF Standard）](https://www.rfc-editor.org/rfc/rfc9111)
- [RFC 9000 & RFC 9114：QUIC Transport Protocol & HTTP/3](https://www.rfc-editor.org/rfc/rfc9114)
- [Linux Virtual Server（LVS）Documentation：IP Load Balancing Techniques（DR / TUN / NAT）](http://www.linuxvirtualserver.org/VS-DRouting.html)
- [Gil Einziger, Roy Friedman & Ben Manes：TinyLFU — A Highly Efficient Cache Admission Policy（Caffeine Paper）](https://arxiv.org/abs/1512.00727)
