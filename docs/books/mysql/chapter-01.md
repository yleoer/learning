---
title: 第 1 章 体系架构、配置变量与字符集链路
description: 厘清 MySQL 客户端通信、Server 层与插件式存储引擎边界，掌握 SET PERSIST 配置优先级与 utf8mb4 全链路转码规范。
---

# 第 1 章 体系架构、配置变量与字符集链路

## 本章要点

一条 SQL 从客户端发出到返回结果，依次跨越连接认证、Server 层解析优化、存储引擎物理读写以及字符集双向编解码。工程上常见的“修改全局变量却对当前连接无效”“重启后线上调优参数回退”“两表按字符串关联突然索引失效”等问题，根源都在这一基础链路中。本章首先拆解客户端通信协议、Server 层组件演进与主流存储引擎职责边界，随后梳理配置文件、`SET PERSIST` 与 `GLOBAL` / `SESSION` 系统变量的优先级规则，最后打通 `utf8mb4` 四级继承体系与客户端通信三变量转码机制。

> 核对日期：2026 年 11 月 17 日；核对环境为 MySQL 8.4.13、Linux/AMD64。

## 1.1 客户端通信与分层架构 {#ch1-1}

### 1.1.1 连接协议、Server 层与插件式存储引擎 {#ch1-1-1}

运行中的 `mysqld` 服务进程称为一个 **MySQL 实例**，客户端与实例之间支持三类进程间通信方式：

- **TCP/IP 套接字**：跨主机通信或显式指定 `-h 127.0.0.1` 时使用，默认监听 `3306` 端口；命令行中大写 `-P` 指定端口，小写 `-p` 紧贴密码且中间不能有空格。
- **UNIX 域套接字**：类 UNIX 同机未指定 `-h` 或指定 `-h localhost` 时默认走本地 `.sock` 文件，绕过网络协议栈，延迟与 CPU 开销更低。
- **命名管道与共享内存**：仅限 Windows 同机按需开启。

请求进入 `mysqld` 后，严格划分为**不关心底层物理文件格式的 Server 层**与**负责物理页读写的存储引擎层**：

```text
客户端连接 ──► [连接与线程管理 / TLS / 身份认证]  ┐
                        │                        │
                        ▼                        │ Server 层
              [词法语法解析器 Parser]            │（跨引擎通用：SQL 解析、重写、
                        │                        │  成本优化、MDL 锁、binlog）
                        ▼                        │
              [查询优化器 Optimizer ──► 执行器]  ┘
                        │  调用统一 Handler C++ 接口（按记录迭代交互）
                        ▼
        [InnoDB（默认） | TempTable | MyISAM | MEMORY ...]  ◄── 插件式存储引擎层
```

阅读原书或早期资料时，需特别注意 Server 层的三项现代版本变革：

