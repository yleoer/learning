---
title: 第 6 章 切片集群（Redis Cluster）、数据倾斜与大容量演进
description: 详解 16384 哈希槽路由、MOVED/ASK 重定向、Gossip 心跳带宽瓶颈与分片订阅、数据/访问倾斜治理及 Apache Kvrocks 冷热分层演进。
---

# 第 6 章 切片集群（Redis Cluster）、数据倾斜与大容量演进

## 本章要点

当业务数据突破数十 GB 时，盲目给单实例加内存会导致 `fork` 页表拷贝阻塞高达秒级且主从同步极慢；横向拆分为多个小分片的切片集群才是兼具低延迟与高扩展性的正途。本章围绕大规模分片集群的核心挑战展开：首先拆解 Redis Cluster 的 `16384` 哈希槽路由、在线迁移 `-MOVED`/`-ASK` 重定向协议及与代理式架构的取舍；随后定量核算 Gossip 心跳风暴对千节点规模的制约、Redis 7.0+ 分片发布订阅（`SPUBLISH`）以及数据量倾斜与访问热点（Hotkey）的治理闭环；最后梳理从早期 Pika/NVM 探索到现代 **Apache Kvrocks** 基于 NVMe SSD 的大容量演进。

> 核对日期：2026 年 11 月 17 日；核对环境为 Redis 8.10.3、Linux/AMD64。

## 6.1 Hash Slot 路由、重定向机制与集群架构对比 {#ch6-1}

### 6.1.1 16384 哈希槽映射、MOVED / ASK 重定向与在线槽迁移 {#ch6-1-1}

Redis Cluster 没有直接维护“亿级 Key -> 实例节点”的庞大映射表，而是在键与物理节点之间引入固定 **`16384` 个哈希槽**（编号 `0 ～ 16383`）作为轻量解耦中间层：

```text
客户端传入 Key ──► 若含 {...} Hash Tag 则只截取首对花括号内非空子串，否则取完整 Key
                         │
                         ▼
             Slot = CRC16(有效子串) mod 16384  ──► 查客户端本地槽路由缓存直连目标分片主节点
```

建群初始化时，必须将全部 `16384` 个槽完整分配完毕集群才进入 `ok` 可服务状态——**Redis 7.0+ 新增了区间分配命令 `CLUSTER ADDSLOTSRANGE 0 5460`**（订正原书 `CLUSTER ADDSLOTS 0,1` 的逗号语法错误，旧命令仅支持空格分隔），并引入结构化拓扑查询 **`CLUSTER SHARDS`** 正式取代已标记弃用的 `CLUSTER SLOTS`。

在线扩缩容或负载均衡迁移某个槽——例如将槽 `300` 从源节点 A 迁往目标节点 B——客户端通过两种重定向协议实现无中断平滑路由：

| 重定向响应 | 触发时机 | 客户端标准处理动作 | 是否更新本地槽路由缓存 |
| --- | --- | --- | :---: |
| `-MOVED 300 172.16.0.2:6379` | 槽 `300` **已彻底迁移至节点 B**，请求仍误发给旧节点 A | 直接重发原命令至新节点 B | **是**（永久刷新本地槽 `300 -> B`） |
| `-ASK 300 172.16.0.2:6379` | 槽 `300` **正在迁移中**，被查 Key 恰已迁走或不在源端 | **先向节点 B 发送 `ASKING` 一次性放行令**，紧接着重发原命令 | **否**（未迁完前同槽新请求仍先发源节点 A） |

> [!NOTE]
> **订正原书手工槽迁移漏步隐患**：手工迁移单个槽必须严格走完闭环五步——① 目标节点执行 `CLUSTER SETSLOT 300 IMPORTING <src_id>`；② 源节点执行 `CLUSTER SETSLOT 300 MIGRATING <dst_id>`；③ 循环 `CLUSTER GETKEYSINSLOT 300 count`；④ 执行 `MIGRATE` 批量搬移键值；⑤ **全部迁空后，必须在主节点执行 `CLUSTER SETSLOT 300 NODE <dst_id>` 广播最终归属**。原书漏掉此收尾步会导致该槽永久卡在迁移中间态；生产日常运维推荐直接使用 `redis-cli --cluster reshard`。

### 6.1.2 官方 Redis Cluster 与代理式集群（Proxy）选型对比 {#ch6-1-2}

业界切片集群曾长期并存两类路线：以早期 **Codis** 为代表的中心化代理模式，以及官方无中心 **Redis Cluster**。两者的架构边界与当代选型定论对照如下：

