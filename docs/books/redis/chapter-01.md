---
title: 第 1 章 体系架构、RESP 协议与事件驱动 I/O 模型
description: 拆解内存键值引擎四大核心模块、RESP 2/3 通信协议与 ACL v2 权限模型，深入理解 epoll 事件循环与 Redis 8 异步多线程 I/O 引擎。
---

# 第 1 章 体系架构、RESP 协议与事件驱动 I/O 模型

## 本章要点

理解 Redis 的切入点不在于死记零散命令，而在于看清一条请求从客户端套接字发出、经协议解码与权限校验、在单线程事件循环中完成内存读写、再编码回传的完整闭环。工程中常见的“为什么单线程 Redis 吞吐能达十万至百万级”“为什么开启多线程后命令依然是原子的”“如何安全封禁高危命令并实施最小权限隔离”等问题，都取决于这一底座设计。本章先梳理键值数据库四大基础模块、RESP 2/3 协议与 ACL v2 权限体系，再剖析 `epoll` 多路复用事件循环及 Redis 6.0 至 Redis 8 的异步多线程网络演进。

> 核对日期：2026 年 11 月 17 日；核对环境为 Redis 8.10.3、Linux/AMD64。

## 1.1 键值引擎架构、RESP 协议与 ACL 权限控制 {#ch1-1}

### 1.1.1 四大核心模块与内存键值引擎边界 {#ch1-1-1}

与通过本地动态库（如 RocksDB `librocksdb.so`）嵌入业务进程的存储引擎不同，Redis 采用独立的网络服务端架构，核心由四大基础模块与两大集群支撑模块协同组成：

```text
客户端 ──(TCP / UNIX Socket + RESP 协议)──► [1. 访问框架：事件驱动网络 I/O + ACL 鉴权]
                                                       │
                                                       ▼
        [2. 索引模块：全局内存哈希表 O(1) 定位键] ──► [3. 操作模块：丰富数据类型原语与原子脚本]
                                                       │
              ┌────────────────────────────────────────┴────────────────────────────────────────┐
              ▼                                                                                 ▼
[4. 存储模块：jemalloc 内存分配器 + Multi-Part AOF / RDB]        [高可用与水平扩展：主从复制 + Sentinel + Cluster]
```

各模块的核心设计取舍直接决定了 Redis 的能力边界：

- **百纳秒级内存随机访问 + 哈希索引**：DRAM 随机访问延迟在百纳秒级，全局键空间采用哈希表实现 `O(1)` 寻址；找到目标键后，再按值对象的内部编码（如跳表、紧凑列表）执行二次操作。代价是内存成本高且断电易失，需要持久化模块兜底，且**不擅长跨海量键执行复杂关系型连接（JOIN）或多维扫描聚合**。
- **内存分配器解耦**：频繁增删不同尺寸的键值极易产生内存碎片，Redis 默认选用 **`jemalloc`** 按精细档位管理内存，而非直接使用 `glibc malloc`。

### 1.1.2 RESP 2 / RESP 3 通信协议编码规范 {#ch1-1-2}

客户端与服务端通过 **RESP**（Redis Serialization Protocol）文本二进制混合协议交互，每帧以首字节标识数据类型，并以 `\r\n`（CRLF）分隔结尾。

> [!WARNING]
> **原书协议兼容性与格式勘误**：原书加餐四声称“Redis 6.0 只支持 RESP 3，对 RESP 2 不兼容”，该说法与事实不符。直至 **Redis 8.x，新建客户端连接默认仍处于 RESP 2 模式**，完全向后兼容所有旧客户端；仅当客户端显式发送 `HELLO 3` 握手命令后，当前连接才会切换至 RESP 3。此外，原书将 Bulk String 误写为 `$9 testvalue\r\n`，标准规范中字节长度与正文之间**必须以 `\r\n` 分隔**。

RESP 2 的 5 种基础帧与 RESP 3（Redis 6.0+ 引入）的核心扩展对照如下：

