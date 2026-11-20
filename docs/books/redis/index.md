---
title: Redis 核心技术与实战
description: 基于 Redis 8 实测重组的架构原理、数据结构、持久化、高可用集群、缓存治理与高并发实战指南。
---

# Redis 核心技术与实战

本指南依据蒋德钧《Redis核心技术与实战》（极客时间专栏，原书基于 Redis 5.0 与初版 6.0）全量通读与勘误整理而成，并全面升级对齐 **Redis 8（实测环境 Redis 8.10.3、Linux/AMD64）**。全书原有的 41 讲正文、7 篇加餐与阶段答疑已消除跨篇重复，围绕“高性能、高可靠、高可扩展”三大主线重组为 **3 大模块、8 章结构化体系**，系统覆盖 Redis 7.0～8.x 的 `listpack` 全面替代 `ziplist`、`kvobj` 嵌入式键值内存布局、Hash 字段级过期（`HEXPIRE`/`HSETEX`）、Multi-Part AOF、共享复制缓冲区、异步多线程 I/O 引擎、原生内置 JSON/TimeSeries/Bloom/VectorSet 多模型以及 `FUNCTION` 持久化脚本等现代核心演进。

## 模块路线与原书映射

| 模块 | 章节 | 核心主题与能力边界 | 对应原书讲次 |
| --- | --- | --- | --- |
| **一、核心架构、数据结构与持久化** | [第 1 章 体系架构、RESP 协议与事件驱动 I/O 模型](./chapter-01) | 四大核心组件、RESP 2/3 报文格式、ACL v2 细粒度权限、`epoll` 事件循环与 Redis 8 异步多线程 I/O | 第 1、3、39 讲，加餐四 |
| | [第 2 章 底层数据结构、对象编码与扩展数据类型](./chapter-02) | 渐进式 Rehash、`listpack`/跳表/SDS、`kvobj` 内存账单、Hash 二级编码与 `HEXPIRE`、亿级统计、GEO、Stream 消费组与原生多模型 | 第 2、10～15、22 讲 |
| | [第 3 章 AOF 多文件日志、RDB 快照与混合持久化](./chapter-03) | 写后日志与刷盘策略、Multi-Part AOF 目录架构、`BGSAVE` 页表 `fork` 与 COW 内存放大、RDB Preamble 混合持久化与 `WAITAOF` | 第 4、5、10 讲 |
| **二、高性能调优、内存治理与高可用集群** | [第 4 章 阻塞治理、内存碎片、缓冲区与延迟诊断全景](./chapter-04) | 五大阻塞点、BIO 与 `lazyfree`、NUMA 绑核、`jemalloc` 碎片清理、输入/输出/复制缓冲区、Swap/THP 治理与诊断三剑客 | 第 16～22 讲，加餐五、六 |
| | [第 5 章 主从复制、哨兵高可用与脑裂防护](./chapter-05) | `PSYNC` 全量与增量复制、共享复制缓冲区、Sentinel 自动发现与 Leader 选举、三轮选主打分、过期键同步真相与脑裂治理 | 第 6～8、10、32～34 讲 |
| | [第 6 章 切片集群（Redis Cluster）、数据倾斜与大容量演进](./chapter-06) | `16384` 哈希槽、`MOVED`/`ASK` 重定向、Gossip 带宽核算与 `SPUBLISH`、Bigkey/Hotkey 倾斜治理及 Apache Kvrocks 冷热分层 | 第 9、28、35、37、38、40、41 讲，加餐七 |
| **三、缓存架构、并发控制与场景实战** | [第 7 章 缓存读写模式、淘汰算法（LRU / LFU）与异常治理](./chapter-07) | Cache-Aside 双写一致性、`CLIENT TRACKING` 客户端缓存、10 种淘汰策略（含 Redis 8.6+ LRM）、LFU 24-bit 对数衰减、雪崩/击穿/穿透与布隆过滤器 | 第 23～27、34、39 讲 |
| | [第 8 章 原子操作、分布式锁、事务 ACID 与高并发秒杀实战](./chapter-08) | Lua 限流与 Redis Functions、分布式锁与看门狗、Redlock 与 Fencing Token 边界、`MULTI`/`EXEC` ACID 检验与秒杀分片扣减 | 第 29～31、34、36、41 讲 |

## 生产高频问题速查索引

| 线上现象或架构诉求 | 核心机制与根因定位 | 跳转章节 |
| --- | --- | --- |
| 连接报 `NOPERM`、协议升级或禁用 `KEYS`/`FLUSHALL` | `HELLO 3` 握手兼容规则、`ACL SETUSER` 命令分类与键前缀权限 | [1.1.2 节](./chapter-01#ch1-1-2)、[1.1.3 节](./chapter-01#ch1-1-3) |
| 多核网卡吞吐受限，评估开启多线程网络读写 | `epoll` 单线程执行边界与 Redis 8 异步 `io-threads` 机制 | [1.2.3 节](./chapter-01#ch1-2-3) |
| 亿级小键值内存膨胀、Hash 单字段独立过期或可靠队列选型 | `kvobj` 64B 嵌入布局、Hash `listpack` + `HEXPIRE`、Stream `XAUTOCLAIM` | [2.2 节](./chapter-02#ch2-2)、[2.3.2 节](./chapter-02#ch2-3-2) |
| AOF 重写磁盘抖动，或 4GB 机器跑 2GB 实例做 `BGSAVE` 触发 OOM | Multi-Part AOF 零双写架构、`fork` 写时复制（COW）内存翻倍边界 | [3.1.2 节](./chapter-03#ch3-1-2)、[3.2.1 节](./chapter-03#ch3-2-1) |
| P99 尾延迟突增、删数据后 RSS 不降或客户端连接被强制断开 | 慢查询/集中过期/THP/Swap 排查清单、`activedefrag` 与 `maxmemory-clients` | [4.2 节](./chapter-04#ch4-2)、[4.3.1 节](./chapter-04#ch4-3-1) |
| 哨兵无法完成故障转移，或主从切换后旧主库新写入数据神秘丢失 | Leader 选举双条件（`> N/2` 且 `>= quorum`）、主从脑裂与 `min-replicas` 约束 | [5.2.2 节](./chapter-05#ch5-2-2)、[5.3.2 节](./chapter-05#ch5-3-2) |
| 集群节点超 800 后心跳占满带宽，或 `Hash Tag` 引发单节点打满 | Gossip `24KB` 往返开销、`SPUBLISH` 分片订阅、Bigkey 拆分与 Hotkey 多副本 | [6.2.1 节](./chapter-06#ch6-2-1)、[6.2.2 节](./chapter-06#ch6-2-2) |
| 数据库与缓存双写脏数据、全表扫描污染缓存或恶意 ID 穿透打垮 DB | 先更 DB 再删缓存、LFU 概率递增与衰减、互斥锁重建与原生 `BF.EXISTS` 布隆拦截 | [7.1.2 节](./chapter-07#ch7-1-2)、[7.2.2 节](./chapter-07#ch7-2-2)、[7.3 节](./chapter-07#ch7-3) |
| 分布式锁误删、GC 停顿导致锁失效，或秒杀库存超卖与少卖 | `SET NX PX` + Lua 解锁、Redlock 争议与 Fencing Token、`FCALL` 原子扣减 | [8.2 节](./chapter-08#ch8-2)、[8.3.2 节](./chapter-08#ch8-3-2) |
