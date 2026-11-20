---
title: 第 8 章 事务机制、Redo 日志与 Undo 日志
description: 厘清 ACID 底层实现分工，深入 MTR 物理逻辑 Redo 日志、#innodb_redo 动态容量池、双 1 两阶段提交、崩溃恢复与 Undo 两阶段删除机制。
---

# 第 8 章 事务机制、Redo 日志与 Undo 日志

## 本章要点

Buffer Pool 将高频数据页缓存在内存中大幅提升了读写吞吐，但也引入了两项核心工程挑战：若事务执行中途出错或主动中止，如何干净撤回已改写的内存页；若事务已向客户端确认提交但脏页尚未刷回磁盘便遭遇断电崩溃，如何在重启后毫秒级无损还原。本章围绕 InnoDB 事务引擎的可靠性基石展开：先厘清 ACID 四大特性的底层组件分工、事务状态机与隐式提交边界，再深入物理逻辑 Redo 日志、MTR 原子组、无锁化 Log Buffer、`#innodb_redo` 动态容量池、“双 1”内部两阶段提交与五步崩溃恢复流程，最后剖析 `trx_id` 惰性分配、Undo 两阶段删除机制与独立 Undo 表空间的自动截断管理。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 8.1 ACID 实现映射、事务生命周期与隐式提交 {#ch8-1}

数据库事务是将一组读写操作封装为逻辑工作单元的执行契约。InnoDB 并非依赖单一模块实现 ACID，而是将四大特性精确拆解至不同底层子系统协同保障：

| 事务特性 | 核心工程语义 | InnoDB 与 Server 层底层实现机制 |
| --- | --- | --- |
| **A** 原子性（Atomicity） | 事务内操作全成功或全撤销，绝不暴露半成品 | **Undo 日志**：记录每次修改前的逻辑反向依据，供显式 `ROLLBACK` 或崩溃恢复阶段撤销未提交改动 |
| **I** 隔离性（Isolation） | 并发事务的状态演进互不干扰 | **MVCC 多版本并发控制**（详见[第 9 章 9.2 节](./chapter-09#ch9-2)）负责无锁快照读，**行锁与间隙锁**（详见[第 10 章 10.2 节](./chapter-10#ch10-2)）负责写写与当前读互斥 |
| **D** 持久性（Durability） | 一旦返回提交成功，掉电崩溃修改亦不丢失 | **Redo 日志**（WAL 预写日志）保证重放恢复，配合**双写缓冲区**防范 `16 KB` 页部分刷盘撕裂，详见[第 2 章 2.2.3 节](./chapter-02#ch2-2-3) |
| **C** 一致性（Consistency） | 数据始终满足现实业务守恒律与完整性约束 | **A + I + D 协同托底** + 数据库层约束——含主键、唯一键、外键、`NOT NULL` 及 **MySQL 8.0.16+ 原生强制生效的 `CHECK` 约束**——+ 应用层业务不变量校验 |

需注意版本演进差异：原书基于 MySQL 5.7 指出“`CHECK` 语法仅被解析而直接忽略”，这一历史局限自 **MySQL 8.0.16** 起已彻底消除，违反 `CHECK` 约束的写入会立即抛出 `ERROR 3819` 并中止语句。

在运行期内，一个事务会严格沿五种状态单向演进：

```text
活动的(Active) ──► 部分提交的(Partially Committed) ──► 提交的(Committed)
      │                         │
      └───────► 失败的(Failed) ◄┘
                    │  应用 Undo 日志逐条撤销已修改页面
                    ▼
               中止的(Aborted)
```

正在执行读写语句的事务处于 **Active**；最后一条语句执行完毕但内存修改尚未完成提交落盘时处于 **Partially Committed**；唯有完成日志持久化进入 **Committed**，或因错误、手动 `ROLLBACK` 走完 Undo 回滚进入 **Aborted**，事务生命周期才算真正完结。

在 SQL 控制层面，`BEGIN [WORK]` 与 `START TRANSACTION` 均可显式开启事务，但唯独 **`START TRANSACTION`** 支持附加访问与快照修饰符：

- **`READ ONLY` 与 `READ WRITE`**：只读模式禁止修改普通持久表，但**允许对会话私有的 `TEMPORARY` 临时表执行 `INSERT`、`UPDATE` 与 `DELETE`**，常用于复杂报表中间汇总计算。
- **`WITH CONSISTENT SNAPSHOT`**：在语句执行瞬间立即生成一致性读视图，而非推迟到事务内首条普通 `SELECT` 执行时才惰性创建；多个修饰符用逗号分隔，如 `START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT;`。
- **保存点局部回滚**：事务内可通过 `SAVEPOINT sp1` 打点、`ROLLBACK TO sp1` 撤销该点之后的修改而不结束事务，或通过 `RELEASE SAVEPOINT sp1` 销毁保存点。

系统变量 `autocommit` 默认开启为 `ON`，此时未包裹在显式事务内的每条语句均自动独立提交。若关闭 `SET SESSION autocommit = OFF` 或已处于显式事务中，在执行以下**五大类语句前，MySQL 会强制先将当前挂起的前序事务隐式提交**（等效自动插入一条 `COMMIT`）：

1. **DDL 数据定义语句**：如 `CREATE / ALTER / DROP / TRUNCATE TABLE`、`RENAME TABLE`。注意 **MySQL 8.0+** 依托 `mysql.ibd` 事务数据字典引入了**原子 DDL**（详见[第 3 章 3.1 节](./chapter-03#ch3-1)），确保单条 DDL 自身崩溃可回滚，但执行该 DDL 前仍会先隐式提交当前会话未提交的前序普通事务；唯独 `CREATE / DROP TEMPORARY TABLE` 例外，不会触发隐式提交。
2. **账号与权限管理语句**：`CREATE / ALTER / DROP USER`、`GRANT`、`REVOKE`、`SET PASSWORD`。
3. **嵌套事务控制与表锁语句**：在未提交事务内再次执行 `BEGIN` / `START TRANSACTION`、将 `autocommit` 由 `OFF` 改回 `ON`，或执行 `LOCK TABLES`、`UNLOCK TABLES`。
4. **数据加载与表维护管理语句**：`LOAD DATA`、`ANALYZE / CHECK / OPTIMIZE / REPAIR TABLE`、`CACHE INDEX`。
5. **复制控制语句**：`START REPLICA`、`STOP REPLICA`、`RESET REPLICA`、`CHANGE REPLICATION SOURCE TO`。自 **MySQL 8.4** 起，旧版 `START / STOP / RESET SLAVE` 与 `CHANGE MASTER TO` 语法已被彻底移除，执行会直接报 `ERROR 1064` 语法错误。

以下 MySQL 8.4.13 实测片段验证了原生 `CHECK` 约束拦截与 `READ ONLY` 事务操作临时表行为：

```sql
CREATE TABLE acct_chk (
  id INT PRIMARY KEY,
  balance BIGINT NOT NULL,
  CONSTRAINT chk_bal_nonneg CHECK (balance >= 0)
) ENGINE=InnoDB;

INSERT INTO acct_chk VALUES (2, -50);
-- ERROR 3819 (HY000): Check constraint 'chk_bal_nonneg' is violated.

CREATE TEMPORARY TABLE tmp_calc (k INT PRIMARY KEY, v INT);
START TRANSACTION READ ONLY;
INSERT INTO tmp_calc VALUES (1, 42); -- 临时表写入在 READ ONLY 事务中正常成功
COMMIT;
```

## 8.2 Redo 日志、动态容量池与崩溃恢复 {#ch8-2}

### 8.2.1 物理逻辑日志、MTR 原子组与无锁 Log Buffer {#ch8-2-1}

若每次事务提交都直接把 Buffer Pool 中涉及的所有脏页刷回磁盘，会产生两大致命瓶颈：一是**严重写放大**，仅修改一行几个字节也必须整页刷写 `16 KB`；二是**随机磁盘 I/O**，单条 SQL 往往同时改动聚簇索引与多个二级索引上离散分布的页面。为此 InnoDB 遵循 **WAL**（预写日志）原则，即 Write-Ahead Logging，提交时只需顺序追加数十字节紧凑的 Redo 日志即可确保持久性。

Redo 日志本质上采用**物理逻辑日志**（Physiological Logging）格式——**物理到页面，逻辑到页内操作**：

- **简单底层字节修改**：如更新段区元数据页或自增计数，直接记录表空间 ID `space_id`、页号 `page_no`、页内偏移量与覆写字节，对应 `MLOG_1BYTE`、`MLOG_2BYTES`、`MLOG_4BYTES`、`MLOG_8BYTES` 及 `MLOG_WRITE_STRING` 等类型。
- **复杂 B+ 树记录插入与重排**：插入一条记录可能联动修改槽目录、记录头 `next_record` 单向链表与页头统计槽位，若逐处记录物理字节偏移反倒臃肿；此时采用 `MLOG_COMP_REC_INSERT` 等逻辑类型，仅记录 `space_id`、`page_no` 与插入记录必要的构造参数，崩溃恢复时调用引擎插入例程在目标页内重演结构变更。

一次底层页面原子操作——例如一次 B+ 树悲观插入同时触发叶子页分裂、父节点目录项插入与段链表修改——必须构成不可分割的 **Mini-Transaction**（MTR）。同一 MTR 产出的多条 Redo 日志在崩溃恢复时要么全部重放，要么整组作废：

- 包含多条日志的 MTR 在组末尾写入 1 字节特殊哨兵记录 **`MLOG_MULTI_REC_END`**（十进制类型码 `31`）；恢复扫描若未读到该结束标记，即判定该 MTR 在落盘中途遭遇断电，整组直接丢弃。
- 仅含单条日志的 MTR 无需浪费 1 字节追加结尾记录，直接将该日志 `type` 字段最高比特位（第 8 位 MSB）置为 `1`，标识单条日志自成完整原子组。

无论在内存还是磁盘上，Redo 日志统一划分为与传统扇区等宽的 **`512` 字节日志块**（`redo log block`）：

```text
|<--- 12B log block header --->|<------ 496B log block body ------>|<-- 4B trailer -->|
  HDR_NO(4B) | HDR_DATA_LEN(2B)   连续紧凑存放 MTR 生成的日志字节流    BLOCK_CHECKSUM(4B)
  HDR_FIRST_REC_GROUP(2B) | CHECKPOINT_NO(4B)
```

其中 `HDR_DATA_LEN` 记录本块已填充字节数（含头部初始为 `12`，写满为 `512`），`HDR_FIRST_REC_GROUP` 指向本块内首个新开启 MTR 的偏移量。

在内存缓冲层，`innodb_log_buffer_size` 默认为 `16 MiB`。原书基于 MySQL 5.7 描述了所有工作线程争抢全局互斥锁串行写入 `log buffer` 的旧机制。自 **MySQL 8.0** 起，InnoDB 已彻底重构为**无锁化并行 Log Buffer 架构**：

1. 并发用户线程仅通过原子指令（CAS）在全局 LSN 序列上预留各自 MTR 所需的精确字节区间，随后**多线程无锁并行**向各自的 `log buffer` 内存切片拷贝日志内容。
2. 并行拷贝期间，先预留前序区间的线程可能尚未拷完，而后序区间已提前拷毕，形成短暂的内存“空洞”。InnoDB 引入定长环形追踪数组 **`recent_written`**，由专用后台线程 `log_writer` 持续推进无空洞的最大连续就绪点 `buf_ready_for_write_lsn` 并顺序写入系统文件缓存，再由 `log_flusher` 负责执行 `fsync` 落盘；同时借助另一组环形结构 **`recent_closed`** 追踪已完成脏页挂入 `flush` 链表的边界，彻底解耦用户写线程与磁盘 I/O 锁竞争。

### 8.2.2 刷盘策略（双 1 两阶段提交）、#innodb_redo 与 Checkpoint {#ch8-2-2}

事务提交时 Redo 日志何时落盘由系统变量 **`innodb_flush_log_at_trx_commit`** 控制，三档行为取舍对比如下：

| 参数取值 | 提交时动作 | 后台刷盘节奏 | 故障容忍边界与适用场景 |
| --- | --- | --- | --- |
| **`1`**（默认） | 写入 OS 页缓存并立即 `fsync` 刷入磁盘 | 后台线程同时按需推进 | **强持久零丢失**：即使整机断电，已提交事务也绝不丢失；核心业务标配 |
| **`2`** | 仅 `write` 进 OS 页缓存，不调 `fsync` | 按 `innodb_flush_log_at_timeout`（默认 `1` 秒）周期 `fsync` 刷盘 | **`mysqld` 进程崩溃通常不丢数据**（OS 页缓存仍在）；仅当操作系统崩溃或整机断电时，可能丢失自上次成功刷盘以来的已提交事务 |
| **`0`** | 提交时不写 OS 缓存也不刷盘 | 按 `innodb_flush_log_at_timeout`（默认 `1` 秒）周期统一 `write + fsync` | 吞吐最高但最脆弱，**只要 `mysqld` 进程崩溃或整机故障**，即可能丢失自上次成功写入/刷盘以来的已提交事务 |

> [!NOTE]
> **切勿将 `0` / `2` 的丢失窗口绝对化为“最多丢失 1 秒”**：`1` 秒只是后台刷盘周期参数 **`innodb_flush_log_at_timeout`**（默认值 `1`，可配置范围 `1..2700` 秒）的默认间隔。MySQL 8.4 官方手册明确指出，对 `0` 和 `2` 而言，每秒刷盘并非 100% 严格保证——一方面 DDL 或其他内部操作可能提前触发刷盘，另一方面在系统高负载或线程调度延迟时，实际刷盘间隔也可能超过 1 个周期。因此真实丢失窗口取决于最后一次成功写入/刷盘的时刻、`innodb_flush_log_at_timeout` 配置及故障类型边界（`0` 怕进程崩，`2` 怕 OS 崩或断电）。

当实例开启 Server 层二进制日志 `binlog`（用于主从复制与时间点恢复）时，单靠引擎层 Redo 刷盘仍不足以保证主从一致：若先写完 Redo 后断电，重启后主库恢复了该事务而从库因缺失 `binlog` 少一条修改；若先写完 `binlog` 后断电，从库同步了该修改而主库重启回滚了该事务。为此 MySQL 实施**内部 XA 两阶段提交**（Two-Phase Commit，2PC）：

```text
1. Prepare 阶段 : InnoDB 写入事务 Redo 日志并将事务状态标为 TRX_PREPARED，按策略 fsync 刷盘
2. Binlog  阶段 : Server 层将含内部事务号 XID 的 Binlog 写入文件；sync_binlog=1 时立即 fsync 刷盘
3. Commit  阶段 : InnoDB 写入提交标记并将事务置为已提交态（借助组提交批量合并落盘）
```

生产规范中常说的“**双 1**”**黄金配置**即同时设定 **`innodb_flush_log_at_trx_commit = 1`** 与 **`sync_binlog = 1`**——两者在 MySQL 8.0 与 8.4 中均已默认设为 `1`——配合组提交机制将同一时刻并发到达的多个事务合并为单次 `fsync`，在保障单机零丢数与主从零偏差的同时摊薄磁盘同步延迟。

在磁盘文件组织上，自 **MySQL 8.0.30** 起（含 **MySQL 8.4 LTS**），原书所述的根目录下固定数量 `ib_logfile0`、`ib_logfile1` 及参数 `innodb_log_file_size`、`innodb_log_files_in_group` 均已废弃，全面升级为 **`#innodb_redo/` 动态容量池架构**：

- InnoDB 在数据目录的 `#innodb_redo/` 子目录下固定维护 **32 个**重做日志文件，总容量由 **`innodb_redo_log_capacity`** 统一控制——默认 `104857600` 字节即 `100 MiB`，单文件大小固定为 `capacity ÷ 32` 即默认 `3276800` 字节（`3.125 MiB`）——且支持通过 `SET GLOBAL innodb_redo_log_capacity = ...` **在线平滑扩缩容而无需重启实例**。
- 32 个文件分为两类：正在承载有效重做数据的**活跃文件 `#ib_redoN`**，以及空闲待命的**备用文件 `#ib_redoN_tmp`**；每写满一个活跃文件便消费一个 `_tmp` 文件重命名为递增序号 `#ib_redo(N+1)`。

全局变量 **LSN**（日志序列号，初始值 `8704`）单调递增统计自系统创建以来累计生成的 Redo 字节总量——注意每跨越一个 `512B` 日志块，其 `12B` 头部与 `4B` 尾部同样计入 LSN 增量，且每个重做文件开头的 `2048B` 文件头除外。每当一个 MTR 修改完缓冲页，会将结束时的 LSN 写入页控制块的 `newest_modification`（即页头 `FIL_PAGE_LSN`）；若是该干净页首次变脏，还将起始 LSN 记入 `oldest_modification` 并挂入 Buffer Pool 的 `flush` 脏页链表（详见[第 3 章 3.3.1 节](./chapter-03#ch3-3-1)）。

后台刷脏线程不断将 `flush` 链表尾部最老脏页落盘摘除后，当前链表尾部剩余最老脏页的 `oldest_modification` 即代表“早于此 LSN 的所有页面改动均已安全落入 `.ibd` 表空间文件”。InnoDB 将该边界持久化记录到首个活跃重做文件头部的检查点槽位中，称为一次 **Checkpoint**（检查点推进）：凡是整文件 `END_LSN < checkpoint_lsn` 的历史活跃文件 `#ib_redoN` 均可安全回收，重命名为新的 `_tmp` 备用文件循环复用。在 MySQL 8.4.13 中可直接通过 `performance_schema` 观测重做池与检查点水位：

```sql
SELECT FILE_ID, FILE_NAME, START_LSN, END_LSN, SIZE_IN_BYTES
FROM performance_schema.innodb_redo_log_files LIMIT 3;
-- +---------+--------------------------+-----------+----------+---------------+
-- | FILE_ID | FILE_NAME                | START_LSN | END_LSN  | SIZE_IN_BYTES |
-- +---------+--------------------------+-----------+----------+---------------+
-- |       9 | ./#innodb_redo/#ib_redo9 |  29480960 | 32755712 |       3276800 |
-- |      10 | ./#innodb_redo/#ib_redo10|  32755712 | 36030464 |       3276800 |
-- |      11 | ./#innodb_redo/#ib_redo11|  36030464 | 39305216 |       3276800 |
-- +---------+--------------------------+-----------+----------+---------------+
```

### 8.2.3 崩溃恢复五步流程 {#ch8-2-3}

当服务器遭遇异常掉电重启时，InnoDB 严格按以下五步自动执行崩溃恢复：

1. **定位恢复起点 `checkpoint_lsn`**：读取重做日志头部的两组交替检查点元数据块，选取序号更大、校验和合法的最新 `checkpoint_lsn` 作为扫描起点，早于该起点的日志对应脏页已在崩溃前落盘，无需再读。
2. **顺序扫描 `512B` 块锁定日志终点**：从 `checkpoint_lsn` 所在块偏移起向后逐块校验扫描；由于运行期间写满的块其 `HDR_DATA_LEN` 恒等于 `512`，扫描遇到的第一个 `HDR_DATA_LEN < 512` 的未满块即为崩溃瞬间的日志物理终点。
3. **按 `(space_id, page_no)` 哈希分桶聚合完整 MTR**：剔除日志尾部缺失 `MLOG_MULTI_REC_END` 结束哨兵的残缺 MTR；将其余完整 MTR 内的日志记录以 `(space_id, page_no)` 计算哈希值归入同一桶链表，并严格维持针对同一页修改的先后生成次序，从而把对同一数据页的数十次离散重放合并为**一次磁盘读页 + 内存连续重演**，彻底规避恢复期随机 I/O 风暴。
4. **比对 `FIL_PAGE_LSN` 幂等跳过已落盘改动**：从磁盘读入目标页——若校验和损坏触发页撕裂，先从双写缓冲区 `#ib_16384_0/1.dblwr` 拷贝完整页修复——再检查页头 `FIL_PAGE_LSN`：由于后台刷脏线程可能在最后一次 Checkpoint 之后已提前将该页刷盘，凡满足 **`FIL_PAGE_LSN >= redo_lsn`** 的日志直接跳过，仅按序重放 `FIL_PAGE_LSN < redo_lsn` 的后续记录。
5. **基于 Undo 日志与 Binlog 裁决未决事务**：Redo 全部重放完毕后，Buffer Pool 恢复至崩溃前一刻的精确物理状态（含未提交事务脏页）。随后扫描回滚段活跃事务槽位：① 普通未提交 `ACTIVE` 事务直接读取其 Undo 日志回滚撤销；② 处于两阶段提交 **`TRX_PREPARED`** 状态的事务，提取其内部 `XID` 前往最新 `binlog` 文件检索——**若 `binlog` 中已存在该 `XID` 则提交事务，若不存在则利用 Undo 日志彻底回滚**。

## 8.3 Undo 日志、两阶段删除与独立 Undo 表空间 {#ch8-3}

为实现原子回滚与[第 9 章 9.2 节](./chapter-09#ch9-2)的 MVCC 多版本快照读，InnoDB 依靠全局单调递增的 `6` 字节**事务 ID**（`trx_id`）与 **Undo 日志**追踪每次行级变更。

`trx_id` 遵循严格的**按需惰性分配**与 **`+256` 批量持久化**规则：

- **普通非锁定只读事务可跳过分配真实 `trx_id`，写操作及部分锁定读需要分配真实 `trx_id`**：`READ ONLY` 事务——对临时表写入时仅分配非持久临时号——以及开启后仅执行**普通非锁定只读 `SELECT`** 的事务，可跳过分配真实持久 `trx_id`。此时查询 `information_schema.INNODB_TRX` 看到的是由内存 `trx_t` 结构体指针与 `1 << 48` 按位或构造的超大虚拟只读标识。需特别纠正“必须等到首行被改写才分配真实事务号”的常见误解：**MySQL 8.4 实测表明，除了真正修改普通表记录的写操作外，显式事务中执行 `SELECT ... FOR UPDATE` 等部分锁定读（即便 `trx_rows_modified = 0`、尚未执行任何 DML）同样会从全局计数器领用真实的递增 `trx_id`**。注意 `INNODB_TRX` 内置 `0.1s` 采样缓存，脚本连续观测需间隔 `DO SLEEP(0.2)`：

```sql
START TRANSACTION;
SELECT * FROM acct_chk;
DO SLEEP(0.2);
SELECT trx_id, trx_rows_modified FROM information_schema.INNODB_TRX
WHERE trx_mysql_thread_id = CONNECTION_ID();
-- 仅执行普通非锁定只读查询：trx_id = 405154356199424（虚拟只读指针编号）, trx_rows_modified = 0
-- 若此处改执行 SELECT * FROM acct_chk WHERE id = 1 FOR UPDATE，即便 trx_rows_modified = 0 也会提前分配真实 trx_id

UPDATE acct_chk SET balance = 200 WHERE id = 1;
DO SLEEP(0.2);
SELECT trx_id, trx_rows_modified FROM information_schema.INNODB_TRX
WHERE trx_mysql_thread_id = CONNECTION_ID();
-- 写操作后：trx_id = 2467（领用真实单调递增 trx_id）, trx_rows_modified = 1
ROLLBACK;
```

- **每满 `256` 落盘预留**：内存计数器每递增 `256` 次，便将当前值写入 `ibdata1` 第 `5` 页 `SYS_HEADER` 的 `TRX_SYS_TRX_ID_STORE` 槽位并刷写 Redo；崩溃恢复启动时将该磁盘值直接 **`+ 256`** 作为新起点，确保崩溃前未及落盘的已用编号绝不会被重复分配。

注意 Undo 日志自身也存储在页面（`FIL_PAGE_UNDO_LOG`）中，**写入 Undo 日志的过程同样会产生对应的 Redo 日志**以保障崩溃后仍能正常回滚。针对 `INSERT`、`DELETE`、`UPDATE` 三类语句，Undo 日志格式、生命周期与索引维护机制截然不同：

| 操作类型 | Undo 日志类别与核心内容 | 聚簇索引与二级索引物理动作 | 提交后生命周期与空间回收机制 |
| --- | --- | --- | --- |
| **`INSERT`** | `TRX_UNDO_INSERT_REC`：仅需记录新插入行的主键值 | 插入聚簇索引与全部二级索引记录，并将受影响二级索引页头 `PAGE_MAX_TRX_ID` 更新为当前 `trx_id` | **提交即弃**：新行提交前对其他事务不可见，提交后无历史快照需回溯其前身，`COMMIT` 瞬间 Undo 页即可重用 |
| **`DELETE`** | `TRX_UNDO_DEL_MARK_REC`：记录主键、旧 `trx_id`、`roll_pointer` 及**所有索引列旧值** | **两阶段删除**——阶段 1 仅把聚簇与二级索引记录头 `deleted_flag` 置 `1`，**绝不立即摘除释放空间** | **延后异步清理**：挂入 History 链表服务并发 MVCC 快照读；待所有更老 `ReadView` 关闭后，由后台 **`purge` 线程**执行阶段 2 摘除记录并入 `PAGE_FREE` 链表 |
| **`UPDATE`**（不改主键） | `TRX_UNDO_UPD_EXIST_REC`：记录主键、旧版本控制列及被更新列旧值与索引列信息 | 若所有被改列前后字节长度完全相等则原位**就地更新**；否则在页内**同步物理删除旧记录并入 `PAGE_FREE` 后再插入新记录**。受波及二级索引一律执行旧项打标删除 + 插入新项 | 同 `DELETE`，归入 `update` 类 Undo 链表，须保留至无任何活跃 `ReadView` 引用后方由 `purge` 线程回收 |
| **`UPDATE`**（修改主键） | 顺序生成 **`TRX_UNDO_DEL_MARK_REC` + `TRX_UNDO_INSERT_REC` 两条日志** | 旧主键位置聚簇记录执行 `delete mark`，新主键位置执行完整 `INSERT`；**全部二级索引**均须旧项打标删除并重插新项 | 旧位置记录与删除 Undo 留待异步 `purge` 物理回收，新位置插入 Undo 在提交时释放；代价远高于普通更新 |

聚簇索引每条记录的 `7` 字节隐藏列 **`DB_ROLL_PTR`**（共 `56 bit`）即指向本行最新一条 Undo 日志的精确物理坐标：

```text
| 1b: is_insert | 7b: rseg_id (0..127) | 32b: undo page_no | 16b: page offset |
```

最高位 `is_insert = 1` 表示指向提交即弃的 `insert undo` 链表，`0` 表示指向需等待 `purge` 清理的 `update undo` 链表；`rseg_id` 标识最多 `128` 个回滚段——其中第 `0` 号驻留系统表空间，第 `1..32` 号专用于临时表不写 Redo 的 Undo 日志，第 `33..127` 号分配给持久化独立 Undo 表空间。

在物理存储演进上，早期 MySQL 默认将所有 Undo 页面混存于系统表空间 `ibdata1`，一旦未提交长事务阻塞 `purge` 导致 `ibdata1` 暴涨至数百 GB，即便提交长事务也无法把空间归还操作系统。**MySQL 8.0+ 与 8.4 LTS** 已彻底解决该痛点：

1. **默认双独立 Undo 表空间**：实例初始化自动创建 `innodb_undo_001` 与 `innodb_undo_002`，对应数据目录下两个 `16 MiB` 初始文件 `undo_001`、`undo_002`，支持运行时在线管理 `CREATE UNDO TABLESPACE u3 ADD DATAFILE 'u3.ibu'`、`ALTER UNDO TABLESPACE u3 SET INACTIVE` 与 `DROP UNDO TABLESPACE u3`。
2. **默认开启自动在线截断回收**：`innodb_undo_log_truncate` 默认设为 `ON`；一旦某个独立 Undo 表空间体积超过 `innodb_max_undo_log_size`（默认 `1 GiB`），后台 `purge` 协调器会自动暂停向其分配新事务，待旧事务排空后在线将其物理截断缩回初始 `16 MiB`，彻底根除磁盘只涨不缩顽疾：

```sql
SELECT NAME, SPACE_TYPE, STATE, FILE_SIZE
FROM information_schema.INNODB_TABLESPACES WHERE SPACE_TYPE = 'Undo';
-- +-----------------+------------+--------+-----------+
-- | NAME            | SPACE_TYPE | STATE  | FILE_SIZE |
-- +-----------------+------------+--------+-----------+
-- | innodb_undo_001 | Undo       | active |  16777216 |
-- | innodb_undo_002 | Undo       | active |  16777216 |
-- +-----------------+------------+--------+-----------+
```

## 练习 {#ch8-exercises}

以下 2 道练习围绕断电崩溃五步恢复与两阶段提交裁决、以及主键更新与等长普通列更新的底层差异展开。存储引擎均为 `InnoDB` 且启用“双 1”配置，建议先独立推演再展开核对。

### 练习 1：推演异常断电瞬间四类混合状态事务与提前刷盘脏页的崩溃恢复结果

某开启了 `binlog` 的线上 MySQL 8.4 实例在 `LSN = 99800` 瞬间遭遇机房断电，最近一次完成的检查点为 `checkpoint_lsn = 92000`。断电前一刻系统存在如下状态：

- 数据页 `P9`：在 `LSN = 95000` 和 `LSN = 98500` 各经历过一次完整 MTR 修改，且后台刷脏线程在 `LSN = 98600` 时已提前将 `P9` 刷回 `.ibd` 磁盘文件。
- 事务 `T1`：已完成 `COMMIT` 返回客户端成功，Redo 与 Binlog 均已落盘，但其修改的数据页 `P12` 仍在内存尚未刷入 `.ibd`。
- 事务 `T2`：仍处于 `ACTIVE` 未提交态，未执行 `COMMIT`，但因其修改了大量行触发 LRU 淘汰，其脏页 `P15` **已在断电前被刷入 `.ibd` 磁盘文件**。
- 事务 `T3`：处于内部两阶段提交 `TRX_PREPARED` 状态，Redo Prepare 日志已落盘，且内部 `XID = 803` **已写入并 `fsync` 至 `binlog`**，尚未写 Redo Commit 标记即断电。
- 事务 `T4`：处于内部两阶段提交 `TRX_PREPARED` 状态，Redo Prepare 日志已落盘，但**尚未写入 `binlog`**——`binlog` 中无 `XID = 804`——即遭遇断电。

请按崩溃恢复流程逐项说明重启后数据页 `P9` 的重放行为，以及事务 `T1`、`T2`、`T3`、`T4` 的最终落定状态（保留提交还是回滚撤销）与判定依据。

<details>
<summary>查看参考答案</summary>

1. **数据页 `P9`：两条 Redo 记录全部幂等跳过，无需重复重放**：
   - 虽然两条修改的 LSN（`95000`、`98500`）均大于恢复扫描起点 `checkpoint_lsn(92000)` 而会被扫描进哈希桶，但 `P9` 在 `LSN = 98600` 刷盘时其页头 `FIL_PAGE_LSN` 已被更新为 `98500`。恢复第 4 步比对发现 `FIL_PAGE_LSN(98500) >= redo_lsn(95000, 98500)`，直接幂等跳过，避免破坏页面或重复插入。
2. **事务 `T1`：最终保留提交**：
   - 磁盘上的 `P12` 虽仍是旧页，满足 `FIL_PAGE_LSN < T1_redo_lsn`，但 `T1` 的完整 MTR Redo 已落盘，恢复第 4 步会将 `P12` 读入内存重放 `T1` 的全部修改，且 `T1` 已标记为提交终态无需回滚。
3. **事务 `T2`：最终彻底回滚撤销**：
   - 尽管 `T2` 的脏页 `P15` 已落入 `.ibd` 文件，但由于写入 Undo 日志时同步记录了 Redo 日志，重放阶段还原出完整的 Undo 回滚段与活跃事务槽位；恢复第 5 步识别出 `T2` 处于未提交 `ACTIVE` 态，立即顺着 `DB_ROLL_PTR` 读取 `T2` 的 Undo 日志将 `P15` 还原回修改前状态。
4. **事务 `T3`：最终补齐提交**：
   - 恢复第 5 步发现 `T3` 处于 `TRX_PREPARED`，提取 `XID = 803` 在 `binlog` 中检索命中——说明该事件已具备被从库拉取复制的资格，InnoDB 自动为 `T3` 补齐提交标记，保持主从一致。
5. **事务 `T4`：最终回滚撤销**：
   - `T4` 虽已完成 Redo Prepare，但在 `binlog` 中查无 `XID = 804`——说明客户端未收到提交成功响应且从库绝不会收到该事件，遂调用 Undo 日志将 `T4` 回滚。

</details>

### 练习 2：对比等长非索引列更新与主键更新的聚簇索引、二级索引及 Undo 开销

给定会员卡表 `member_card` 及其中一条已提交记录 `(100, '13800000001', 1)`：

```sql
CREATE TABLE member_card (
  card_id BIGINT NOT NULL,
  phone VARCHAR(20) NOT NULL,
  tier TINYINT NOT NULL,
  PRIMARY KEY (card_id),
  KEY idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO member_card VALUES (100, '13800000001', 1);
```

分析在两个独立事务中分别执行以下两条语句时，聚簇索引页、二级索引 `idx_phone` 以及 Undo 日志在底层动作上的全部差异：

- 语句 `U1`：`UPDATE member_card SET tier = 2 WHERE card_id = 100;`
- 语句 `U2`：`UPDATE member_card SET card_id = 200 WHERE card_id = 100;`

<details>
<summary>查看参考答案</summary>

| 对比维度 | 语句 `U1`（等长修改非索引列 `tier`） | 语句 `U2`（修改主键列 `card_id`） |
| --- | --- | --- |
| **聚簇索引物理动作** | `TINYINT` 修改前后固定占 `1` 字节且未动主键，直接在 `card_id = 100` 原记录位置执行**就地更新**（In-place Update），覆写 `tier`、`DB_TRX_ID` 与 `DB_ROLL_PTR` | 聚簇索引按主键严格排序，无法原位改键：先将旧位置 `card_id = 100` 记录头 `deleted_flag` 置 `1`（**delete mark**），再按新位置定位插入一条完整的 `card_id = 200` 新记录（可能触发页分裂） |
| **二级索引 `idx_phone` 动作** | **零修改**：`phone` 与主键 `card_id` 均未变化，无需触碰任何二级索引页，也不更新 `PAGE_MAX_TRX_ID` | **必须重写全部二级索引**：二级索引叶子节点存储 `(phone, card_id)`，需将旧项 `('13800000001', 100)` 打标 `deleted_flag = 1`，再插入新项 `('13800000001', 200)`，并更新二级索引页 `PAGE_MAX_TRX_ID` |
| **Undo 日志类型与条数** | 仅生成 **1 条** `TRX_UNDO_UPD_EXIST_REC` 日志，挂入 `update undo` 链表待后续 `purge` 回收 | 连续生成 **2 条**日志：针对 `card_id = 100` 的 `TRX_UNDO_DEL_MARK_REC`（待异步 `purge`）与针对 `card_id = 200` 的 `TRX_UNDO_INSERT_REC`（提交即弃） |

工程启示：在 InnoDB 中切忌将业务上可能变更的编码直接设为主键，否则每次改主键值都会退化为全索引树的“删除 + 插入”双重写放大。

</details>

## 面试题 {#ch8-interview}

以下 3 道面试题聚焦 WAL 写性能本质、“双 1”两阶段提交防不一致原理、以及 `DELETE` 空间不缩容与两类 Undo 回收时机差异。建议先独立作答再展开核对。

### 面试题 1：既然 Buffer Pool 中的脏页最终还是要刷回磁盘，为什么事务提交时写 Redo 日志比直接刷脏页快得多？

<details>
<summary>查看参考答案</summary>

核心在于**消除 `16 KB` 页级写放大**与**化离散随机 I/O 为连续顺序追加 I/O**：

1. **写入字节量相差数百倍**：InnoDB 刷脏页的最小物理单位是 `16 KB` 数据页，即便事务只改了一行中的 `4` 字节整数，直接刷脏也必须整页写出 `16384` 字节（开启双写缓冲区时还要再翻倍）；而物理逻辑 Redo 日志仅记录表空间号、页号与紧凑修改差量，往往只需几十字节。
2. **磁盘寻道与并发合并差异**：单条事务常波及聚簇索引与多个二级索引上跨表空间离散分布的多个页面，直接刷脏会产生高延迟随机写；而 Redo 日志始终向当前活跃 `#ib_redoN` 文件尾部**顺序追加写**，且配合无锁 `log buffer` 与组提交机制，可将几十个并发事务的提交合并为一次 `fsync` 完成，后台线程再在低峰期异步批量刷脏。

</details>

### 面试题 2：生产环境常说的 MySQL“双 1”配置指哪两个参数？开启 `binlog` 时若缺少内部两阶段提交（2PC）会导致什么后果？

<details>
<summary>查看参考答案</summary>

1. **双 1 配置定义**：
   - **`innodb_flush_log_at_trx_commit = 1`**：每次事务提交时强制将 InnoDB Redo 日志写入并 `fsync` 刷入持久化磁盘；
   - **`sync_binlog = 1`**：每次事务提交时强制将 Server 层 `binlog` 写入并 `fsync` 刷入持久化磁盘，MySQL 8.0 与 8.4 中两者默认均为 `1`。
2. **缺少两阶段提交的严重后果**：若退化为先写一个日志再写另一个日志的单阶段串行模式，在两次写盘间隙发生断电重启就会造成**主从数据永久不一致**：
   - **假设先写 Redo 后写 Binlog，中间断电**：重启后主库依靠 Redo 恢复了该事务的修改，但因 `binlog` 未写出，从库与基于 `binlog` 的时间点备份永远丢失这次提交，主库比从库**多**数据；
   - **假设先写 Binlog 后写 Redo，中间断电**：从库拉取已落盘的 `binlog` 执行了修改，而主库重启后因无 Redo 记录将事务回滚，从库比主库**多**数据。两阶段提交通过 `Prepare Redo → 刷 Binlog → 崩溃时以 XID 是否落入 Binlog 作为唯一提交准绳` 彻底封堵了这一窗口。

</details>

### 面试题 3：为什么执行 `DELETE` 删除几百万行记录后磁盘 `.ibd` 文件体积没有缩小？为什么 `INSERT` 的 Undo 日志提交即弃，而 `DELETE` 和 `UPDATE` 的 Undo 日志提交后不能立即丢弃？

<details>
<summary>查看参考答案</summary>

1. **`DELETE` 后 `.ibd` 文件不缩小的原因**：
   - `DELETE` 采用**两阶段删除**：事务执行期仅把记录头 `deleted_flag` 置为 `1`；即便事务提交且后台 `purge` 线程完成物理清理，也只是将被删记录占用的字节挂入数据页内部的 **`PAGE_FREE` 垃圾重用链表**——整页清空时归还给表空间内的空闲页链表——留给本表后续新 `INSERT` 的数据直接覆写复用，**InnoDB 不会主动截断 `.ibd` 文件把空间退还给操作系统**。若确需回收磁盘空间，需在低峰期执行重建表操作 `ALTER TABLE tbl ENGINE=InnoDB;` 或等价的 `OPTIMIZE TABLE tbl;`。
2. **两类 Undo 日志提交后回收时机不同的原因**：
   - **`INSERT` Undo 提交即弃**：新插入记录在事务未提交前仅本事务可见，一旦事务 `COMMIT`，所有新老事务要么直接看到最新行，要么因 `ReadView` 早于该事务而判定不可见（回溯到“不存在”即可），没有任何并发事务需要读取“插入之前的旧版本”，因此 `insert undo` 在提交瞬间即可释放重用。
   - **`DELETE` / `UPDATE` Undo 不能立即丢弃**：事务提交时刻，系统中可能仍存在更早开启、处于 `REPEATABLE READ` 或慢查询执行中的并发活跃事务，它们的 MVCC `ReadView` 仍需顺着聚簇索引记录的 `DB_ROLL_PTR` 读取修改前或删除前的历史版本；唯有等到早于该提交时刻的所有 `ReadView` 全部关闭后，后台 `purge` 线程才能安全清理这些 `update undo` 日志。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: 15.3.1 START TRANSACTION, COMMIT, and ROLLBACK Statements](https://dev.mysql.com/doc/refman/8.4/en/commit.html)
- [MySQL 8.4 Reference Manual: 15.3.3 Statements That Cause an Implicit Commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)
- [MySQL 8.4 Reference Manual: 15.1.20.6 CHECK Constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html)
- [MySQL 8.4 Reference Manual: 17.6.5 Redo Log — #innodb_redo & Capacity Sizing](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- [MySQL 8.4 Reference Manual: 17.6.6 Undo Logs & Undo Tablespaces](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html)
- [MySQL 8.4 Reference Manual: 17.18.2 InnoDB Recovery](https://dev.mysql.com/doc/refman/8.4/en/innodb-recovery.html)
