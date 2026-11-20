---
title: 第 2 章 底层数据结构、对象编码与扩展数据类型
description: 剖析全局字典渐进式 Rehash、listpack/跳表/SDS 编码、Redis 8 kvobj 内存优化、Hash 二级编码与 HEXPIRE，以及亿级统计、GEO、Stream 与原生多模型。
---

# 第 2 章 底层数据结构、对象编码与扩展数据类型

## 本章要点

同样是向 Redis 存入 1 亿条数据，选错数据结构可能导致内存暴涨 4 倍，或者一条看似普通的查询瞬间卡死主线程数秒。要做到“既快又省”，必须穿透外部命令看清两层映射：一是五种基础类型如何映射到 `SDS`、哈希表、跳表、`quicklist`、`listpack` 与 `intset` 等底层结构，以及 Redis 7.x/8.x 在消除连锁更新、压缩键值头（`kvobj`）与支持 Hash 字段级过期上的重大革新；二是面对亿级聚合/基数统计、地理位置检索、可靠消费组队列及时间序列/向量检索时，如何精准选用扩展类型。

> 核对日期：2026 年 11 月 17 日；核对环境为 Redis 8.10.3、Linux/AMD64。

## 2.1 全局字典渐进式 Rehash 与核心底层结构 {#ch2-1}

### 2.1.1 双哈希表装载因子阈值与渐进式 Rehash {#ch2-1-1}

Redis 顶层键空间是一个全局哈希表，通过链式哈希解决冲突。随着键数量增长，冲突链拉长会使 `O(1)` 查找退化为 `O(N)`。为避免一次性搬迁千万级键阻塞单线程，Redis 维护 `ht[0]` 与 `ht[1]` 两张表实施**渐进式 Rehash**，其精确触发条件与推进机制如下：

