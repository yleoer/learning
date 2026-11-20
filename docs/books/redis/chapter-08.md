---
title: 第 8 章 原子操作、分布式锁、事务 ACID 与高并发秒杀实战
description: 掌握 RMW 并发竞态控制、Lua 与 Redis Functions、分布式锁看门狗与 Redlock 安全性边界、MULTI/EXEC ACID 检验及高并发秒杀架构。
---

# 第 8 章 原子操作、分布式锁、事务 ACID 与高并发秒杀实战

## 本章要点

尽管 Redis 主线程执行单条命令天然互斥，但真实业务往往是由“先读取、再条件判断、最后修改写回（Read-Modify-Write, RMW）”组成的多步复合逻辑——一旦多个客户端并发交错执行，超发、超卖、限流越界与误删他人锁等严重事故便接踵而至。本章系统梳理 Redis 并发控制的全套武器库与架构边界：首先对比单命令原子原语、无越界 Lua 脚本与 **Redis 7.0+ Functions** 持久化函数库；随后剖析单节点分布式锁、Watchdog 续期看门狗及 **Redlock 与 Fencing Token（栅栏令牌）的安全性定论**；最后逐项检验 `MULTI`/`EXEC`/`WATCH` 对 ACID 的真实支持度，并落地一套防超卖、防少卖、抗十万级 QPS 的秒杀系统设计闭环。

> 核对日期：2026 年 11 月 17 日；核对环境为 Redis 8.10.3、Linux/AMD64。

## 8.1 并发竞态控制、Lua 脚本与 Redis Functions {#ch8-1}

### 8.1.1 RMW 并发竞态、原子单命令与防越界 Lua 限流器 {#ch8-1-1}

当两个客户端同时执行三步伪代码 `v = GET(k); v = v - 1; SET(k, v)`（初值 `10`）时，若客户端 A 与 B 先后执行完 `GET` 均拿到 `10`，各自减 `1` 后写回 `9`，两次扣减实际只扣了 `1`——这就是典型的 **RMW 并发竞态**。

Redis 提供两级无锁原子化手段消除竞态：

1. **单步数值修改直接用内置原子命令**：如 `INCR` / `DECR` / `INCRBY` / `HINCRBY`；条件初始化用 `SET key val NX EX 60`。
2. **多步条件读写必须完整包入同一段 Lua 脚本**：Redis 主线程将整个 Lua 脚本作为一个不可分割的整体串行执行，期间绝不会插入任何其他客户端的命令。

> [!WARNING]
> **订正原书第 29 / 34 / 41 讲 IP 限流代码的并发越界漏洞（TOCTOU）**：原书答疑称“先在客户端执行 `GET(ip)` 判断是否超过 20 次，未超过再调用 Lua 脚本执行 `INCR + 首次 EXPIRE`”是安全的——**这在高并发下存在严重漏洞**！当计数已达 `19` 或 `20` 时，50 个并发请求在脚本外同时执行 `GET` 都会看到未超限并全部冲进脚本执行 `INCR`，导致瞬间放行 70 个请求（且原书写 `> 20` 从 1 计数实际放行了 21 次）！
>
> **铁律**：所有参与临界条件判断的 `GET` 必须与 `INCR`、`EXPIRE` 一同放入脚本内部，且脚本内严禁包含无关耗时计算：

```lua
-- 完整无竞态固定窗口限流脚本（KEYS[1]=限流键, ARGV[1]=上限次数, ARGV[2]=窗口秒数）
-- 注意：Lua 注释符必须是双短横线 "--"（订正原书第 36 讲误用 "#" 导致语法报错的笔误！）
local cur = tonumber(redis.call("GET", KEYS[1]) or "0")
if cur >= tonumber(ARGV[1]) then
    return 0
end
cur = redis.call("INCR", KEYS[1])
if cur == 1 then
    redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return 1
```

### 8.1.2 Redis 7.0+ Functions（FUNCTION LOAD / FCALL）持久化管理 {#ch8-1-2}

传统的 `EVAL` 每次需传输完整脚本文本浪费带宽；而改用 `SCRIPT LOAD` + `EVALSHA` 虽只传 40 位 SHA1 摘要，但脚本**仅暂存于实例内存缓存中**——一旦实例重启、执行 `SCRIPT FLUSH` 或挂载新从库，客户端调用 `EVALSHA` 就会抛出 `NOSCRIPT` 错误，迫使业务 SDK 编写复杂的异常捕获重载兜底逻辑。