1. **查询缓存（Query Cache）已于 MySQL 8.0.3 彻底移除**：早期 5.7 曾把查询缓存列为请求首站，但只要目标表发生任何一行增删改或 DDL，整张表关联的全部缓存即被粗粒度清空，多核高并发下全局缓存锁反而成为严重瓶颈。**MySQL 8.0 起已彻底删除查询缓存模块及 `query_cache_size`、`SQL_CACHE` 等全部变量与语法**，高频缓存应交由业务侧 Redis 或应用内存承担。
2. **默认认证插件升级与旧插件禁用**：自 MySQL 8.0.4 起默认认证插件由 `mysql_native_password` 升级为更安全的 **`caching_sha2_password`**；到了 **MySQL 8.4 LTS**，旧变量 `default_authentication_plugin` 已被移除（写入 `my.cnf` 会导致实例拒绝启动），且 `mysql_native_password` 默认处于禁用状态。
3. **记录级流式交互与条件下推**：执行器调用存储引擎 Handler 接口时以**单条记录**为单位循环拉取，而非一次性把整表装入 Server 层内存；配合索引条件下推（ICP，详见 [4.2.2 节](./chapter-04#ch4-2-2)）可在引擎层提前过滤不匹配的二级索引项，减少回表与跨层调用开销。

### 1.1.2 主流存储引擎核心能力对比 {#ch1-1-2}

自 MySQL 5.5.5 起 **`InnoDB`** 成为默认存储引擎；MySQL 8.0 还引入了专供内部内存临时表使用的 **`TempTable`** 引擎。常见引擎的核心边界对照如下：

| 对比维度 | `InnoDB`（默认） | `MyISAM` | `MEMORY` | `TempTable`（8.0+ 内部专用） |
| --- | --- | --- | --- | --- |
| **事务与崩溃恢复** | 支持标准 ACID、XA 与保存点 | 不支持 | 不支持 | 不支持（仅服务单次查询中间结果） |
| **最小锁粒度** | **行级锁** + 表级意向锁 | 仅表级锁 | 仅表级锁 | 会话私有，无跨连接锁竞争 |
| **MVCC 多版本读** | 支持（基于聚簇索引隐藏列与 Undo） | 不支持 | 不支持 | 不支持 |
| **索引与数据组织** | **聚簇索引**（索引即数据），辅以二级索引 | 堆表（`.MYD`）+ 非聚簇索引（`.MYI`） | 默认 Hash 索引，可选 B-Tree | 内存紧凑布局，支持变长列与溢出转盘 |
| **内存缓存范围** | Buffer Pool 同时缓存**数据页与索引页** | Key Cache **仅缓存索引**，数据靠 OS 页缓存 | 全量驻留内存，重启即清空 | 受 `temptable_max_ram`（默认 `1 GiB`）控制 |

日常可通过 `SHOW ENGINES;` 查看实例支持的引擎，或用 `ALTER TABLE tbl ENGINE = InnoDB;` 重建转换引擎并回收表空间碎片。

## 1.2 启动选项、系统变量与持久化优先级 {#ch1-2}

MySQL 的运行行为由启动配置与系统变量共同控制，编写配置或在线调参须把握以下四条硬规则：

1. **短划线与下划线的语法边界**：命令行启动选项与 `my.cnf` 配置文件中，多单词选项名里的 `-` 与 `_` 完全等价——例如 `--skip-networking` 等同于 `--skip_networking`；但在 **SQL 语句中读写系统变量时，名称必须且只能使用下划线 `_`**，如 `@@max_connections`。
2. **配置文件组与同名覆盖顺序**：服务端依次按系统级 `/etc/my.cnf` 或 `/etc/mysql/my.cnf` → `--defaults-extra-file` → 用户级读取配置文件；`[server]` 作用于所有服务端程序，`[mysqld]` 仅作用于实例进程。**多个配置文件或同一文件多个选项组出现同名参数时，一律以最后读取的位置为准**；若命令行传入 `--defaults-file=/path/my.cnf`，则仅读取该单一文件。
3. **`SET PERSIST` 改写了最高配置优先级（MySQL 8.0+）**：在 5.7 时代“命令行选项优先级最高”，且 `SET GLOBAL` 重启即失效；自 MySQL 8.0 引入持久化语法后，数据目录下的 JSON 文件 **`mysqld-auto.cnf`** 拥有最高最终覆盖权：

| 配置生效与持久化方式 | 修改内存 `GLOBAL` 值 | 写入 `mysqld-auto.cnf` | 适用场景与优先级说明（由高到低） |
| --- | :---: | :---: | --- |
| `SET PERSIST var = val;`（8.0+） | **是** | **是** | **优先级第 1（最高）**：在线改参并跨重启保留，避免漏改配置文件 |
| `SET PERSIST_ONLY var = val;`（8.0.2+） | 否 | **是** | 修改运行期只读变量——如 `innodb_buffer_pool_chunk_size`，供下次重启生效 |
| 命令行参数 `mysqld --var=val` | 启动初始化 | 否 | **优先级第 2**：高于普通 `my.cnf`，但会被 `mysqld-auto.cnf` 覆盖 |
| 普通配置文件 `my.cnf` | 启动初始化 | 否 | **优先级第 3**：按文件读取先后顺序后者覆盖前者 |

清理持久化配置使用 `RESET PERSIST [IF EXISTS] var_name;`，并可通过 **`performance_schema.variables_info`** 的 `VARIABLE_SOURCE` 列核查每个变量当前值究竟来自编译默认、指定配置文件、命令行还是 `PERSISTED`。

4. **`GLOBAL` 与 `SESSION` 作用域隔离**：绝大多数系统变量分属两级作用域。**执行 `SET GLOBAL var = val` 仅修改全局基准值，对后续新建的客户端连接生效，绝不会改变当前及已有连接中的 `SESSION` 值**！而 `SET var = val` 未写范围关键字时，**默认等价于 `SET SESSION`**。此外，`max_connections`（默认 `151`）实际允许 **`max_connections + 1`** 个并发连接，多出的 `1` 个专供拥有 `CONNECTION_ADMIN` 权限的管理员在连接池打满时登录排障——该细粒度权限于 8.0.14+ 取代了已弃用的 `SUPER` 权限。

与可调的系统变量相对，**状态变量**如 `Threads_running`、`Innodb_buffer_pool_read_requests` 由内核只读维护，通过 `SHOW [GLOBAL | SESSION] STATUS LIKE '...';` 观测运行健康度。

## 1.3 字符集、比较规则与通信转码链路 {#ch1-3}

### 1.3.1 utf8mb3 历史包袱与 utf8mb4_0900_ai_ci 默认规范 {#ch1-3-1}

**字符集**定义字符到二进制字节的编码映射及单字符最大字节数 `Maxlen`，**比较规则**（Collation）定义字符排序与判等规则。常见字符集特征对比如下：

| 字符集名称 | 单字符字节数（`Maxlen`） | 默认比较规则（MySQL 8.4） | 关键特性与版本演进边界 |
| --- | :---: | --- | --- |
| `ascii` / `latin1` | `1` | `ascii_general_ci` / `latin1_swedish_ci` | 单字节定长编码；纯英文 ASCII 编码串若无需多语言混排有时用于极致压缩，但需严防跨表字符集混用 |
| `gbk` | `1～2`（`2`） | `gbk_chinese_ci` | 兼容 ASCII 的双字节汉字编码，按拼音排序 |
| `utf8mb3`（旧别名 `utf8`） | `1～3`（`3`） | `utf8mb3_general_ci` | **历史残缺版 UTF-8**：无法存储 4 字节 Emoji 与生僻字；**8.0.28+ 已标记弃用**，`SHOW CREATE TABLE` 统一显示为 `utf8mb3` |
| **`utf8mb4`（8.0+ 默认）** | `1～4`（`4`） | **`utf8mb4_0900_ai_ci`** | **完整标准 UTF-8**：8.0 起成为服务端默认字符集，基于 Unicode 9.0 算法的 `_0900_ai_ci` 排序更准且比旧 `_general_ci` 更快 |

比较规则后缀直观标明了判等行为：`_ai` / `_as` 表示不区分 / 区分重音，`_ci` / `_cs` 表示不区分 / 区分大小写，`_bin` 表示直接按字节二进制值比较；需要区分大小写查询时可选用 `utf8mb4_0900_as_cs` 或 `utf8mb4_0900_bin`。

MySQL 按 **服务器 → 数据库 → 表 → 列** 四级就近继承字符集与比较规则，且任意一级**只改字符集会自动切为该字符集的默认比较规则，只改比较规则也会自动联动切换所属字符集**。日常维护需注意两处细节：

- **查看库级字符集**：原书使用的 `character_set_database` 变量在 MySQL 8.0+ 已标记弃用，应改用 `SHOW CREATE DATABASE db_name;` 或查询 `information_schema.SCHEMATA`。
- **修改表已有列的字符集**：`ALTER TABLE t DEFAULT CHARACTER SET utf8mb4;` **仅改变后续新增列的默认继承值，不会重写既有列**；将既有列一并重编码须执行 **`ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`**。

### 1.3.2 客户端通信三变量转码与隐式转换索引失效陷阱 {#ch1-3-2}

客户端发出的字节流在 Server 层经历三次会话级系统变量接力转换：

```text
客户端发出字节流
   │  1. Server 按 @@character_set_client 解码
   ▼
转码为 @@character_set_connection（纯字面量比较按 @@collation_connection 执行）
   │  2. 若与表列比较，自动转换为【表列自身的字符集与比较规则】（列级优先级更高！）
   ▼
存储引擎执行检索，结果按 @@character_set_results 编码发回客户端终端渲染
```

执行 `SET NAMES utf8mb4;` 等价于一次性将 `character_set_client`、`character_set_connection` 与 `character_set_results` 三个会话变量同步设为 `utf8mb4`；它不改变客户端终端自身的编码，只有终端编码与这三个变量一致才不会乱码。

**高频生产故障——跨表字符集或比较规则不一致引发隐式转换与索引失效**：当两张关联表的连接列字符集不同——例如新表 `u.order_no` 为 `utf8mb4`，而遗留表 `l.order_no` 为 `latin1` 且建有索引 `idx_order_no`——或同为 `utf8mb4` 但一方为 `utf8mb4_0900_ai_ci`、另一方为 `utf8mb4_general_ci` 时：

```sql
EXPLAIN SELECT * FROM orders_utf8mb4 u
JOIN orders_latin1 l ON u.order_no = l.order_no;
SHOW WARNINGS;
-- Warning 1739: Cannot use ref access on index 'idx_order_no' due to type or collation conversion on field 'order_no'
```

由于 `utf8mb4` 字符范围大于 `latin1`，MySQL 只能将 `latin1` 列向上转换为 `CONVERT(l.order_no USING utf8mb4)` 再与 `u.order_no` 比对——这相当于在被驱动表的索引列上套了一层函数，违反了[第 4 章 4.3 节](./chapter-04#ch4-3)“索引列单独出现在比较符一侧”的铁律，导致 `idx_order_no` 无法执行 `ref` 等值查找，被迫退化为全索引扫描配合 Hash Join！根治方法是统一全库表字符集为 `utf8mb4` 与统一的比较规则。

## 练习 {#ch1-exercises}

以下 2 道练习分别检验系统变量作用域及持久化行为判断，以及跨字符集连接导致索引失效的诊断与修复。建议先独立推演，再展开核对参考答案与 MySQL 8.4 实测依据。

### 练习 1：辨析 GLOBAL、SESSION 与 PERSIST 的生效范围

客户端连接 A 与连接 B 已同时登录同一台 MySQL 8.4 实例，初始 `wait_timeout` 均为默认值 `28800`。现依次在**连接 A** 中执行以下语句：

```sql
SET GLOBAL wait_timeout = 3600;
SELECT @@wait_timeout, @@GLOBAL.wait_timeout;
```

请回答：
1. 连接 A 的 `SELECT` 输出的两个数值分别是多少？连接 B 中执行 `SELECT @@wait_timeout;` 输出多少？随后新建的连接 C 中输出多少？
2. 若此时 DBA 重启 `mysqld`，重启后新建连接的 `wait_timeout` 是多少？应改用哪条命令才能既立即修改全局值又在重启后保留？

<details>
<summary>查看参考答案</summary>

1. **各连接读取结果**：
   - 连接 A 输出 **`28800`** 和 **`3600`**：`@@wait_timeout` 未加作用域前缀时等价于 `@@SESSION.wait_timeout`；修改 `GLOBAL` 变量绝不回写已存活会话的 `SESSION` 副本，故连接 A 自身会话仍为 `28800`，全局值为 `3600`。
   - 已存活的连接 B 同样输出 **`28800`**。
   - 新建立的连接 C 在握手初始化时从最新 `GLOBAL` 值拷贝会话变量，故输出 **`3600`**。
2. **重启影响与持久化方案**：
   - 仅执行 `SET GLOBAL` 只修改内存值，重启 `mysqld` 后会回退为配置文件值或编译默认值 **`28800`**。
   - 应改用 **`SET PERSIST wait_timeout = 3600;`**，该命令会同步更新内存 `GLOBAL` 值并将配置写入数据目录下的 `mysqld-auto.cnf`，重启后依然生效。

</details>

### 练习 2：诊断并修复比较规则冲突与索引失效

新库订单明细表 `order_item` 采用 MySQL 8.4 默认的 `utf8mb4` 与 `utf8mb4_0900_ai_ci`，而从旧库迁移来的商品表 `product` 保留了 `CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`，两表均在 `sku_code VARCHAR(32)` 上建有二级索引 `idx_sku`。执行以下关联查询时报错或性能骤降：

```sql
SELECT i.id, p.title
FROM order_item i
JOIN product p ON i.sku_code = p.sku_code
WHERE i.order_id = 10086;
```

请说明该 SQL 在 MySQL 8.4 下会发生什么现象，并给出永久治理 DDL 与无法立即改表时的临时应急改写方案。

<details>
<summary>查看参考答案</summary>

1. **运行现象**：同属 `utf8mb4` 字符集但列上显式或继承的比较规则分别为 `utf8mb4_0900_ai_ci` 与 `utf8mb4_general_ci`（可强制性级别相同且互不兼容）时，直接执行 `i.sku_code = p.sku_code` 会触发 **`ERROR 1267 (HY000): Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation '='`**；即便手工在被驱动表列上套 `COLLATE utf8mb4_0900_ai_ci` 绕过报错，也会导致 `p.sku_code` 上的 `idx_sku` 无法做 `ref` 查找！
2. **永久治理方案（推荐）**：在低峰期统一将旧表既有列转换至 `utf8mb4_0900_ai_ci`：
   ```sql
   ALTER TABLE product CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   ```
3. **无法立即改表时的应急改写**：将 `COLLATE` 转换加在**驱动表已由 `i.order_id = 10086` 过滤出的极少量结果列**一侧，保持被驱动表索引列 `p.sku_code` 裸露，从而让 `product` 正常命中 `idx_sku` 的 `ref` 访问：
   ```sql
   SELECT i.id, p.title
   FROM order_item i
   JOIN product p ON i.sku_code COLLATE utf8mb4_general_ci = p.sku_code
   WHERE i.order_id = 10086;
   ```

</details>

## 面试题 {#ch1-interview}

以下 3 道面试题聚焦架构组件取舍、配置持久化边界与字符集底层差异。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么 MySQL 8.0 彻底删除了查询缓存（Query Cache），而不是继续优化它？

<details>
<summary>查看参考答案</summary>

核心原因是**维护成本远高于收益，且在高并发写场景下会引发严重的锁争用**：

1. **命中率苛刻**：SQL 文本必须逐字节完全一致（多一个空格、注释或大小写差异即不命中），且含 `NOW()` 等非确定性函数的查询一律无法缓存。
2. **失效粒度极粗**：只要表上发生任意一行 `INSERT` / `UPDATE` / `DELETE`，该表关联的所有缓存条目会瞬间全部清空。
3. **全局锁瓶颈**：缓存的查找、写入与批量失效均需争抢受互斥锁保护的内存结构，多核机器上常导致大量线程卡在 `Waiting for query cache lock`。将缓存下沉至应用侧可控失效粒度的 Redis 或本地缓存，整体吞吐与可预测性远优于数据库内置查询缓存。

</details>

### 面试题 2：`SET PERSIST` 与 `SET PERSIST_ONLY` 有什么区别？如果有同事在 `my.cnf` 中修改了参数并重启，为什么参数值还是没变？

<details>
<summary>查看参考答案</summary>

1. **两者区别**：`SET PERSIST` 同时修改当前运行实例的内存 `GLOBAL` 值并写入数据目录下的 `mysqld-auto.cnf`；`SET PERSIST_ONLY` **不修改当前内存值**，仅写入 `mysqld-auto.cnf` 待下次重启生效，专门用于持久化像 `innodb_buffer_pool_chunk_size` 这类运行期只读的系统变量。
2. **`my.cnf` 修改不生效的原因**：`mysqld` 启动加载完所有常规配置文件和命令行参数后，**最后读取 `mysqld-auto.cnf`**。若此前有人对该参数执行过 `SET PERSIST`，`mysqld-auto.cnf` 中的旧持久化值会直接覆盖 `my.cnf` 的新值。可通过查询 `performance_schema.variables_info` 确认 `VARIABLE_SOURCE = 'PERSISTED'`，并执行 `RESET PERSIST 参数名;` 清除覆盖项。

</details>

### 面试题 3：MySQL 中的 `utf8` 与 `utf8mb4` 有什么区别？修改表字符集时 `ALTER TABLE t CHARSET=utf8mb4` 为什么没能解决旧列的 Emoji 报错？

<details>
<summary>查看参考答案</summary>

1. **`utf8` 与 `utf8mb4` 的区别**：MySQL 历史上的 `utf8` 实为 `utf8mb3` 的别名，单字符最多只存 `1～3` 字节，无法存入占 `4` 字节的 Emoji 表情与生僻汉字（已在 8.0.28+ 标记弃用）；`utf8mb4` 才是完整支持 `1～4` 字节的标准 UTF-8，且在 MySQL 8.0+ 中默认搭配更准确高效的 `utf8mb4_0900_ai_ci` 比较规则。
2. **旧列仍报错的原因**：`ALTER TABLE t [DEFAULT] CHARSET=utf8mb4` **只修改表级默认字符集属性**，仅对后续 `ADD COLUMN` 新增且未显式指定字符集的列生效，表内既有字符串列仍保留原有的 `utf8mb3` 定义！必须执行 `ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4;`（或单独 `MODIFY COLUMN`）才能将已有列的数据与元数据一并重编码为 `utf8mb4`。

</details>

## 参考资料

- [MySQL 8.4 Reference Manual：Pluggable Storage Engine Architecture](https://dev.mysql.com/doc/refman/8.4/en/pluggable-storage-overview.html)
- [MySQL 8.4 Reference Manual：Using Option Files](https://dev.mysql.com/doc/refman/8.4/en/option-files.html)
- [MySQL 8.4 Reference Manual：SET Syntax for Variable Assignment（PERSIST / PERSIST_ONLY）](https://dev.mysql.com/doc/refman/8.4/en/set-variable.html)
- [MySQL 8.4 Reference Manual：Character Sets, Collations, Unicode](https://dev.mysql.com/doc/refman/8.4/en/charset.html)
- [MySQL 8.4 Reference Manual：Connection Character Sets and Collations](https://dev.mysql.com/doc/refman/8.4/en/charset-connection.html)
