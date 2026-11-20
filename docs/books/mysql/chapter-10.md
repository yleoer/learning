---
title: 第 10 章 InnoDB 锁机制、加锁规则与死锁诊断
description: 掌握表级意向锁、MDL 与五类 InnoDB 行锁原理，基于 MySQL 8.4 实测梳理 RC/RR 全场景加锁矩阵与 data_locks 死锁排障方法。
---

# 第 10 章 InnoDB 锁机制、加锁规则与死锁诊断

## 本章要点

MVCC 解决了普通查询“读写互不阻塞”的难题，但面对并发“写—写”竞争以及业务需要显式锁定读取范围的场景，数据库必须依靠严密的锁子系统来捍卫一致性。线上常见的慢查询雪崩、在线加字段卡死全表、高并发幂等插入死锁，归根结底都源于对 Server 层与 InnoDB 层锁粒度及加锁边界的误判。

本章从读取模式与多粒度表锁切入，剖析 `FOR SHARE` / `FOR UPDATE` 非阻塞修饰符、意向锁矩阵、Server 层 `MDL` 元数据锁与 `AUTO-INC` 自增锁在 MySQL 8.4 中的默认策略；随后拆解五类 InnoDB 行锁在 `performance_schema.data_locks` 中的精确标识与隐式锁惰性转换机制，基于 MySQL 8.4.13 实测给出 `RC` / `RR` 全场景语句加锁速查表及 8.0.18+ 唯一索引范围上界优化；最后落地 `data_locks` 实时锁观测与死锁日志诊断规范。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 10.1 读取模式、多粒度表锁与自增锁演进 {#ch10-1}

### 10.1.1 锁定读语法演进与非阻塞修饰符 {#ch10-1-1}

除[9.2 节](./chapter-09#ch9-2)介绍的一致性无锁读外，业务若需在读取阶段直接锁住目标记录以防止并发篡改，需使用**锁定读**（Locking Read）。自 MySQL 8.0 起，官方标准锁定读语法与锁等待控制修饰符如下表所示：

| 读取语法 | 加锁模式 | 行为特征与版本演进说明 |
| --- | --- | --- |
| `SELECT ... FOR SHARE` | 行级共享锁（`S`） | 允许并发事务继续读或加 `S` 锁，阻塞并发修改；**自 MySQL 8.0 起取代旧语法 `LOCK IN SHARE MODE`**，支持 `OF tbl` 指定多表连接中仅锁某张表 |
| `SELECT ... FOR UPDATE` | 行级排他锁（`X`） | 阻塞其他事务加 `S` 或 `X` 锁，直至当前事务提交或回滚 |
| `... FOR SHARE / UPDATE NOWAIT` | 非阻塞快速失败 | MySQL 8.0+ 新增：若目标行已被冲突锁占用，**零等待立即报错** `ERROR 3572 (HY000)`，防止热点行阻塞拖垮连接池 |
| `... FOR SHARE / UPDATE SKIP LOCKED` | 跳过已锁记录 | MySQL 8.0+ 新增：**自动跳过已被冲突锁占用的记录**，仅锁定并返回当前可立即获锁的记录，常用于数据库抢单与任务队列分发 |

补充 `SERIALIZABLE` 隔离级别下的普通 `SELECT` 规则：当 `autocommit = 0`（显式事务内）时，InnoDB 会自动将普通 `SELECT` 转化为 `SELECT ... FOR SHARE` 加锁读；而当 `autocommit = 1` 时，InnoDB 识别出单语句只读事务无需串行化锁保护，直接降级为无锁 MVCC 快照读，即使目标行正被其他未提交事务持有 `X` 锁也不会阻塞。

### 10.1.2 表级意向锁矩阵与 Server 层 MDL 元数据锁 {#ch10-1-2}

InnoDB 支持表锁与行锁并存的多粒度锁机制。倘若没有表级辅助标记，当某会话执行 `LOCK TABLES t WRITE` 申请表级 `S` 锁或 `X` 锁时，引擎不得不遍历整棵 B+ 树逐行检查是否存在冲突行锁。为此 InnoDB 引入了表级**意向共享锁**（`IS`）与**意向排他锁**（`IX`）：事务给任意记录加行级 `S` / `X` 锁前，必须先在表级别加上对应的 `IS` / `IX` 锁，使表锁冲突判定降为 `O(1)` 复杂度：

| 当前表已持有 \ 新申请 | `IS` | `IX` | `S` | `X` |
| --- | --- | --- | --- | --- |
| **`IS`** | 兼容 | 兼容 | 兼容 | 互斥 |
| **`IX`** | 兼容 | **兼容** | 互斥 | 互斥 |
| **`S`** | 兼容 | 互斥 | 兼容 | 互斥 |
| **`X`** | 互斥 | 互斥 | 互斥 | 互斥 |

注意：**`IS` 与 `IX`、`IX` 与 `IX` 之间完全兼容**——意向锁仅代表“某事务准备锁表内若干行”，绝不会阻塞其他事务并发读写不同行，仅用于拦截全表级 `S` / `X` 锁。

真正频繁在线上引发全表卡死事故的表级锁，其实是 MySQL Server 层自动维护的 **`MDL`**（元数据锁，Metadata Lock），可通过 `performance_schema.metadata_locks` 实时观测：

- 任何普通无锁 `SELECT` 及 DML 语句执行期间，都会自动申请并持有事务周期的 **`SHARED_READ` / `SHARED_WRITE` 读锁**，彼此互不阻塞；
- 执行 `ALTER TABLE`、`DROP TABLE` 等表结构变更时，在元数据切换阶段必须申请 **`EXCLUSIVE` 排他 MDL 写锁**，且 **MDL 等待队列对写锁赋予高优先级**！
- **线上雪崩链路**（MySQL 8.4 实测）：若会话 `M1` 开启事务执行了一条慢查询或漏提交空闲连接，长期握着 `SHARED_READ` 不放；此时运维在会话 `M2` 发起 `ALTER TABLE hero ADD COLUMN tmp_col INT;`，`M2` 因拿不到 `EXCLUSIVE` 锁进入 `PENDING` 状态；**此后所有新到达的普通无锁 `SELECT` 都会被排在 `M2` 之后统统陷入 `PENDING` 阻塞**，短短几秒即可耗尽全局 `max_connections`！因此生产执行 DDL 前必须先检查并清理 `information_schema.INNODB_TRX` 中的长事务。

### 10.1.3 AUTO-INC 自增锁与 MySQL 8.4 默认交错模式 {#ch10-1-3}

向含 `AUTO_INCREMENT` 列的表插入数据时，InnoDB 通过系统变量 `innodb_autoinc_lock_mode` 控制自增值分配锁粒度：

| 参数取值 | 模式名称 | 加锁机制与自增 ID 连续性特征 | 版本默认策略 |
| --- | --- | --- | --- |
| `0` | 传统模式（Traditional） | 所有 `INSERT` 均申请语句级表锁 `AUTO-INC`——语句结束即释放，不等事务提交 | 历史兼容模式 |
| `1` | 连续模式（Consecutive） | 行数已知的简单 `INSERT` 仅用轻量互斥量原子递增；行数未知的批量 `INSERT ... SELECT` 仍加表级 `AUTO-INC` 锁以保证单语句内 ID 连续 | MySQL 5.7 默认值 |
| **`2`** | **交错模式**（Interleaved） | **所有类型的插入一律不加表级 `AUTO-INC` 锁**，多条批量插入可交错分配 ID，并发吞吐最高；多语句并发或回滚时允许 ID 出现空洞 | **MySQL 8.0 / 8.4 默认值** |

MySQL 8.0 与 8.4 将默认值切换为 `2` 的前提，是二进制日志已全面默认采用基于行的 `ROW` 格式回放，主从复制不再依赖批量插入自增 ID 的连续分配；在 MySQL 8.4 中，`binlog_format` 系统变量更已被正式标记为废弃——读取或设置均触发 `Warning 1287` 预告未来版本移除。

## 10.2 InnoDB 五类行锁原理与隐式锁惰性转换 {#ch10-2}

**InnoDB 行锁的本质是加在索引记录上的锁**（Index Record Lock）——锁定聚簇索引记录或二级索引记录本身及其前方的键值间隙。在 MySQL 8.0 / 8.4 的标准观测表 `performance_schema.data_locks` 中，五类行锁的 `LOCK_MODE` 精确表示与相容性规则汇总如下：

| 行锁类型 | `data_locks.LOCK_MODE` 实测值 | 锁定区间形态 | 相容性与核心设计意图 |
| --- | --- | --- | --- |
| **记录锁**（Record Lock） | `X,REC_NOT_GAP` / `S,REC_NOT_GAP` | 单条索引记录本身 `[curr]` | 仅 `S` 与 `S` 兼容，其余互斥；精准锁定已存在的单条记录 |
| **间隙锁**（Gap Lock） | `X,GAP` / `S,GAP` | 当前记录前方的开区间 `(prev, curr)` | **`S,GAP` 与 `X,GAP`、`X,GAP` 与 `X,GAP` 之间 100% 互相兼容**！既不锁记录本身，也不阻塞其他间隙锁，唯一作用是阻挡向该开区间插入新记录 |
| **临键锁**（Next-Key Lock） | **裸 `X` 或裸 `S`**（无后缀！） | 左开右闭区间 `(prev, curr]`；加在 `supremum pseudo-record` 上锁 `(max, +∞)` | 记录锁与间隙锁的组合体，`REPEATABLE READ` 默认加锁单位，兼顾单行互斥与防幻读 |
| **插入意向锁**（Insert Intention Lock） | 普通记录：`X,GAP,INSERT_INTENTION`<br>`Supremum`：`X,INSERT_INTENTION` | 待插入键值落入的开区间 `(prev, curr)` | `INSERT` 被已有 `Gap` / `Next-Key` 锁阻塞时生成的等待态间隙锁；**多个插入意向锁之间彼此完全兼容**，允许并发向同一间隙插入不同键值 |
| **隐式锁**（Implicit Lock） | 无冲突时**不产生记录锁行**；冲突时物化为 `X,REC_NOT_GAP` | 新插入的聚簇或二级索引记录 | 惰性加锁优化：省去正常 `INSERT` 分配内存锁结构的 CPU 与内存开销 |

### 10.2.1 隐式锁惰性物化与内存锁结构合并压缩 {#ch10-2-1}

常规 `INSERT` 执行成功后立即查询 `performance_schema.data_locks`，只会看到 `1` 条表级 `IX` 锁，没有任何 `RECORD` 行锁——因为新记录已记录了活跃读写事务的状态，这把“无形之锁”即**隐式锁**。仅当另一并发事务 `T2` 试图对该未提交新记录加锁读取或修改时，才会按以下路径触发**惰性转换**（Lazy Conversion）：

1. **聚簇索引路径**：`T2` 读取记录的隐藏列 `DB_TRX_ID`，发现所属事务 `T1` 仍处于活跃未提交态；此时**由 `T2` 代为在内存中帮 `T1` 补建一把显式的 `X,REC_NOT_GAP` 已获锁结构**，随后为 `T2` 自己创建一把 `WAITING` 状态的锁结构并挂起等待。
2. **二级索引路径**：二级索引记录不含 `DB_TRX_ID`，`T2` 先对比该二级索引页头部的 `PAGE_MAX_TRX_ID` 是否小于当前最小活跃读写事务 ID；若不满足，则回表定位聚簇索引记录并沿版本链核实是否存在活跃修改事务，确认后同样代 `T1` 补建显式 `X,REC_NOT_GAP` 锁并自身进入等待。

此外，当一个大事务锁住成千上万行时，InnoDB 并不会为每行单独分配一个 C++ `lock_t` 内存对象。只要多条记录同时满足以下**四个合并条件**，它们就会共用**同一个 `lock_t` 锁结构**，仅通过结构末尾的位图（Bitmap）按记录的页面 `heap_no` 每行占用 `1 bit` 标记加锁状态：

- **同一事务**：由同一个 `trx_id` 申请；
- **同一数据页**：表空间号 `space_id` 与页号 `page_no` 完全相同；
- **同一加锁模式**：`type_mode` 完全一致，例如同为 `X` 或同为 `X,REC_NOT_GAP`；
- **同一等待状态**：同为已获锁 `GRANTED` 状态。

## 10.3 RC 与 RR 语句加锁行为全景速查（MySQL 8.4 实测） {#ch10-3}

### 10.3.1 主键、唯一索引与普通二级索引等值/范围加锁矩阵 {#ch10-3-1}

为直观核验各类 SQL 的精确锁集合，统一建立如下测试表 `hero` 并写入 `5` 条基准数据：

```sql
CREATE TABLE hero (
    number  INT PRIMARY KEY,
    name    VARCHAR(32) NOT NULL,
    uk_code VARCHAR(16) UNIQUE,
    country VARCHAR(32) NOT NULL,
    INDEX idx_name (name)
) ENGINE=InnoDB CHARSET=utf8mb4;

INSERT INTO hero VALUES
    (1,  'l刘备',   'H01', '蜀'),
    (3,  'z诸葛亮', 'H03', '蜀'),
    (8,  'c曹操',   'H08', '魏'),
    (15, 'x荀彧',   'H15', '魏'),
    (20, 's孙权',   'H20', '吴');
-- 主键顺序：1 → 3 → 8 → 15 → 20 → supremum
-- idx_name 二级索引顺序：'c曹操'(8) → 'l刘备'(1) → 's孙权'(20) → 'x荀彧'(15) → 'z诸葛亮'(3) → supremum
```

> [!IMPORTANT]
> **重大版本演进更正——MySQL 8.0.18+ 与 8.4 唯一索引范围上界优化**：《MySQL是怎样运行的》基于 MySQL 5.7 指出，在 `REPEATABLE READ` 下执行主键闭区间范围查询 `WHERE number > 1 AND number <= 15 FOR UPDATE` 时，引擎扫描命中 `15` 后仍会继续向右扫描 `20` 并给 `20` 加上 Next-Key 锁 `(15, 20]`。**自 MySQL 8.0.18 起并在 MySQL 8.4 LTS 中延续，针对主键及非空唯一索引的范围上界已实现精准剪枝优化**：
> 1. **闭区间上界 `<= 15` 且 `15` 存在时**：唯一性保证 `15` 之后绝不可能再出现等于 `15` 的记录，扫描在 `15` 处直接停止，仅锁 `3, 8, 15` 为 `X`，**完全不触碰也不锁后继记录 `20`**！
> 2. **开区间上界 `< 15` 或闭区间 `<= 14` 未命中时**：扫描定位到右边界 `15` 后，将 `15` 上的 Next-Key 锁自动**降级为纯间隙锁 `X,GAP`**（即 `(8, 15)`），不再无辜阻塞其他事务修改 `number = 15`！
> 3. **注意适用边界**：普通非唯一二级索引（如 `idx_name`）因允许插入相同键值的重复行，**不享受该上界裁剪**，闭区间仍需锁住后继记录以封锁尾部同值插入间隙。

基于 MySQL 8.4.13 `performance_schema.data_locks` 逐条实测核对，`READ COMMITTED` 与 `REPEATABLE READ` 的语句加锁全景对照如下——均以 `SELECT ... FOR UPDATE` 为例，表中省略共有的表级 `IX` 锁：

| 查询场景与 `WHERE` 条件 | `READ COMMITTED` 实测记录锁 | `REPEATABLE READ` 实测记录锁与降级依据 |
| --- | --- | --- |
| **主键等值命中**：`number = 8` | `PRIMARY`: `8 (X,REC_NOT_GAP)` | `PRIMARY`: `8 (X,REC_NOT_GAP)`——唯一等值精确命中，Next-Key 退化为纯记录锁 |
| **主键等值未命中**：`number = 7` / `25` | **无任何记录锁** | `7`：`PRIMARY` `8 (X,GAP)` 锁 `(3, 8)`；`25`：`supremum (X)` 锁 `(20, +∞)` |
| **唯一二级索引等值命中**：`uk_code = 'H08'` | `uk_code`: `'H08',8 (X,REC_NOT_GAP)`<br>`PRIMARY`: `8 (X,REC_NOT_GAP)` | 同左——必须同步锁聚簇索引主键 `8`，否则并发按主键更新该行将失去互斥保护 |
| **唯一二级索引等值未命中**：`uk_code = 'H07'` | **无任何记录锁** | `uk_code`: `'H08',8 (X,GAP)` 锁 `('H03', 'H08')` 间隙 |
| **普通索引等值命中**：`name = 'c曹操'` | `idx_name`: `'c曹操',8 (X,REC_NOT_GAP)`<br>`PRIMARY`: `8 (X,REC_NOT_GAP)` | `idx_name`: `'c曹操',8 (X)` + **后继 `'l刘备',1 (X,GAP)`**<br>`PRIMARY`: `8 (X,REC_NOT_GAP)`；若为覆盖索引 `FOR SHARE` 则免锁 `PRIMARY` |
| **普通索引等值未命中**：`name = 'k关羽'` | **无任何记录锁** | `idx_name`: 后继 `'l刘备',1 (X,GAP)` 锁 `('c曹操', 'l刘备')` |
| **主键双闭区间命中**：`number >= 8 AND number <= 15` | `PRIMARY`: `8, 15` 均为 `X,REC_NOT_GAP` | `PRIMARY`: 左界命中退化 `8 (X,REC_NOT_GAP)`，右界命中停在 `15 (X)`，**不锁 `20`** |
| **主键开区间上界**：`number > 1 AND number < 15` | `PRIMARY`: `3, 8` 均为 `X,REC_NOT_GAP` | `PRIMARY`: `3 (X)`, `8 (X)`，右界 `15` **降级为 `X,GAP`**；`<= 14` 未命中结果一致 |
| **主键无上界范围**：`number >= 15` | `PRIMARY`: `15, 20` 均为 `X,REC_NOT_GAP` | `PRIMARY`: `15 (X,REC_NOT_GAP)`，`20 (X)`，`supremum (X)` |
| **普通索引闭区间**：`name >= 'c曹操' AND name <= 'l刘备'` | `idx_name`: `'c曹操',8`、`'l刘备',1 (X,REC_NOT_GAP)`<br>`PRIMARY`: `8, 1 (X,REC_NOT_GAP)` | `idx_name`: `'c曹操',8 (X)`、`'l刘备',1 (X)` 及**后继 `'s孙权',20 (X)`**<br>`PRIMARY`: `8, 1 (X,REC_NOT_GAP)` |

### 10.3.2 无索引扫描、半一致性读与 INSERT 隐式/显式加锁 {#ch10-3-2}

1. **无索引全表扫描与提前释锁边界**：当执行 `SELECT * FROM hero WHERE country = '魏' FOR UPDATE;` 或无索引 `UPDATE` / `DELETE` 时，InnoDB 只能全表扫描聚簇索引，且引擎起初无法替 Server 层评估未建索引列的过滤条件：
   - **`REPEATABLE READ`**：对全表全部 5 条主键记录 `{1, 3, 8, 15, 20}` 连同 `supremum pseudo-record` 统统加上 Next-Key 锁 `X`，且**不满足条件的行在事务结束前绝不提前释放**，直接冻结整张表的并发更新与插入！
   - **`READ COMMITTED`**：InnoDB 逐行加 `X,REC_NOT_GAP` 后上交 Server 层校验 `WHERE` 条件；若不匹配 `country = '魏'`，Server 层立即调用 `unlock_row` 提前释放该行锁，最终仅保留命中行 `{8, 15}` 的记录锁。补充索引条件下推（见[4.2.2 节](./chapter-04#ch4-2-2)）版本细节：原书基于 MySQL 5.7 指出 `RC` 下被 ICP 在引擎内过滤掉的二级索引记录因未上交 Server 层而无法提前释锁；在 **MySQL 8.4** 实测中，InnoDB 已修复该过度加锁问题，`RC` 下被 ICP 过滤的记录不再残留行锁；而在 `RR` 下，ICP 扫描区间内的二级索引记录仍保留 Next-Key 锁，但未通过 ICP 的记录可省去聚簇索引回表锁。

2. **`READ COMMITTED` 下的 `UPDATE` 半一致性读**（Semi-consistent Read）：在 `READ COMMITTED`（及 `READ UNCOMMITTED`）下，当 `UPDATE` 语句全表或范围扫描遇到某行（如 `number = 8`）已被另一未提交事务加上 `X` 锁时，不会像 `SELECT ... FOR UPDATE` 那样无脑挂起等待，而是直接读取该行**最新已提交版本**（`country = '魏'`）评估 `WHERE` 条件：若不满足当前更新条件如 `WHERE country = '蜀'`，则**零等待直接跳过该锁冲突行**继续扫描；仅当最新已提交版本确实命中 `WHERE` 条件时，才重新执行阻塞式加锁重读。这一机制大幅降低了 `RC` 下并发无索引或宽范围 `UPDATE` 的锁冲突概率。

3. **`INSERT` 从隐式锁转为显式加锁的三类特例**：
   - **目标间隙已被封锁**：插入位置前后的后继记录上存在其他事务持有的 `Gap` 或 `Next-Key` 锁时，阻塞并显式生成 `X,GAP,INSERT_INTENTION`，在 `Supremum` 上则显示为 `X,INSERT_INTENTION`。
   - **唯一键冲突报错**（`ERROR 1062`）：插入时检测到主键或唯一二级索引存在重复键值，除向客户端返回 `Duplicate entry` 错误外，当前未结束事务还会对已存在的冲突记录**显式加共享锁**——MySQL 8.4 实测：主键冲突加 `S,REC_NOT_GAP`，唯一二级索引冲突在 `RU` / `RC` / `RR` 下均加 Next-Key `S` 锁；顺带更正原书此处将源码条件“`<= READ COMMITTED`”误印为“`READ UNCOMMITTED`”的笔误。若该冲突记录刚由另一未提交事务插入，这次 `S` 锁申请还会强制将对方的隐式锁转为显式 `X,REC_NOT_GAP` 并进入等待。
   - **外键约束父表检查**：向子表插入引用外键的值时，无论处于何种隔离级别，若父表对应主键值存在，都会显式给父表该记录加 `S,REC_NOT_GAP` 防止父记录被并发删改；若外键值在父表不存在且处于 `RR` 级别，则还会对父表后继记录加 `GAP` 锁。

## 10.4 使用 data_locks 观测锁状态与死锁实战排障 {#ch10-4}

### 10.4.1 基于 performance_schema 的实时锁观测 {#ch10-4-1}

MySQL 5.7 时代的旧诊断表 `information_schema.INNODB_LOCKS` 与 `INNODB_LOCK_WAITS` 已在 **MySQL 8.0** 中彻底删除——旧表还存在未发生阻塞等待时查不到任何已持有行锁的严重盲区。在 MySQL 8.0 与 8.4 中，统一使用 `performance_schema.data_locks` 关联 `data_lock_waits` 与 `INNODB_TRX` 定位阻塞源头，其中 `data_locks` **无需发生锁等待即可实时列出所有活跃事务已持有的 `GRANTED` 锁与等待中的 `WAITING` 锁**：

```sql
SELECT
    w.REQUESTING_ENGINE_TRANSACTION_ID AS req_trx,
    r.trx_query                        AS waiting_sql,
    w.BLOCKING_ENGINE_TRANSACTION_ID   AS blk_trx,
    b.trx_mysql_thread_id              AS blk_thread_id,
    dl.OBJECT_NAME, dl.INDEX_NAME, dl.LOCK_MODE, dl.LOCK_DATA
FROM performance_schema.data_lock_waits w
JOIN information_schema.INNODB_TRX r  ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.INNODB_TRX b  ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
JOIN performance_schema.data_locks dl ON dl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID;
```

拿到阻塞源会话的 `blk_thread_id` 后，可结合 `performance_schema.events_statements_history` 查看该空闲未提交事务此前执行过的历史 SQL，紧急止血时可执行 `KILL <blk_thread_id>;` 回滚释放锁。

### 10.4.2 死锁检测机制与“间隙锁 + 插入意向锁”死锁复现 {#ch10-4-2}

当两个或多个事务在等待有向图（Wait-for Graph）中形成闭环时即发生**死锁**。InnoDB 默认开启 `innodb_deadlock_detect = ON`，在每次发生锁等待时即时深度优先搜索等待环路；一旦检出死锁，会比较环中各事务的**回滚权重 `trx_weight`**——即修改过的记录数与持有的锁结构数之和——**自动选择权重最小、回滚代价最低的事务作为牺牲者立即回滚**，并向其客户端抛出 `ERROR 1213 (40001)`。仅在秒杀等极端单行高并发竞争导致死锁检测消耗过高 CPU 时，才考虑评估关闭死锁检测并调小默认 `50` 秒的 `innodb_lock_wait_timeout`。

应用层编写容错重试逻辑时，必须严格区分**死锁（`ERROR 1213`）**与**锁等待超时（`ERROR 1205`）**的回滚范围：

- **`ERROR 1213`（Deadlock）**：InnoDB 已自动**回滚整个牺牲事务**并释放其持有的锁，应用层可直接从事务起点重新开启并重试整笔业务事务。
- **`ERROR 1205`（Lock wait timeout exceeded）**：在默认配置 `innodb_rollback_on_timeout = OFF` 下，InnoDB **只回滚超时的那一条语句**，当前事务仍处于活跃状态，事务中先前已执行的修改与已持有的锁均未被回滚！若业务需要整笔重试，**必须先显式执行 `ROLLBACK` 结束当前事务**再重新开启，否则直接继续或误提交会导致部分写入残留、破坏原子性；仅当实例显式开启 `innodb_rollback_on_timeout = ON` 时，锁等待超时才会自动回滚整个事务。

线上最高频的死锁并非简单的“反向锁两行”，而是由 **`X,GAP` 彼此兼容、却与 `X,GAP,INSERT_INTENTION` 互斥**触发的幂等校验死锁。以下为基于 `hero` 表 `{1, 3, 8, 15, 20}` 在 MySQL 8.4.13 上的真实复现时序：

| 步序 | 会话 `T1 (trx 2318)` | 会话 `T2 (trx 2319)` | `data_locks` 锁状态演进与因果说明 |
| --- | --- | --- | --- |
| `1` | `BEGIN;`<br>`SELECT * FROM hero WHERE number = 7 FOR UPDATE;` | — | `7` 未命中，`T1` 获得主键 `8` 上的 **`X,GAP`**（`GRANTED`），封锁 `(3, 8)` |
| `2` | — | `BEGIN;`<br>`SELECT * FROM hero WHERE number = 6 FOR UPDATE;` | `6` 同样落入 `(3, 8)`；**因 `X,GAP` 与 `X,GAP` 100% 兼容**，`T2` **零等待同样获得 `8` 上的 `X,GAP`**（`GRANTED`）！ |
| `3` | `INSERT INTO hero VALUES (7, 'g关羽', 'H07', '蜀');` | — | `T1` 插入需申请 `8` 上的 `X,GAP,INSERT_INTENTION`，被 `T2` 持有的 `X,GAP` 阻塞，进入 **`WAITING`** |
| `4` | 随 `T2` 回滚释放间隙锁，插入自动唤醒并成功返回 | `INSERT INTO hero VALUES (6, 'z张飞', 'H06', '蜀');` | `T2` 申请 `X,GAP,INSERT_INTENTION` 被 `T1` 的 `X,GAP` 阻塞，形成 `2318 ↔ 2319` 闭环！死锁检测立即回滚 `T2` 报 **`ERROR 1213`** |

事后执行 `SHOW ENGINE INNODB STATUS\G`，定位 `LATEST DETECTED DEADLOCK` 段落，按“**(1) 查事务正在执行的 SQL → (2) 看 `HOLDS THE LOCK(S)` 已持何锁 → (3) 看 `WAITING FOR THIS LOCK` 正等何锁 → (4) 看底部 `WE ROLL BACK TRANSACTION (N)` 最终回滚了谁**”四步即可秒级破案——以下节选自本次 8.4.13 实测输出：

```text
*** (1) TRANSACTION:
TRANSACTION 2318, ACTIVE 0 sec inserting
INSERT INTO hero VALUES (7, 'g关羽', 'H07', '蜀')
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 21 page no 4 n bits 80 index PRIMARY of table `verify_ch09_10`.`hero`
trx id 2318 lock_mode X locks gap before rec
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 21 page no 4 n bits 80 index PRIMARY of table `verify_ch09_10`.`hero`
trx id 2318 lock_mode X locks gap before rec insert intention waiting

*** (2) TRANSACTION:
TRANSACTION 2319, ACTIVE 0 sec inserting
INSERT INTO hero VALUES (6, 'z张飞', 'H06', '蜀')
*** (2) HOLDS THE LOCK(S):
... trx id 2319 lock_mode X locks gap before rec
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
... trx id 2319 lock_mode X locks gap before rec insert intention waiting
*** WE ROLL BACK TRANSACTION (2)
```

总结**五条生产防死锁工程铁律**：

1. **固定加锁次序**：单个事务更新多张表或批量更新多行主键时，必须先在业务层对主键值做升序排序（`ORDER BY id ASC`），从拓扑上斩断反向加锁环路；
2. **废除“先 `FOR UPDATE` 查空再 `INSERT`”反模式**：防重幂等写入一律依托唯一索引，改用单条 `INSERT ... ON DUPLICATE KEY UPDATE` 或业务层捕获 `ERROR 1062`；
3. **写条件必走高选择性索引**：杜绝无索引 `UPDATE` / `DELETE` 在 `RR` 下升级为全表 Next-Key 锁连同 `Supremum` 锁表；
4. **极致压缩事务持锁窗口**：严禁在 `BEGIN ... COMMIT` 之间夹杂远程 HTTP/RPC 调用、消息投递或文件读写；
5. **按需降级为 `READ COMMITTED`**：对不依赖数据库层防范围幻读的常规互联网 OLTP 服务，使用 `READ COMMITTED` 可消去绝大多数 `Gap` 锁与插入意向锁死锁，并激活 `UPDATE` 半一致性读与未命中行提前释锁。

## 练习 {#ch10-exercises}

以下 2 道练习覆盖 MySQL 8.4 `REPEATABLE READ` 下精确行锁清单推导与并发幂等写入死锁治理。练习均基于 [10.3.1 节](#ch10-3-1)定义的 `hero` 表结构与 `5` 条初始记录——主键顺序为 `1 → 3 → 8 → 15 → 20`，`idx_name` 顺序为 `'c曹操'(8) → 'l刘备'(1) → 's孙权'(20) → 'x荀彧'(15) → 'z诸葛亮'(3)`。建议先独立写出每把锁的索引名、模式与记录值，再展开核对。

### 练习 1：推导 MySQL 8.4 `RR` 下四条锁定读在 `data_locks` 中的精确锁清单

假设在默认 `REPEATABLE READ` 隔离级别下分别开启独立事务，单独执行以下 4 条语句。请依次写出每条语句执行后，在 `performance_schema.data_locks` 中产生的表级锁与全部记录级锁——需指明 `INDEX_NAME`、`LOCK_MODE` 与 `LOCK_DATA`：

1. `SELECT * FROM hero WHERE number = 10 FOR UPDATE;`
2. `SELECT * FROM hero WHERE number >= 3 AND number < 15 FOR UPDATE;`
3. `SELECT * FROM hero WHERE name = 's孙权' FOR UPDATE;`
4. `SELECT number, name FROM hero WHERE name = 's孙权' FOR SHARE;`

<details>
<summary>查看参考答案</summary>

以下结果均已在 MySQL 8.4.13 `performance_schema.data_locks` 中逐条实测核对：

1. **`SELECT * FROM hero WHERE number = 10 FOR UPDATE;`**——主键等值未命中，落入 `(8, 15)` 间隙：
   - 表级锁：`INDEX_NAME = NULL`，`LOCK_MODE = IX`
   - 记录锁：`PRIMARY` 索引，`LOCK_DATA = 15`，**`LOCK_MODE = X,GAP`**（共 `1` 把记录级间隙锁）

2. **`SELECT * FROM hero WHERE number >= 3 AND number < 15 FOR UPDATE;`**——单条语句同时触发三种锁模式：
   - 表级锁：`INDEX_NAME = NULL`，`LOCK_MODE = IX`
   - `PRIMARY` 索引，`LOCK_DATA = 3`，**`LOCK_MODE = X,REC_NOT_GAP`**：闭区间左界精确命中唯一主键 `3`，无需锁 `(1, 3)` 间隙，退化为纯记录锁；
   - `PRIMARY` 索引，`LOCK_DATA = 8`，**`LOCK_MODE = X`**：区间内部记录，加标准 Next-Key 锁 `(3, 8]`；
   - `PRIMARY` 索引，`LOCK_DATA = 15`，**`LOCK_MODE = X,GAP`**：触发 MySQL 8.0.18+ / 8.4 唯一索引开区间右界优化，`< 15` 将 `15` 从 Next-Key 锁降级为纯间隙锁 `(8, 15)`，不阻塞其他事务更新 `15`。

3. **`SELECT * FROM hero WHERE name = 's孙权' FOR UPDATE;`**——普通非唯一二级索引等值命中并回表：
   - 表级锁：`INDEX_NAME = NULL`，`LOCK_MODE = IX`
   - `idx_name` 索引，`LOCK_DATA = 's孙权', 20`，**`LOCK_MODE = X`**：Next-Key 锁，锁住 `('l刘备', 's孙权']`；
   - `idx_name` 索引，`LOCK_DATA = 'x荀彧', 15`，**`LOCK_MODE = X,GAP`**：锁住后继间隙 `('s孙权', 'x荀彧')`，阻止并发插入同名 `'s孙权'`；
   - `PRIMARY` 索引，`LOCK_DATA = 20`，**`LOCK_MODE = X,REC_NOT_GAP`**：回表锁定对应聚簇索引记录。

4. **`SELECT number, name FROM hero WHERE name = 's孙权' FOR SHARE;`**——普通二级索引覆盖查询加共享锁：
   - 表级锁：`INDEX_NAME = NULL`，`LOCK_MODE = IS`
   - `idx_name` 索引，`LOCK_DATA = 's孙权', 20`，**`LOCK_MODE = S`**
   - `idx_name` 索引，`LOCK_DATA = 'x荀彧', 15`，**`LOCK_MODE = S,GAP`**
   - **关键差异**：因查询列仅含 `number`（主键）与 `name`（索引列），触发覆盖索引（`Using index`）且加的是 `FOR SHARE` 共享锁，**无需回表给 `PRIMARY` 的 `20` 加锁**！注意：此时另一事务若通过主键 `WHERE number = 20` 修改非索引列 `country` 不会受阻，但一旦试图修改索引列 `name` 则会在维护 `idx_name` 时被上述 `S` 锁拦截。

</details>

### 练习 2：剖析并发订单幂等写入死锁并给出高并发重构方案

某支付网关订单表 `orders(id BIGINT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(32) NOT NULL UNIQUE, amount INT)` 在默认 `REPEATABLE READ` 下处理渠道并发回调，原代码逻辑如下：

```sql
BEGIN;
SELECT id FROM orders WHERE order_no = 'ORD_20261117_09' FOR UPDATE;
-- 若应用层判断查询结果为空，则执行插入：
INSERT INTO orders (order_no, amount) VALUES ('ORD_20261117_09', 9900);
COMMIT;
```

压测发现：当上游因网络超时对同一笔新订单并发重发两次回调，甚至对两笔相邻单号 `'ORD_20261117_08'` 与 `'ORD_20261117_09'`——两者在 `order_no` 索引上落入同一间隙——并发调用时，频繁爆出 `ERROR 1213` 死锁。请说明：(1) 为什么改成唯一索引 `order_no` 后“先 `FOR UPDATE` 查空再 `INSERT`”依然会死锁；(2) 如何重构该 SQL 流程以彻底根除间隙锁死锁？

<details>
<summary>查看参考答案</summary>

1. **唯一索引未命中依然死锁的原因**：
   - 唯一索引退化为纯记录锁 `REC_NOT_GAP` 的前提是**等值查询精确命中已存在记录**；当新单号 `'ORD_20261117_09'` 在库中**尚不存在**时，即便 `order_no` 是 `UNIQUE` 索引，在 `REPEATABLE READ` 下依然必须对后继索引记录（或 `supremum`）加上排他间隙锁 **`X,GAP`** 以防止幻读！
   - 两个并发回调事务执行完首条 `SELECT ... FOR UPDATE` 后，由于 `X,GAP` 之间完全兼容，双方同时持有了同一开区间的 `X,GAP`；紧接着双方各自执行 `INSERT` 申请 `X,GAP,INSERT_INTENTION`，互相等待对方释放 `X,GAP`，必然触发死锁。

2. **根治重构方案**：
   - **删除前置 `SELECT ... FOR UPDATE` 探路语句**，直接依靠 `order_no` 上的 `UNIQUE` 约束执行单条原子幂等写入：
     ```sql
     INSERT INTO orders (order_no, amount)
     VALUES ('ORD_20261117_09', 9900)
     ON DUPLICATE KEY UPDATE id = id; -- 或使用 INSERT IGNORE，或在应用层捕获 ERROR 1062 后改走普通快照读返回已有单据
     ```
   - **原理解析**：删除未命中 `FOR UPDATE` 后，正常插入不同单号（如 `_08` 与 `_09`）仅在无锁情况下写入记录并借助**隐式锁**保护，互不加 `X,GAP`，并发吞吐提升数倍且零死锁；即便是同一单号 `_09` 极端并发双写，胜出事务先写入隐式锁，败方检测到唯一键冲突将胜方隐式锁物化为 `X,REC_NOT_GAP` 并单向排队等待胜方提交后执行幂等分支，不会形成双向持锁环路。同时在业务层对 `ERROR 1213` 保留最多 `2 ~ 3` 次指数退避重试作为防御性兜底。

</details>

## 面试题 {#ch10-interview}

以下 3 道面试题考查间隙锁相容性反直觉设计、MySQL 8.0.18+ / 8.4 范围加锁演进差异以及线上 DDL 元数据锁雪崩排障。代码与表结构约定同[练习部分](#ch10-exercises)，建议先独立思考再展开核对。

### 面试题 1：两个并发事务能同时对同一个区间持有排他间隙锁（`X,GAP`）吗？既然互相兼容，为什么反而极易引发死锁？

<details>
<summary>查看参考答案</summary>

1. **完全可以同时持有**。InnoDB 的间隙锁（无论 `S,GAP` 还是 `X,GAP`）设计目标纯粹是“防止其他事务往该开区间插入幻影记录”，并不锁定任何现存记录；两个事务同时声明“禁止往 `(3, 8)` 插入新行”在目标上毫无冲突，且当某条记录被物理清除合并前后间隙时也要求多个间隙锁能够并存，因此 **`S,GAP` 与 `X,GAP`、`X,GAP` 与 `X,GAP` 之间 100% 兼容**。
2. **极易诱发死锁的根因**：正因为申请阶段互不阻塞，事务 `T1` 和 `T2` 都能顺利拿到同一间隙 `(3, 8)` 的 `X,GAP`，构成双方各持一把防插入锁的对称局面；一旦随后 `T1` 和 `T2` 都试图往 `(3, 8)` 内执行 `INSERT`，插入操作需要申请的**插入意向锁** `X,GAP,INSERT_INTENTION` 与对方已持有的 `X,GAP` 严格互斥，导致 `T1` 等 `T2` 放 `X,GAP`、`T2` 等 `T1` 放 `X,GAP`，瞬间闭环形成死锁。

</details>

### 面试题 2：表 `hero` 主键 `number` 存在 `{1, 3, 8, 15, 20}`，在 `RR` 隔离级别下执行 `SELECT * FROM hero WHERE number > 1 AND number <= 15 FOR UPDATE`，MySQL 5.7 与 MySQL 8.0.18+ / 8.4 的加锁范围有何差异？若条件改为 `number < 15` 呢？

<details>
<summary>查看参考答案</summary>

1. **闭区间 `number > 1 AND number <= 15 FOR UPDATE`**（上界 `15` 精确存在）：
   - **MySQL 5.7**：扫描命中 `15` 后仍会继续向右读取下一条记录 `20`，最终对主键 `3`、`8`、`15`、**`20`** 全部加上 Next-Key 锁 `X`（无辜锁死 `(15, 20]`）。
   - **MySQL 8.0.18+ 及 MySQL 8.4**：利用唯一索引确定性实施范围上界剪枝——既然 `15` 已找到，主键唯一性保证后面绝不会再有第二个 `15`，扫描在 `15` 处直接终止，仅对 `3`、`8`、`15` 加 Next-Key 锁 `X`，**记录 `20` 及其前方间隙 `(15, 20)` 完全不加锁**。
2. **开区间 `number > 1 AND number < 15 FOR UPDATE`**：
   - 在 **MySQL 8.0.18+ 及 MySQL 8.4** 中，主键 `3` 和 `8` 加 Next-Key 锁 `X`，而右边界记录 `15` 上的锁会从 Next-Key 锁自动**降级为纯间隙锁 `X,GAP`**（仅锁 `(8, 15)` 开区间），其他并发事务依然可以正常 `UPDATE` 或 `FOR UPDATE` 修改 `number = 15` 这行记录本身。注意：这两项上界优化仅对主键和非空唯一索引生效，普通非唯一二级索引不适用。

</details>

### 面试题 3：线上对百万行表执行 `ALTER TABLE` 新增字段，DDL 本身支持 Instant / Online，为什么刚发起却导致该表后续所有普通无锁 `SELECT` 全部卡死？如何安全操作？

<details>
<summary>查看参考答案</summary>

1. **根因是 Server 层 `MDL` 元数据锁的写锁高优先级排队机制**：即便是支持 `ALGORITHM=INSTANT` 或 Online DDL 的 `ALTER TABLE`，在表定义准备与最终提交切换的极短瞬间，依然必须申请表的 **`EXCLUSIVE` 排他 MDL 写锁**。若发起 DDL 时，表上恰好存在一个尚未提交的长事务或慢查询持有 `SHARED_READ` 类型的 MDL 读锁，`ALTER TABLE` 就会进入 `PENDING` 等待状态；由于 MDL 等待队列遵循写锁优先，**排在该 `ALTER TABLE` 之后到达的所有普通无锁 `SELECT` 拿 `SHARED_READ` 请求都会被一并拦截在队列中**，引发全表读写完全冻结。
2. **安全变更规范**：
   - 变更前先查询 `information_schema.INNODB_TRX` 与 `performance_schema.metadata_locks`，确认目标表无运行中的长事务或慢查询；
   - 在执行 DDL 的会话中调小 Server 层 MDL 等待秒数，例如先设置 `SET SESSION lock_wait_timeout = 3;`——注意区分于控制 InnoDB 行锁的 `innodb_lock_wait_timeout`——若 `3` 秒内拿不到 MDL 排他锁则自动报错退出让路，绝不长期霸占队列阻塞业务查询，待低峰期重试。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: 17.7.1 InnoDB Locking](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html)
- [MySQL 8.4 Reference Manual: 17.7.2.4 Locking Reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
- [MySQL 8.4 Reference Manual: 17.7.3 Locks Set by Different SQL Statements in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-locks-set.html)
- [MySQL 8.4 Reference Manual: 17.6.1.6 AUTO_INCREMENT Handling in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-auto-increment-handling.html)
- [MySQL 8.4 Reference Manual: 10.11.4 Metadata Locking](https://dev.mysql.com/doc/refman/8.4/en/metadata-locking.html)
- [MySQL 8.4 Reference Manual: 29.12.13.1 The data_locks Table](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html)
- [MySQL 8.4 Reference Manual: 17.7.5 Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)
