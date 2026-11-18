---
title: 第 3 章 数据目录、表空间与 Buffer Pool
description: 掌握 MySQL 8.4 数据目录与 SDI 事务数据字典，剖析 InnoDB 段区页空间管理机制及 Buffer Pool 冷热双区 LRU 与刷脏架构。
---

# 第 3 章 数据目录、表空间与 Buffer Pool

## 本章要点

[第 2 章](./chapter-02#ch2-2)剖析了单个 `16 KiB` 数据页的内部字节构造，但在生产库中，成千上万张表与数百万个数据页究竟如何在磁盘文件与服务器内存中组织调度？本章打通从文件系统到内存缓冲池的完整存储链路：首先对照 MySQL 8.4 实测数据目录，厘清统一事务数据字典 `mysql.ibd` 与序列化字典信息（SDI）如何彻底终结 `.frm` 时代，并梳理独立双写文件、动态 Redo 目录与系统视图演进；接着深入 InnoDB 独立表空间，解释物理上的“页—区—组”与逻辑上的“段—32 碎片页规则—`6k + 3` 条 XDES 链表”如何兼顾小表空间利用率与大表顺序 I/O；最后拆解 InnoDB Buffer Pool 的控制块、三大管理链表、冷热双区防扫描污染 LRU 算法、刷脏路径与面向现代 SSD 的 8.4 默认参数体系。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 3.1 现代数据目录与事务数据字典（SDI） {#ch3-1}

MySQL 安装目录 `basedir` 存放 `mysqld`、`mysql`、`ibd2sdi` 等可执行程序，而所有库表元数据、用户数据页与核心引擎日志均存放在**数据目录** `datadir` 中——可通过 `SHOW VARIABLES LIKE 'datadir'` 查看具体路径，Linux 默认位于 `/var/lib/mysql/`。

原书基于 MySQL 5.7 介绍每个数据库目录下含 `db.opt`、每张表额外生成二进制结构文件 `.frm`，导致 Server 层 `.frm` 文件与 InnoDB 内部字典双份维护，一旦 DDL 中途崩溃极易引发字典不一致。自 MySQL 8.0 起，官方引入**统一事务数据字典**，英文称 Transactional Data Dictionary，彻底移除了 `.frm`、`db.opt`、`.par`、`.trn` 与 `.trg` 文件，将全部库表结构统一存入受 InnoDB 事务与 Redo 日志保护的 `mysql.ibd` 表空间，从而实现了崩溃安全的**原子 DDL**。

为了避免单点依赖 `mysql.ibd` 并在灾难恢复或表空间迁移 `IMPORT TABLESPACE` 时仍能自描述表结构，MySQL 8.0+ 同步引入了**序列化字典信息**（SDI），全称为 Serialized Dictionary Information：

- **InnoDB 表**：仅生成 `<表名>.ibd` 单一文件，表结构与索引定义以 `zlib` 压缩的 JSON 格式直接嵌入 `.ibd` 内部的专用页 `FIL_PAGE_SDI`——页类型为 `0x45BD`，新建独立表空间固定位于 `Page 3`。离线状态下可通过官方命令行工具 `ibd2sdi` 直接从 `.ibd` 提取完整 JSON 元数据。
- **MyISAM 等非事务引擎表**：引擎文件本身不支持内嵌 SDI 页，因此会在对应数据库目录下生成独立的 `<表名>_<字典ID>.sdi` 纯文本 JSON 文件，配合 `.MYD` 数据文件与 `.MYI` 索引文件共同存储。

MySQL 8.4 实例 `datadir` 下的核心目录与文件职责如下表所示：

| 文件或目录路径 | 引入/演进节点 | 核心存储职责与运维要点 |
| --- | --- | --- |
| `mysql.ibd` | 8.0+ 统一字典 | 存放全局事务数据字典表及 `mysql` 系统库表；用户会话禁止直接查询隐藏字典基表，须走 `information_schema` 视图 |
| `ibdata1` | 历代保留（职责瘦身） | 系统表空间 `space_id = 0`；8.4 中字典、双写缓冲与 Undo 已全部剥离，默认初始 `12 MiB` 且按需自增 |
| `<db>/<table>.ibd` | `innodb_file_per_table=ON` | 独立表空间文件，同时承载该表聚簇索引数据、全部二级索引与内嵌 `Page 3` SDI 元数据 |
| `<db>/<table>_<id>.sdi`、`.MYD`、`.MYI` | 8.0+ 替代 `.frm` | MyISAM 表三件套：`.sdi` 存 JSON 表结构，`.MYD` 存定长或变长行数据，`.MYI` 存非聚簇 B+ 树索引 |
| `#ib_16384_0.dblwr`、`#ib_16384_1.dblwr` | **8.0.20+ 独立双写文件** | 将**双写缓冲区**（Doublewrite Buffer）从 `ibdata1` 独立拆分出来，配合页尾校验修复撕裂页，详见 [2.2.3 节](./chapter-02#ch2-2-3) |
| `#innodb_redo/` | **8.0.30+ 动态日志池** | 存放 `#ib_redoN` 重做日志文件，由 `innodb_redo_log_capacity`（默认 `100 MiB`）动态扩缩，取代旧版 `ib_logfile0/1`，详见 [8.2.2 节](./chapter-08#ch8-2-2) |
| `undo_001`、`undo_002` | 8.0+ 默认独立 Undo | 独立 Undo 表空间，默认 2 个文件，支持在线自动截断回收长事务膨胀空间，详见 [8.3 节](./chapter-08#ch8-3) |
| `ibtmp1`、`#innodb_temp/*.ibt` | 5.7+ / **8.0.13+ 会话池** | `ibtmp1` 为全局共享临时表空间；`#innodb_temp` 存放 `temp_1.ibt`～`temp_10.ibt` 会话临时表空间池，断开连接即回收 |
| `ib_buffer_pool` | 5.7+ 预热转储文件 | 关机时转储热页 `(space_id, page_no)` 列表，重启后后台异步重装恢复 Buffer Pool 命中率 |
| `auto.cnf`、`mysqld-auto.cnf` | 5.6+ / 8.0+ 持久化 | `auto.cnf` 保存实例唯一 `server-uuid`；`mysqld-auto.cnf` 保存 `SET PERSIST` 持久化变量，详见 [1.2 节](./chapter-01#ch1-2) |

实例初始化后自带 4 个系统数据库：`mysql` 存放账户权限、时区、优化器成本常数与持久化统计信息；`information_schema` 提供标准元数据只读视图；`performance_schema` 提供低开销运行期探针，覆盖内存、I/O 与数据锁状态表；`sys` 则汇总前两者生成易读的运维诊断视图。注意原书使用的 `information_schema.INNODB_SYS_TABLES`、`INNODB_SYS_INDEXES`、`INNODB_SYS_DATAFILES` 等 `INNODB_SYS_*` 视图已在 MySQL 8.0 彻底移除，8.4 中统一查询去除了 `SYS_` 前缀的 `INNODB_TABLES`、`INNODB_INDEXES`、`INNODB_TABLESPACES` 与 `INNODB_COLUMNS`。

下面在 MySQL 8.4.13 中分别创建 InnoDB 表 `t_sdi` 与 MyISAM 表 `t_myisam`，对比磁盘文件清单、内部字典视图以及 `t_sdi.ibd` 前 8 个页面偏移量 `24..25` 字节处的 `FIL_PAGE_TYPE` 二进制页类型：

```sql
CREATE TABLE t_sdi (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  KEY idx_code (code)
) ENGINE=InnoDB;

CREATE TABLE t_myisam (
  id INT PRIMARY KEY,
  note VARCHAR(32)
) ENGINE=MyISAM;

SELECT NAME, SPACE_TYPE, ROW_FORMAT, N_COLS
FROM information_schema.INNODB_TABLES
WHERE NAME = 'verify_ch03_04/t_sdi';

SELECT i.NAME, i.TYPE, i.PAGE_NO, i.N_FIELDS
FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t ON i.TABLE_ID = t.TABLE_ID
WHERE t.NAME = 'verify_ch03_04/t_sdi';
```

数据库目录文件列表、字典查询输出与 `FLUSH TABLES t_sdi FOR EXPORT` 落盘后的前 8 页头部类型核对如下：

```text
-- /var/lib/mysql/verify_ch03_04/ 目录实测（无 db.opt，无 .frm）：
t_myisam.MYD       (0 B)        t_myisam_373.sdi   (2788 B, 纯文本 JSON 表结构)
t_myisam.MYI       (1024 B)     t_sdi.ibd          (131072 B = 8 × 16 KiB)

-- INNODB_TABLES 与 INNODB_INDEXES 输出：
+----------------------+------------+------------+--------+
| NAME                 | SPACE_TYPE | ROW_FORMAT | N_COLS |
+----------------------+------------+------------+--------+
| verify_ch03_04/t_sdi | Single     | Dynamic    |      5 |  -- 2 显式列 + 3 内部列
+----------------------+------------+------------+--------+
+----------+------+---------+----------+
| NAME     | TYPE | PAGE_NO | N_FIELDS |
+----------+------+---------+----------+
| PRIMARY  |    3 |       4 |        4 |  -- 聚簇索引根页固定在 Page 4
| idx_code |    0 |       5 |        2 |  -- 二级索引根页在 Page 5（code + id）
+----------+------+---------+----------+

-- t_sdi.ibd 前 8 页 FIL_PAGE_TYPE 实测：
Page 0: 0x0008 (FIL_PAGE_TYPE_FSP_HDR)    Page 4: 0x45BF (FIL_PAGE_INDEX, PRIMARY root)
Page 1: 0x0005 (FIL_PAGE_IBUF_BITMAP)     Page 5: 0x45BF (FIL_PAGE_INDEX, idx_code root)
Page 2: 0x0003 (FIL_PAGE_INODE)           Page 6: 0x0000 (FIL_PAGE_TYPE_ALLOCATED)
Page 3: 0x45BD (FIL_PAGE_SDI)             Page 7: 0x0000 (FIL_PAGE_TYPE_ALLOCATED)
```

在原书基于的 MySQL 5.7 中，聚簇索引根页位于 `Page 3`；而在 MySQL 8.0+ / 8.4 中，由于 `Page 3` 固定分配给 `0x45BD`（`FIL_PAGE_SDI`），新建独立表空间的**聚簇索引根页顺延至 `Page 4`**。

## 3.2 独立表空间：段、区、碎片页与元数据链表 {#ch3-2}

B+ 树同一层级的页面通过 `FIL_PAGE_PREV` 与 `FIL_PAGE_NEXT` 构成双向链表，但若相邻逻辑页在磁盘上相隔甚远，范围扫描就会退化为高昂的随机 I/O。为此，InnoDB 在 `16 KiB` 数据页之上引入了多层物理与逻辑空间管理抽象：

- **物理层级（页 → 区 → 组）**：默认每页 `16 KiB`；连续 **`64` 个页**组成一个**区**（Extent），固定大小 `1 MiB`，作为大表顺序分配的连续物理单元；连续 **`256` 个区**组成一个**组**（Extent Group），固定大小 `256 MiB` 共 `16,384` 页。每组开头的固定位置存放管理整个组的控制页：第 0 组的前 3 页依次是 `FSP_HDR`（`Page 0`）、`IBUF_BITMAP`（`Page 1`）与 `INODE`（`Page 2`）；第 1 组及后续每组——页号为 `16384` 的整数倍——前 2 页依次是 `XDES` 页与 `IBUF_BITMAP` 页。
- **逻辑层级（段与双段隔离）**：**段**（Segment）不是连续物理区域，而是若干零散页面与完整区的逻辑集合。为避免 B+ 树非叶子目录页穿插在叶子数据页之间打断顺序扫描，InnoDB 为**每棵 B+ 树索引同时创建两个段**——存放叶子页的**叶子节点段**与存放内节点的**非叶子节点段**。因此拥有 `k` 个索引的表共包含 `2k` 个段。
- **32 碎片页规则（小表防膨胀机制）**：若每个段一创建就分配完整的 `1 MiB` 区，一张只有主键的空表至少要占 `2 MiB`。为此 InnoDB 在表空间全局维护共享的**碎片区**（`FREE_FRAG`）：新段起初逐页从碎片区申请零散页面；**一旦该段已占满 `32` 个碎片页（即 `512 KiB`），后续空间申请立即切换为每次分配完整的 `1 MiB` 区**。实测 MySQL 8.4 中仅含主键的新建空表 `.ibd` 初始体积仅为 `7 × 16 KiB = 112 KiB`。

表空间内的每个区必然处于以下 4 种状态之一，并通过 `XDES Entry` 中的双向链表节点挂载在 `6k + 3` 条状态链表上（`k` 为表内索引个数）：

| 区状态 | 归属层级 | 对应管理链表 | 状态流转与空间分配规则 |
| --- | --- | --- | --- |
| `FREE` | 表空间级（全局 3 条链表） | 表空间 `FREE` 链表 | 64 页全部空闲；需要新碎片区或段专属区时从该链表摘取 |
| `FREE_FRAG` | 表空间级 | 表空间 `FREE_FRAG` 链表 | 供各段混用分配零散碎片页，且区内仍有未用完的空闲页 |
| `FULL_FRAG` | 表空间级 | 表空间 `FULL_FRAG` 链表 | 碎片区 64 页全部写满；一旦某页释放则迁回 `FREE_FRAG` 链表 |
| `FSEG` | 段专属级（`2k` 个段各 3 条） | 段级 `FREE` / `NOT_FULL` / `FULL` 链表 | 整区归单一特定段独占：按页占用情况在段内全空、半满、全满 3 条链表间流转 |

支撑上述 `O(1)` 分配与回收的三大核心二进制元数据组件汇总如下：

| 元数据组件 | 驻留位置与单条体积 | 核心字段与职责 |
| --- | --- | --- |
| `File Space Header` | 仅 `Page 0`（`FSP_HDR`）内占 `112 B` | 记录 `Space ID`、当前表空间总页数、`FREE` / `FREE_FRAG` / `FULL_FRAG` 全局链表基节点 `List Base Node`（各 `16 B`）及 `SEG_INODES_FULL/FREE` 链表 |
| `XDES Entry`（区描述符） | `Page 0` 及每组首部 `XDES` 页，每条 **`40 B`** | 每页容纳 256 条，一对一描述 1 个区：`Segment ID`（`8 B`）+ 链表前后指针 `List Node`（`12 B`）+ 状态 `State`（`4 B`）+ 64 页空闲位图 `Page State Bitmap`（`16 B`） |
| `INODE Entry`（段描述符） | `Page 2`（`INODE` 页）及扩展页，每条 **`192 B`** | 每页容纳 85 条，一对一描述 1 个段：`Segment ID`（`8 B`）+ 已用 `NOT_FULL` 页数（`4 B`）+ 段内三条链表基节点（`3 × 16 B`）+ **`32` 个碎片页号数组**（`32 × 4 B = 128 B`） |

## 3.3 InnoDB Buffer Pool 内存架构与冷热 LRU {#ch3-3}

### 3.3.1 控制块、页哈希表与 free / flush 链表 {#ch3-3-1}

磁盘随机读写耗时通常在数十微秒至毫秒级，而内存访问仅需数十纳秒。InnoDB 在启动时按系统变量 `innodb_buffer_pool_size` 向操作系统申请连续内存作为**缓冲池**（Buffer Pool），将其切分为与磁盘页等大的 `16 KiB` **缓冲页**——该参数最小值为 `5 MiB`，单机默认 `128 MiB`，生产数据库专机常配物理内存的 `50%～75%`。

为追踪每个缓冲页的归属与状态，InnoDB 为每个缓冲页一对一配备一个**控制块**（Control Block），记录表空间号、页号、缓冲页内存地址、锁信息与链表节点指针。单个控制块约占 `808 B`，相当于 `16 KiB` 缓冲页体积的 **`5%` 左右**。注意**控制块内存是在 `innodb_buffer_pool_size` 之外额外向操作系统申请的**——例如配置 `innodb_buffer_pool_size = 64G` 时，缓冲页与控制块合计实际占用约 `67.2 GiB` 物理内存：

```text
[ 控制块 0 | 控制块 1 | ... | 控制块 N ]  (额外申请 ≈ 5%)  +  [ 缓冲页 0 | 缓冲页 1 | ... | 缓冲页 N ]  (innodb_buffer_pool_size)
      │          │                │                                 ▲          ▲                ▲
      └──────────┴────────────────┴────────── 一对一映射 ───────────┴──────────┴────────────────┘
```

引擎访问某页时，以 `(space_id, page_no)` 为键在**页哈希表**中做 `O(1)` 检索：若命中则直接读写内存缓冲页；若未命中，则需分配缓冲页并维护以下三条核心双向链表，各链表的 `16 B` 基节点 `List Base Node` 独立驻留内存以记录头尾指针与节点计数：

1. **`free` 链表（空闲页链表）**：初始化时将全部未加载数据的控制块挂入 `free` 链表。每当需要从磁盘载入新页，直接从 `free` 链表头摘取一个空闲控制块，填入 `(space_id, page_no)` 并挂入页哈希表。
2. **`flush` 链表（脏页链表）**：凡是在内存中修改过、与磁盘页不一致的**脏页**（Dirty Page），其控制块都会同时挂入 `flush` 链表。链表按页面被首次修改时的重做日志序列号 `oldest_modification` 有序组织，后台刷脏只需从链表尾部最老脏页向前推进即可抬升 Checkpoint，详见 [8.2.2 节](./chapter-08#ch8-2-2)。
3. **`LRU` 链表（淘汰管理链表）**：串联所有已加载有效数据的缓冲页控制块，决定 `free` 链表耗尽时优先淘汰哪些冷页。

### 3.3.2 冷热双区 LRU、防扫描污染与惰性晋升 {#ch3-3-2}

若直接采用朴素的单链表 LRU，即新读入或刚命中的页一律移至表头、表尾淘汰，在数据库场景下会遭遇两类致命的缓存命中率雪崩：

- **预读失效**：InnoDB 提供线性预读——顺序访问某区页面达到 `innodb_read_ahead_threshold`（默认 `56` 页）时异步预读下一整个区——以及默认关闭的随机预读 `innodb_random_read_ahead = OFF`。若预读页后续根本未被查询用到却插在 LRU 头部，会白白挤掉真正的热点页。
- **全表扫描缓存污染**：偶发执行一次远超 Buffer Pool 容量的大表扫描或 `mysqldump` 备份，短时间内涌入的海量冷页会把所有高频业务热点页一次性全部挤出内存。

为此，InnoDB 将 `LRU` 链表按系统变量 `innodb_old_blocks_pct`（默认 `37`）切分为两段：前 `63%` 为高频热数据所在的 **`young` 区**（热区），后 `37%` 为 **`old` 区**（冷区），两区交界处称为 **`midpoint`**：

```text
LRU 链表：[ young 热区 (默认 63%，前 1/4 命中不移动) ] ──▶│ midpoint │──▶ [ old 冷区 (默认 37%，新读入页插入此处，尾部淘汰) ]
                         ▲                                                   │
                         └──── 再次访问且距首次加载 ≥ innodb_old_blocks_time (1000ms) ────┘
```

三项关键规则协同守卫热区命中率：

| 防护机制 | 控制参数与默认值 | 运行规则与解决的核心问题 |
| --- | --- | --- |
| 中点插入（Midpoint Insertion） | `innodb_old_blocks_pct = 37` | 所有首次从磁盘载入的页面（含预读页）**一律插入 `old` 区头部**；若预读页从未被访问，会在 `old` 区尾部快速淘汰，绝不触碰 `young` 热区 |
| 冷区驻留时间窗过滤 | `innodb_old_blocks_time = 1000` | 单位 `ms`。全表扫描在几毫秒内读完同一页上百行记录后不再访问：仅当某 `old` 页再次被访问且距首次加载时间 **`≥ 1000 ms`** 时才晋升至 `young` 头部，扫描页全部困在 `old` 区内部循环覆写 |
| 热区前 `1/4` 惰性晋升 | 内核固定阈值（`young` 前 `25%`） | 每次调整链表顺序都需竞争实例级 `LRU list mutex`；因此命中已处于 `young` 区前 `1/4` 的极热页面时**原地不动**，仅命中 `young` 区后 `3/4` 的页面时才将其提至 `young` 头部 |

### 3.3.3 刷脏路径、Chunk 在线扩缩容与 8.4 SSD 默认项 {#ch3-3-3}

InnoDB 通过三类路径将脏页写回磁盘，分别对应 `SHOW ENGINE INNODB STATUS` 中 `Pending writes` 的三项计数：

- **`BUF_FLUSH_LRU`（冷区尾部刷脏）**：后台线程定期从 `LRU` 链表冷区尾部扫描少量页面，发现脏页即刷盘并释放回 `free` 链表，保持空闲页水位。
- **`BUF_FLUSH_LIST`（脏页链表推进刷脏）**：后台 Page Cleaner 线程综合 `innodb_io_capacity` 与 Redo 日志占用水位，从 `flush` 链表尾部批量刷出最老脏页以推进 Checkpoint。
- **`BUF_FLUSH_SINGLE_PAGE`（用户线程同步单页刷脏）**：当后台刷脏速度跟不上前台写入、`free` 链表耗尽且 `LRU` 尾部找不到可直接驱逐的干净页时，前台查询线程被迫同步刷出单个脏页腾挪空间——这是导致线上 SQL 尾延迟尖刺的高危信号，一旦持续大于 `0` 需立即排查刷脏吞吐瓶颈。

在高并发多核服务器上，可通过 `innodb_buffer_pool_instances` 将 Buffer Pool 拆分为多个互不干扰的独立实例，各自拥有独立的哈希表、管理链表与互斥锁；当 `innodb_buffer_pool_size < 1 GiB` 时该值自动回退为 `1`。每个实例底层由若干个大小为 `innodb_buffer_pool_chunk_size`（默认 `128 MiB`）的连续内存块拼成，支持在线动态执行 `SET GLOBAL innodb_buffer_pool_size = ...` 逐块扩缩容而无需整池内存拷贝。配置时必须满足硬性对齐公式：

```text
对齐步长 Step = innodb_buffer_pool_chunk_size × innodb_buffer_pool_instances
实际生效容量  = ⌈请求容量 ÷ Step⌉ × Step
```

若请求的 `innodb_buffer_pool_size` 不是 `Step` 的整数倍，MySQL 会**自动向上取整对齐**——例如 `instances = 8`、`chunk_size = 128 MiB`（`Step = 1 GiB`）时，配置 `2.2 GiB` 会自动扩容为 `3 GiB`。

此外，原书中的多项存储引擎默认配置源自机械硬盘时代；在 MySQL 8.4 LTS 中，面向现代 NVMe SSD 的关键默认行为已发生重大演进：

| 系统变量 | 原书（5.7）默认 | MySQL 8.4 LTS 默认 | 架构演进依据与调优建议 |
| --- | --- | --- | --- |
| `innodb_change_buffering` | `all` | **`none`** | 原书重点介绍写缓冲区（Change Buffer）暂存非唯一二级索引变更以省去随机读；SSD 随机读延迟极低，写缓冲的合并锁开销与崩溃恢复复杂度得不偿失，**8.4 默认彻底关闭** |
| `innodb_flush_neighbors` | `1`（同区连带刷脏） | **`0`** | 机械盘时代刷脏时顺带刷写相邻脏页可减少磁头寻道；SSD 无寻道开销，关闭后显著降低无谓写放大 |
| `innodb_buffer_pool_in_core_file` | 未隔离（全量写入） | **`OFF`**（8.0.14+） | 进程崩溃生成 `core dump` 时排除数十 GiB 的 Buffer Pool 内存，避免写爆根分区并大幅缩短故障恢复耗时 |
| `innodb_dedicated_server` | 无 | `OFF`（专机可开 `ON`） | 数据库独占整台物理机或云主机时开启 `ON`，自动按宿主机内存比例托管 Buffer Pool 容量、Redo 容量与刷盘方式 |

线上巡检 `SHOW ENGINE INNODB STATUS\G` 的 `BUFFER POOL AND MEMORY` 段时，切记其页面指标单位是 **`16 KiB` 页数而非字节**，MySQL 8.4.13 默认 `128 MiB` 实例的实测输出与核心字段对照如下：

```text
Buffer pool size   8192        -- 总缓冲页数：8192 × 16 KiB = 128 MiB
Free buffers       6951        -- free 链表当前剩余空闲页数
Database pages     1241        -- LRU 链表当前数据页总数
Old database pages 438         -- old 冷区当前页数（约占 LRU 链表的 35%～37%）
Modified db pages  57          -- flush 链表当前尚未落盘的脏页总数
Pending writes: LRU 0, flush list 0, single page 0
Pages made young 58, not young 19  -- 冷区晋升热区页数 vs 因未满 1000ms 驻留窗被拦截的次数
```

## 练习 {#ch3-exercises}

以下 2 道练习覆盖 SDI 页布局核验、碎片页向完整区过渡的空间增长规律，以及多实例 Buffer Pool 对齐换算与监控指标诊断。SQL 示例默认在 MySQL 8.4 的 `verify_ch03_04` 库中执行，请先独立推演再展开核对。

### 练习 1：查询数据字典视图验证 SDI 页布局与段区增长规律

在 `verify_ch03_04` 库创建仅含整型主键的表 `CREATE TABLE t_only_pk (id INT PRIMARY KEY, pad CHAR(200) NOT NULL DEFAULT '') ENGINE=InnoDB;`。请结合 `information_schema` 视图回答并验证：
1. `t_only_pk` 的聚簇索引 `PRIMARY` 根页号 `PAGE_NO` 是多少？新建空表时 `INNODB_TABLESPACES.FILE_SIZE` 为多少字节，折合多少页？
2. 先执行 `SET SESSION cte_max_recursion_depth = 5000;` 放宽递归深度，再使用递归 CTE 依次插入至 `500` 行与 `2500` 行，观察 `FILE_SIZE` 的变化规律，并解释为何前几百行按小步长增长、而超过阈值后跳变为 `1 MiB` 的整数倍。

<details>
<summary>查看参考答案</summary>

验证 SQL 及在 MySQL 8.4.13 上的实测结果如下：

```sql
SET SESSION cte_max_recursion_depth = 5000;
CREATE TABLE t_only_pk (
  id INT PRIMARY KEY,
  pad CHAR(200) NOT NULL DEFAULT ''
) ENGINE=InnoDB;

-- 1. 查看聚簇索引根页号与空表文件大小
SELECT i.NAME, i.PAGE_NO
FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t ON i.TABLE_ID = t.TABLE_ID
WHERE t.NAME = 'verify_ch03_04/t_only_pk';
-- 输出：NAME = PRIMARY, PAGE_NO = 4

SELECT 'empty' AS stage, FILE_SIZE, FILE_SIZE / 16384 AS pages
FROM information_schema.INNODB_TABLESPACES WHERE NAME = 'verify_ch03_04/t_only_pk';
-- 输出：empty | 114688 | 7.0000

-- 2. 分批写入 500 行与 2500 行观察表空间扩张
INSERT INTO t_only_pk (id, pad)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
SELECT n, REPEAT('x', 200) FROM seq;
SELECT '500_rows' AS stage, FILE_SIZE, FILE_SIZE / 16384 AS pages
FROM information_schema.INNODB_TABLESPACES WHERE NAME = 'verify_ch03_04/t_only_pk';
-- 输出：500_rows | 229376 | 14.0000

INSERT INTO t_only_pk (id, pad)
WITH RECURSIVE seq(n) AS (SELECT 501 UNION ALL SELECT n + 1 FROM seq WHERE n < 2500)
SELECT n, REPEAT('x', 200) FROM seq;
SELECT '2500_rows' AS stage, FILE_SIZE, FILE_SIZE / 16384 AS pages
FROM information_schema.INNODB_TABLESPACES WHERE NAME = 'verify_ch03_04/t_only_pk';
-- 输出：2500_rows | 9437184 | 576.0000
```

**关键依据**：
1. **根页号与初始大小**：MySQL 8.0+ / 8.4 的独立表空间前 4 页依次固定为 `FSP_HDR`（`0`）、`IBUF_BITMAP`（`1`）、`INODE`（`2`）和内嵌表结构字典页 `FIL_PAGE_SDI`（`3`），因此聚簇索引根页固定位于 **`Page 4`**；单主键空表预分配 `7` 页，即 `7 × 16,384 = 114,688 B`（`112 KiB`）。
2. **两阶段扩张规律**：写入 `500` 行时叶子节点段占用的碎片页尚未达到 `32` 页上限，表空间从全局 `FREE_FRAG` 区按零散页小步自增至 `14` 页（`224 KiB`）；写入 `2500` 行后，叶子节点段早已用满 `32` 个碎片页（`512 KiB`），触发按完整 `1 MiB` 区（`64` 页）分配及成倍自增策略，文件体积变为 `9,437,184 B`（`576` 页 = 整 `9 MiB`）。

</details>

### 练习 2：计算多实例 Buffer Pool 自动对齐容量并判读状态指标

某生产实例启动配置为 `innodb_buffer_pool_instances = 8`、`innodb_buffer_pool_chunk_size = 256M`、`innodb_buffer_pool_size = 5G`。运行一段时间后，`SHOW ENGINE INNODB STATUS\G` 输出以下片段：

```text
Buffer pool size   393216
Free buffers       0
Database pages     392192
Old database pages 145110
Modified db pages  61200
Pending writes: LRU 0, flush list 18, single page 9
```

请回答：
1. 实例启动后实际生效的 `innodb_buffer_pool_size` 是多少 GiB？连同控制块在内，Buffer Pool 大约向操作系统申请了多少 GiB 内存？请验证它是否与状态输出中的 `Buffer pool size 393216` 一致。
2. 状态输出反映了什么线上性能隐患？应从哪些方向排查治理？

<details>
<summary>查看参考答案</summary>

1. **自动对齐容量与总内存换算**：
   - 对齐步长 `Step = 256 MiB × 8 = 2048 MiB = 2 GiB`。
   - 请求容量 `5 GiB` 不是 `2 GiB` 的整数倍，MySQL 自动向上取整为 `⌈5 ÷ 2⌉ × 2 = 6 GiB`。
   - 状态行 `Buffer pool size 393216` 的单位为 `16 KiB` 页：`393,216 × 16 KiB = 6,291,456 KiB = 6 GiB`，两者完全吻合，其中差值 `393216 - 392192 = 1024` 页供内部结构预留。
   - 计入约 `5%` 的额外控制块内存后，实际向操作系统申请约 `6 GiB × 1.05 ≈ 6.3 GiB`。
2. **线上性能隐患与排查方向**：
   - **核心隐患**：`Free buffers` 已跌至 `0`，且 `Pending writes: single page` 出现 **`9`**（大于 `0`）——说明后台 Page Cleaner 刷脏速度赶不上前台淘汰与写入需求，`LRU` 尾部无干净页可直接回收，导致 9 个前台用户查询线程被迫阻塞执行**同步单页刷脏** `BUF_FLUSH_SINGLE_PAGE`，引发明显的 SQL 响应毛刺。
   - **治理方向**：检查磁盘 IOPS 是否打满；若 SSD 余量充足，适当上调 `innodb_io_capacity` 与 `innodb_io_capacity_max` 加快后台 `flush list` 刷脏速率；同时排查是否存在批量无提交或高频全表写放大 SQL，并在物理内存允许时通过 `SET GLOBAL innodb_buffer_pool_size` 按 `2 GiB` 步长在线扩容。

</details>

## 面试题 {#ch3-interview}

以下 3 道面试题聚焦表空间防膨胀设计、Buffer Pool 防全表扫描污染原理与 8.0+ SDI 灾难恢复机制。代码与环境约定同[练习部分](#ch3-exercises)，建议先独立作答再展开核对。

### 面试题 1：为什么新建一张空的 InnoDB 表不会立刻占满 2MB 的区空间？

<details>
<summary>查看参考答案</summary>

**结论**：因为 InnoDB 引入了**表空间共享碎片区 `FREE_FRAG` 与 32 碎片页过渡规则**。

**关键依据**：每棵 B+ 树索引拆分为叶子节点段与非叶子节点段，单主键表至少含 2 个段。若每段起始即分配完整的 `1 MiB` 区（64 页），空表至少占用 `2 MiB`，在成千上万张小配置表场景下会造成严重磁盘浪费。因此新建段先从全局 `FREE_FRAG` 区逐页申请零散碎片页并记录在 `INODE Entry` 的 32 页数组中，MySQL 8.4 中单主键空表 `.ibd` 初始仅 `112 KiB`（7 页）；直到该段用满 **`32` 个碎片页**（`512 KiB`）后，后续扩容才切换为每次申请完整的 `1 MiB` 区。

</details>

### 面试题 2：线上偶发执行了一次 50GB 大表的全表扫描，会把 Buffer Pool 里的业务热点数据全部挤出去吗？

<details>
<summary>查看参考答案</summary>

**结论**：在默认配置下**不会**，InnoDB 通过**冷热双区中点插入 + `1000 ms` 冷区驻留窗口**拦截全表扫描污染。

**关键依据**：
1. **`midpoint` 中点插入**：`LRU` 链表默认按 `innodb_old_blocks_pct = 37` 将后 `37%` 划为 `old` 冷区，大表扫描新读入的数据页只会插入 `old` 区头部，不会直接进入前 `63%` 的 `young` 热区。
2. **`innodb_old_blocks_time = 1000`（毫秒）**：全表扫描虽然会对同一数据页内的上百行记录发起多次访问，但这些访问集中在几毫秒内完成，随后便继续扫向下一页。由于末次访问与首次加载的时间差远小于 `1000 ms` 阈值，扫描页始终无法晋升至 `young` 区，只能在 `old` 区内部快速淘汰覆写，从而完整保护 `young` 区的业务热点页。仅当单行处理极慢导致单页停留超 `1 s` 时才可能突破防线，此时可临时调大 `innodb_old_blocks_time`。

</details>

### 面试题 3：MySQL 8.0+ 删除 .frm 文件后表结构存在哪里？如果只备份或拷贝了单个 .ibd 文件，还能离线还原表结构吗？

<details>
<summary>查看参考答案</summary>

**结论**：运行期表结构统一存放在系统数据字典表空间 `mysql.ibd` 中；若仅有单个 `.ibd` 文件，**仍然可以离线提取完整表结构**。

**关键依据**：MySQL 8.0+ 在将全局元数据收入 `mysql.ibd` 实现原子 DDL 的同时，还在每个 InnoDB 独立表空间 `Page 3` 的 `FIL_PAGE_SDI` 页（类型 `0x45BD`）内部冗余写入了**序列化字典信息**（SDI），以 `zlib` 压缩的 JSON 格式完整保存了列名、类型、字符集、索引与约束定义。即使原实例崩溃或 `mysql.ibd` 丢失，也可在操作系统命令行直接执行官方工具 `ibd2sdi your_table.ibd` 导出 JSON 元数据并重建 `CREATE TABLE` 语句，随后配合 `ALTER TABLE ... DISCARD / IMPORT TABLESPACE` 恢复数据。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: Chapter 16 MySQL Data Dictionary](https://dev.mysql.com/doc/refman/8.4/en/data-dictionary.html)
- [MySQL 8.4 Reference Manual: 16.3 Serialized Dictionary Information (SDI) & ibd2sdi](https://dev.mysql.com/doc/refman/8.4/en/serialized-dictionary-information.html)
- [MySQL 8.4 Reference Manual: 17.6.3.2 File-Per-Table Tablespaces & Space Management](https://dev.mysql.com/doc/refman/8.4/en/innodb-file-per-table-tablespaces.html)
- [MySQL 8.4 Reference Manual: 17.5.1 Buffer Pool & Making the Buffer Pool Scan Resistant](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html)
- [MySQL 8.4 Reference Manual: 17.8.3.1 Configuring InnoDB Buffer Pool Size Online](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool-resize.html)
