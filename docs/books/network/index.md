---
title: 图解网络
description: 以《图解网络》为主线，结合 RFC 9110–9114、RFC 9293、RFC 9000、TLS 1.3 与 Linux 6.12 LTS，重组并精简梳理网络分层、IP/ICMP、TCP 机制、HTTP/1.1–3、HTTPS 安全演进与线上排障体系。
---

# 图解网络

本指南以小林 coding 的《图解网络》（v4.0）为主线，结合 **RFC 9110–9114（HTTP/1.1–3）**、**RFC 9293（TCP）**、**RFC 9000–9002（QUIC）**、**RFC 8446（TLS 1.3）** 与 **Linux 6.12 LTS** 内核网络栈实现，对原书全部技术篇章进行了系统的**去重、精简、勘误与现代知识重组**。原书由多篇独立公众号文章汇编而成，跨节重复显著（例如三次握手与队列机制反复出现四次、`TIME_WAIT` 出现五次、HTTP/2 与 QUIC 多次重叠），本指南将每个知识点收拢至唯一权威出处，并通过章节间链接串成一条完整脉络。

全专题围绕四个核心工程问题展开：**一次网络请求如何穿越协议栈与网络设备、TCP 如何在不可靠 IP 之上实现状态机管理与高吞吐可靠传输、HTTP 与 TLS 如何演进至 QUIC/HTTP/3 与后量子安全时代、线上丢包与连接异常如何借助现代 Linux 工具链定位根因**。

## 章节导航

原书基础篇、HTTP 篇、TCP 篇与 IP 篇的全部核心知识经去重与重新归类后，重组为以下 8 章（原书前言、书单、画图经验与赞赏支持已精简移除）：

| 章节 | 核心问题 | 整合原书来源 |
| --- | --- | --- |
| [第 1 章 网络分层模型、一次网页访问全过程与 Linux 协议栈](./chapter-01) | TCP/IP 与 OSI 如何分层？键入网址后数据包如何经由交换机与路由器送达？Linux 内核如何经 DMA、NAPI 与 `sk_buff` 收发网络包？ | 2.1–2.3 |
| [第 2 章 IP 寻址、路由转发、辅助协议与 ICMP 诊断](./chapter-02) | CIDR 子网划分、最长前缀匹配与 IPv6 有何关键规则？DNS、ARP、DHCP、NAT、IGMP 如何协同？`ping`、`traceroute` 与 `127.0.0.1` 底层如何工作？ | 5.1–5.3（并入 2.1/2.2 中的 DNS/ARP/路由） |
| [第 3 章 TCP 基础、连接建立与半/全连接队列](./chapter-03) | 为何 TCP 面向字节流且必须三次握手？ISN 与 PAWS 如何防历史报文？半/全连接队列溢出、SYN Flood 与 TFO 在现代 Linux 中如何演化？ | 4.1（前半）、4.4、4.5（建连）、4.6–4.8、4.20–4.21、4.24（建连与数据） |
| [第 4 章 TCP 连接断开、TIME_WAIT 与边界异常处理](./chapter-04) | 四次挥手为何及何时合并为三次？`TIME_WAIT`/`CLOSE_WAIT` 泛滥如何治理？已建连或 `TIME_WAIT` 收到 SYN/RST、进程崩溃与拔网线分别会发生什么？ | 4.1（后半）、4.5（挥手）、4.9–4.14、4.16、4.23、4.24（挥手） |
| [第 5 章 TCP 可靠传输、流量控制、拥塞控制与性能调优](./chapter-05) | RACK-TLP 与 SACK 如何提速重传？滑动窗口、Nagle 与延迟确认如何交互？拥塞控制如何从 Reno 演进至 CUBIC 与 BBR？如何基于 BDP 调优缓冲区？ | 4.2、4.3（传输抓包）、4.5（传输优化）、4.22（可靠边界） |
| [第 6 章 HTTP 语义、缓存机制与 HTTP/1.1 到 HTTP/3 协议演进](./chapter-06) | HTTP 语义、缓存与压缩有哪些易错边界？HTTP/2 如何通过 HPACK 与多路复用提速？QUIC 与 HTTP/3 如何根治队头阻塞并实现连接迁移？ | 3.1（HTTP）、3.2、3.6–3.7、4.17–4.18 |
| [第 7 章 HTTPS、PKI 信任体系与 TLS 1.3 现代安全演进](./chapter-07) | PKI 证书链如何离线验签？TLS 1.3 如何以 1-RTT、强制 AEAD 与后量子混合密钥交换取代旧体系？0-RTT 重放风险与 OCSP 退场改变了什么？ | 3.1（HTTPS）、3.3–3.5、4.15 |
| [第 8 章 现代应用通信协议与网络排障实战](./chapter-08) | 现代微服务中 RPC 与 HTTP/2/3 如何融合？轮询、SSE、WebSocket 与 WebTransport 如何选型？如何用 `iproute2`、`tcpdump` 与 `mtr` 闭环排查全链路丢包？ | 3.8–3.9、4.3（抓包实战）、4.22（排障） |