**自 Redis 7.0 起引入 Functions（服务端一等公民函数库）**，将脚本与数据同等纳入 **RDB / Multi-Part AOF 自动持久化与主从自动复制链路**，成为现代 Redis 8 生产编写原子逻辑的首选范式：

```bash
# 1. 注册名为 stock_lib 的服务端持久化函数库（自动写入 AOF 并同步给所有从库）
redis-cli FUNCTION LOAD "#!lua name=stock_lib
redis.register_function('deduct_sku', function(keys, args)
  local remain = tonumber(redis.call('HGET', keys[1], 'avail') or '0')
  local buy = tonumber(args[1])
  if remain < buy then return 0 end
  redis.call('HINCRBY', keys[1], 'avail', -buy)
  redis.call('HINCRBY', keys[1], 'sold', buy)
  return buy
end)"

# 2. 业务客户端直接按函数名原子调用：1 个键名参数 sku:1001，扣减数量 2
redis-cli FCALL deduct_sku 1 sku:1001 2
```

对于纯只读聚合函数，还可声明 `flags = { 'no-writes' }` 并通过 **`FCALL_RO`** 安全路由至只读从节点执行。

## 8.2 分布式锁演进、续期看门狗与 Redlock 安全性辨析 {#ch8-2}

### 8.2.1 单节点安全加解锁原语与 Watchdog 自动续期 {#ch8-2-1}

跨多台应用服务器互斥访问共享资源时，基于单主 Redis 节点构建分布式锁必须同时满足**互斥性、防死锁与防误删**三项铁律：

1. **原子加锁原语**：严禁拆成 `SETNX` + `EXPIRE` 两条独立命令（两步间客户端崩溃会导致锁永不过期死锁！），必须使用单条原子命令绑定**客户端全局唯一请求标识 `req_uuid`**（如 `UUID + thread_id`，绝不能写死常量 `1`）与毫秒级过期时间：
   ```bash
   SET lock:order:9001 "550e8400-e29b:tid-42" NX PX 30000
   ```
2. **原子校验解锁原语**：释放锁时绝不能直接调 `DEL`——若客户端 A 因业务卡顿超过 `30s` 锁已自动过期并被客户端 B 抢走，此时 A 苏醒直接 `DEL` 就会**误删客户端 B 的锁**！必须用 Lua 脚本或 Function 原子完成“读取比对唯一标识 + 一致才删除”：
   ```lua
   if redis.call("GET", KEYS[1]) == ARGV[1] then
       return redis.call("DEL", KEYS[1])
   else
       return 0
   end
   ```
3. **Watchdog（看门狗）自动续期机制**：若业务正常执行偶尔超过 `30s` 怎么办？成熟客户端框架（如 Redisson）在加锁成功后会启动一个后台定时任务（每 `30 ÷ 3 = 10s` 触发一次）：只要当前进程持锁线程仍在执行临界区代码，就通过 Lua 脚本校验 `req_uuid` 一致后将锁 TTL 重置回 `30000ms`；一旦客户端进程宕机，看门狗随之消失，锁最多 `30s` 后必定自动释放。

### 8.2.2 Redlock 多数派算法与 Fencing Token 正确性边界 {#ch8-2-2}

单主从架构下存在一个已知容灾短板：客户端 A 在主库加锁成功返回后，主库尚未把该键异步复制给从库便突然断电；哨兵将从库提升为新主库后，新主库上没有这把锁，客户端 B 也能成功加锁，导致双客户端同时持锁。

为此，Antirez 提出了部署 **`N` 个完全独立无主从关系的 Redis 实例（通常 `N = 5`）** 的 **Redlock 算法**：客户端记录起始时间 `T1`，依次以极短网络超时向 5 个节点用相同键值请求 `SET ... NX PX <TTL>`；记录结束时间 `T2`，**仅当在至少 `⌊N/2⌋ + 1 = 3` 个节点加锁成功，且总耗时 `(T2 - T1) < TTL` 时才判定加锁成功**（实际有效锁时长扣减为 `TTL - (T2 - T1)`）；否则必须向全部 5 个节点广播 Lua 解锁脚本清理残留锁。

