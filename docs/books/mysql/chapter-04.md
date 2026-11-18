---
title: 第 4 章 B+ 树索引原理与高效设计规范
description: 深入 InnoDB 聚簇索引与二级索引 B+ 树构造，掌握扫描区间推导、最左前缀、索引条件下推与现代索引设计铁律。
---

# 第 4 章 B+ 树索引原理与高效设计规范

## 本章要点

单页内部可通过页目录槽二分查找快速定位记录，详见 [2.2.2 节](./chapter-02#ch2-2-2)；但当表体积膨胀至数万个数据页时，若无跨页导航结构，查询只能沿着双向链表逐页遍历。本章系统拆解 InnoDB B+ 树索引的物理实现与工程优化规则：首先从目录项记录出发，剖析聚簇索引、二级索引与联合索引的组织差异及 B+ 树三大底层不变量；接着围绕扫描区间推导建立单列与联合索引 9 类边界条件判定总表，厘清索引条件下推（ICP）、排序分组生效前提与 MySQL 8.0+ 移除 `GROUP BY` 隐式排序的行为演进；最后结合 MySQL 8.4 实测验证降序索引、不可见索引、函数索引与索引跳跃扫描四大现代特性，并给出八条生产级索引设计铁律。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 4.1 聚簇索引、二级索引与 B+ 树三大不变量 {#ch4-1}

为消除跨页线性遍历，InnoDB 为每个数据页提取出**页面内最小键值 + 页号**组成一条轻量的**目录项记录**（Directory Entry Record），集中存入上层的 `FIL_PAGE_INDEX` 数据页（页类型 `0x45BF`）。目录项记录与普通用户记录共享相同的行格式与页目录二分查找机制，仅在 40 比特记录头信息中以两处标志位区分，详见 [2.1.1 节](./chapter-02#ch2-1-1)：一是 `record_type = 1` 标识目录项记录，而叶子节点用户记录为 `record_type = 0`——注意原书第 6 章图 6-16 曾误将内节点目录项画成 `record_type = 0`，引擎真实落盘值必为 `1`；二是 B+ 树同一层级最左侧内节点页的首条最小目录项记录会将 `min_rec_flag` 置为 `1`。

上层目录页满后再向上提炼更高一层目录页，最终收敛为多叉平衡搜索树——**B+ 树**。InnoDB 据此构建三类物理索引形态：

- **聚簇索引**（Clustered Index）：按主键值大小对所有记录和页排序，**叶子节点直接存放完整的用户记录**——包含全部显式业务列以及 `DB_TRX_ID`、`DB_ROLL_PTR` 隐藏列。InnoDB 建表时自动创建聚簇索引，即“**索引即数据，数据即索引**”。
- **二级索引**（Secondary Index，又称辅助索引）：按指定索引列大小排序，**叶子节点仅存放“索引列值 + 主键值”**。若查询还需读取该二级索引未覆盖的其他列，引擎必须拿着叶子节点匹配到的主键值回到聚簇索引重新做一次根到叶检索，这一动作称为**回表**（Lookup）——每条记录回表都可能触发随机磁盘 I/O。
- **联合索引**（Composite Index）：对多列 `(c1, c2, c3)` 同时建立一棵二级索引 B+ 树，绝不会为每列单独建树。树内先按 `c1` 排序，`c1` 相同时按 `c2` 排序，再相同时按 `c3` 排序，叶子节点存放 `(c1, c2, c3, 主键值)`。

```text
二级索引 B+ 树 (Root: Page 5)                     聚簇索引 B+ 树 (Root: Page 4)
[ 内节点: (key, id, page_no), record_type=1 ]     [ 内节点: (id, page_no), record_type=1 ]
              │                                                 ▲  │
              ▼                                        回表检索  │  ▼
[ 叶子页: (key, id), record_type=0 ] ──── 携带主键值 id ────────┘  [ 叶子页: (id, 全部列, 隐藏列), record_type=0 ]
```

无论数据如何增删分裂，InnoDB B+ 树始终严守**三大底层不变量**：

1. **根节点万年不动**：每棵 B+ 树自创建起便固定根页页号并登记到数据字典——如 [3.1 节](./chapter-03#ch3-1)实测，MySQL 8.0+ / 8.4 独立表空间 `Page 3` 存放 `FIL_PAGE_SDI`，聚簇索引根页固定在 **`Page 4`**。初始阶段记录直接插入根页；当根页首次写满触发分裂时，InnoDB 先把根页全部记录原样拷贝到新申请的页 `Page A`，再将 `Page A` 分裂出 `Page B`，最后把原根页就地清空升级为内节点并写入指向 `Page A` 与 `Page B` 的两条目录项记录。此后无论树高增至几层，引擎访问该索引永远从同一个根页号起步：

   ```text
   初始状态：Page 4 [ 用户记录写满 ]
   分裂过程：Page 4 ──全量拷贝──▶ Page A ──页分裂──▶ Page A (前半段叶子) + Page B (后半段叶子)
   最终状态：Page 4 [ 目录项指向 Page A | 目录项指向 Page B ]  (Page 4 原地升级为内节点，页号永不改变)
   ```
2. **二级索引内节点目录项唯一性**：若二级索引列存在大量重复值，而内节点目录项只存 `(索引列, 页号)`，新插入一条同值记录时将无法唯一判定该落入哪个子页。因此 InnoDB 将**主键值一并拼入二级索引的内节点目录项**，构成 `(索引列, 主键, 页号)` 复合键。**即便是 `UNIQUE` 唯一二级索引也同样携带主键**——因为 SQL 标准允许唯一索引列存入多个 `NULL`，且 MVCC 下同一唯一键值在页内可能同时存在带删除标记的旧版本与新插入版本。
3. **单页最少 2 条记录与 2～4 层高扇出定律**：若某页仅容纳 1 条记录，层级将失去二分收敛意义，因此 InnoDB 强制单页至少存放 2 条记录，超出部分转入溢出页，详见 [2.1.2 节](./chapter-02#ch2-1-2)。假设聚簇叶子页平均存 `100` 条完整记录、内节点页平均存 `1000` 条短目录项，则 2 层可存 `10 万` 行，3 层可存 `100 × 1000 × 1000 = 1 亿` 行，4 层高达 `1000 亿` 行——真实生产 B+ 树高度普遍在 **2～4 层**之间，且顶层内节点长期常驻 Buffer Pool，单键检索通常至多产生 `1～2` 次磁盘 I/O。

对比 InnoDB 与 MyISAM 的索引物理架构，可以更清晰地理解“聚簇”与“非聚簇”的本质分野：

| 对比维度 | InnoDB 存储引擎 | MyISAM 存储引擎 |
| --- | --- | --- |
| 数据与索引关系 | 聚簇存储，`.ibd` 内聚簇索引叶子即完整行数据 | 数据与索引分离：`.MYD` 存行数据，`.MYI` 存全部索引 |
| 主键索引叶子载荷 | 完整用户记录（含全部列与 MVCC 隐藏列） | `主键值 + 行在 .MYD 中的文件偏移量（行号）` |
| 二级索引叶子载荷 | `索引列值 + 主键值`（回表需再查聚簇 B+ 树） | `索引列值 + 行在 .MYD 中的文件偏移量`（与主索引同构） |
| 回表访问特征 | 通过主键走聚簇索引 B+ 树二分定位 | 直接拿文件偏移量对 `.MYD` 执行一次 `lseek` 定点读取 |
| 显式主键要求 | 无显式主键且无非空唯一键时自动生成 6B `DB_ROW_ID` | 允许建无主键表，索引全部属于二级非聚簇索引 |

## 4.2 扫描区间推导、最左前缀与索引条件下推（ICP） {#ch4-2}

### 4.2.1 单列与联合索引扫描区间判定总表 {#ch4-2-1}

优化器执行索引查询前，会先从 `WHERE` 子句提取能够限制索引键起止范围的**边界条件**（Boundary Condition），构造出形如 `[a, b]` 或 `('a', +∞)` 的**扫描区间**（Scan Interval）。全表扫描等价于聚簇索引上的 `(-∞, +∞)`。以下演示统一基于测试表 `single_table`：

```sql
CREATE TABLE single_table (
  id INT NOT NULL AUTO_INCREMENT,
  key1 VARCHAR(100),
  key2 INT,
  key3 VARCHAR(100),
  key_part1 VARCHAR(100),
  key_part2 VARCHAR(100),
  key_part3 VARCHAR(100),
  common_field VARCHAR(100),
  PRIMARY KEY (id),
  KEY idx_key1 (key1),
  UNIQUE KEY idx_key2 (key2),
  KEY idx_key3 (key3),
  KEY idx_key_part (key_part1, key_part2, key_part3)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

多条件经 `AND` 与 `OR` 组合时遵循集合运算规则：**`AND` 取交集**，例如 `key1 > 'a' AND common_field = 'x'` 中未建索引的 `common_field` 无法收紧 `idx_key1` 边界，直接化简为 `key1 ∈ ('a', +∞)`；**`OR` 取并集**，要求**每个 `OR` 分支都能利用该索引生成有限区间**——一旦任一分支如 `key1 > 'a' OR common_field = 'x'` 右侧在该索引上退化为 `TRUE`，并集立即膨胀为 `(-∞, +∞)`，迫使该单列索引失效。字符串前缀匹配 `LIKE 'abc%'` 等价于左闭右开范围 `['abc', 'abd')`；而左模糊 `LIKE '%abc'` 因首字符未知无法生成有界区间。

联合索引 `idx_key_part (key_part1, key_part2, key_part3)` 按词典序逐列有序：**只有当前导列取确定等值时，紧邻下一列才是局部有序的**。以下 9 类典型 `WHERE` 条件在 `idx_key_part` 上的扫描区间与生效列对比，尤其需要重点区分 **Q8（`<`）与 Q9（`<=`）在右边界上的本质差异**：

| 编号 | `WHERE` 过滤条件 | `idx_key_part` 生成的扫描区间 | 形成区间的列数（`key_len`）与底层机理 |
| --- | --- | --- | --- |
| Q1 | `key_part1 = 'a'` | `['a', 'a']` | 1 列（`403`）：满足最左前缀首列等值 |
| Q2 | `key_part1 = 'a' AND key_part2 = 'b'` | `[('a', 'b'), ('a', 'b')]` | 2 列（`806`）：前两列连续等值定位 |
| Q3 | `key_part2 = 'a'` | 无法形成区间（非覆盖时 `ALL`） | 0 列：缺失首列 `key_part1`，全局 `key_part2` 乱序 |
| Q4 | `key_part1 = 'a' AND key_part3 = 'c'` | `['a', 'a']` | 1 列（`403`）：中间跳过了 `key_part2`，`key_part3` 仅走 ICP |
| Q5 | `key_part1 = 'a' AND key_part2 > 'b' AND key_part2 < 'd'` | `(('a', 'b'), ('a', 'd'))` | 2 列（`806`）：首列等值固定后，次列有序形成开区间 |
| Q6 | `key_part1 > 'a' AND key_part2 = 'b'` | `('a', +∞)` | 1 列（`403`）：首列严格大于 `'a'`，其后 `key_part2` 无序 |
| Q7 | `key_part1 >= 'a' AND key_part2 = 'b'` | `[('a', 'b'), (+∞, +∞))` | 2 列（`806`）：**闭左界**在 `key_part1 = 'a'` 段内跳过 `< 'b'` 的记录 |
| Q8 | `key_part1 < 'b' AND key_part2 = 'a'` | `(-∞, 'b')` | **1 列（`403`）**：严格小于 `'b'`，根本不含 `'b'` 段，次列无法收紧右界 |
| Q9 | `key_part1 <= 'b' AND key_part2 = 'a'` | `((-∞, -∞), ('b', 'a']]` | **2 列（`806`）**：**闭右界**扫至 `('b', 'a')` 末尾即停，免扫 `('b', 'c')` 等尾部 |

在 `utf8mb4` 下，可空 `VARCHAR(100)` 单列 `key_len = 100 × 4 + 2（变长头）+ 1（NULL 位）= 403`，详见 [7.1.1 节](./chapter-07#ch7-1-1)。在 MySQL 8.4.13 中对 Q8 与 Q9 执行 `EXPLAIN`，`key_len` 从 `403` 翻倍为 `806` 直接印证了上述推导：

```sql
EXPLAIN SELECT * FROM single_table WHERE key_part1 < 'b' AND key_part2 = 'a';
-- type: range | key: idx_key_part | key_len: 403 | Extra: Using index condition

EXPLAIN SELECT * FROM single_table WHERE key_part1 <= 'b' AND key_part2 = 'a';
-- type: range | key: idx_key_part | key_len: 806 | Extra: Using index condition
```

### 4.2.2 索引条件下推（ICP）与排序分组生效边界 {#ch4-2-2}

观察上表 Q4 `SELECT * FROM single_table WHERE key_part1 = 'a' AND key_part3 = 'p1'`：虽然 `key_part3 = 'p1'` 因中间缺少 `key_part2` 不能用于收紧扫描区间 `['a', 'a']`，但 `idx_key_part` 二级索引叶子记录本身已经存有 `key_part3` 的值。

在早期无优化版本中，InnoDB 每扫到一条 `key_part1 = 'a'` 的二级索引记录就立刻回表读取整行返回 Server 层，再由 Server 层判断 `key_part3 = 'p1'`。自 MySQL 5.6 引入并默认开启**索引条件下推**（ICP）后——英文称 Index Condition Pushdown，受 `optimizer_switch` 中的 `index_condition_pushdown=on` 控制——Server 层会把涉及该二级索引列的剩余过滤条件下推给存储引擎：InnoDB 在遍历二级索引页时直接比对 `key_part3 = 'p1'` 及 Q8/Q9 中的 `key_part2 = 'a'`，不满足则当场跳过，**只对通过下推条件筛选的少量记录发起回表**，从而大幅削减随机回表 I/O。`EXPLAIN` 的 `Extra` 列出现 `Using index condition` 即表示触发了 ICP。

除定界过滤外，B+ 树天然有序性还可直接消除内存或磁盘归并排序（`Using filesort`）。要让 `ORDER BY` 或 `GROUP BY` 复用联合索引顺序，必须使排序列按联合索引最左前缀顺序连续出现——若前导列已在 `WHERE` 中通过**等值条件 `=`** 固定为常量，后续列可无缝接力有序，如 `WHERE key_part1 = 'a' ORDER BY key_part2, key_part3 LIMIT 10`。反之，以下 5 类场景会导致索引排序失效：

1. **跳过前导列或颠倒列顺序**：如 `ORDER BY key_part2, key_part3`（无 `key_part1 = const`）或 `ORDER BY key_part2, key_part1`。
2. **升序索引上混用不一致的排序方向**：在常规全升序联合索引上执行 `ORDER BY key_part1 ASC, key_part2 DESC`——首列升序段的末尾无法直接衔接次列降序段的起点，必须改建 [4.3 节](#ch4-3)的降序索引。
3. **排序列跨越不同索引或多张表**：如 `ORDER BY key1, key2` 或连接查询中混排两张表的列。
4. **排序列套用了未建函数索引的表达式**：如 `ORDER BY UPPER(key1)`。
5. **无 `LIMIT` 的大范围非覆盖查询**：若按二级索引顺序扫描需对海量行逐条随机回表，优化器基于成本估算会主动放弃索引，改走全表顺序扫描加内存 `filesort`，详见 [6.2 节](./chapter-06#ch6-2)。

> [!WARNING]
> **MySQL 8.0+ / 8.4 重大变更：移除 `GROUP BY` 隐式排序**
> 原书基于 MySQL 5.7 指出 `GROUP BY` 默认按分组列隐式排序，并介绍通过追加 `ORDER BY NULL` 取消多余排序。自 MySQL 8.0 起，`GROUP BY col ASC/DESC` 语法已被彻底移除，执行直接报语法错误，且 **`GROUP BY` 不再附带任何隐式排序保证**——在无可用索引的列上执行 `GROUP BY common_field` 时，8.4 优化器直接使用临时表哈希聚合，`Extra` 仅显示 `Using temporary` 而不再出现 `Using filesort`。若业务要求分组结果按顺序返回，**必须显式编写 `ORDER BY` 子句**。

```sql
-- MySQL 8.4.13 实测 ICP 下推与无隐式排序的 GROUP BY 执行计划：
EXPLAIN SELECT * FROM single_table WHERE key_part1 = 'a' AND key_part3 = 'p1';
-- type: ref | key: idx_key_part | key_len: 403 | filtered: 10.00 | Extra: Using index condition

EXPLAIN SELECT common_field, COUNT(*) FROM single_table GROUP BY common_field;
-- type: ALL | key: NULL         | rows: 2000   | Extra: Using temporary  (无 Using filesort！)
```

## 4.3 现代索引新特性与八条工程设计铁律 {#ch4-3}

针对传统 B+ 树在混合方向排序、安全灰度删索引、表达式过滤与低基数前导列缺失场景下的痛点，MySQL 8.0 至 8.4 LTS 补齐了四大生产级索引特性：

| 现代索引特性 | 起始版本 | 核心定义语法 | 解决的核心痛点与严苛使用边界 |
| --- | --- | --- | --- |
| **真正降序索引**（Descending Index） | 8.0.1+ | `KEY idx_pa (priority DESC, created_at ASC)` | 5.7 解析 `DESC` 后静默忽略仍按升序存；8.0+ 在页内真实按降序组织，彻底消除多列混合方向 `ORDER BY` 的 `Using filesort` |
| **不可见索引**（Invisible Index） | 8.0+ | `ALTER TABLE t ALTER INDEX idx INVISIBLE;` | 引擎随写入正常维护该索引，但优化器默认对其“失明”；删索引前先设 `INVISIBLE` 灰度观察，异常时秒级 `VISIBLE` 恢复而无需重建 |
| **函数索引**（Functional Index） | 8.0.13+ | `KEY idx_fn ((LOWER(email)))` | **必须加双层括号**；底层自动创建隐藏的 `VIRTUAL GENERATED` 虚拟列并建索引，使函数计算或 JSON 路径提取走 `ref` 精确查找 |
| **索引跳跃扫描**（Index Skip Scan） | **8.0.13+** | 无需改 DDL（`skip_scan=on` 默认开启） | 缺失低基数首列时自动拆解为枚举首列各离散值的多次子范围扫描；**严苛前提**：仅限单表、禁含 `GROUP BY` / `DISTINCT`，且**必须是覆盖索引** |

下面在 MySQL 8.4.13 中构造 `orders_demo` 与 `skip_demo` 两张 `2000` 行测试表，实测上述四大特性的 `EXPLAIN` 效果与退化边界：

```sql
-- 1. 降序索引与函数索引实测表
CREATE TABLE orders_demo (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  priority TINYINT NOT NULL,
  created_at DATETIME NOT NULL,
  email VARCHAR(128) NOT NULL,
  KEY idx_asc_asc (priority ASC, created_at ASC),
  KEY idx_desc_asc (priority DESC, created_at ASC),
  KEY idx_lower_email ((LOWER(email)))
) ENGINE=InnoDB CHARSET=utf8mb4;

-- 对比全升序索引 vs 降序联合索引处理混合排序：
EXPLAIN SELECT id, priority, created_at FROM orders_demo FORCE INDEX (idx_asc_asc)
  ORDER BY priority DESC, created_at ASC LIMIT 10;
-- key: idx_asc_asc  | rows: 2000 | Extra: Using index; Using filesort  (扫全索引再排序)

EXPLAIN SELECT id, priority, created_at FROM orders_demo
  ORDER BY priority DESC, created_at ASC LIMIT 10;
-- key: idx_desc_asc | rows: 10   | Extra: Using index                  (扫满 10 条即停！)

-- 验证双括号函数索引命中与会话级不可见索引灰度验证：
EXPLAIN SELECT id, email FROM orders_demo WHERE LOWER(email) = 'user42@example.com';
-- type: ref | key: idx_lower_email | key_len: 515 | rows: 1

ALTER TABLE orders_demo ALTER INDEX idx_lower_email INVISIBLE;
-- 此时普通会话自动回退 type: ALL；排障会话可单独开启验证：
SET SESSION optimizer_switch = 'use_invisible_indexes=on';

-- 2. 索引跳跃扫描（gender 仅 0/1 两个离散值，联合索引 KEY idx_gender_score (gender, score)）：
EXPLAIN SELECT id, gender, score FROM skip_demo WHERE score > 1980;
-- type: range | key: idx_gender_score | Extra: Using where; Using index for skip scan

EXPLAIN SELECT id, gender, score, note FROM skip_demo WHERE score > 1980;
-- type: ALL   | key: NULL             | Extra: Using where (多了非索引列 note 需回表，跳跃扫描立即失效！)
```

结合 B+ 树底层物理代价与线上慢 SQL 治理经验，生产表结构评审应严守**八条工程索引设计铁律**：

1. **按需索引，拒绝给纯展示列建单列索引**：仅对出现在 `WHERE`、`JOIN ON`、`ORDER BY`、`GROUP BY` 中的高频列建索引。
2. **评估列基数（Cardinality）**：不重复值极少的性别、软删除标记列切忌单独建立单列索引——命中 `50%` 记录再随机回表远慢于顺序全表扫描；此类列应与高区分度列组合为联合索引使用。
3. **优先覆盖索引（`Using index`），严禁无脑 `SELECT *`**：让二级索引囊括查询所需全部字段以彻底消除回表；分页深翻页场景先用覆盖索引子查询查出 `id` 再关联回表，即延迟关联优化。
4. **最小化索引列字节宽度**：优先选 `TINYINT`、`INT UNSIGNED`、`BIGINT`，窄键值使单个 `16 KiB` 内节点页容纳更多目录项，压低树高并节省 Buffer Pool 内存。
5. **超长文本科学评估前缀索引长度**：通过计算 `COUNT(DISTINCT LEFT(url, N)) / COUNT(*)` 选取区分度逼近全列的最短截断长度 `N` 建立 `KEY idx_url (url(N))`；但注意前缀索引**无法消除 `ORDER BY url` 的 `filesort`**，也无法作为 `url` 列的覆盖索引。
6. **主键必须窄且趋势单调递增**：采用 `AUTO_INCREMENT`、趋势递增雪花 ID 或 MySQL 8.0+ 重排时间高位的 `UUID_TO_BIN(UUID(), 1)`（`16 B`），确保新行始终追加在聚簇叶页末尾；严禁直接拿 `36` 字节随机 `UUID` 字符串当主键，否则会频繁在旧页中间强插导致**页分裂**、页面填充率跌至 `50%` 左右，且所有二级索引叶子与内节点都要重复背负宽大的主键值。
7. **比较符左侧保持裸列（Sargable 原则）**：将 `WHERE amount * 100 > 500` 改写为 `WHERE amount > 5`，将 `WHERE DATE(created_at) = '2026-11-17'` 改写为半开区间 `created_at >= '2026-11-17 00:00:00' AND created_at < '2026-11-18 00:00:00'`，并防范 [1.3.2 节](./chapter-01#ch1-3-2)的跨字符集隐式类型转换。
8. **清理冗余与重复前缀索引**：已存在联合索引 `KEY (a, b, c)` 时，单列 `KEY (a)` 与 `KEY (a, b)` 绝大多数情况下属于纯冗余开销——每多一棵索引树，每次增删改都要额外维护一棵 B+ 树的页分裂与脏页刷盘；下线前先用 `INVISIBLE` 灰度确认无慢查询回退后再执行 `DROP INDEX`。

## 练习 {#ch4-exercises}

以下 2 道练习检验复杂布尔条件下的扫描区间与 `key_len` 精确推导，以及运用 MySQL 8.4 现代索引特性改造慢查询的能力。测试环境基于 `verify_ch03_04` 库（字符集 `utf8mb4`），请先独立推导再展开核对。

### 练习 1：复杂布尔条件下联合索引扫描区间、key_len 与 ICP 精确推演

基于 [4.2.1 节](#ch4-2-1)已灌入 `2000` 行数据的 `single_table` 表——其中 `key_part1`、`key_part2`、`key_part3` 均为可空 `VARCHAR(100)`，单列 `key_len = 403`——请逐条推导以下 4 条查询在 `idx_key_part (key_part1, key_part2, key_part3)` 上的扫描区间、`EXPLAIN` 的 `type` 与 `key_len` 值，以及是否触发 ICP（`Using index condition`）：

```sql
-- SQL 1（注意双开区间 > 与 <）
SELECT * FROM single_table WHERE key_part1 = 'a' AND key_part2 > 'b' AND key_part2 < 'd' AND key_part3 = 'p1';
-- SQL 2（注意双闭区间 >= 与 <=）
SELECT * FROM single_table WHERE key_part1 = 'a' AND key_part2 >= 'b' AND key_part2 <= 'd' AND key_part3 = 'p1';
-- SQL 3
SELECT * FROM single_table WHERE (key_part1 = 'a' AND key_part2 = 'b') OR key_part1 > 'h';
-- SQL 4
SELECT * FROM single_table WHERE key_part1 = 'a' OR common_field = 'val_1';
```

<details>
<summary>查看参考答案</summary>

MySQL 8.4.13 实测结论与底层推导如下：

| 查询 | `type` | `key` | `key_len` | `Extra` | 扫描区间与边界推导 |
| --- | --- | --- | --- | --- | --- |
| SQL 1 | `range` | `idx_key_part` | **`806`** | `Using index condition` | 开区间 `(('a', 'b'), ('a', 'd'))`：首列固定 `'a'`，次列严格大于 `'b'` 且小于 `'d'`，端点不含 `'b'` 与 `'d'`，第 3 列无法收紧边界，仅下推走 ICP |
| SQL 2 | `range` | `idx_key_part` | **`1209`** | `Using index condition` | 闭区间 `[('a', 'b', 'p1'), ('a', 'd', 'p1')]`：左端 `key_part2 = 'b'` 段内 `key_part3` 有序，左界收紧至 `('a', 'b', 'p1')`；右端 `'d'` 段同理收紧至 `('a', 'd', 'p1')`，故 3 列全部参与定界，即 `403 × 3 = 1209`！但中间如 `key_part2 = 'c'` 段的记录仍混有任意 `key_part3`，因此依然触发 ICP 过滤 |
| SQL 3 | `range` | `idx_key_part` | **`806`** | `Using index condition` | 两段 `OR` 分支均能使用 `idx_key_part`，合并为双区间 `[('a', 'b'), ('a', 'b')] ∪ ('h', +∞)`，`key_len` 取各区间用到的最大列宽 `403 × 2 = 806` |
| SQL 4 | `ALL` | `NULL` | `NULL` | `Using where` | 右侧 `OR` 分支 `common_field = 'val_1'` 无索引，在 `idx_key_part` 上等价于 `(-∞, +∞)`，并集退化为全表扫描 |

</details>

### 练习 2：综合运用降序索引、函数索引与冗余清理改造慢查询

工单表 `support_ticket` 当前定义与线上高频慢 SQL 如下：

```sql
CREATE TABLE support_ticket (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id INT NOT NULL,
  priority TINYINT NOT NULL,
  opened_at DATETIME NOT NULL,
  contact_email VARCHAR(128) NOT NULL,
  summary VARCHAR(200) NOT NULL,
  KEY idx_tenant (tenant_id)
) ENGINE=InnoDB CHARSET=utf8mb4;

-- 慢 SQL A：按租户筛选工单，要求优先级从高到低、同优先级按创建时间从早到晚取前 20 条
SELECT id, priority, opened_at FROM support_ticket
WHERE tenant_id = 7 ORDER BY priority DESC, opened_at ASC LIMIT 20;

-- 慢 SQL B：忽略大小写精确检索联系人邮箱
SELECT id, contact_email FROM support_ticket
WHERE LOWER(contact_email) = 'ops88@acme.io';
```

请编写一条 `ALTER TABLE` 语句完成索引优化并清理冗余索引，随后说明优化后两条 SQL 在 MySQL 8.4 中的执行计划变化。

<details>
<summary>查看参考答案</summary>

优化 DDL 及 MySQL 8.4.13 实测 `EXPLAIN` 结果如下：

```sql
ALTER TABLE support_ticket
  ADD INDEX idx_tenant_prio_open (tenant_id ASC, priority DESC, opened_at ASC),
  ADD INDEX idx_lower_contact ((LOWER(contact_email))),
  DROP INDEX idx_tenant;
```

**执行计划与设计依据**：
1. **慢 SQL A**：命中联合降序索引 `idx_tenant_prio_open`，`EXPLAIN` 显示 `type = ref`、`key_len = 4`、`Extra = Using index`。前导列 `tenant_id = 7` 等值定位后，紧随其后的 `(priority DESC, opened_at ASC)` 物理顺序与 `ORDER BY` 完全吻合，且查询列 `(id, priority, opened_at)` 全部包含在该二级索引叶子节点中，同时实现**零 `filesort` + 覆盖索引免回表 + 读满 20 行即停**。
2. **慢 SQL B**：双层括号函数索引 `((LOWER(contact_email)))` 建立了匹配的虚拟生成列索引，`EXPLAIN` 变为 `type = ref`、`key = idx_lower_contact`、`rows = 1`，消除全表扫描。
3. **冗余索引清理**：新增的 `idx_tenant_prio_open` 最左列即为 `tenant_id`，完全覆盖原单列索引 `idx_tenant` 的检索能力，同批 `DROP INDEX idx_tenant` 可减少每次写入的索引维护开销——线上大表建议先执行 `ALTER INDEX idx_tenant INVISIBLE` 灰度验证后再删除。

</details>

## 面试题 {#ch4-interview}

以下 3 道面试题聚焦 InnoDB 主键选型物理代价、联合索引闭开区间边界差异以及索引跳跃扫描的适用红线。代码与环境约定同[练习部分](#ch4-exercises)，建议先独立作答再展开核对。

### 面试题 1：为什么 InnoDB 表强烈建议使用短且单调递增的主键？直接用 36 位随机 UUID 字符串做主键会产生什么连锁后果？

<details>
<summary>查看参考答案</summary>

**结论**：短且单调递增的主键契合聚簇索引按主键物理有序排列的底层结构；直接用 36 位随机 `UUID` 字符串做主键会同时引爆**高频随机页分裂、Buffer Pool 命中率暴跌与二级索引体积成倍膨胀**三大灾难。

**关键依据**：
1. **页分裂与空间碎片**：自增主键每次插入都追加在最右侧叶子页尾部，上一页写满后顺序开辟新页，紧凑无搬移；随机 `UUID` 每次以大概率落入历史已满数据页中间，迫使引擎频繁执行**页分裂**与跨页记录拷贝，导致大量页面空间利用率跌至 `50%～60%` 且磁盘随机 I/O 激增。
2. **全表索引连带膨胀**：InnoDB 所有二级索引的叶子节点与内节点目录项都必须存储主键值。`CHAR(36)` 单键至少占 `36 B`——是 `8 B` `BIGINT` 的 `4.5` 倍——不仅让聚簇树变胖，更拖累每棵二级索引单页扇出度下降、树高增加并挤占宝贵的 Buffer Pool 内存。分布式场景若需全局唯一 ID，应改用趋势递增的 64 位雪花算法 ID，或用 MySQL 8.0+ 内置函数 `UUID_TO_BIN(UUID(), 1)` 将时间戳高位前置并压缩为 `16 B` `BINARY(16)`。

</details>

### 面试题 2：在联合索引 (a, b) 上，查询 WHERE a <= 'b' AND b = 'x' 与 WHERE a < 'b' AND b = 'x' 生成的扫描区间有何本质区别？

<details>
<summary>查看参考答案</summary>

**结论**：`<=` 能利用第 2 列 `b = 'x'` 进一步收紧扫描区间右边界（用到 **2 列**定界），而 `<` 只能用到第 1 列 `a` 定界（仅用到 **1 列**定界）。

**关键依据**：联合索引 `(a, b)` 先按 `a` 排序，仅在 `a` 值相等的记录段内 `b` 才有序。
- 当条件为 **`a <= 'b' AND b = 'x'`** 时，右边界包含 `a = 'b'` 这一段；在该段内 `b` 是严格升序排列的，因此引擎扫完 `('b', 'x')` 后即可确知后续的 `('b', 'y')`、`('b', 'z')` 均不满足条件而**提前终止扫描**，扫描区间为 `((-∞, -∞), ('b', 'x']]`，`EXPLAIN` 的 `key_len` 覆盖 `(a, b)` 两列。
- 当条件为 **`a < 'b' AND b = 'x'`** 时，结果集根本不包含 `a = 'b'` 的记录；而对于 `a < 'b'` 的最后一个不确定值（如 `'a'` 或 `'azzz'`），优化器无法预知其具体值，也就无法结合 `'x'` 截断尾部，只能生成单列开区间 `(-∞, 'b')`，`key_len` 仅计入 `a` 单列，`b = 'x'` 退化为 ICP 逐条过滤。

</details>

### 面试题 3：MySQL 8.0 引入索引跳跃扫描（Index Skip Scan）后，是不是再也不用遵守联合索引最左前缀原则了？

<details>
<summary>查看参考答案</summary>

**结论**：**绝不是**。索引跳跃扫描只是特定窄场景下的兜底补救优化，严苛的生效条件决定了联合索引设计仍必须严守最左前缀原则。

**关键依据**：Index Skip Scan（8.0.13+）的本质是优化器在缺失联合索引前导列时，主动枚举前导列的每一个不同取值，把查询重写成多次带等值前导列的子范围扫描。它面临四道硬性红线：
1. **必须是覆盖索引查询**：查询投影列必须全部包含在该联合索引内——只要 `SELECT *` 或多查任何一个需要回表的非索引列，跳跃扫描就会在 MySQL 8.4 中直接失效退化为全表扫描。
2. **前导列不同值（基数）必须极少**：仅适合性别、布尔标志、少量枚举状态做前导列；若前导列是用户 ID 或订单号等高基数列，枚举上万次子扫描的代价远超全表扫描，优化器会直接放弃。
3. **仅支持单表查询**，多表 `JOIN` 无法触发。
4. **查询中不能包含 `GROUP BY` 或 `DISTINCT`**。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual: 17.6.2.1 Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html)
- [MySQL 8.4 Reference Manual: 10.2.1.2 Range Optimization & Multiple-Part Index Ranges](https://dev.mysql.com/doc/refman/8.4/en/range-optimization.html)
- [MySQL 8.4 Reference Manual: 10.2.1.6 Index Condition Pushdown Optimization](https://dev.mysql.com/doc/refman/8.4/en/index-condition-pushdown-optimization.html)
- [MySQL 8.4 Reference Manual: 10.3.13 Descending Indexes](https://dev.mysql.com/doc/refman/8.4/en/descending-indexes.html)
- [MySQL 8.4 Reference Manual: 10.3.12 Invisible Indexes](https://dev.mysql.com/doc/refman/8.4/en/invisible-indexes.html)
- [MySQL 8.4 Reference Manual: 15.1.15 CREATE INDEX Statement — Functional Key Parts](https://dev.mysql.com/doc/refman/8.4/en/create-index.html#create-index-functional-key-parts)
- [MySQL 8.4 Reference Manual: 10.2.1.16 ORDER BY Optimization & GROUP BY Optimization](https://dev.mysql.com/doc/refman/8.4/en/order-by-optimization.html)
