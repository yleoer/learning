---
title: 第 3 章 AOF 多文件日志、RDB 快照与混合持久化
description: 深入解析写后 AOF 日志刷盘策略、Redis 7.0+ Multi-Part AOF 多文件架构、BGSAVE 写时复制内存放大边界与 RDB Preamble 混合持久化。
---

# 第 3 章 AOF 多文件日志、RDB 快照与混合持久化

## 本章要点

Redis 将数据常驻内存换取百纳秒级吞吐，但也面临实例宕机数据清空的风险；而一旦引入磁盘持久化，重写刷盘与快照创建又可能反过来引发主线程卡顿甚至宿主机 OOM。本章围绕“低丢数率、快恢复速度、小性能抖动”三角权衡展开：前半部分剖析写后 AOF 日志、三种 `appendfsync` 刷盘策略、`WAITAOF` 细粒度确认，以及 Redis 7.0+ **Multi-Part AOF** 如何消除传统重写的内存双写膨胀；后半部分拆解 `BGSAVE` 子进程的 `fork` 页表拷贝与写时复制（COW）机制，订正原书对混合持久化的机制误读，并给出生产持久化选型矩阵。

> 核对日期：2026 年 11 月 17 日；核对环境为 Redis 8.10.3、Linux/AMD64。

## 3.1 写后 AOF 日志、刷盘策略与 Multi-Part AOF {#ch3-1}

### 3.1.1 写后日志设计取舍与 appendfsync 三种刷盘策略 {#ch3-1-1}

不同于关系型数据库（如 MySQL InnoDB Redo Log）普遍采用的“写前日志（WAL）”，Redis 的 **AOF**（Append Only File）采用**写后日志**顺序：主线程**先在内存中成功执行写命令，再将该命令按 RESP 协议格式写入用户态 AOF 缓冲区**。

写后日志带来两项直接收益：① **免去事前语法校验开销**，凡能记入 AOF 的命令必定已在内存合法执行，恢复重放不会因语法错误中断；② **不阻塞当前写命令的内存修改**。但相应也有两项固有代价：若刚改完内存尚未落盘即断电会丢失最新操作；若刷盘系统调用在主线程同步执行且磁盘繁忙，则会阻塞**下一条**命令。

为此，`appendfsync` 参数提供了三种内核页缓存（Page Cache）落盘时机，生产特性对照如下：

| `appendfsync` 取值 | `write` 与 `fsync` 执行线程及时机 | 宕机最大丢数据窗口 | 性能与阻塞特征 |
| --- | --- | --- | --- |
| **`everysec`（默认）** | 主线程调 `write` 写内核缓冲，**BIO 后台子线程每秒调 1 次 `fsync`** | 约 **`1～2` 秒**写操作 | **通用首选**：兼顾十万级吞吐与秒级安全；但磁盘重度拥塞卡住后台 `fsync` 超 `2s` 时仍会反向阻塞主线程 |
| `always` | 主线程每次事件循环向客户端回包**前**同步执行 `write` + `fsync` | **客户端已收成功响应的数据零丢失** | 每笔写请求受制于磁盘毫秒级 IOPS，吞吐骤降，仅极少数金融小流量单点使用 |
| `no` | 主线程仅调 `write` 写内核缓冲，何时刷盘完全由操作系统决定 | 取决于 OS 脏页刷盘周期（常达 `30s`） | 写延迟最低，但掉电丢数据最多 |

> [!TIP]
> **Redis 7.2+ 按需强持久原语 `WAITAOF`**：若业务全局希望保持 `appendfsync everysec` 的高吞吐，又要求极少数关键写操作（如核心账务凭证）必须确认物理落盘才返回，无需将全局切为 `always`——可在关键写命令后显式调用 **`WAITAOF numlocal numreplicas timeout`**（例如 `WAITAOF 1 1 1000` 表示最多等待 `1000ms`，直至本机与至少 `1` 个从库均完成当前偏移量的 AOF `fsync`）。