> [!IMPORTANT]
> **架构师必知定论——Martin Kleppmann 对 Redlock 的批判与工程选型准则**：
> 分布式系统学者 Martin Kleppmann（《数据密集型应用系统设计》作者）指出，Redlock 依然无法提供 100% 强一致互斥：① 若客户端 1 拿到 Redlock 后在写存储前发生长达数十秒的 **GC STW（Stop-The-World）全局停顿**或系统时钟跳变，期间锁已过期并由客户端 2 合法获取，客户端 1 从 GC 醒来后浑然不知仍把旧数据覆盖写入后端存储；② Redlock **无法生成全局单调递增的栅栏令牌**（Fencing Token）供后端存储校验拦截滞后写请求。
>
> **现代工程选型二分法**：
> - **效率型锁（Efficiency Lock，占业务 95%）**：加锁目的是避免重复计算或防缓存击穿并发查库，极端秒级主从切换偶发重入不会造成资损——**直接使用单主从/Cluster 上的 `SET NX PX + Lua 解锁 + Watchdog` 即可**，无需承担维护 5 套独立实例的高昂成本去跑 Redlock。
> - **正确性型锁（Correctness Lock，金融核心/强互斥状态机）**：一旦重入会引发资损或数据损坏——**不应依赖任何形态的 Redis 锁（含 Redlock）作为唯一屏障**！应选用基于 Raft/ZAB 强一致共识算法的 **etcd（Lease + Revision）或 ZooKeeper（临时顺序节点 + zxid）** 获取单调递增 Fencing Token，并在最终落库的数据库层面配合唯一约束或乐观锁版本号（`WHERE version = old_ver`）做终极兜底。

## 8.3 MULTI / EXEC 事务 ACID 检验与秒杀系统实战 {#ch8-3}

### 8.3.1 语法错误 vs 运行期错误：Redis 事务 ACID 逐项判定 {#ch8-3-1}

Redis 通过 `MULTI`（开启事务入队模式）、`EXEC`（批量串行执行队列命令）、`DISCARD`（清空放弃队列）与 `WATCH`（乐观锁监控键变更）实现轻量事务。**注意：Redis 引擎内部没有 Undo 回滚日志，不支持事务回滚（Rollback）**！其对标准 ACID 四属性的真实支持边界如下（订正原书第 31 讲文末将语法错误与运行期错误写反的笔误）：

| ACID 维度 | Redis `MULTI` / `EXEC` 真实行为与边界判定 |
| --- | --- |
| **原子性（A）** | **仅防入队语法错，不防运行期逻辑/类型错（不满足严格原子性）**：<br>① **入队阶段检出命令拼写或参数个数语法错误**：`EXEC` 直接返回 `EXECABORT` 整体丢弃，一条都不执行；<br>② **入队通过、但 `EXEC` 运行期发生错误**（如对 String 键执行 `LPOP` 报 `WRONGTYPE`）：**报错的那条命令失败，但同事务前面已执行的命令绝不回滚，后面的正确命令依然继续执行成功**！ |
| **一致性（C）** | 引擎数据结构自身不会损坏；但因运行期部分失败不回滚，**无法保障跨键业务不变量守恒**（如扣款报错失败但加款继续成功） |
| **隔离性（I）** | `EXEC` 提交后单线程一次性串行跑完，天然隔离；`EXEC` 提交前需在 `MULTI` 前显式调用 **`WATCH key`**——若提交前被其他连接修改过，`EXEC` 整体放弃返回 `nil` |
| **持久性（D）** | 完全取决于持久化策略：仅在 `appendfsync always`（或紧跟 `WAITAOF`）下确认落盘，默认 `everysec` 仍有 1 秒丢数窗口 |

> [!TIP]
> **现代开发准则**：由于 `MULTI`/`EXEC + WATCH` 既无运行期回滚，又无法读取前一步结果做分支判断，且高并发下 `WATCH` 乐观锁冲突会导致海量无效重试耗尽吞吐，**生产中凡涉及多步原子读写逻辑，一律优先使用 Redis Functions（`FCALL`）或 Lua 脚本替代 `MULTI`/`EXEC`**。

### 8.3.2 高并发秒杀流量漏斗、库存子键分片与原子扣减闭环 {#ch8-3-2}

