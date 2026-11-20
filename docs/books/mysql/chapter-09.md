---
title: 第 9 章 事务隔离级别与 MVCC 多版本并发控制
description: 厘清四类并发一致性异常与隔离级别矩阵，深入剖析版本链、ReadView 四步可见性算法、RC/RR 快照差异与混合读写幻读边界。
---

# 第 9 章 事务隔离级别与 MVCC 多版本并发控制

## 本章要点

多个客户端并发读写同一份数据时，若对每条读写请求都施加严格串行排队，数据库吞吐量将急剧跌落；若完全放任无锁并发，业务又会遭遇脏写、脏读、不可重复读与幻读等一致性破坏。如何在隔离强度与并发吞吐之间取得平衡，正是事务隔离机制要解决的核心矛盾。

本章首先厘清四类并发一致性异常的严重程度阶梯，对比 SQL 标准与 MySQL InnoDB 在四种隔离级别下的行为差异及配置作用域；随后深入拆解 InnoDB 实现读写互不阻塞的核心基石——**多版本并发控制**（MVCC），剖析聚簇索引版本链与 `ReadView` 四步可见性判定算法，揭示 `READ COMMITTED` 与 `REPEATABLE READ` 在快照生成时机上的唯一本质差异及二级索引可见性校验路径；最后结合 `purge` 清理边界分析长事务隐患，并通过 MySQL 8.4 实测完整还原 `REPEATABLE READ` 下混合读写触发“幻影行浮现”的边界特例与规避规范。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 9.1 四类并发异常与隔离级别矩阵 {#ch9-1}

当并发事务同时访问相同范围的记录时，若缺乏隔离控制，按数据受损严重程度从高到低依次可能出现四类异常现象：

| 并发异常 | 英文术语 | 触发时序与破坏后果 | 严重等级 |
| --- | --- | --- | --- |
| **脏写** | Dirty Write | 事务 `T1` 覆写了未提交事务 `T2` 已修改的记录；若 `T2` 随后回滚，会把 `T1` 已提交的更新一并抹除，造成静默数据丢失 | 最高——所有级别均借行锁严禁发生 |
| **脏读** | Dirty Read | `T1` 读取了 `T2` 已修改但尚未提交的记录；若 `T2` 随后回滚，`T1` 读到的便是逻辑上从未存在过的伪数据 | 高 |
| **不可重复读** | Non-Repeatable Read | `T1` 以相同条件多次读取同一记录，因并发事务 `T2` 修改该记录并提交，导致 `T1` 前后读到不同的列值 | 中 |
| **幻读** | Phantom Read | `T1` 以相同条件多次范围查询，因并发事务 `T2` 插入符合条件的新记录并提交，导致 `T1` 后续读出先前不存在的“幻影行” | 低 |

这里需厘清一个高频概念边界：若并发事务 `T2` **删除**了符合条件的记录并提交，导致 `T1` 再次查询时结果集行数变少，从标准定义看属于单条已知记录状态改变引发的**不可重复读**，而非幻读；幻读特指结果集中冒出先前不存在的新增记录。

SQL 标准定义了四种隔离级别以划定上述异常的容忍下限，而 MySQL InnoDB 引擎在默认级别上提供了超越标准的一致性保障：

| 隔离级别 | 脏写 | 脏读 | 不可重复读 | 幻读（SQL 标准） | MySQL InnoDB 实际行为与底层实现机制 |
| --- | --- | --- | --- | --- | --- |
| `READ UNCOMMITTED` | 禁止 | 可能 | 可能 | 可能 | 普通 `SELECT` 直接读取聚簇索引最新版本，无快照开销但破坏业务一致性 |
| `READ COMMITTED` | 禁止 | 禁止 | 可能 | 可能 | 每次普通 `SELECT` 重新创建独立 `ReadView`，仅读取语句开始前已提交版本 |
| `REPEATABLE READ`（默认） | 禁止 | 禁止 | 禁止 | 可能 | **绝大部分场景已消除幻读**：快照读复用首个 `ReadView`，锁定读加 `Next-Key` 锁；仅混合读写特例（见[9.4 节](#ch9-4)）会浮现新行 |
| `SERIALIZABLE` | 禁止 | 禁止 | 禁止 | 禁止 | `autocommit = 0` 时普通 `SELECT` 自动转为 `FOR SHARE` 加锁读；`autocommit = 1` 单语句只读仍走无锁快照 |

运行时可通过 `SET [GLOBAL | SESSION] TRANSACTION ISOLATION LEVEL <level>` 动态调整隔离级别，其中 `<level>` 支持 `READ UNCOMMITTED`、`READ COMMITTED`、`REPEATABLE READ`、`SERIALIZABLE` 四种空格分隔写法；三种作用域的生效边界截然不同：

| 配置语法 | 对当前会话影响 | 对新建立会话影响 | 关键使用限制 |
| --- | --- | --- | --- |
| `SET GLOBAL TRANSACTION ...` | 不影响已有会话 | 新连接继承新全局值 | 需 `CONNECTION_ADMIN`（或已弃用的 `SUPER`）权限 |
| `SET SESSION TRANSACTION ...` | 更新当前会话**后续**事务默认值，**不影响当前已开启的活跃事务** | 不影响其他会话 | **允许在活跃事务内执行**；注意此时查询 `@@session.transaction_isolation` 已返回新值，但并不代表当前事务已切换 |
| `SET TRANSACTION ...`（省略作用域） | **仅对当前会话下一个尚未开启的事务生效一次**，结束后自动恢复原会话值 | 不影响其他会话 | **不得在已开启的活跃事务内执行**，否则报 `ERROR 1568 (25001)` |

查看当前隔离级别应读取系统变量 `@@transaction_isolation`，注意变量值采用连字符写法如 `REPEATABLE-READ`。以下在 MySQL 8.4.13 上验证不带作用域关键字的单次事务覆盖行为：

```sql
SELECT @@global.transaction_isolation, @@session.transaction_isolation;
-- 输出：REPEATABLE-READ, REPEATABLE-READ

-- 省略 SESSION/GLOBAL：仅让紧随其后的单个事务以 READ COMMITTED 运行
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;
SELECT * FROM iso_t WHERE id = 1; -- 本事务内每次 SELECT 重建 ReadView
COMMIT;

-- 下一个事务自动恢复为会话默认的 REPEATABLE-READ，无需手动还原
BEGIN;
SELECT * FROM iso_t WHERE id = 1; -- 已恢复为复用首个 ReadView
COMMIT;
```

> [!WARNING]
> **系统变量废弃移除提示**：原书及早期资料常用的旧变量名 `tx_isolation` 已在 MySQL 8.0.3 中彻底移除。在 MySQL 8.4 中执行 `SELECT @@tx_isolation;` 会直接报错 `ERROR 1193 (HY000): Unknown system variable 'tx_isolation'`，升级老旧客户端连接池探活脚本时务必替换为 `transaction_isolation`。

## 9.2 MVCC 核心架构：版本链与 ReadView 四步可见性算法 {#ch9-2}

**MVCC**——即 Multi-Version Concurrency Control（多版本并发控制）——其核心目标是在 `READ COMMITTED` 与 `REPEATABLE READ` 两种隔离级别下，让不加锁的普通 `SELECT`——又称**快照读**或**一致性无锁读**——无需等待记录上的排他锁即可安全读取历史快照版本，从而实现**写不阻塞读、读也不阻塞写**。相比之下，`READ UNCOMMITTED` 直接读取最新记录无需版本回溯，而 `SERIALIZABLE` 在显式事务中退化为加锁读，详见[10.1 节](./chapter-10#ch10-1)。

### 9.2.1 聚簇索引隐藏列与 Undo 版本链 {#ch9-2-1}

如[2.1.1 节](./chapter-02#ch2-1-1)与[8.3 节](./chapter-08#ch8-3)所述，每条聚簇索引记录都包含两个驱动 MVCC 的隐藏列：

- `DB_TRX_ID`（`6` 字节）：最后一次插入或修改该记录的读写事务 ID。
- `DB_ROLL_PTR`（`7` 字节）：回滚指针，指向本次修改前生成的 Undo 日志记录。

每当读写事务更新聚簇索引记录时，都会先将旧版本列值、旧 `DB_TRX_ID` 与旧 `DB_ROLL_PTR` 写入一条 Undo 日志，再原地或重建更新数据页上的最新记录，并令最新记录的 `DB_ROLL_PTR` 指向刚生成的 Undo 日志。多次更新后，数据页上的最新记录作为链头，通过 `roll_pointer` 单向串联起按时间倒序排列的**历史版本链**。例如主键 `number = 1` 的记录依次被事务 `80` 插入、事务 `105` 和 `120` 修改后，版本链形态如下：

```text
[聚簇索引数据页最新记录]
  number=1, name='张飞', country='蜀', trx_id=120, roll_ptr ──┐
                                                             ▼
[Undo Log 版本 V2]
  number=1, name='关羽', country='蜀', trx_id=105, roll_ptr ──┐
                                                             ▼
[Undo Log 初始版本 V1]
  number=1, name='刘备', country='蜀', trx_id=80,  roll_ptr = NULL (INSERT Undo)
```

### 9.2.2 ReadView 四大字段与四步可见性算法 {#ch9-2-2}

面对同一条版本链，快照读究竟该采纳哪一版数据，取决于查询持有的**一致性读视图**（`ReadView`）。每个 `ReadView` 在创建瞬间固化以下四个核心元数据字段：

| `ReadView` 字段 | 源码对应成员 | 精确语义与易错边界 |
| --- | --- | --- |
| `m_ids` | `m_ids` | 生成 `ReadView` 瞬间，系统中**活跃未提交的读写事务 ID 有序列表**——仅含已分配非零 `trx_id` 的事务 |
| `min_trx_id` | `m_up_limit_id` | 生成瞬间 `m_ids` 中的最小值；凡 `< min_trx_id` 的事务必定早已提交；若 `m_ids` 为空则等于 `max_trx_id` |
| `max_trx_id` | `m_low_limit_id` | 生成瞬间系统**即将分配给下一个读写事务的 ID**——**绝非 `m_ids` 的最大值**！若 `trx 105` 创建后迅速提交而 `80, 100` 仍未提交，则 `m_ids = [80, 100]`，但 `max_trx_id = 106` |
| `creator_trx_id` | `m_creator_trx_id` | 创建该 `ReadView` 的事务自身 ID；纯只读事务因惰性分配规则未领真实 ID，故初始恒为 **`0`** |

关于 `creator_trx_id = 0` 有一个可实测验证的细节：开启事务后仅执行普通 `SELECT` 时，查询 `information_schema.INNODB_TRX` 会看到类似 `405154356199424` 的巨大十进制 `trx_id`——这并非真实的全局事务号，而是 InnoDB 为只读事务用内存结构体指针拼接高位标记生成的虚拟展示号；其内核 `ReadView.creator_trx_id` 依然是 `0`，直至事务首次执行真正改动数据的写语句时，才领用真实的递增 `trx_id` 并同步写入 `creator_trx_id`。

拿到版本链头部记录的 `DB_TRX_ID`（记为 `trx_id`）后，InnoDB 严格按以下**四步决策表**判断该版本对当前 `ReadView` 是否可见：

| 判定步序 | 比较条件 | 可见性结论 | 底层因果依据 |
| --- | --- | --- | --- |
| 第 1 步 | `trx_id == creator_trx_id` | **可见** | 当前事务正在读取自己先前修改的记录；只读事务 `creator_trx_id = 0` 必不命中此步 |
| 第 2 步 | `trx_id < min_trx_id` | **可见** | 生成该版本数据的事务在当前 `ReadView` 创建前早已提交 |
| 第 3 步 | `trx_id ≥ max_trx_id` | **不可见** | 生成该版本数据的事务在当前 `ReadView` 创建之后才开启 |
| 第 4 步 | `min_trx_id ≤ trx_id < max_trx_id` | **在 `m_ids` 中：不可见**<br>**不在 `m_ids` 中：可见** | 在有序列表 `m_ids` 中二分查找：命中说明拍快照时该事务仍未提交；未命中说明拍快照前已提交 |

**版本链回溯与删除标记处理**：若当前版本经上述四步判定为**不可见**，InnoDB 便顺着 `DB_ROLL_PTR` 取出下一个历史 Undo 版本，用其 `trx_id` 重新执行四步判定，直至找到**第一个可见版本**为止；若遍历至链尾仍无可见版本，则该记录对当前查询完全不存在。反之，一旦定位到首个可见版本，还需检查其记录头信息中的 `deleted_flag` 位：若 `deleted_flag = 1`，说明该记录在快照时刻已被逻辑删除但尚未被 `purge` 物理清除，同样直接跳过不返回给客户端。

## 9.3 RC 与 RR 快照时机对比及二级索引可见性判断 {#ch9-3}

`READ COMMITTED` 与 `REPEATABLE READ` 共用完全相同的版本链与 `ReadView` 四步判定算法，二者在 MVCC 层面的**唯一核心差异**在于**生成 `ReadView` 的时机**：

- **`READ COMMITTED`**：**每次执行普通 `SELECT` 前，都会重新生成一个全新的 `ReadView`**。因此两次查询之间只要其他读写事务完成了提交，其 `trx_id` 就会从新 `ReadView` 的 `m_ids` 中消失或落入 `< min_trx_id` 区间，修改结果立刻对后一次 `SELECT` 可见，这正是不可重复读与幻读产生的根源。
- **`REPEATABLE READ`**：**仅在事务内第一次执行普通 `SELECT` 时生成一个 `ReadView`**，此后直至事务结束前的所有普通 `SELECT` 一律复用该 `ReadView`。

使用 `REPEATABLE READ` 时务必区分两种事务启动语句的快照起点差异（详见[8.1 节](./chapter-08#ch8-1)）：普通 `BEGIN` 或 `START TRANSACTION` 采用延迟快照策略，在事务真正发出**第一条普通 `SELECT`** 时才创建 `ReadView`；若要求在开启事务瞬间立刻冻结快照，必须执行 **`START TRANSACTION WITH CONSISTENT SNAPSHOT`**。双会话实测对比如下：

```sql
-- 初始状态：iso_t 表含 (1, 100)
S1> BEGIN;                                          -- 仅标记事务边界，尚未生成 ReadView
S2> START TRANSACTION WITH CONSISTENT SNAPSHOT;     -- 立即生成并固化 ReadView (v = 100)

-- 此时并发会话 S3 更新该行并立即提交
S3> UPDATE iso_t SET v = 200 WHERE id = 1;

S1> SELECT v FROM iso_t WHERE id = 1;               -- 返回 200（此刻才首次生成 ReadView！）
S2> SELECT v FROM iso_t WHERE id = 1;               -- 返回 100（复用启动瞬间固化的 ReadView）
```

### 9.3.1 多事务并发读写时序全景推演 {#ch9-3-1}

设表 `mvcc_hero(number PK, name, country)` 初始仅含已提交事务 `trx 50` 插入的一行 `(1, '刘备', '蜀')`。现有两个并发写事务 `T1 (trx_id = 100)`、`T2 (trx_id = 200)` 与两个只读观察事务 `T3`（`READ COMMITTED`）、`T4`（`REPEATABLE READ`），按时间轴 `t1 → t5` 交错执行的完整推演如下：

| 时刻 | 执行动作 | 聚簇版本链（新 → 旧） | `T3 (RC)` 的 `ReadView` 与结果 | `T4 (RR)` 的 `ReadView` 与结果 |
| --- | --- | --- | --- | --- |
| `t1` | `T1(100)` 将 `name` 改为 `'关羽'`，再改为 `'张飞'`（未提交）；`T2(200)` 开启并修改其他行（未提交） | `'张飞'(100) → '关羽'(100) → '刘备'(50)` | — | — |
| `t2` | `T3` 与 `T4` 各自执行第 1 次 `SELECT name WHERE number = 1` | 同上 | 新建视图：`m_ids=[100,200], min=100, max=201, creator=0`；`100` 在 `m_ids` 不可见，回溯至 `50 < 100`，返回 **`'刘备'`** | 新建并固化视图：`m_ids=[100,200], min=100, max=201, creator=0`；同左返回 **`'刘备'`** |
| `t3` | `T1(100)` 执行 `COMMIT`；`T2(200)` 将 `number = 1` 的 `name` 依次改为 `'赵云'`、`'诸葛亮'`（未提交） | `'诸葛亮'(200) → '赵云'(200) → '张飞'(100) → '关羽'(100) → '刘备'(50)` | — | — |
| `t4` | `T3` 与 `T4` 各自执行第 2 次 `SELECT name WHERE number = 1` | 同上 | **重建新视图**：`m_ids=[200], min=200, max=201`；`200` 不可见，回溯至 `'张飞'(100) < 200`，返回 **`'张飞'`** | **复用 `t2` 旧视图**：`m_ids=[100,200]`；`200` 与 `100` 均命中旧 `m_ids` 不可见，一路回溯至 `50`，仍返回 **`'刘备'`** |
| `t5` | `T2(200)` 执行 `COMMIT` 后，`T3` 与 `T4` 执行第 3 次查询 | 同上 | **重建新视图**：`m_ids=[], min=201, max=201`；`200 < 201` 直接可见，返回 **`'诸葛亮'`** | **复用 `t2` 旧视图**：`200` 仍在旧 `m_ids` 内不可见，始终稳定返回 **`'刘备'`** |

### 9.3.2 二级索引页面的 MVCC 可见性判断 {#ch9-3-2}

只有聚簇索引记录才存储 `DB_TRX_ID` 和 `DB_ROLL_PTR` 隐藏列；二级索引记录仅保存索引列值、主键值及记录头信息（见[4.1 节](./chapter-04#ch4-1)）。当查询走二级索引——尤其是无需回表的覆盖索引扫描（`Extra: Using index`）——时，InnoDB 借助二级索引数据页 `Page Header` 中的 **`PAGE_MAX_TRX_ID`** 字段（即修改过该页的最大 `trx_id`）分两级完成可见性校验：

1. **页级快速放行路径**——满足 `PAGE_MAX_TRX_ID < ReadView.min_trx_id`：表明曾改动过该二级索引页面的所有事务，在当前 `ReadView` 生成前早已全部提交！因此页内所有 `deleted_flag = 0` 的二级索引记录对当前快照必然可见，`deleted_flag = 1` 的记录必然已删除，覆盖索引可直接返回索引列值，零回表开销。
2. **回表版本链核验路径**——满足 `PAGE_MAX_TRX_ID ≥ ReadView.min_trx_id`：表明该页近期曾被未提交或快照后的事务改动过，单凭二级索引无法判断真伪。此时即便是覆盖索引查询，InnoDB 也必须携带记录中的主键值**回表查找聚簇索引**，沿聚簇索引版本链定位首个对当前 `ReadView` 可见的历史版本，再核对该可见历史版本中的二级索引列值是否与刚才扫描到的二级索引记录一致——若一致则返回，不一致则说明该键值由不可见事务写入，直接跳过。

## 9.4 Purge 清理边界、长事务危害与 RR 混合读写幻读特例 {#ch9-4}

### 9.4.1 提交序号 trx_no、History List 与长事务四大危害 {#ch9-4-1}

如[8.3 节](./chapter-08#ch8-3)所述，`DELETE` 语句第一阶段仅将记录头 `deleted_flag` 置为 `1`（`delete mark`），且 `UPDATE` / `DELETE` 产生的 Undo 日志在事务提交时不能像 `INSERT` Undo 那样立刻丢弃——因为其他并发会话的旧 `ReadView` 可能仍需顺着版本链读取这些历史记录。

为精确界定哪些 Undo 日志和删除标记记录已彻底无人需要，InnoDB 为每个提交的读写事务按提交先后分配一个单调递增的**提交序号 `trx_no`**，并将其产生的更新类 Undo 日志按 `trx_no` 顺序挂入全局 **`History list`**（历史链表）。每个 `ReadView` 在创建时，除了记录事务 ID 边界，还会记录此刻系统已生成的最大提交序号。后台 **`purge` 清理线程**运行时，会取当前整个实例中**创建时间最早的活跃 `ReadView`** 作为安全水位线：只有所属事务满足 `trx_no < 最老活跃 ReadView 对应的 trx_no` 的 Undo 日志，才确保绝不会被任何现存或未来的 `ReadView` 访问，可被安全回收，对应的 `deleted_flag = 1` 记录也会从聚簇索引与二级索引页中物理抹除。

由此可见，线上哪怕只存在**一个**开启了 `REPEATABLE READ` 事务、执行过一条普通 `SELECT` 后便忘记提交的空闲连接——或者将耗时外部 RPC 与文件导出包裹在数据库事务内——最老 `ReadView` 就会被死死钉在数小时前，引发四大连锁故障：

1. **Undo 表空间暴涨**：`SHOW ENGINE INNODB STATUS` 输出的 `History list length`（待清理 Undo 组计数）从正常的数十飙升至数百万，导致 `undo_001` / `undo_002` 文件持续膨胀且无法触发在线截断；
2. **B+ 树空间碎片化**：大量已删除记录长期停留在 `delete mark` 状态无法物理清理，数据页空洞率攀升，范围扫描 I/O 放大；
3. **版本链遍历拖垮 CPU**：热点行版本链堆积数千层历史版本，其他短事务执行快照读时被迫顺着 `roll_pointer` 大量跳转比对，引发 CPU 毛刺与慢查询；
4. **锁与元数据阻塞风险**：该长事务同时持有涉及表的 Server 层 `MDL` 读锁，一旦遭遇在线 `ALTER TABLE` 就会阻塞全表所有后续查询（详见[10.1 节](./chapter-10#ch10-1)）。

生产环境中应监控 `History list length` 指标（常规 OLTP 宜低于 `1000`），并定期执行以下巡检 SQL 揪出未提交长事务：

```sql
SELECT
    trx_id, trx_mysql_thread_id AS thread_id, trx_state,
    TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec,
    trx_rows_locked, trx_rows_modified, trx_query
FROM information_schema.INNODB_TRX
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) >= 30
ORDER BY duration_sec DESC;
```

### 9.4.2 RR 混合读写引发“幻影行浮现”的边界特例 {#ch9-4-2}

前文指出，`REPEATABLE READ` 在**纯快照读**下依靠复用首个 `ReadView` 屏蔽新插入记录，在**纯锁定读**下依靠 `Next-Key` 锁阻止并发插入。但若同一事务先执行不加锁的普通 `SELECT`，中途并发事务插入了新行并提交，随后原事务又对该新行执行了 `UPDATE` 或 `DELETE`，就会触发经典的**幻影行浮现**特例。以下为基于三行初始数据 `{1, 8, 20}` 在 MySQL 8.4.13 上的完整实测时序：

```sql
-- T1（默认 REPEATABLE READ）：开启事务并执行首次快照读
T1> BEGIN;
T1> SELECT * FROM mvcc_hero WHERE number > 10;
-- 返回：(20, '孙权', '吴') 仅 1 行；此时生成 ReadView，creator_trx_id = 0

-- T2：并发插入主键 30 的新记录并自动提交（T1 首读未加间隙锁，T2 畅通无阻）
T2> INSERT INTO mvcc_hero VALUES (30, '司马懿', '晋');

-- T1：再次执行普通快照读，因 30 的 trx_id ≥ T1.max_trx_id，依然不可见（无幻读）
T1> SELECT * FROM mvcc_hero WHERE number > 10;
-- 返回：(20, '孙权', '吴') 仅 1 行

-- T1：关键转折！对整段条件或 number = 30 执行 UPDATE（当前读）
T1> UPDATE mvcc_hero SET country = '西晋' WHERE number = 30;
-- 输出：Query OK, 1 row affected, Rows matched: 1  Changed: 1

-- T1：第 3 次执行相同的普通快照读！
T1> SELECT * FROM mvcc_hero WHERE number > 10;
-- 返回：(20, '孙权', '吴') 与 (30, '司马懿', '西晋') 共 2 行！幻影行 30 凭空浮现！
T1> COMMIT;
```

这一现象的底层根因完全符合 [9.2.2 节](#ch9-2-2)的四步可见性规则：

1. `UPDATE`、`DELETE` 属于**当前读**（Current Read），不走 `ReadView`，而是直接定位并锁定聚簇索引上最新已提交的 `(30, '司马懿', '晋')` 记录；
2. `T1` 首次真正修改数据，InnoDB 为其分配真实的非零读写事务 ID（记为 `trx_T1`），同步将 `T1` 自身 `ReadView.creator_trx_id` 更新为 `trx_T1`，并将 `number = 30` 最新记录的隐藏列 `DB_TRX_ID` 覆写为 `trx_T1`，旧版本 `'晋'` 挂入 Undo 链；
3. 当 `T1` 第 3 次执行普通 `SELECT` 扫描到 `number = 30` 时，检查其 `DB_TRX_ID == creator_trx_id`（均为 `trx_T1`），在四步可见性算法的**第 1 步**即直接判定为**可见**，于是原先对快照隐身的记录就此暴露。

**工程规避准则**：在 `REPEATABLE READ` 下，凡是事务后续需要根据前置查询结果对同一范围做状态变更或防重校验，**切勿先用普通 `SELECT` 探路再裸写 `UPDATE` / `INSERT`**，而应从第一条读取语句起就显式使用 `SELECT ... FOR UPDATE` 或 `FOR SHARE` 锁住目标记录及间隙，或者直接依托唯一索引执行原子写入。

## 练习 {#ch9-exercises}

以下 2 道练习检验 `ReadView` 四步可见性算法的精确推演能力，以及 `REPEATABLE READ` 混合读写幻读边界的分析与修复。假设所有测试表均采用 InnoDB 引擎，未显式开启事务的语句均在 `autocommit = 1` 下自动提交。建议先独立推演作答，再展开参考答案核对。

### 练习 1：基于四事务交错时序推导 `RC` 与 `RR` 快照结果

表 `account(id INT PRIMARY KEY, balance INT)` 初始包含已提交事务 `trx_id = 40` 插入的一行 `(1, 1000)`。现有四个读写事务与两个只读查询会话——`Q_rc` 采用 `READ COMMITTED` 级别、`Q_rr` 采用 `REPEATABLE READ` 级别——按以下严格先后次序执行：

1. `T1` 开启并执行 `UPDATE account SET balance = 900 WHERE id = 1;`，分配 `trx_id = 60`，未提交；
2. `T2` 开启并修改表中 `id = 2` 的其他记录，分配 `trx_id = 75`，随后立即执行 `COMMIT`；
3. `T3` 开启并修改表中 `id = 3` 的其他记录，分配 `trx_id = 80`，未提交；
4. **观测点 A**：`Q_rc` 与 `Q_rr` 均执行 `BEGIN; SELECT balance FROM account WHERE id = 1;`；
5. `T1 (60)` 执行 `COMMIT`；紧接着 `T4` 开启并执行 `UPDATE account SET balance = 500 WHERE id = 1;`，分配 `trx_id = 90` 后立即 `COMMIT`，此时 `T3 (80)` 仍未提交；
6. **观测点 B**：`Q_rc` 与 `Q_rr` 再次执行 `SELECT balance FROM account WHERE id = 1;`。

请分别写出在**观测点 A** 与**观测点 B** 时，`Q_rc` 和 `Q_rr` 各自所持 `ReadView` 的四个核心字段值——即 `m_ids`、`min_trx_id`、`max_trx_id` 与 `creator_trx_id`，并推导每次查询返回的 `balance` 数值及四步法命中步骤。

<details>
<summary>查看参考答案</summary>

1. **观测点 A**：此时系统已分配过的最大事务 ID 为 `80`，其中 `T1 (60)` 与 `T3 (80)` 活跃未提交，而 `T2 (75)` 已提交；`Q_rc` 与 `Q_rr` 均为纯只读事务，各自首次生成完全相同的 `ReadView`：
   - 核心字段：`m_ids = [60, 80]`，`min_trx_id = 60`，`max_trx_id = 81`（下一个待分配 ID），`creator_trx_id = 0`。
   - 版本链形态：`balance = 900 (trx_id = 60) → balance = 1000 (trx_id = 40)`。
   - 判定过程：检查链头 `trx_id = 60`，不等于 `creator_trx_id (0)`，落入 `60 ≤ trx_id < 81`（第 4 步）且 `60` 在 `m_ids` 中，判定**不可见**；顺 `roll_pointer` 回溯至 `trx_id = 40`，满足 `40 < min_trx_id (60)`（第 2 步），判定**可见**。因此观测点 A 处 **`Q_rc` 与 `Q_rr` 均返回 `1000`**。顺带指出：若此时查询 `T2 (75)` 修改的 `id = 2`，因 `75` 落入 `[60, 81)` 但不在 `m_ids` 中，经第 4 步判定为可见。

2. **观测点 B**：此时 `T1 (60)` 与 `T4 (90)` 均已提交，仅 `T3 (80)` 仍活跃未提交；`id = 1` 的版本链变为 `500 (trx_id = 90) → 900 (trx_id = 60) → 1000 (trx_id = 40)`：
   - **`Q_rc`**（重建新视图）：`m_ids = [80]`，`min_trx_id = 80`，`max_trx_id = 91`，`creator_trx_id = 0`——注意尽管 `m_ids` 最大值仅为 `80`，但系统已分配过 `90`，故 `max_trx_id` 必为 `91`！检查链头 `trx_id = 90`：落入 `80 ≤ 90 < 91`（第 4 步）且 `90` **不在 `m_ids` 中**，判定**可见**，直接返回 **`500`**。
   - **`Q_rr`**（复用旧视图）：仍保持观测点 A 的 `m_ids = [60, 80]`、`min_trx_id = 60`、`max_trx_id = 81`、`creator_trx_id = 0`。检查链头 `trx_id = 90 ≥ 81`（第 3 步不可见）→ 回溯至 `trx_id = 60`（命中旧 `m_ids`，第 4 步不可见）→ 回溯至 `trx_id = 40 < 60`（第 2 步可见），依然稳定返回 **`1000`**。

</details>

### 练习 2：诊断并修复 `RR` 领券核销流程中的幻影行异常

某营销系统领券表定义为 `CREATE TABLE coupon_claim (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL, status TINYINT NOT NULL, INDEX idx_user (user_id));`，其中 `status = 0` 表示未核销、`1` 表示已核销。后台客服补偿脚本在默认 `REPEATABLE READ` 下执行如下事务逻辑：

```sql
BEGIN;
-- 步骤 1：先查询该用户是否已有领券记录
SELECT id, status FROM coupon_claim WHERE user_id = 888;
-- 查得 Empty set 后，脚本原本准备插入，却误先执行了一条兜底状态修正语句：
UPDATE coupon_claim SET status = 1 WHERE user_id = 888;
-- 步骤 3：再次核对并准备生成审计报表
SELECT id, status FROM coupon_claim WHERE user_id = 888;
COMMIT;
```

线上偶发异常：步骤 1 查询返回 `0` 行，但紧接着步骤 3 却查出了 `1` 行 `(id = 5001, status = 1)`。请解释：(1) 该异常在 `REPEATABLE READ` 下发生的具体并发时序与 MVCC 机制原因；(2) 在保持 `REPEATABLE READ` 不变的前提下，给出两种消除该一致性漏洞的工程改写方案。

<details>
<summary>查看参考答案</summary>

1. **并发时序与机制根因**：
   - 步骤 1 执行普通无锁 `SELECT`，创建 `ReadView`（`creator_trx_id = 0`），此时未对 `idx_user` 上 `user_id = 888` 所在间隙加任何锁；
   - 在步骤 1 与 `UPDATE` 之间的极短窗口内，用户端并发请求成功执行了 `INSERT INTO coupon_claim VALUES (5001, 888, 0)` 并提交；
   - 客服事务随后的 `UPDATE ... WHERE user_id = 888` 执行**当前读**，命中刚提交的 `id = 5001`，为客服事务分配真实读写 `trx_id` 同步赋给 `creator_trx_id`，并将 `id = 5001` 的 `DB_TRX_ID` 改写为客服事务自身 ID；
   - 步骤 3 再次执行普通 `SELECT` 时，因 `id = 5001` 的 `DB_TRX_ID == creator_trx_id` 命中可见性第 1 步，新记录穿透原快照浮现。

2. **两种工程修复方案**：
   - **方案一**——每用户限领一张券时升级唯一约束：将普通索引 `INDEX idx_user (user_id)` 升级为 `UNIQUE KEY uk_user (user_id)`，无需“先查再写”，直接通过单条原子语句 `INSERT INTO coupon_claim (id, user_id, status) VALUES (..., 888, 1) ON DUPLICATE KEY UPDATE status = 1;` 完成幂等写入与状态修正，彻底消除读写拆分竞态。
   - **方案二**——允许同用户多张券时首读显式加锁：将步骤 1 改为显式锁定读 `SELECT id, status FROM coupon_claim WHERE user_id = 888 FOR UPDATE;`。在 `REPEATABLE READ` 下，InnoDB 会在 `idx_user` 索引上对 `888` 落点的开区间施加间隙锁（`X,GAP`），直接阻塞外部并发插入 `user_id = 888` 的记录直至本事务提交，保证整个事务周期内读写视图严格一致。

</details>

## 面试题 {#ch9-interview}

以下 3 道面试题聚焦 `ReadView` 参数误区、`RC` / `RR` 快照机制本质差异与二级索引 MVCC 原理。代码与环境约定同[练习部分](#ch9-exercises)，建议先独立组织语言作答再展开核对。

### 面试题 1：`ReadView` 中的 `max_trx_id` 等于活跃读写事务列表 `m_ids` 中的最大值吗？为什么这样设计？

<details>
<summary>查看参考答案</summary>

**不等于**。`max_trx_id`（源码成员 `m_low_limit_id`）记录的是生成 `ReadView` 瞬间，InnoDB 全局事务系统**即将分配给下一个读写事务的 ID**，而非 `m_ids` 列表的最大值。

**原因**：事务开启的先后顺序（`trx_id` 递增顺序）与事务提交的快慢顺序并不一致。假设事务 `100` 开启后长期未提交，紧接着开启的短事务 `105` 瞬间完成了修改并提交，随后某会话创建 `ReadView`：此时活跃未提交列表 `m_ids` 仅包含 `[100]`（最大值为 `100`），而系统下一个待分配事务号 `max_trx_id` 为 `106`。倘若错误地把 `max_trx_id` 设为 `max(m_ids) = 100` 或 `101`，那么早已正常提交的事务 `105` 就会因满足 `trx_id ≥ max_trx_id` 被第 3 步误判为“快照生成后才开启的不可见事务”，导致已提交数据神秘不可见。

</details>

### 面试题 2：`READ COMMITTED` 与 `REPEATABLE READ` 在底层 MVCC 实现上有什么区别？在 `RR` 下执行 `BEGIN` 后，快照立刻就固定了吗？

<details>
<summary>查看参考答案</summary>

1. **MVCC 唯一核心区别在于生成 `ReadView` 的频率与时机**：两者复用完全相同的聚簇索引版本链与四步可见性判定逻辑；`READ COMMITTED` 在**每一次普通 `SELECT` 执行前都重新生成新的 `ReadView`**，因此总能看到最新已提交结果；`REPEATABLE READ` **只在事务内第一次执行普通 `SELECT` 时生成 `ReadView`**，并在本事务后续所有普通 `SELECT` 中一直复用该视图。
2. **`BEGIN` 并不会立刻固定快照**：常规 `BEGIN` 或 `START TRANSACTION` 仅声明事务边界，直到发出**第一条普通 `SELECT`** 时才真正构造 `ReadView`；在 `BEGIN` 之后、首条 `SELECT` 之前由其他事务提交的数据，对该 `RR` 事务依然可见。只有显式执行 `START TRANSACTION WITH CONSISTENT SNAPSHOT;`，InnoDB 才会在语句执行瞬间立即创建并固化 `ReadView`。

</details>

### 面试题 3：MySQL 默认的 `REPEATABLE READ` 完全解决幻读了吗？另外，二级索引记录没有 `DB_TRX_ID` 隐藏列，执行覆盖索引查询时如何判断 MVCC 可见性？

<details>
<summary>查看参考答案</summary>

1. **绝大部分场景已消除，但在“先快照读、后当前写”混合场景下仍会浮现幻影行**：
   - 若全程仅执行普通 `SELECT`（快照读），依靠复用首个 `ReadView` 可屏蔽并发新插入记录；若从一开始就使用 `SELECT ... FOR UPDATE` / `FOR SHARE`（锁定读），InnoDB 通过 `Next-Key` 锁与 `Gap` 锁封锁扫描区间，直接阻止并发事务插入幻影行。
   - 但若事务 `T1` 先用普通无锁 `SELECT` 查询某区间，并发事务 `T2` 插入满足条件的新行并提交后，`T1` 又对该新行执行了 `UPDATE` 或 `DELETE`（当前读），就会同步分配自身事务 ID 更新 `creator_trx_id` 并将新行的 `DB_TRX_ID` 覆写为 `creator_trx_id`，导致 `T1` 后续普通 `SELECT` 通过可见性第 1 步看到这行原本不存在的新记录。
2. **二级索引覆盖查询的 MVCC 判定**：InnoDB 首先读取二级索引页头部的 `PAGE_MAX_TRX_ID`（修改过该页的最大事务 ID）。若 `PAGE_MAX_TRX_ID < ReadView.min_trx_id`，说明改动该页的全部事务在快照前均已提交，页内 `deleted_flag = 0` 的记录直接可见，无需回表；反之若 `PAGE_MAX_TRX_ID ≥ ReadView.min_trx_id`，则必须根据主键值回表查聚簇索引，沿版本链找到首个可见版本并核对二级索引列值一致后才返回。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: 17.7.2.1 Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.4 Reference Manual: 17.3 InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html)
- [MySQL 8.4 Reference Manual: 17.7.2.3 Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)
- [MySQL 8.4 Reference Manual: 17.8.9 Purge Configuration](https://dev.mysql.com/doc/refman/8.4/en/innodb-purge-configuration.html)
- [MySQL 8.4 Reference Manual: 15.3.7 SET TRANSACTION Statement](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html)