### 3.1.2 从“两处日志”到 Redis 7.0+ Multi-Part AOF 架构 {#ch3-1-2}

随着写命令不断追加，AOF 文件会持续膨胀，不仅耗尽磁盘，重启逐条重放更耗时漫长。**AOF 重写**（`BGREWRITEAOF`）通过扫描当前内存最新状态，将对同一个键的历史多次修改合并为一条等效当前状态的最小写入命令（即“多变一”），由 `auto-aof-rewrite-min-size`（默认 `64mb`）与 `auto-aof-rewrite-percentage`（默认 `100`）联合触发。

阅读原书第 4 讲时，需特别注意 **Redis 7.0 对 AOF 重写架构的彻底革新**：

- **Redis 6.2 及更早版本的“一个拷贝，两处日志”痛点**：主线程 `fork` 出重写子进程后，重写期间新到达的所有写命令必须**双写两份**——既写入现行 `aof_buf`，又额外写入内存中的 **`aof_rewrite_buf` 重写缓冲区**并通过管道发给子进程；一旦重写期间写入量大，不仅额外消耗大量内存与进程间通信 CPU，收尾阶段主线程将剩余增量追加进新文件时还会引发明显卡顿。
- **Redis 7.0+ / 8.x 的 Multi-Part AOF（MP-AOF，多文件清单架构）**：启用 `appendonly yes` 后，数据目录下不再是单一文件，而是生成专属目录 **`appendonlydir/`**，内部由三类文件协同管理：

```text
appendonlydir/
 ├── appendonly.aof.1.base.rdb      ◄── Base 基准文件（重写时刻全量快照，默认 RDB 二进制格式）
 ├── appendonly.aof.1.incr.aof      ◄── Incr 增量文件（分段顺序追加的写命令流）
 └── appendonly.aof.manifest        ◄── Manifest 清单文件（原子追踪当前生效的 base 与 incr 序列）
```

触发 `BGREWRITEAOF` 时，**彻底取消了 `aof_rewrite_buf` 内存双写与管道传输**：主线程只需立即打开一个新的增量文件 `appendonly.aof.2.incr.aof` 继续单路追加写命令，同时 `fork` 子进程在后台独立生成新的基准文件 `appendonly.aof.2.base.rdb`；子进程写完后，主线程仅需微秒级原子更新 `manifest` 清单切向新序号，再交由 BIO 后台线程异步删除过期的 `1.base` 与 `1.incr` 文件，一举根治了内存双写膨胀与收尾阻塞两大历史顽疾。

## 3.2 RDB 内存快照、写时复制与混合持久化选型 {#ch3-2}

### 3.2.1 BGSAVE 子进程、fork 页表拷贝与 COW 内存放大边界 {#ch3-2-1}

相比重放命令流，直接将某一时刻的内存数据拍成紧凑二进制快照——**RDB**（Redis Database）——在灾难恢复与主从全量同步时加载速度要快一个数量级。生成 RDB 有两个命令：`SAVE` 在主线程同步执行，生产严禁直接调用；**`BGSAVE`** 则通过操作系统 `fork()` 创建子进程在后台写出 `.rdb` 文件。

围绕 `BGSAVE`（及同理使用 `fork` 的 `BGREWRITEAOF`）有两处决定线上生死的核心操作系统边界：