秒杀场景具有**瞬时十万级 QPS、99% 以上读查验与极少量有效下单**的极端特征，必须通过分层漏斗与分片原子扣减协同承载：

```text
[1. 秒杀前/接入层] 静态页推 CDN + 网关层黑名单/令牌桶限流（拦截 90%+ 无效刷单流量）
          │
          ▼
[2. Redis 集群原子预扣层（物理独立实例池，库存键永不过期防击穿！）]
    将单品 1000 件总库存拆分为 10 个分片子键：sku:99:seg_0 ～ sku:99:seg_9（每片 100 件）
    客户端随机路由分片 ──► 调用 FCALL deduct_sku 一步原子完成“余量校验 + 扣减 avail + 增加 sold”
          │  返回 0 则直接毫秒级响应“已售罄”，绝不触碰后端 MySQL！
          ▼  返回成功扣减数 (> 0)
[3. 异步落库与超时回补层] 发送可靠 MQ 异步创建 MySQL 订单；若超时未支付或落库最终失败，调回补函数归还库存
```

实施秒杀扣减务必守住三条红线（订正原书第 36 讲伪代码隐患）：

1. **严禁“先查库存再扣减”分离执行，也严禁用 `DECRBY` 扣成负数后不加回就抛弃**：若某商品余量仅剩 `1` 件，某用户请求购买 `2` 件，假若直接执行 `DECRBY stock 2` 得到 `-1` 判定失败却忘记立即 `INCRBY stock 2` 归还，最后那 `1` 件库存就会被永久吞掉造成**少卖**！使用 `8.1.2 节` 中的 `deduct_sku` 函数“先在 Lua 内判够减再执行 `HINCRBY -buy`”可同时 100% 杜绝**超卖**与**少卖**。
2. **Cluster 下单品库存分片必须在键名上显式拆分子键**：若总库存为 `1000` 件、瞬时并发达 `20 万 QPS`，单个分片主节点仍可能吃紧。需在业务层将库存预拆为 `sku:99:seg_0` ～ `sku:99:seg_9` 十个不同键（切勿加 `{sku:99}` Hash Tag，否则又聚回同一槽！），使其散列到 10 台主节点并行承接扣减；若某子键率先售罄，客户端可顺延轮询下一个子键。
3. **秒杀集群与日常核心业务集群物理隔离**：防止大促极端流量波及日常登录、购物车等基础链路。

## 练习 {#ch8-exercises}

以下 2 道练习分别检验有缺陷并发限流代码的漏洞审计与 Functions 改造，以及单品十万级 QPS 秒杀预扣与取消回补完整实现。建议先独立编写，再展开核对参考答案。

### 练习 1：审计两段线上限流代码缺陷并重构为 Redis Function

某网关限制单个用户在 `60` 秒窗口内最多调用短信接口 `5` 次，实习生先后提交了两版伪代码：
- **版本 A（纯客户端命令拼装）**：`cnt = redis.Incr("sms:" + uid); if cnt == 1 { redis.Expire("sms:" + uid, 60) }; return cnt <= 5`
- **版本 B（脚本外先读）**：先执行 `if int(redis.Get("sms:" + uid)) >= 5 { return false }`，未超限再调用 Lua 脚本执行 `INCR` 与首次 `EXPIRE`。

请指出版本 A 与版本 B 在生产环境各自会引发什么严重故障，并写出基于 Redis 8 `FUNCTION LOAD` 的无缺陷持久化函数实现。

<details>
<summary>查看参考答案</summary>

1. **两版代码的致命缺陷**：
   - **版本 A（永久封禁死锁故障）**：`INCR` 与 `EXPIRE` 是两条独立网络请求。若客户端刚执行完 `INCR` 返回 `1`，此时应用进程恰好崩溃重启、容器被驱逐或网络闪断，导致 `EXPIRE` 未能发出，该键 `sms:<uid>` 将变成**无过期时间的永久键**——该用户发满 5 条短信后将被**永久封禁**，再也收不到验证码！
   - **版本 B（高并发限流击穿故障）**：把读取判断 `GET >= 5` 放在了原子脚本之外（典型 TOCTOU 竞态）。当某恶意脚本并发发起 50 个请求且当前计数为 `4` 时，50 个请求同时 `GET` 全都读到 `4 < 5` 通过检查，随后排队进入 Lua 执行 `INCR`，最终实际发出了 **54 条高价短信**，限流形同虚设。