| 对比维度 | 官方 `Redis Cluster` | 代理式架构（早期 `Codis` / 现代 `Predixy`、`Envoy`） |
| --- | --- | --- |
| **路由位置与槽数** | 智能客户端本地缓存 `16384` 槽映射，节点间靠 Gossip 扩散 | 无状态 Proxy 代理层路由（Codis 为 `CRC32 mod 1024` 存 ZooKeeper），对单机客户端透明 |
| **大键迁移影响** | 原生 `MIGRATE` 为同步整键序列化传输，迁移超大键会短暂阻塞源与目标主线程 | Codis 曾定制拆元素异步迁移，但**内核永久停滞在远古 Redis 3.2.8**，已停止演进 |
| **多键操作与兼容** | 跨槽 `MGET`/`MULTI`/Lua 报错 `CROSSSLOT`，需靠 `{tag}` 同槽约束或客户端拆包并发 | 现代轻量代理如 Predixy 可在代理层自动拆包聚合 `MGET`，兼容遗留单机客户端 |
| **当代生产选型** | **新建系统绝对首选**：紧跟 Redis 7.x/8.x 全部新特性，无额外代理转发一跳延迟 | 存量无法升级 Smart Client 的业务选用支持 Cluster 协议的 **Predixy / Envoy**，**不再新上 Codis** |

## 6.2 Gossip 通信瓶颈、分片订阅与数据倾斜治理 {#ch6-2}

### 6.2.1 Gossip 报文体积核算、规模上限与 Sharded Pub/Sub {#ch6-2-1}

为什么官方建议单个 Redis Cluster 规模不超过 **1000 个实例**，而一线大厂实战通常控制在 **400～500 个节点**以内？罪魁祸首是集群总线端口（客户端端口 `+ 10000`，如 `16379`）全网扩散的 **Gossip 心跳开销**：

1. **单次心跳往返高达 `24 KiB`**：每个节点的 `PING` / `PONG` 报文头部固定携带自身的 `16384 bit` 槽位图（`16384 ÷ 8 = 2 KiB`），报文体默认随机附带集群总节点数 **`1/10`** 的同伴状态结构 `clusterMsgDataGossip`（每项固定 **`104 字节`**）。在 1000 节点集群中，单条 `PING` 携带 100 个节点状态即占 `10.4 KiB + 2 KiB ≈ 12 KiB`，一去一回消耗 **`24 KiB`**！
2. **超时探测放大公式**：每个实例除了每秒常规随机挑 1 个最久未通信节点发 `PING` 外，**每 `100ms`（每秒 10 次）还会扫描所有距上次收到 `PONG` 超过 `cluster-node-timeout / 2` 的节点并立即补发 `PING`**：

```text
单节点每秒发送 PING 总数 = 1 + 10 × 超出 (cluster-node-timeout ÷ 2) 的节点数
```

一旦集群规模过大且网络微抖导致超时节点增多，内网带宽瞬间被心跳风暴淹没。工程上可将 `cluster-node-timeout` 从默认 `15000`（`15s`）适度调大至 **`20000～25000`（`20～25s`）** 平滑探测频率。

3. **Redis 7.0+ 分片发布订阅（Sharded Pub/Sub）根治广播风暴**：传统 `PUBLISH` 在 Cluster 中会将每条消息**无差别全网广播给所有节点**，节点越多放大越剧烈。**自 Redis 7.0 起新增 `SPUBLISH` / `SSUBSCRIBE`**：频道名同样按 `CRC16` 映射到唯一哈希槽，消息**仅在归属该槽的单个主从分片内部转发**，跨分片零广播开销！

### 6.2.2 数据量倾斜（Bigkey / Hash Tag）与访问倾斜（Hotkey）治理 {#ch6-2-2}

集群运行中若发现个别分片内存率先告警或 CPU 飙到 100%，需区分**数据量倾斜**与**数据访问倾斜**精准施策：

- **数据量倾斜（个别实例内存远高于均值）**：
  1. **滥用 `Hash Tag`（头号元凶）**：例如为支持事务把所有用户订单键都写成 `order:{vip}:1001`、`order:{vip}:1002`，导致几千万个键全部按 `CRC16("vip")` 砸进**同一个槽与同一个实例**！除非确需极小规模同槽原子操作，高并发集合一律禁止绑定宽泛 Hash Tag。
  2. **大集合 Bigkey 聚集**：将百万元素大 Hash / ZSet 在业务层按 ID 取模拆分为 `user:fans:0` ～ `user:fans:99` 一百个子键，使其均匀散列到不同分片。
  3. **槽分配不均**：统一同集群机器硬件规格，避免手工给单节点分配过多槽位。