| 帧类型 | 首字符 | 协议版本 | 编码示例（`\r\n` 显式标出） | 核心语义与二进制安全边界 |
| --- | :---: | :---: | --- | --- |
| 简单字符串 | `+` | RESP 2+ | `+OK\r\n` | 非二进制安全状态回复，内容不能含 `\r` 或 `\n` |
| 错误回复 | `-` | RESP 2+ | `-ERR unknown command\r\n` | 首词为错误码（如 `ERR`、`WRONGTYPE`、`MOVED`） |
| 64 位整数 | `:` | RESP 2+ | `:100\r\n` | 有符号 64 位整型结果（如 `INCR`、`LLEN` 返回值） |
| 批量字符串 | `$` | RESP 2+ | `$9\r\ntestvalue\r\n` | **二进制安全**：按前缀字节长度精确读取，可含 `\0`，上限 `512 MiB`；RESP 2 空值为 `$-1\r\n` |
| 数组 | `*` | RESP 2+ | `*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n` | 客户端发送的所有命令均为 Bulk String 数组 |
| 空值 / 布尔 / 浮点 | `_` / `#` / `,` | RESP 3 | `_\r\n`、`#t\r\n`、`,3.14\r\n` | 消除 RESP 2 将浮点数、空值混入字符串需客户端二次解析的开销 |
| 字典 / 集合 / 推送 | `%` / `~` / `>` | RESP 3 | `%1\r\n$2\r\nf1\r\n$2\r\nv1\r\n` | 原生区分 `HGETALL` 字典与普通列表；`>` 帧支撑客户端缓存失效主动推送（见 [7.1.3 节](./chapter-07#ch7-1-3)） |

### 1.1.3 ACL v2 细粒度权限控制与高危命令封禁 {#ch1-1-3}

在 Redis 6.0 之前，实例仅靠单一全局密码 `requirepass` 鉴权，并依赖 `rename-command KEYS ""` 重命名封禁危险命令——**`rename-command` 在 Redis 7.0+ 已正式标记弃用**。现代生产环境统一使用 **ACL**（6.0 引入，7.0 升级为支持读写分离与选择器的 **ACL v2**）按“用户 + 命令集 + 键前缀 + Pub/Sub 频道”实施最小权限控制：

```bash
# 创建仅允许对 cache:* 读、对 session:* 读写的业务账号，启用连接探活并封禁危险命令集
127.0.0.1:6379> ACL SETUSER app_svc on >StrongPass#2026 (%R~cache:* +@read) (%RW~session:* +@read +@write) +ping -@dangerous
OK
```

编写 ACL 规则须避开两个高频陷阱：

1. **密码前缀 `>` 后严禁加空格**：必须紧贴写为 `>StrongPass#2026`（原书误写为 `> abc` 会直接报未知修饰符语法错误）。
2. **`+@read` 不包含连接探活命令 `PING`**：`PING` 归属 `@fast` 与 `@connection` 类别；连接池通常在借出连接时发送 `PING`，若只授权 `+@read` 而漏写 `+ping`（或 `+@connection`），客户端初始化即报 `NOPERM User ... has no permissions to run the 'ping' command`。

## 1.2 单线程事件循环与异步多线程 I/O 引擎 {#ch1-2}

### 1.2.1 “单线程”精确边界与无锁设计收益 {#ch1-2-1}

常说的“Redis 是单线程的”，严格是指 **键值对读写命令的执行由唯一主线程串行完成**；而 RDB 快照生成、AOF 重写由 `fork` 出的**子进程**承担，文件关闭、`fsync` 刷盘、`UNLINK` 大键惰性释放由后台 **BIO 线程**承担，网络套接字读写与协议解析在开启多线程后则由 **I/O 线程**并行分担。

核心命令执行坚持单线程的根本原因在于：Redis 瓶颈通常在内存容量与网络带宽而非 CPU 算力。一旦允许多个工作线程并发修改同一个 `Hash`、`List` 或跳表，就必须为底层精细数据结构全面引入互斥锁或原子同步原语——锁竞争、线程上下文切换与 CPU L1/L2 缓存失效不仅会吞噬多核并行收益，还会破坏单命令与 Lua 脚本天然的无锁原子性。

### 1.2.2 epoll 多路复用与非阻塞事件回调流程 {#ch1-2-2}

单线程之所以不会卡死在某个慢速客户端连接上，核心在于将监听套接字（`listen`）与已连接套接字（`accept` 返回）全部设为**非阻塞模式**，并交由操作系统内核的 I/O 多路复用器（Linux 下为 `epoll`，macOS/BSD 下为 `kqueue`）统一监控：

```text
多个客户端 Socket FD ──► 内核 epoll_ctl 注册监听
                                │
          主线程调用 epoll_wait 阻塞等待任一 FD 就绪（零空转轮询）
                                │ 返回就绪事件列表
                                ▼
          用户态事件循环 aeProcessEvents 按序分发回调（非内核态直接回调！）
             ├── Accept 事件 ──► acceptTcpHandler（建立非阻塞连接并注册可读事件）
             ├── Read 事件   ──► readQueryFromClient（读取解析命令 -> 查表执行 -> 写入输出缓冲）
             └── Write 事件  ──► sendReplyToClient（将输出缓冲区响应刷回客户端套接字）
```

需注意一处常见概念混淆：**操作系统内核并不会直接跨态调用用户空间的回调函数**；`epoll_wait` 只是将已就绪的文件描述符列表返回给 Redis 主线程，再由主线程在用户态事件循环 `aeProcessEvents` 中依次执行对应的事件处理器。因此，只要某条命令自身执行耗时过长（如全量扫描百万元素集合），整个事件循环就会被原地卡住，这也是 [第 4 章](./chapter-04#ch4-1) 阻塞治理的核心对象。

### 1.2.3 从 Redis 6.0 同步屏障到 Redis 8 异步多线程 I/O {#ch1-2-3}

随着万兆网卡普及，单机十万级以上 QPS 场景中，内核态到用户态的 `read`/`write` 系统调用拷贝及 RESP 协议解析会占去主线程大部分 CPU 时间。为此，Redis 在保留**主线程单线程串行执行命令**的前提下，对网络 I/O 多线程历经了两代演进：

| 对比维度 | Redis 6.0 / 7.x 初代多线程 I/O | Redis 8 全新异步多线程 I/O 引擎 |
| --- | --- | --- |
| **开启配置** | 需同时配 `io-threads N` 与 `io-threads-do-reads yes`（默认仅写多线程） | **仅需配置 `io-threads N`**（默认 `1`；`io-threads-do-reads` 已彻底废弃移除） |
| **协作模型** | **同步屏障自旋等待**：主线程分发就绪连接后，必须自旋干等所有 I/O 线程全部读完，再串行执行命令，随后再干等所有 I/O 线程全部写完 | **事件驱动异步流水线**：主线程将客户端连接直接托管给独立事件循环的 I/O 线程；I/O 线程异步完成 `epoll` 监听、Socket 读取、RESP 解析及结果回写，仅把解析好的命令批次推给主线程无锁执行 |
| **命令原子性** | 主线程单线程串行执行命令，完全无锁 | **依然由主线程单线程串行执行命令**，事务与脚本原子性零变化 |
| **多核加速比** | 受限于每轮同步屏障空等，扩展性有限 | 消除主线程忙等待，8 核环境下吞吐最高提升约 **100%+**（单实例突破百万 QPS） |

生产环境中，若单实例 QPS 未达 5 万以上、主线程 CPU 利用率未接近饱和，保持默认 `io-threads 1` 即可；当网络读写确实成为瓶颈时，可在 8 核及以上机器将 `io-threads` 设为 `4～8`（预留核心给主线程、BIO 线程与操作系统中断）。

## 练习 {#ch1-exercises}

以下 2 道练习分别检验 RESP 2 报文编码与协议握手规则，以及生产环境 ACL v2 最小权限排错。建议先独立作答，再展开核对参考答案。

### 练习 1：手写 LPUSH / LRANGE 的 RESP 2 报文并辨析协议返回差异

假设客户端刚刚与 Redis 8.10.3 建立默认 TCP 连接，依次执行以下两条命令：

```bash
LPUSH metrics 10 3.5 ok
LRANGE metrics 0 -1
```

请回答：
1. 列表内元素的实际排列顺序是什么？写出服务端对 `LRANGE metrics 0 -1` 返回的**精确原始 RESP 2 报文**（显式标出 `\r\n`）。
2. 为何整数 `10` 和小数 `3.5` 在该报文中没有使用 `:` 或 `,` 首字符？若客户端希望 `HGETALL` 直接返回字典类型、`ZSCORE` 直接返回浮点数类型，应在连接初始化时发送什么命令？

<details>
<summary>查看参考答案</summary>

1. **元素顺序与精确 RESP 2 报文**：
   - `LPUSH` 依次从列表头部插入 `10`、`3.5`、`ok`，因此列表从头到尾顺序为 **`ok`、`3.5`、`10`**。
   - 在默认 RESP 2 模式下，集合响应一律编码为 `*` 数组，且数组内所有元素无论原本字面形态如何，在 List 中均存储并编码为二进制安全的 `$` 批量字符串（Bulk String）：
     ```text
     *3\r\n$2\r\nok\r\n$3\r\n3.5\r\n$2\r\n10\r\n
     ```
2. **类型编码原因与 RESP 3 升级方式**：
   - 一方面，Redis List 底层存储的就是字节序列而非强类型数值；另一方面，RESP 2 本身没有独立的浮点数类型，且集合命令统一返回扁平 `*` 数组。
   - 客户端只需在建连握手时发送 **`HELLO 3`**（可附带 `AUTH username password` 一步完成鉴权与协议切换），当前连接即升级为 **RESP 3**，此后 `HGETALL` 将返回 `%` 字典帧、`ZSCORE` 将返回 `,` 双精度浮点数帧。

</details>

### 练习 2：排查并修复微服务 ACL v2 权限配置故障

某运维同学为订单只读查询服务创建 ACL 账号时执行了如下命令：

```bash
ACL SETUSER order_ro on > Ord#2026 ~order:* +@read -@dangerous
```

结果命令直接报错；去掉空格修复密码后，Java 应用启动连接池（Lettuce / Jedis）初始化健康检查时依然抛错：`NOPERM User order_ro has no permissions to run the 'ping' command`；此外，该服务还需要向频道 `order:events` 发布通知。请指出原命令的所有问题，并写出完整的修复命令。

<details>
<summary>查看参考答案</summary>

1. **三处问题定位**：
   - **密码语法错误**：`>` 与密码 `Ord#2026` 之间多写了空格，Redis 会把 `>` 解析为空密码修饰符，再把 `Ord#2026` 当成非法权限词报错。
   - **遗漏连接探活权限**：`+@read` 仅包含键值只读命令，不包含属于 `@connection` 类别的 `PING`、`ECHO`、`CLIENT` 等连接管理命令，导致连接池探活失败。
   - **未配置 Pub/Sub 频道与发布命令权限**：ACL v2 默认新建用户无频道权限（或受 `acl-pubsub-default` 限制），需显式授予 `&order:events` 频道权限及 `+publish`（或 `+spublish`）命令权限。
2. **完整修复命令**：
   ```bash
   ACL SETUSER order_ro reset on >Ord#2026 ~order:* &order:events +@read +ping +publish -@dangerous
   ```

</details>

## 面试题 {#ch1-interview}

以下 3 道面试题聚焦单线程架构本质、多路复用非阻塞机制与多线程演进边界。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么常说 Redis 是单线程的，却能轻松支撑十万级以上 QPS？既然多核普遍，为什么不把命令执行也改成多线程？

<details>
<summary>查看参考答案</summary>

1. **单线程为何极快**：① 绝大部分读写纯在百纳秒级**内存**中完成；② 采用哈希表、跳表、`listpack` 等**高效紧凑数据结构**；③ 基于 **`epoll` I/O 多路复用与非阻塞套接字**，单线程即可同时托管数万并发连接而无阻塞空等；④ 省去了多线程上下文切换与锁竞争开销。
2. **命令执行不改多线程的原因**：键值集合结构（如 Hash、ZSet、List）内部状态复杂，多线程并发读写必须引入细粒度锁或复杂并发控制——不仅高并发锁争用会导致吞吐不升反降、代码复杂度暴增，还会破坏 Redis 单命令、事务与 Lua 脚本天然的无锁串行原子性。因此 Redis 选择将耗时的网络 I/O 解析回写、磁盘 `fsync` 与大键释放交给多线程/子进程，而让核心内存状态机保持纯粹单线程。

</details>

### 面试题 2：如果某个客户端发送请求发了一半突然网络卡死或断连，会阻塞 Redis 处理其他客户端的请求吗？

<details>
<summary>查看参考答案</summary>

**完全不会阻塞。**

Redis 将监听套接字与所有已连接客户端套接字均设置为**非阻塞模式**，并通过 `epoll` 监听可读/可写事件。当某客户端报文只发了一半卡住时，主线程从非阻塞 `read` 读出当前已到达的字节存入该客户端专属的输入缓冲区（`querybuf`）后立即返回，继续处理事件队列中其他已就绪的客户端请求；待该慢客户端后续字节到达内核缓冲区再次触发可读事件时，才拼齐完整 RESP 命令予以执行。同理，客户端断连只是触发可读事件返回 `0`（EOF），主线程回收该连接结构即可。

</details>

### 面试题 3：Redis 6.0 的多线程与 Redis 8 的多线程有什么区别？把 `io-threads` 设为 `8` 后，执行 `INCR` 或 Lua 脚本还需要额外加锁吗？

<details>
<summary>查看参考答案</summary>

1. **两代多线程区别**：Redis 6.0/7.x 采用**同步屏障模型**——默认仅多线程写，读需额外开启 `io-threads-do-reads yes`，且主线程每轮都需自旋等待所有 I/O 线程读写完毕；**Redis 8 重构为事件驱动异步多线程引擎**——废弃 `io-threads-do-reads`，配置 `io-threads 8` 后各 I/O 线程独立轮询事件循环，异步完成套接字读取、RESP 协议解析和结果回写，消除主线程空等，多核吞吐最高翻倍。
2. **无需额外加锁**：无论 `io-threads` 设为多少，I/O 线程**只负责网络字节流收发与协议编解码**，绝不直接读写键值数据库；所有解析完毕的命令仍统一交由**唯一主线程按序串行执行**，`INCR` 与 Lua 脚本的原子性不受任何影响。

</details>

## 参考资料

- [Redis Official Documentation：RESP Protocol Specification（RESP2 & RESP3）](https://redis.io/docs/latest/develop/reference/protocol-spec/)
- [Redis Official Documentation：Access Control Lists（ACL v2）](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)
- [Redis 8.0 Release Notes：New Asynchronous I/O Threading & Unified Distribution](https://redis.io/blog/redis-8-ga/)
- [Redis Source Code：`src/ae.c` & `src/networking.c`（Event Loop & Async I/O Threads）](https://github.com/redis/redis/tree/8.0/src)