2. **无缺陷 Redis Function 重构方案**：
   ```bash
   redis-cli FUNCTION LOAD "#!lua name=rate_limiter
   redis.register_function('allow_sms', function(keys, args)
     local limit = tonumber(args[1])
     local window = tonumber(args[2])
     local cur = tonumber(redis.call('GET', keys[1]) or '0')
     if cur >= limit then
       return 0
     end
     cur = redis.call('INCR', keys[1])
     if cur == 1 then
       redis.call('EXPIRE', keys[1], window)
     end
     return 1
   end)"

   # 调用：限制 60 秒最多 5 次
   redis-cli FCALL allow_sms 1 sms:u_10086 5 60
   ```

</details>

### 练习 2：设计防重复下单、防超卖少卖且支持超时回补的秒杀函数库

某限量球鞋总库存 `1000` 双，要求**同一用户 `uid` 限购 `1` 双**，且超时 15 分钟未支付需安全回补库存（防止网络重发导致同一笔取消订单重复回补把总库存加超！）。请设计所需的 Redis 键结构，并编写包含 `try_seckill`（抢购扣减）与 `rollback_seckill`（幂等回补）两个函数的 Redis Function 库。

<details>
<summary>查看参考答案</summary>

1. **键结构设计（单活动同槽原子操作）**：
   - 若单商品并发在单节点可承载范围（如 `< 8 万 QPS`），为保证“库存扣减 + 用户限购判重 + 订单状态登记”三步绝对原子，可使用活动 ID 作为 Hash Tag 使两键落在同一槽：
     - 库存 Hash 键 `seckill:{act_88}:stock`：包含字段 `avail`（初值 `1000`）与 `sold`（初值 `0`）；
     - 已购用户与状态 Hash 键 `seckill:{act_88}:orders`：`field` 为 `uid`，`value` 为状态——`"LOCKED"` 表示已锁库存待支付，取消后删除该 field 以允许用户重抢，同时凭该 field 存在性保证**幂等回补**，绝不重复加库存！
2. **完整 Redis Function 库实现**：
   ```lua
   #!lua name=seckill_lib

   -- KEYS[1]=库存Hash, KEYS[2]=订单状态Hash; ARGV[1]=uid, ARGV[2]=购买件数(1)
   -- 返回值：1=抢购成功, -1=重复购买, 0=库存不足
   redis.register_function('try_seckill', function(keys, args)
     local uid = args[1]
     local buy = tonumber(args[2])
     if redis.call('HEXISTS', keys[2], uid) == 1 then
       return -1
     end
     local avail = tonumber(redis.call('HGET', keys[1], 'avail') or '0')
     if avail < buy then
       return 0
     end
     redis.call('HINCRBY', keys[1], 'avail', -buy)
     redis.call('HINCRBY', keys[1], 'sold', buy)
     redis.call('HSET', keys[2], uid, 'LOCKED')
     return 1
   end)

   -- 幂等取消回补：仅当订单处于 LOCKED 状态时才删除状态并归还库存，防 MQ 重复投递多加库存！
   redis.register_function('rollback_seckill', function(keys, args)
     local uid = args[1]
     local buy = tonumber(args[2])
     if redis.call('HGET', keys[2], uid) ~= 'LOCKED' then
       return 0
     end
     redis.call('HDEL', keys[2], uid)
     redis.call('HINCRBY', keys[1], 'avail', buy)
     redis.call('HINCRBY', keys[1], 'sold', -buy)
     return 1
   end)
   ```

</details>

## 面试题 {#ch8-interview}

以下 3 道面试题聚焦分布式锁原子细节、Redlock 强一致争议与 Redis 事务回滚机制。建议先独立作答，再展开核对参考答案。

### 面试题 1：用 Redis 实现单节点分布式锁必须注意哪三个核心要素？如果业务还没跑完锁就快过期了怎么办？

<details>
<summary>查看参考答案</summary>