1. **`fork` 调用本身在主线程同步执行**：虽然 `fork` 无需拷贝物理内存中的实际键值数据，但内核**必须为子进程复制主进程的进程控制块与虚拟内存页表（Page Table）**！实例内存越大、页表项越多，`fork` 瞬间冻结主线程的时间越长（例如 `32 GiB` 大实例在虚拟化云主机上 `latest_fork_usec` 可飙升至数百毫秒乃至秒级）。因此生产规范要求单实例内存控制在 **`2～6 GiB`**。
2. **写时复制（Copy-On-Write, COW）的内存翻倍风险**：`fork` 完成瞬间，父子进程页表共同指向同一批只读物理内存页（常规页 `4 KiB`）；子进程遍历原物理页序列化写出 RDB，而一旦主线程接收新写请求修改某个键，CPU 触发写保护缺页异常，**内核必须新分配一块物理页拷贝旧页数据供主线程修改**。在极端写密集场景下，若 `BGSAVE` 期间有 80% 的内存页被修改，实例总物理内存占用将激增至原来的 **约 1.8 倍**！

### 3.2.2 混合持久化真实机制（RDB Preamble）与生产选型 {#ch3-2-2}

单用 RDB 快照间隔长（通常 5～15 分钟一次），宕机易丢失分钟级数据；单用纯文本 AOF 重启加载又慢。自 Redis 4.0 引入、**Redis 5.0+ 及 Redis 8 默认开启的混合持久化**（`aof-use-rdb-preamble yes`）融合了两者之长。

> [!WARNING]
> **订正原书第 5 讲混合持久化机制误述**：原书声称“混合持久化是让 RDB 快照以一定频率执行，两次快照之间用 AOF 记录命令，等到第二次做全量快照时清空 AOF 日志”。**这与源码事实完全不符**！定期执行 `BGSAVE` 生成独立的 `dump.rdb` **绝不会清空或截断任何 AOF 文件**。
>
> **真实工作流**：`aof-use-rdb-preamble yes` **仅作用于 AOF 重写（`BGREWRITEAOF`）阶段**！在 Redis 7.0+ / 8.x 的 MP-AOF 下，`bgrewriteaof` 子进程直接以高压缩二进制 **RDB 格式**写出 `appendonly.aof.<seq>.base.rdb` 基准文件，而后续日常写入则以 **RESP 文本格式**持续追加到 `appendonly.aof.<seq>.incr.aof` 中。实例重启恢复时，先极速加载 `base.rdb` 还原基准内存，再重放少量 `incr.aof` 增量命令，既实现秒级恢复，又只丢失最多 `1` 秒数据。

不同业务容忍度下的持久化配置选型准则如下：

| 业务场景特征 | 推荐持久化组合 | 关键参数与容量配套要求 |
| --- | --- | --- |
| **核心存储 / 不允许分钟级丢数** | **开启 AOF（默认含 RDB Preamble 混合模式）** + 低频 RDB 备份 | `appendonly yes`、`aof-use-rdb-preamble yes`、`appendfsync everysec`；宿主机预留至少 **40%～50% 空闲物理内存**防 COW OOM |
| **纯旁路缓存 / 可从 DB 快速重建** | 仅开启低频 RDB（甚至无盘主从下关闭主库落盘） | 关闭 `appendonly no`，免去每秒磁盘 `fsync` 与重写开销，追求极致吞吐与低成本 |
| **重写期间磁盘 I/O 偶发毛刺** | 评估开启 `no-appendfsync-on-rewrite yes` 或升级 NVMe SSD | 重写子进程刷盘期间暂缓主进程 `everysec` 的 `fsync`，消除磁盘争抢阻塞，代价是重写窗口宕机可能多丢数秒数据 |

## 练习 {#ch3-exercises}

以下 2 道练习分别检验小规格宿主机上 `BGSAVE` 引发的性能雪崩/OOM 推演，以及 MP-AOF 清单流转与 `WAITAOF` 实战用法。建议先独立分析，再展开核对参考答案。

### 练习 1：诊断 2 核 4GB 云主机运行 2.2GB 写密集 Redis 时的持久化事故

某业务在一台 **2 核 CPU、4 GiB 物理内存**（操作系统自身常驻占用 `500 MiB`，且已关闭 Swap）的云主机上部署了单实例 Redis，当前 `used_memory` 为 **`2.2 GiB`**，线上读写请求比例为 **`2 : 8`（80% 为高频随机修改已有键）**，配置了每 5 分钟自动触发 `BGSAVE`。上线高峰期实例频繁出现响应延迟飙升，随后直接被系统强制杀死重启。请从 CPU 和内存两个维度定量推演事故成因，并给出工程整改方案。