1. **装载因子与两档扩容阈值**：设 `load_factor = 已存键总数 / 哈希桶数组大小`：
   - 当 **`load_factor >= 1` 且当前未执行 `BGSAVE` 或 `BGREWRITEAOF` 子进程**时，启动扩容（分配 `2` 倍于当前容量的幂次空间）；若正在持久化则暂缓扩容，避免桶迁移大量修改内存页触发操作系统写时复制（COW，详见 [3.2.1 节](./chapter-03#ch3-2-1)）。
   - 当 **`load_factor >= 5`** 时，说明冲突链已严重恶化，无论是否正在持久化均**强制立即启动扩容**。
2. **分摊迁移与定时兜底**：扩容期间设置 `rehashidx = 0`。此后**每处理一次客户端增删改查请求，顺带将旧表 `rehashidx` 桶位上的整条冲突链迁移至新表并将 `rehashidx + 1`**；若实例空闲无请求，后台每 `100ms` 运行的 `databasesCron` 也会每次最多花 `1ms` 主动推进一批桶迁移。Rehash 期间新增键直接写入新表，查改删则依次检索旧表与新表，全部迁完后释放旧表空间。

### 2.1.2 SDS、listpack、quicklist、跳表与整数集合 {#ch2-1-2}

除哈希表外，支撑各类键值编码的五大核心底层结构及其版本演进如下：

- **简单动态字符串（`SDS`）**：保存显式长度 `len` 与已分配容量 `alloc`，使 `STRLEN` 为 `O(1)` 且杜绝 C 字符串缓冲区溢出与 `\0` 截断。自 Redis 3.2 起按长度分为 `sdshdr5/8/16/32/64` 阶梯紧凑头——例如 `32～255` 字节串使用仅占 `3B` 头的 `sdshdr8`；追加扩容时，**新长度 `< 1 MiB` 成倍预分配，`>= 1 MiB` 每次固定多预留 `1 MiB`**。
- **紧凑列表（`listpack`，Redis 7.0+ 全面取代 `ziplist`）**：原书介绍的压缩列表 `ziplist` 在每个元素头部用 `prevlen` 记录**前一个元素长度**（`< 254B` 占 `1B`，`>= 254B` 占 `5B`）——一旦在连续多个 `250～253B` 元素前插入一个 `>= 254B` 的元素，就会引发后面所有元素逐个从 `1B` 扩容至 `5B` 的**连锁更新（Cascading Update）**！**Redis 7.0 已彻底淘汰运行时 `ziplist`，全部替换为 `listpack`**：每个元素格式改为 `[encoding | data | backlen]`，把**当前元素自身长度 `backlen`** 放在元素末尾供反向遍历读取，前驱元素变长绝不影响后继元素，**从根源上消除了连锁更新**，同时保持连续内存零指针与极高 CPU 缓存局部性。
- **快速列表（`quicklist`）**：早在 Redis 3.2 就取代了单纯的双向链表，本质是**以 `listpack`（7.0 前为 `ziplist`）为节点的双向链表**，由 `list-max-listpack-size`（默认 `-2`，即单节点不超过 `8 KiB`）兼顾首尾 `O(1)` 读写与内存紧凑性。
- **跳表（`skiplist`）**：在双向有序链表之上构建多层随机索引指针，平均查找、插入、删除时间复杂度均为 **`O(log N)`**，且范围遍历比平衡树更简洁高效。
- **整数集合（`intset`）**：升序紧凑排列的 `int16` / `int32` / `int64` 数组。注意订正原书配图误差：**`intset` 查找采用二分查找，时间复杂度为 `O(log N)`**（并非 `O(N)`），仅插入新元素平移内存或位宽升级时为 `O(N)`。

### 2.1.3 五大基础类型编码映射与复杂度四句口诀 {#ch2-1-3}

在 **Redis 8.10.3** 中实测核验的五种基础类型底层编码切换规则与查询复杂度汇总如下——注意 **Redis 7.0+ 单节点小 List 直接采用纯 `listpack`，Redis 7.2+ 小规模字符串 Set 也新增了 `listpack` 编码**：

| 数据类型 | 紧凑编码及触发上限（Redis 8 默认配置） | 大规模标准编码 | 慢操作避坑与复杂度核心口诀 |
| --- | --- | --- | --- |
| **`String`** | `int`（64 位有符号整数）；`embstr`（短串嵌入分配） | `raw`（独立动态 `SDS`） | 单键 `GET`/`SET`/`INCR` 均为 `O(1)`，但 `500MB` 超大 String 网络收发仍会卡主线程 |
| **`Hash`** | **`listpack`**（字段数 `≤ 512` 且单键值 `≤ 64B`；启用字段过期时转为紧凑编码 **`listpackex`**） | `hashtable` | `HGET`/`HSET`（原 `HMSET` 已弃用）单字段 `O(1)`；**严禁对大 Hash 执行 `HGETALL` `O(N)`，改用 `HSCAN`** |
| **`List`** | **`listpack`**（单节点内紧凑存放） | `quicklist` | 首尾 `LPUSH`/`RPOP` 与 `LLEN` 均为 **`O(1)`**；按索引 `LINDEX`/`LSET` 及长区间 `LRANGE` 为 `O(N)` |
| **`Set`** | `intset`（纯整数且 `≤ 512` 个）；**`listpack`**（非整数但元素 `≤ 128` 个且单值 `≤ 64B`，7.2+） | `hashtable` | `SADD`/`SISMEMBER`/`SCARD` 为 `O(1)`；`SMEMBERS` 与大集合交并差 `SINTER`/`SUNION`/`SDIFF` 耗时高，**7.0+ 仅求交集基数优先用 `SINTERCARD ... LIMIT`** |
| **`Sorted Set`** | **`listpack`**（元素 `≤ 128` 个且单成员 `≤ 64B`） | `skiplist` + `hashtable` | 哈希表支撑 `ZSCORE` `O(1)`，跳表支撑 `ZADD` 与统一范围查询 **`ZRANGE ... BYSCORE`**（6.2+ 取代已弃用的 `ZRANGEBYSCORE`）`O(log N + M)`；6.2+ 新增 `ZDIFF` |

> [!TIP]
> **集合复杂度四句口诀**：① **单元素读写是基础**（`HGET`/`SADD` 等多为 `O(1)`，批量 `M` 个为 `O(M)`）；② **全量范围遍历极耗时**（`HGETALL`/`SMEMBERS` 必改用 `HSCAN`/`SSCAN` 分批游标迭代）；③ **元素总数统计最高效**（底层头部存有计数器，`LLEN`/`HLEN`/`SCARD`/`ZCARD` 均为 `O(1)`）；④ **首尾双端弹出是特例**（`LPUSH`/`RPOP`/`BLMOVE` 为 `O(1)`）。注意所有紧凑编码一旦超限升级为哈希表或跳表，均**单向不可逆**（除非重建键）。

## 2.2 String 内存开销演进与 Hash 二级编码压缩 {#ch2-2}

### 2.2.1 从传统三层元数据到 Redis 8 kvobj 嵌入式布局 {#ch2-2-1}

原书第 11 讲展示了一个经典生产痛点：保存 1 亿条“10 位数字图片 ID -> 10 位数字存储对象 ID”（有效载荷仅 `16B`），在早期 Redis 5.0/6.0 中用 `String` 竟耗费约 **6.4 GB**（平均约 `64B/条`）。

这里需要先订正原书对旧版 64B 账单的四处源码细节偏差，再看 **Redis 8** 的革命性优化：

- **Redis 5.0～7.0 真实源码内存账**：顶层字典 `dictEntry` 占 `24B`——64 位 `jemalloc` 本就有 `24B` 标准档位，并非原书所说向上取 2 的幂次扩成 `32B`；顶层键始终是裸 `sdshdr8` 字符串——`3B 头 + 10B + 1B '\0' = 14B` 经 `jemalloc` 分配 `16B`，绝非 `int` 编码 `redisObject`；值对象为 `int` 编码 `redisObject`（`16B`）；再加上全局哈希表桶数组每条约 `8～10.7B` 的指针均摊，合计 **`24 + 16 + 16 + ~8 ≈ 64B`**！若再给键设置 `EXPIRE`，旧版还需在独立的过期字典中额外分配一个 `dictEntry`（再多耗 `24～32B`）。
- **Redis 8 全新 `kvobj` 嵌入式键值布局（实测大幅瘦身）**：Redis 8 重构了顶层键空间对象 `kvobj`，将字典条目头、可选的 64 位过期时间戳、键字符串与短字符串值**紧凑嵌入同一块 `≤ 64B` 的 CPU 缓存行内存块**中，省去了独立的 `dictEntry` 与 `redisObject` 指针跳转！在 **Redis 8.10.3** 中实测 `MEMORY USAGE` 结果如下：
  - `SET 1101000051 3301000051`（整数值）：单键仅占 **`32B`**（短键如 `SET s_int 12345` 仅占 **`24B`**），附加 `EXPIRE` 仅原地增加 **`8B`** 时间戳（`24B -> 32B`）！
  - 短字符串 `embstr` 边界：无过期时间时，只要 **`键字节数 + 值字节数 ≤ 41`**（如 `1B` 键配 `40B` 值，或 `20B` 键配 `21B` 值），整个键值对均以 `embstr` 塞入单块 `≤ 64B` 分配中；超过该总长才拆分为 `raw` 独立 `SDS`。

### 2.2.2 Hash listpack 二级编码与字段级过期（HEXPIRE） {#ch2-2-2}

即便有 `kvobj` 优化，亿级独立顶层键依然要承担亿级哈希桶指针与键前缀重复开销。将 10 位 ID `1101000060` 拆成**前 7 位 `1101000` 作为 Hash 键、后 3 位 `060` 作为 field** 的**二级编码方案**，可让最多 1000 条记录共享 1 个顶层键并在一块连续的 **`listpack`** 内无指针紧排：

```bash
# 调高紧凑编码条数上限至 1000，确保每组后 3 位（000~999）始终保持 listpack 编码而不退化为 hashtable
CONFIG SET hash-max-listpack-entries 1000
HSET pic:1101000 060 3302000080
```

过去采用 Hash 聚合存储最大的顾虑是“无法对 Hash 内部的单个 field 独立设置过期时间”。**自 Redis 7.4 起原生引入 Hash 字段级过期（HFE），Redis 8 进一步补齐了原子读写设过期命令**，彻底打通了二级编码与会话分项缓存的最后一公里：

```bash
# Redis 7.4+ 为已有 Hash 指定字段设置 3600 秒独立 TTL 并查询剩余秒数
HEXPIRE user:sess:1001 3600 FIELDS 1 refresh_token
HTTL user:sess:1001 FIELDS 1 refresh_token

# Redis 8.0+ 写入字段值的同时一步原子绑定过期时间
HSETEX user:sess:1001 EX 3600 FIELDS 1 access_token "eyJhbGciOi..."
```

> [!NOTE]
> **字段级过期（HFE）的底层紧凑编码 `listpackex`**：在 Redis 7.4+/8.x 中，给满足 `hash-max-listpack-entries` 与 `hash-max-listpack-value` 阈值的短字段 Hash 设置字段 TTL 后，其底层编码会由 `listpack` 转为专门的紧凑编码 **`listpackex`**（在连续内存块内以 `[field, value, expireAt]` 三元组紧凑存放），**并不会直接退化为 `hashtable`**；只有字段数或单值长度超过阈值时才会升级为 `hashtable`。需注意一旦转为 `listpackex`，即使后续用 `HPERSIST` 清除 TTL 也不会自动降级回 `listpack`，且同 Hash 内未设 TTL 的字段也会保留极少量过期占位元数据。

## 2.3 亿级统计、GEO、Stream 队列与原生多模型 {#ch2-3}

### 2.3.1 四类亿级统计选型：Set、ZSet、Bitmap 与 HyperLogLog {#ch2-3-1}

面对亿级用户规模的统计需求，四种模式的内存成本与精度取舍截然不同：

| 统计模式 | 典型业务场景 | 推荐类型与核心命令 | 1 亿用户规模内存开销与精度边界 |
| --- | --- | --- | --- |
| **集合聚合统计** | 每日新增、次日留存、共同关注 | `Set`（`SDIFFSTORE` / `SINTERCARD`）或 `ZSet`（`ZINTERSTORE` / `ZDIFF`） | 精确无损，但占用数百 MB 至 GB 内存；大集合聚合须在从库或客户端执行防阻塞 |
| **实时排序统计** | 排行榜、无漂移时间线分页 | `Sorted Set`（`ZADD` + `ZRANGE ... BYSCORE REV LIMIT`） | 避免 `List` 翻页期间因头部新插入元素导致下标后移重复读取旧数据 |
| **二值状态统计** | 亿级用户连续 10 天签到、布尔特征 | **`Bitmap`**（底层 `String`：`SETBIT` / `GETBIT` / `BITCOUNT` / `BITOP AND`） | 1 亿比特仅占 `10^8 ÷ 8 ÷ 2^20 ≈ 11.92 MiB`（10 天共约 `120 MiB`），要求用户 ID 为稠密非负整数偏移 |
| **超大基数统计** | 亿级页面独立访客 UV 去重计数 | **`HyperLogLog`**（`PFADD` / `PFCOUNT` / `PFMERGE`） | 固定最多仅占 **`12 KiB`** 内存即可统计 `2^64` 级基数！代价是存在 **`0.81%`** 标准误差且无法反查单元素是否存在 |

### 2.3.2 GEO 奇偶交叉编码与 Stream 可靠消费组队列 {#ch2-3-2}

1. **GEO 地理位置检索（底层复用 `Sorted Set`）**：`GEOADD` 将二维经度 `[-180, 180]` 与纬度 `[-90, 90]` 分别做 `N` 次二分区间编码（左 `0` 右 `1`），再按**偶数位放经度、奇数位放纬度**交叉合并为 52 位整数 GeoHash 作为 `ZSet` 的 `score`。由于网格边界两侧编码可能突变，查询周边时会自动同时检索当前方格及周围 **8 个相邻方格**。注意原书使用的 `GEORADIUS` 自 **Redis 6.2 起已正式废弃**，现统一使用支持圆形与矩形框检索的 **`GEOSEARCH`**：

```bash
GEOADD cars:loc 116.397128 39.916527 car_01 116.405285 39.904989 car_02
GEOSEARCH cars:loc FROMLONLAT 116.40 39.91 BYRADIUS 5 km ASC COUNT 10 WITHDIST
```

2. **轻量级可靠消息队列选型（`List` vs `Pub/Sub` vs `Stream`）**：
   - `Pub/Sub` 纯内存转发不持久化，消费者离线或输出缓冲区溢出即丢消息；`List` 虽可用 `LPUSH` + **`BLMOVE`**（6.2+ 取代已废弃的 `BRPOPLPUSH`）备份防丢，但**不支持多消费组广播与组内水平分担**。
   - **Redis 5.0+ `Stream`**（底层为 `rax` 基数树 + `listpack`）完备满足保序、**单个 Stream 内唯一单调递增**的 `<ms>-<seq>` ID、消费组负载均衡与崩溃恢复：

```bash
# 1. 写入消息并近似裁剪保留最近 10000 条（命令行调用时注意给 ~ 和 * 加引号防 Shell 展开）
XADD mq:orders MAXLEN ~ 10000 * order_id 9001 amount 199
# 2. 创建消费组与组内消费者拉取未投递新消息（>）
XGROUP CREATE mq:orders cg_pay 0 MKSTREAM
XREADGROUP GROUP cg_pay worker_1 COUNT 10 BLOCK 2000 STREAMS mq:orders >
# 3. 业务处理成功后确认（从消费组 PEL 待确认列表移除）
XACK mq:orders cg_pay 1700000000000-0
# 4. Redis 6.2+ 超时待确认消息接管：worker_2 自动扫描并认领空闲超 60000ms 未 XACK 的 PEL 消息
XAUTOCLAIM mq:orders cg_pay worker_2 60000 0-0 COUNT 10
```

> [!IMPORTANT]
> **订正 `XACK` 删除语义与 `XAUTOCLAIM` 接管语义误区**：
> 1. 执行 `XACK` **仅将该消息从当前消费组的 `PEL`（Pending Entries List，待确认列表）中移除，绝不会删除 Stream 中的消息本体**！正因如此，其他消费组（如实时风控组与离线归档组）才能各自独立消费全量数据。控制 Stream 内存上限必须配合 `XADD ... MAXLEN/MINID ~` 或 `XTRIM`。
> 2. **`XAUTOCLAIM` 接管的消息不等同于“业务失败”或“死信”**：它仅仅代表该消息在 PEL 中超过空闲时间阈值仍未收到 `XACK`——原消费者可能只是处理较慢、网络抖动或进程宕机。因此业务消费逻辑必须保证**幂等**（防原消费者慢完成导致重复处理）；若需识别真正反复失败的毒丸/死信消息，应结合 `XPENDING` 返回的**投递次数（delivery count）**达到上限后再人工或自动转存死信队列并 `XACK`。

### 2.3.3 Redis 8 原生内置 TimeSeries、JSON、概率结构与 Vector Set {#ch2-3-3}

在原书时代，存储时间序列或使用布隆过滤器需自行编译加载外部 `.so` 模块；若用 `Hash + ZSet` 双写勉强模拟，不仅内存翻倍，把采样值当 `ZSet` `member` 还会因去重覆盖丢失同值历史样本。**自 Redis 8 起，原 Redis Stack 核心数据结构已全部原生内置于标准开源发行版中，开箱即用**：

- **`TimeSeries`（时序数据）**：底层采用基数树索引 + **Gorilla 压缩块**（时间戳二阶差分 + 浮点数异或压缩，单点仅占约 `1.4～2B`），原生支持 `TS.CREATE ... RETENTION` 过期保留、`TS.ADD` 写入及 `TS.RANGE ... AGGREGATION avg 60000` 服务端降采样窗口聚合，无需将数百万原始点拉回客户端。
- **`JSON` 文档与二级查询引擎（`FT.*`）**：`JSON.SET` / `JSON.NUMINCRBY` 支持按 JSONPath 原地读写嵌套字段而无需整串反序列化回写。
- **5 种概率数据结构**：原生提供 `BF.*` 布隆过滤器、`CF.*` 支持删除的布谷鸟过滤器（详见 [7.3.2 节](./chapter-07#ch7-3-2)）、`TOPK.*` 热点 Top-K 识别、`CMS.*` 频次估计与 `TDIGEST.*` 分位数统计。
- **`Vector Set`（向量集合，Redis 8 全新核心类型）**：面向 AI 语义检索与推荐场景，通过 `VADD key VALUES dim v1 v2 ... elem` 写入高维浮点嵌入向量（默认自动 8-bit 量化省内存），并用 `VSIM` 执行毫秒级近似最近邻（ANN）相似度检索。

## 练习 {#ch2-exercises}

以下 2 道练习分别检验亿级键值紧凑编码与字段级过期设计，以及高并发统计与可靠 Stream 消费组运维。建议先独立推演，再展开核对参考答案。

### 练习 1：设计 5000 万商品扩展属性的高密度存储与分项过期方案

某电商服务需缓存 5000 万个整数商品 `sku_id`（范围 `10000000～59999999`）对应的短促销文案（平均 `24B` 字符串），同时部分商品还带有仅存活 `15` 分钟的限时闪购价字段。若在 Redis 8 中按 `SET promo:<sku_id> "<text>"` 逐条拆成独立键，与采用 Hash 二级编码相比有何优劣？请给出兼顾极致省内存与限时价自动过期的具体命令方案。

<details>
<summary>查看参考答案</summary>

1. **逐条 String 与 Hash 二级编码对比**：
   - 在 Redis 8 中，`promo:10000001`（`14B` 键）+ `24B` 值总长 `38B ≤ 41B`，虽能命中 `kvobj` 的 `embstr` 单块 `64B` 分配，但 5000 万个顶层键仍需约 `64B × 5×10^7 ≈ 3.2 GB` 载荷外加 `64M` 级全局哈希桶数组（`512 MiB`），合计近 **`3.7 GB`**。
   - 若将 8 位 `sku_id` 拆为前 5 位桶号（如 `promo:10000`）做 Hash key、后 3 位（`000～999`）做 field，每 1000 个商品共用 1 个顶层键并在 `listpack` 内无指针连续存放，单条仅占约 `30B`，总内存可压降至 **`1.5 GB` 左右**（节省约 60%）。
2. **分项过期编码边界与命令方案**：
   - 在 Redis 7.4+/8.x 中，只要字段数与单值长度未超过 `hash-max-listpack-entries` / `hash-max-listpack-value` 阈值，对短字段 Hash 执行 `HEXPIRE` / `HSETEX` 后会转为紧凑的 **`listpackex`** 编码，**并不会一定退化为 `hashtable`**，因此不必因担心退化为哈希表而盲目拆成独立 String 键。
   - 不过，`listpackex` 会为同 Hash 内每个字段携带少量过期时间元数据（且转为 `listpackex` 后不可逆降级回 `listpack`）。当 5000 万全量促销文案绝大多数无 TTL、仅有少量活动商品存在 15 分钟闪购价时，仍可将**长期稳定的促销文案**存入纯 `listpack` 二级编码 Hash，而将**带独立 TTL 的活动闪购属性**直接用 `HSETEX` 存入保持 `listpackex` 紧凑编码的 Hash（按商品或活动分桶均可，避免给无过期字段平摊额外过期槽位）：
     ```bash
     # 1. 全量静态紧凑二级编码（保持 listpack）
     CONFIG SET hash-max-listpack-entries 1000
     HSET promo:10000 001 "满299减50"

     # 2. 活动商品多字段闪购属性按字段独立 900s 过期（Redis 8 HSETEX，短字段保持 listpackex 紧凑编码）
     HSETEX flash:sku:10000001 EX 900 FIELDS 2 price "199.00" limit "2"
     ```

</details>

### 练习 2：亿级用户周全勤签到统计与 Stream 多业务可靠分发

1. 某 App 注册用户 ID 为 `1 ～ 100,000,000` 连续整数，需统计本周一至周日**连续 7 天每天都登录**的用户总人数。请写出核心 Redis 命令并计算这 7 天键占用的总内存大小。
2. 用户下单事件既要供“积分服务集群（3 个实例并行分担）”处理，又要供“审计归档服务（2 个实例并行分担）”全量消费，且任一实例处理中途崩溃不能丢单。请给出基于 `Stream` 的完整命令闭环。

<details>
<summary>查看参考答案</summary>

1. **Bitmap 连续 7 天全勤统计与内存核算**：
   - 每天以 `sign:20261116` ～ `sign:20261122` 为键，用户登录时执行 `SETBIT sign:20261116 <uid> 1`。
   - 周末统计时，先用 `BITOP AND` 对 7 个位图按位求与，再用 `BITCOUNT` 统计置 `1` 的总位数：
     ```bash
     BITOP AND sign:week_all sign:20261116 sign:20261117 sign:20261118 sign:20261119 sign:20261120 sign:20261121 sign:20261122
     BITCOUNT sign:week_all
     ```
   - **内存核算**：单日 1 亿 bit 占 `100,000,000 ÷ 8 ÷ 1024 ÷ 1024 ≈ 11.92 MiB`；7 天原始位图加 1 个结果位图共 8 个键，合计仅约 **`95.4 MiB`**（注意大位图 `BITOP` 应在从库或低峰期执行）。
2. **Stream 双独立消费组 + 超时待确认消息接管闭环**：
   - 为积分服务和归档服务分别创建**两个独立的消费组** `cg_points` 和 `cg_audit`，同一消费组内的多个实例以不同消费者名拉取 `>` 实现负载均衡；存活实例定时调用 `XAUTOCLAIM` 接管超过空闲时间阈值仍未 `XACK` 的 PEL 消息（注意超时未确认可能仅因原消费者处理慢或宕机，并不直接等同于业务失败/死信，因此消费逻辑需保持幂等，并结合 `XPENDING` 检查投递次数以识别真正反复失败的死信消息）：
     ```bash
     XGROUP CREATE mq:order cg_points 0 MKSTREAM
     XGROUP CREATE mq:order cg_audit  0 MKSTREAM

     # 积分组实例 1 拉取并确认
     XREADGROUP GROUP cg_points pts_1 COUNT 20 BLOCK 2000 STREAMS mq:order >
     XACK mq:order cg_points <msg_id>

     # 积分组定时巡检：自动接管组内其他消费者空闲超 30 秒仍未 XACK 的待确认消息
     XAUTOCLAIM mq:order cg_points pts_2 30000 0-0 COUNT 20
     ```

</details>

## 面试题 {#ch2-interview}

以下 3 道面试题聚焦 `listpack` 演进、全局字典 Rehash 边界与时序数据踩坑。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么 Redis 7.0 彻底用 `listpack` 取代了沿用多年的压缩列表 `ziplist`？

<details>
<summary>查看参考答案</summary>

核心原因是根治 `ziplist` 的**连锁更新**（Cascading Update）缺陷。

`ziplist` 为了支持从尾向头反向遍历，在每个节点**开头**存放前驱节点长度 `prevlen`（前驱 `< 254B` 时占 `1B`，`>= 254B` 时膨胀为 `5B`）。若列表中恰好连续排列着一批 `250～253B` 的节点，一旦在头部插入或修改出一个 `>= 254B` 的节点，紧邻节点因 `prevlen` 从 `1B` 涨到 `5B` 也突破 `254B`，进而像多米诺骨牌一样触发后续所有节点连续 `realloc` 移位扩容，最坏复杂度退化至 `O(N^2)` 并阻塞主线程。

**`listpack`** 将节点布局改为 `[encoding | content | backlen]`，把**当前节点自身的总长度 `backlen`** 变长编码在节点**末尾**——正向遍历读 `encoding`，反向遍历从末尾向左读 `backlen`，任何节点的增删改都绝不会改变相邻节点的头部长度，彻底消除了连锁更新。

</details>

### 面试题 2：Redis 全局哈希表什么情况下触发扩容 Rehash？为什么正在执行 `BGSAVE` 时装载因子达到 `1` 却不立即扩容？

<details>
<summary>查看参考答案</summary>

1. **两级触发阈值**：① 正常情况下，当装载因子 `used / size >= 1` 且当前没有 `BGSAVE`（RDB）或 `BGREWRITEAOF` 子进程运行时，立即启动扩容；② 当存在持久化子进程时，允许装载因子暂时上升，直到 **`used / size >= 5`** 才强制扩容。
2. **持久化期间暂缓扩容的原因**：持久化子进程依赖操作系统的**写时复制**（Copy-On-Write）与主进程共享物理内存页。一旦触发渐进式 Rehash，大量哈希桶指针修改会高频污染众多 `4 KiB` 物理内存页，迫使内核不断复制新物理页，既拖慢主线程又会导致实例物理内存激增甚至触发 OOM。

</details>

### 面试题 3：早期有人用 `Sorted Set` 存传感器监控数据，把时间戳设为 `score`、温度采样值设为 `member`，上线后为什么会丢数据？在 Redis 8 中应如何设计？

<details>
<summary>查看参考答案</summary>

1. **丢数据根因**：**`Sorted Set` 的 `member` 是唯一去重集合**！如果直接把温度值（如 `"26.5"`）作为 `member`，当 10:05 再次测得 `"26.5"` 执行 `ZADD` 时，Redis 会将其视为更新已有成员 `"26.5"` 的 `score`，直接把 10:00 那条记录的时间戳覆盖抹掉，造成历史采样点静默丢失（若强行用 `ZSet`，必须写成 `"1700000000:26.5"` 拼接时间戳保证唯一）。
2. **Redis 8 标准方案**：直接使用内置的 **`TimeSeries`** 数据类型（`TS.CREATE` / `TS.ADD` / `TS.RANGE`），不仅天然按时间戳去重/追加、借助 Gorilla 压缩将单样本压至约 `2` 字节以内，还能直接在服务端完成 `AGGREGATION avg/max/min` 时间窗口降采样聚合与过期自动裁剪。

</details>

## 参考资料

- [Redis Official Documentation：Redis Data Types Overview（Core & Redis 8 Native Types）](https://redis.io/docs/latest/develop/data-types/)
- [Redis Official Documentation：Hashes & Hash Field Expiration（HEXPIRE / HSETEX）](https://redis.io/docs/latest/develop/data-types/hashes/)
- [Redis Official Documentation：Redis Streams Tutorial & Consumer Groups](https://redis.io/docs/latest/develop/data-types/streams/)
- [Antirez Listpack Specification：`listpack.md`](https://github.com/antirez/listpack/blob/master/listpack.md)