1. **三大核心安全要素**：
   - **加锁与设过期时间必须单命令原子执行**：使用 `SET lock_key unique_val NX PX 30000`，防止 `SETNX` 后进程崩溃未执行 `EXPIRE` 造成永久死锁；
   - **锁值必须是当前客户端线程的全局唯一标识（如 `UUID:threadId`）**：标识锁归属权；
   - **解锁必须使用 Lua 脚本原子校验唯一标识后删除**：防止线程 A 发生长耗时卡顿导致锁超时释放后，误把线程 B 新持有的锁直接 `DEL` 掉。
2. **业务耗时超期的应对——Watchdog 看门狗续期**：加锁成功后由客户端后台守护线程每 `TTL / 3`（如 `10s`）检查当前业务线程是否仍存活持锁；若仍在执行则通过 Lua 校验唯一标识后自动将锁过期时间顺延回 `30s`；若客户端宕机则后台续期停止，锁到期自动释放。

</details>

### 面试题 2：为什么主从切换会导致 Redis 分布式锁偶发失效？Redlock 能彻底解决强一致锁问题吗？涉及资金扣款的强互斥锁应该用什么？

<details>
<summary>查看参考答案</summary>

1. **主从切换丢锁原因**：Redis 主从复制默认是**异步**的。客户端 A 在主库 `SET NX PX` 加锁成功并收到 `OK` 后，若主库尚未将该写命令传播给从库即宕机，新升主的从库上不存在该锁键，客户端 B 随即也能加锁成功，破坏互斥性。
2. **Redlock 的局限性**：Redlock 虽用 5 个独立节点多数派避免了单主从异步丢锁，但仍强依赖“有界网络延迟、无长时进程暂停（GC STW）与时钟稳定”假设——若客户端 1 拿锁后遭遇长时间 Full GC 停顿，锁超时后被客户端 2 拿到，客户端 1 醒来后由于**缺乏单调递增的栅栏令牌**（Fencing Token）被后端存储拦截，仍可能并发写坏数据。
3. **工程选型定论**：普通防重计算场景用单主 Redis 锁（配 Watchdog）性价比最高；涉及资金账务与核心状态机的**强一致正确性锁**，应使用基于 Raft/ZAB 共识的 **etcd / ZooKeeper**（利用单调递增 Revision / zxid 做 Fencing Token）或直接依托关系型数据库行锁/唯一索引/乐观锁版本号兜底。

</details>

### 面试题 3：在 `MULTI` 事务中依次入队 `SET a 1`、`LPOP a`、`SET b 2` 后执行 `EXEC`，最终 `a` 和 `b` 的值是什么？为什么现代开发更推荐用 Lua / Redis Functions 替代 `MULTI`？

<details>
<summary>查看参考答案</summary>

1. **执行结果**：最终 **`a = "1"`，`b = "2"`**！
   - 原因：`LPOP a` 语法本身完全合法，入队阶段均返回 `QUEUED`；直到 `EXEC` 真正执行时，第 1 条 `SET a 1` 把 `a` 设为了字符串，第 2 条 `LPOP a` 触发运行期类型错误 `WRONGTYPE` 报错跳过，而 **Redis 没有回滚机制**，不仅第 1 条不会回滚，第 3 条 `SET b 2` 也会正常执行成功！只有入队阶段就写错命令名（如 `SETX a 1`）才会触发 `EXECABORT` 整批放弃。
2. **推荐 Lua / Redis Functions 的三大理由**：① 只需 **1 次网络 RTT**（`MULTI` 需逐条发送入队命令）；② 支持在服务端读取前一步返回值做 **`if/else` 条件判断**（如先判余额够不够再扣减，避免错误命令运行期半途失败）；③ 无需依赖高并发下极易因冲突导致大批事务重试失败的 `WATCH` 乐观锁，吞吐量与可维护性远超 `MULTI`/`EXEC`。

</details>

## 参考资料

- [Redis Official Documentation：Scripting with Lua & Redis Programmability](https://redis.io/docs/latest/develop/interact/programmability/)
- [Redis Official Documentation：Redis Functions（`FUNCTION LOAD` / `FCALL`）](https://redis.io/docs/latest/develop/interact/programmability/functions-intro/)
- [Redis Official Documentation：Distributed Locks with Redis & Redlock Algorithm](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)
- [Martin Kleppmann：How to Do Distributed Locking（Critique of Redlock & Fencing Tokens）](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Redis Official Documentation：Transactions（`MULTI` / `EXEC` / `WATCH`）](https://redis.io/docs/latest/develop/interact/transactions/)