## 版本基线与现代演进对照 {#version-policy}

原书 v4.0 的文章跨度覆盖 2020–2022 年，实验环境多停留在 CentOS 6.5（Linux 2.6.32）及 HTTP/3 草案阶段。本指南以 **2026 年主流 IETF RFC 标准**与 **Linux 6.12 LTS** 为统一核对基线，汇总关键勘误与现代化更新如下：

| 原书 v4.0 内容或历史背景 | 本指南的校准与现代写法 |
| --- | --- |
| NAPI 硬中断“发起软中断后立刻恢复屏蔽的中断”、`ksoftirqd` 负责全部软中断、`sk_buff` 克隆整包拷贝数据 | 纠正为 NAPI 在 `napi_poll` 收空队列后才恢复硬中断；`NET_RX` 优先在 `irq_exit()` 执行，超预算才交由 `ksoftirqd`；`skb_clone()` 共享数据载荷，见[第 1 章](./chapter-01#ch1-3-2) |
| DHCP“全程使用广播”、IPv4 无链路本地地址、`ping 0.0.0.0` 一律报 `No route to host`、使用 `ifconfig`/`route`/`arp` | 纠正 DHCP 续租（T1）为单播；补齐 IPv4 `169.254.0.0/16`、NDP/SLAAC、DoH/DoT/DoQ、STUN/TURN/ICE、ICMP 源点抑制已废弃（RFC 6633）；注明 Linux `ping 0.0.0.0` 指向本机；统一使用 `ip`/`ss`/`nstat`，见[第 2 章](./chapter-02#ch2-3) |
| 沿用 RFC 793、`somaxconn=128`、`tcp_syn_retries=5`（63 s）、2.6.32 `max_qlen_log` 队列公式、HTTP 仅靠 `\r\n` 划分报文边界 | 升级至 **RFC 9293**；校准 Linux 6.12 默认值（`somaxconn=4096`、`tcp_syn_retries=6` ≈ 127 s、`tcp_syncookies=1`、`tcp_fastopen=1`）；更新 Linux 4.4+ 全局无锁 `ehash`；纠正“TCP 粘包”与 `Content-Length`/`chunked` 边界；交代 TFO 公网僵化现状，见[第 3 章](./chapter-03#ch3-3) |
| 误读 4.11 `TIME_WAIT` 收 SYN 源码中的 `\|\|` 为 `&&`；`tcp_tw_reuse` 默认关闭；进程崩溃一律发 FIN | 依据内核源码纠正 `TIME_WAIT` 合法重用条件为 `seq > rcv_nxt \|\| tsval > ts_recent`；校准 Linux 4.12+ `tcp_tw_reuse=2` 且已移除 `tcp_tw_recycle`；补齐未读数据崩溃发 RST、RFC 5961 与 `ss -K`，见[第 4 章](./chapter-04#ch4-3-2) |
| 笔误 `RFC6289`、零窗口探测次数自相矛盾、拥塞控制止步 Reno、称 `free` 的 `buff/cache` 反映 TCP 缓冲区 | 纠正为 **RFC 6298**；统一持续定时器指数退避行为；升级至 **RACK-TLP（RFC 8985）**、**CUBIC（RFC 9438）** 与 **BBR**；纠正 `tcp_mem` 压力阈值、2×BDP 记账与 `/proc/net/sockstat` 观测，见[第 5 章](./chapter-05#ch5-3) |
| `ETag` 与 `Last-Modified` 优先级写反、3.2 误写 `ETag` 请求头、推荐 HTTP/2 Server Push、HTTP/3 仍为草案且写错 QPACK 静态表（91 项）与 QUIC 连接流控公式 | 按 **RFC 9110–9114 / 9204 / 9000** 全面校准：`If-None-Match` 存在时忽略 `If-Modified-Since`；标注 Server Push 已移除并转向 **103 Early Hints**；更新 QPACK 99 项静态表与 QUIC `MAX_DATA` 独立流控模型；补齐 `zstd`/AVIF/AV1，见[第 6 章](./chapter-06#ch6-4) |
| “私钥加密=数字签名”、客户端向 CA 请求中间证书、TLS 记录层仍含压缩+MAC、推荐 OpenSSL 1.1.1 与 OCSP Stapling、混淆 1-RTT/0-RTT 重放风险 | 规范为“私钥签名、公钥验签”与服务端下发完整链；以 **TLS 1.3**（强制 AEAD、**`X25519MLKEM768`** 后量子混合密钥交换、**ECH**）为主线；更新 **Let's Encrypt 2025 永久关闭 OCSP** 与短期证书/CRLSets 体系；厘清 `psk_dhe_ke` 与 `0-RTT` 边界，见[第 7 章](./chapter-07#ch7-2) |
| 归因“历史原因没换 HTTP/2”、WebSocket 遗漏掩码且错写最大长度 2<sup>64</sup>、缺失 SSE/WebTransport、`ethtool` 万兆带宽算术错误 | 阐明现代 gRPC/ConnectRPC 与 HTTP/2/3 融合；补齐 **SSE**、**WebSocket over H2/H3（RFC 8441/9220）** 与 **WebTransport**；纠正 WebSocket `2^63 - 1` 上限与掩码规则；纠正全双工万兆（1250 MB/s）与 `sar` `rxkB/s` 单位并更新 `iproute2` 排障闭环，见[第 8 章](./chapter-08#ch8-4) |

## 阅读与自测约定

建议按 [第 1 章](./chapter-01) 至 [第 8 章](./chapter-08) 顺序系统构建网络知识体系；若面向面试复盘或故障排查，也可直达[三次握手与队列溢出](./chapter-03#ch3-3)、[`TIME_WAIT` 与状态机边界](./chapter-04#ch4-2)、[RACK-TLP 与 CUBIC/BBR](./chapter-05#ch5-3)、[QUIC 与 HTTP/3](./chapter-06#ch6-4)、[TLS 1.3 与安全演进](./chapter-07#ch7-2)或[全链路丢包排查闭环](./chapter-08#ch8-4)。

每章均遵循“本章要点 → 机制推导与校准 → 练习 → 面试题 → 参考资料”结构，所有参考答案默认折叠，建议先独立推导再展开核对。

## 延伸参考资料

- [IETF RFC Editor（RFC 9110–9114 / 9293 / 9000–9002 / 8446）](https://www.rfc-editor.org/)
- [Linux Kernel Networking Documentation](https://docs.kernel.org/networking/index.html)
- [Linux Programmer's Manual (`tcp(7)`, `ip(7)`, `socket(7)`)](https://man7.org/linux/man-pages/man7/tcp.7.html)
- [High Performance Browser Networking (Ilya Grigorik)](https://hpbn.co/)
- [Cloudflare Learning Center & Technical Blog (QUIC / TLS 1.3 / ECH / PQC)](https://blog.cloudflare.com/)