- **数据访问倾斜（单个 Hotkey 承受数十万 QPS 热点风暴）**：
  - 注意：**迁移哈希槽无法解决单键热点**——槽迁到哪台机器就把哪台机器打死！
  - **只读热点键**：采用 **“多副本随机前缀打散”**，将热点键复制 `M` 份并冠以不同前缀（如 `hot_1:item:99` ～ `hot_16:item:99`），使其散列到 16 个不同分片共同分摊读流量；或开启本地内存缓存配合 `CLIENT TRACKING` 广播失效（见 [7.1.3 节](./chapter-07#ch7-1-3)）。
  - **高频读写热点键**：如秒杀总库存，多副本同步无法保证强一致，必须采用**库存子键分片扣减**（详见 [8.3.2 节](./chapter-08#ch8-3-2)）。

## 6.3 基于 SSD 与分层内存的大容量演进路线 {#ch6-3}

### 6.3.1 基于 RocksDB 的键值编码映射与 Apache Kvrocks 架构 {#ch6-3-1}

当单业务数据量达数 TB 至数十 TB、但极热访问仅占 10% 时，全量使用昂贵的纯 DRAM Redis Cluster 成本极高。业界成熟解法是构建**上层完全兼容 RESP 协议与五大集合语义、底层基于 LSM-Tree（RocksDB）落盘 NVMe SSD** 的大容量引擎——早期代表为原书介绍的 **Pika / PikiwiDB**，当前云原生主流为 Apache 顶级项目 **Apache Kvrocks**：

```text
客户端 (标准 Redis SDK) ──► 多线程网络与协议解析层
                                   │
                                   ▼
                  集合键值编码层（将 Hash/List/Set/ZSet 拆解映射为有序单值 KV + 版本号/TTL）
                                   │
                                   ▼
        RocksDB 引擎：[内存小 MemTable (热写缓冲) + Block Cache (热读缓存)] ──► NVMe SSD (多层 SST 文件 + Binlog 同步)
```

其核心设计精髓有两点：① 利用 RocksDB 底层键天然按字典序排列的特性，将集合拆分为带类型前缀与主键版本号的复合键——例如 `Hash` 字段映射为 `[ns | key | version | field] -> value`，删除整张大 Hash 只需递增元数据 `version` 交由后台 Compaction 异步清理，实现 `O(1)` 秒删大键；② 主从复制直接基于磁盘持久化的 RocksDB WAL 流，**彻底消除了内存 Redis 全量同步 `fork` 大 RDB 与复制缓冲区溢出的顽疾**。注意底层必须搭配高随机 IOPS 的 **NVMe SSD**，严禁用机械硬盘 HDD，否则多层 SST 读取与后台 Compaction 会触发严重写入停顿（Write Stall）。

### 6.3.2 从持久内存探索到 CXL 与冷热分层存储实践 {#ch6-3-2}

阅读原书第 40 讲与加餐七时，还需了解近年底层硬件生态的重要变迁：

- **Intel Optane PMem（AEP 持久内存）已退出历史舞台**：原书探讨的基于 `/dev/pmem` DAX 直通挂载持久内存方案，随着 **Intel 于 2022 年正式停产 Optane 业务**已不再作为新建商用硬件选型。
- **现代两大替代演进方向**：一是硬件层兴起的 **CXL（Compute Express Link）内存池化扩展**，以百纳秒级延迟突破单机插槽内存容量墙；二是软件层以微博 `RedRock`、**Apache Kvrocks** 及云厂商混合存储版 Redis 为代表的 **DRAM 热缓存 + NVMe SSD 冷存储自动分层架构**，用约 1/5～1/10 的硬件成本承载海量准实时键值数据。

## 练习 {#ch6-exercises}

以下 2 道练习分别检验在线槽迁移重定向全流程推演，以及集群心跳风暴与数据倾斜治理。建议先独立作答，再展开核对参考答案。

### 练习 1：推演在线槽迁移期间的客户端重定向交互序列

假设 3 主节点集群中，槽 `5000` 正处于从节点 A（`10.0.0.1:6379`）向节点 B（`10.0.0.2:6379`）在线迁移的过程中：键 `{u100}:profile`（哈希槽为 `5000`）已经迁移到了节点 B，而同属槽 `5000` 的键 `{u100}:cart` 仍留在节点 A。此时某新启动的客户端本地缓存仍记录槽 `5000 -> 节点 A`。请回答：
1. 客户端先后请求 `GET {u100}:cart` 与 `GET {u100}:profile` 时，服务端与客户端各自交互几步？本地路由缓存是否更新？
2. 当槽 `5000` 内所有键全部迁往节点 B 并执行 `CLUSTER SETSLOT 5000 NODE <B_ID>` 之后，客户端再次请求 `GET {u100}:cart` 时交互如何变化？

<details>
<summary>查看参考答案</summary>

1. **迁移进行中（`MIGRATING` / `IMPORTING` 态）**：
   - **`GET {u100}:cart`（1 次往返）**：客户端发给源节点 A -> 键仍在 A 本地，节点 A 直接返回购物车数据，无重定向。
   - **`GET {u100}:profile`（2 次往返，不改缓存）**：① 客户端发给源节点 A -> A 查本地不存在且槽处于 `MIGRATING` 态，返回 `-ASK 5000 10.0.0.2:6379`；② 客户端**不更新本地槽 `5000` 的缓存**，连上目标节点 B 先发 **`ASKING`** 打开单次查询权限，紧接着发 `GET {u100}:profile` 拿到结果（实践中客户端将 `ASKING` 与 `GET` 打包在一次 Pipeline 发送）。
2. **迁移彻底完成后（`NODE` 归属广播完毕）**：
   - 客户端发 `GET {u100}:cart` 给旧节点 A -> A 发现槽 `5000` 已正式归属节点 B，返回 **`-MOVED 5000 10.0.0.2:6379`**；
   - 客户端**立即将本地路由表更新为 `5000 -> 节点 B`**，并向节点 B 重发 `GET {u100}:cart`（无须发 `ASKING`）；此后所有落入槽 `5000` 的请求均直连节点 B。

</details>

### 练习 2：治理集群单分片内存告警与千万级广播风暴

某 200 主 200 从（共 400 节点）的 Redis 8 Cluster 出现两起告警：
1. 仅第 17 号主节点内存使用率高达 `92%`，其余 199 个主节点均只有 `25%`；排查发现研发为方便查询把所有商家的商品列表全命名为 `shop:{items}:<shop_id>`。
2. 网关层每秒调用 `5000` 次 `PUBLISH cfg:refresh <payload>` 向在线网关实例推送配置变更，导致全部 400 个节点的集群总线网卡带宽与 CPU 居高不下。

请分别指出两起故障的底层原因，并给出不中断业务的治理改造方案。

<details>
<summary>查看参考答案</summary>

1. **第 17 号节点单点内存打满根因与治理**：
   - **根因**：键名 `shop:{items}:<shop_id>` 中写死了常量 **`{items}` Hash Tag**！Redis Cluster 只对花括号内的 `"items"` 计算 `CRC16("items") mod 16384`，导致全平台数百万商家的键 100% 落在**同一个哈希槽**（恰好位于第 17 号主节点）上，分片机制彻底失效。
   - **平滑治理**：去掉无意义的常量花括号，改为 `shop:items:<shop_id>`；若确需同一商家的少量键同槽，也应将高基数的 `<shop_id>` 放进花括号：`shop:{<shop_id>}:items`。上线期间采取“双写新旧键 -> 后台渐进迁移补齐新键 -> 读切新键 -> `UNLINK` 异步清理旧键”四步平滑切换。
2. **`PUBLISH` 集群风暴根因与治理**：
   - **根因**：传统 `PUBLISH` 在 Redis Cluster 中是**全网广播**——每秒 `5000` 次发布会被复制广播给全部 399 个对端节点，相当于全集群每秒处理 `5000 × 400 = 200 万` 次内部消息分发！
   - **治理方案**：将网关发布与订阅全面切换为 Redis 7.0+ 的**分片发布订阅 `SPUBLISH cfg:refresh <payload>` 与 `SSUBSCRIBE cfg:refresh`**，使消息仅在 `CRC16("cfg:refresh") mod 16384` 对应的**唯一 1 个主从分片内**流转，集群内部跨分片广播流量瞬间降为 `0`。

</details>

## 面试题 {#ch6-interview}

以下 3 道面试题聚焦 `16384` 槽数设计依据、热点键应对策略与大容量 SSD 架构选型。建议先独立作答，再展开核对参考答案。

### 面试题 1：CRC16 算法能算出 `2^16 = 65536` 个值，为什么作者 Antirez 把 Redis Cluster 的哈希槽数定为 `16384` 而不是 `65536`？

<details>
<summary>查看参考答案</summary>

这是基于**心跳报文体积、集群目标规模上限与压缩率**三方面权衡的经典工程决策：

1. **控制 Gossip 心跳头部大小**：每个 `PING`/`PONG` 心跳包头部都包含当前节点负责槽位的完整位图（Bitmap）。`16384` 个槽位图仅占 `16384 ÷ 8 = 2 KiB`；若改为 `65536` 个槽，仅位图头就会暴涨 4 倍至 **`8 KiB`**，在高频 Gossip 交互下白白浪费大量内网带宽。
2. **受 Gossip 节点状态开销限制，集群规模不会超过 1000 主节点**：由于超过 1000 节点后 Gossip 同步延迟与带宽已成瓶颈，对于最多 1000 个主节点的集群，`16384` 个槽平均每主分得约 16 个槽，负载均衡粒度已经完全足够，无需 65536。
3. **位图压缩效率更高**：节点数较少时，槽位图越短且连续置 `1` 越集中，节点间传输槽位配置时的压缩率越高。

</details>

### 面试题 2：在 Redis Cluster 中遇到单个超高并发的只读热点 Key（单键 50 万 QPS），增加集群分片节点或者迁移 Slot 有用吗？应该怎么解决？

<details>
<summary>查看参考答案</summary>

1. **加节点和迁 Slot 完全无效**：同一个 Key 经过 `CRC16(key) mod 16384` 永远只会映射到唯一 1 个槽、落到唯一 1 台主节点上；把该槽迁走只是把 50 万 QPS 压力转移给另一台机器，无法分散单键流量。
2. **三种标准解法（常组合使用）**：
   - **应用进程本地二级缓存（最彻底，推荐）**：在各业务服务节点内存中短暂缓存该热点值（如 1～3 秒 TTL），并结合 Redis 6.0+ **`CLIENT TRACKING ON BCAST`** 在源键变更时主动推送失效通知，直接把 99.9% 读请求拦截在应用本地内存。
   - **多副本随机前缀打散**：写入热点数据时同步写入 `N` 个带编号前缀的副本键（如 `hot:1:news_88` ～ `hot:16:news_88`），客户端读取时随机拼接 `1～16` 前缀，将流量均匀打散到 16 个不同分片节点。
   - **读写分离扩容从库**：若架构允许读从节点，可为该槽所在分片临时挂载多个只读从库分担读压。

</details>

### 面试题 3：当业务需要低成本存储 10TB 键值数据，但仍希望沿用 Redis 数据结构与客户端生态时，为什么推荐 Apache Kvrocks 这类 SSD 方案而不是硬上超大纯内存 Cluster？

<details>
<summary>查看参考答案</summary>

1. **纯内存方案的成本与运维瓶颈**：10TB 纯内存加上主从副本与 COW 预留至少需要 **25～30TB DRAM**，不仅硬件采购成本高昂，拆成数千个小实例还会撞上 Redis Cluster 的 Gossip 1000 节点通信天花板；若盲目做百 GB 大内存单实例，则 `fork` 阻塞与全量同步风暴根本无法承受。
2. **Apache Kvrocks（RocksDB on NVMe SSD）的核心优势**：① 将全量冷温数据落盘在单价低廉一个数量级的 NVMe SSD 上，仅把热写 `MemTable` 与热读 `Block Cache` 驻留内存，延迟仍保持亚毫秒至毫秒级；② 完整兼容 RESP 协议与 `Hash`/`List`/`Set`/`ZSet`/`Bitmap` 操作及 Cluster 槽拓扑；③ 主从同步直接流式拉取磁盘 WAL 日志，无需 `fork` 生成内存快照，单分片轻松承载数百 GB 至 TB 级数据。

</details>

## 参考资料

- [Redis Official Documentation：Redis Cluster Specification（Hash Slots, Redirection & Gossip）](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/)
- [Redis Official Documentation：Sharded Pub/Sub（`SPUBLISH` / `SSUBSCRIBE`）](https://redis.io/docs/latest/develop/interact/pubsub/#sharded-pubsub)
- [Antirez GitHub Issue #2576：Why Redis Cluster Uses 16384 Slots](https://github.com/redis/redis/issues/2576)
- [Apache Kvrocks Official Documentation：Architecture & Data Encoding Design](https://kvrocks.apache.org/docs/technical-design/kvrocks-design)