<details>
<summary>查看参考答案</summary>

1. **内存维度——COW 写时复制撑爆 4 GiB 触发 OOM Killer**：
   - `BGSAVE` `fork` 子进程瞬间共享 `2.2 GiB` 物理页，但高达 80% 的随机写流量会在快照写出期间迅速触碰绝大部分 `4 KiB` 物理页，迫使内核不断复制新页。
   - 峰值物理内存需求约为：`原有 2.2 GiB + COW 新增 (2.2 GiB × 80%) + OS 常驻 0.5 GiB ≈ 4.46 GiB > 4.0 GiB`！由于关闭了 Swap，物理内存耗尽瞬间直接触发 Linux 内核 **OOM Killer** 强杀 `redis-server` 进程（若开启了 Swap 则会引发数十倍延迟雪崩）。
2. **CPU 维度——双核资源饱和争抢**：
   - `BGSAVE` 子进程全速遍历内存序列化压缩写盘会吃满 **1 个逻辑核**，导致 Redis 主线程、BIO 刷盘线程与内核网络软中断只能争抢仅剩的 **另 1 个核**，引发严重排队毛刺。
3. **工程整改方案**：
   - 将宿主机内存扩容至 **`8 GiB`、CPU 升级至 4 核及以上**（保证 Redis 实例内存不超过宿主机物理内存的 50%），或将 `2.2 GiB` 数据横向拆分为切片集群；同时务必确认宿主机已关闭透明大页 THP（见 [4.3.1 节](./chapter-04#ch4-3-1)）以避免写时复制（COW）触发 `2 MiB` 大页复制或分裂放大延迟与内存占用。

</details>

### 练习 2：推演 Multi-Part AOF 重写文件变迁并设计关键扣款落盘确认

在刚启动的 Redis 8 实例中查看 `/data/appendonlydir/appendonly.aof.manifest`，内容如下：

```text
file appendonly.aof.1.base.rdb seq 1 type b
file appendonly.aof.1.incr.aof seq 1 type i startoffset 0
```

请回答：
1. 当手动执行一次 `BGREWRITEAOF` 成功完成后，`appendonlydir/` 目录内生效的文件名及 `manifest` 内容会变成什么？为什么此过程不再需要 Redis 6.x 的 `aof_rewrite_buf`？
2. 若全局保持 `appendfsync everysec`，但某笔充值入账命令 `HSET wallet:1001 balance 500` 要求必须在本机和至少 1 个从库的 AOF 文件完成物理 `fsync` 后才能向客户端返回成功（超时上限 500ms），应紧接着发送什么命令及如何判读返回值？

<details>
<summary>查看参考答案</summary>

1. **MP-AOF 重写后的文件与免双写机制**：
   - 重写开始瞬间，主线程直接新建 `appendonly.aof.2.incr.aof` 接收后续新写命令；`fork` 子进程在后台写出新的 RDB 格式基准文件 `appendonly.aof.2.base.rdb`。
   - 子进程完成后，主线程原子重写 `manifest` 清单为：
     ```text
     file appendonly.aof.2.base.rdb seq 2 type b
     file appendonly.aof.2.incr.aof seq 2 type i startoffset <offset>
     ```
     旧的 `1.base.rdb` 与 `1.incr.aof` 标记为历史文件并由 BIO 线程异步删除。因为重写开始起新写命令已直接落入独立的 `2.incr.aof`，无需再往内存 `aof_rewrite_buf` 双写和跨进程管道搬运。
2. **`WAITAOF` 命令与返回值判读**：
   - 紧随 `HSET` 后在同一连接（或 Pipeline）执行：
     ```bash
     WAITAOF 1 1 500
     ```
   - 命令返回包含两个整数的数组 `[local_fsynced, replicas_fsynced]`：当返回 **`[1, 1]`**（或第二项 `>= 1`）时，确认本机与至少 1 个从库均已完成物理 `fsync`；若超时返回 `[1, 0]` 或 `[0, 0]`，业务层即可立即告警或转入异步核账流程。

</details>

## 面试题 {#ch3-interview}

以下 3 道面试题聚焦写后日志设计哲学、MP-AOF 演进收益与混合持久化高频误区。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么 MySQL Redo Log 用“写前日志（WAL）”，而 Redis AOF 却设计成“写后日志”？

<details>
<summary>查看参考答案</summary>

根本差异在于**存储引擎主数据介质与恢复方式不同**：

1. MySQL 数据页在磁盘上，修改的是内存 Buffer Pool 脏页，必须先顺序写 Redo Log 落盘（WAL）才能在断电后重放物理页修改并利用 Undo Log 回滚未提交事务。
2. Redis 本身就是纯内存无回滚数据库，且 AOF 记录的是客户端原始命令文本而非底层字节偏移。采用**写后日志**（先执行内存修改、成功后再写日志）无需在记日志前额外耗费 CPU 做一遍命令语法与参数合法性检查，天然保证写入 AOF 的每一条命令都是可成功重放的有效命令，同时避免写日志阻塞当前命令的内存执行。

</details>

### 面试题 2：Redis 7.0 的 Multi-Part AOF 相比早期单文件 AOF 解决了什么生产痛点？

<details>
<summary>查看参考答案</summary>

主要根治了早期单文件 AOF 重写时的**内存双写开销**与**主线程收尾阻塞**：

1. **消除内存双写与 IPC 开销**：旧版重写期间主线程必须把增量写命令同时写入 `aof_buf` 和内存 `aof_rewrite_buf`，并通过管道不断发给子进程，高并发写入下额外消耗大量内存与 CPU；MP-AOF 直接切分出新的 `incr.aof` 供主线程单写，彻底移除了 `aof_rewrite_buf`。
2. **消除重写收尾卡顿与磁盘突发尖峰**：旧版子进程结束前主线程需集中把剩余 `aof_rewrite_buf` 刷入新文件并 `rename`，易造成毫秒至秒级毛刺；MP-AOF 只需原子切换轻量 `manifest` 清单即可立即生效，旧文件由后台线程平缓回收。

</details>

### 面试题 3：开启默认混合持久化（`aof-use-rdb-preamble yes`）后，执行 `BGSAVE` 会影响 AOF 日志吗？重启时 Redis 优先加载 RDB 还是 AOF？

<details>
<summary>查看参考答案</summary>

1. **`BGSAVE` 与 AOF 互不干扰**：手动或定时触发 `BGSAVE` 只会独立生成 `dump.rdb` 快照文件，**绝不会清空或修改 AOF 文件**。混合持久化仅在触发 **`BGREWRITEAOF`**（AOF 重写）时生效——子进程将基准内存写为 RDB 格式的 `base.rdb`，后续增量写为 RESP 格式的 `incr.aof`。
2. **重启加载优先级**：只要开启了 `appendonly yes`，Redis 启动时**一律优先读取 `appendonlydir/appendonly.aof.manifest` 加载 `base.rdb + incr.aof`**（因为 AOF 数据通常比低频 `dump.rdb` 更完整最新）；仅当未开启 AOF 时，才会去加载 `dump.rdb`。

</details>

## 参考资料

- [Redis Official Documentation：Redis Persistence（RDB, AOF & Multi-Part AOF）](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis Official Documentation：`WAITAOF` Command Reference](https://redis.io/docs/latest/commands/waitaof/)
- [Redis 7.0 Multi-Part AOF Design Specification（`src/aof.c`）](https://github.com/redis/redis/blob/8.0/src/aof.c)
