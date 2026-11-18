---
title: 第 4 章 大规模并发系统的容错与治理
description: 构建模块边界结构化错误契约，运用超时抢占、双模式心跳、对冲复制请求、多层令牌桶限流与 Steward 自愈监管治理大规模并发系统。
---

# 第 4 章 大规模并发系统的容错与治理

## 本章要点

单机同步原语与局部流水线能够保障进程内的数据协作，但在跨模块、跨网络的并发系统中，慢下游、硬件抖动、非预期崩溃与流量洪峰随时发生。若缺乏系统级容错治理，单个协程挂起或单路下游超时便会沿调用树逆流放大，演变为连接池耗尽与全局重试雪崩。本章围绕大规模并发系统的容错闭环展开：先建立模块边界的结构化错误传递契约，再确立可抢占协程周期与双模式心跳探活机制，进而利用对冲复制请求削平长尾延迟、结合多层多维令牌桶限流阻断过载风暴，最终通过自相似的 Steward 监管模型实现异常协程隔离与自愈。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 4.1 模块边界错误契约与结构化传递 {#ch4-1}

在异步流水线与扇出调用中，错误常跨越多个协程与架构层传递而脱离原始调用栈。要在顶层准确决策重试、降级或告警，系统必须构造**格式良好的错误（Well-Formed Error）**：

| 核心职责 | 承载信息与并发工程约束 |
| --- | --- |
| 发生了什么（What） | 保留底层根因与各模块补充的业务语义，供上游按具体错误类型分流处理 |
| 何时何地发生（When & Where） | 在错误**首次实例化**时捕获 UTC 时间戳与完整调用栈；**栈轨迹严禁混入面向用户的 `Error()` 文本** |
| 单行用户友好摘要 | 剥离内部路径、指针与拓扑细节，仅输出可供调用终端理解的简短提示 |
| 关联诊断标识 | 携带 `logID` 或链路 Trace ID，把终端报错与后台完整诊断日志精确串联 |

工程上实行**二分模块边界模型**：每个架构模块在导出边界处必须将所有**已知边界错误**显式包装为本模块的领域错误类型；一旦顶层捕获到**未经模块边界包装的原始错误**，即可断定遇到了穿透防线的**未预期 Bug**。此时绝不能把内部原始报错暴露给终端，而应使用并发安全的 `log/slog`——见[学习指南 16.3 节](../go-guide/chapter-16#ch16-3)，替代原书修改全局状态而引发并发竞态的 `log.SetPrefix`——记录完整堆栈，同时向用户返回附带 `logID` 的通用提示。下例使用泛型 `errors.AsType`（Go 1.26+）在顶层解包分流，按需导入 `"errors"`、`"fmt"`、`"log/slog"`、`"runtime/debug"` 与 `"time"`，解包规则见[学习指南 10.2.2 节](../go-guide/chapter-10#ch10-2-2)：

```go
type BoundaryError struct {
	Inner   error
	Message string
	Stack   []byte
	At      time.Time
}

func WrapBoundary(err error, msg string) BoundaryError {
	return BoundaryError{err, msg, debug.Stack(), time.Now().UTC()}
}
func (e BoundaryError) Error() string { return e.Message }
func (e BoundaryError) Unwrap() error { return e.Inner }

type IntermediateError struct{ BoundaryError }

var ErrExecFailed = errors.New("exec binary missing")

func RunJob(id string, rawFn func(string) error) error {
	err := rawFn(id)
	if errors.Is(err, ErrExecFailed) { // 已知边界错误：显式包装转换
		return IntermediateError{WrapBoundary(err, "job binary unavailable")}
	}
	return err // nil 或未预期 Bug（原样上抛交由顶层告警记录）
}

func HandleTopLevel(logger *slog.Logger, logID string, err error) string {
	if ie, ok := errors.AsType[IntermediateError](err); ok { return ie.Message }
	logger.Error("unexpected bug", "log_id", logID, "err", err)
	return fmt.Sprintf("internal error, ref logID=%s", logID)
}
```

## 4.2 超时动因、可抢占周期与状态回滚边界 {#ch4-2}

并发操作设定超时服务于三类核心治理目标：**系统饱和时快速拒绝**，前提是客户端绝不在超时瞬间无退避盲目重试以免引发重试风暴；**数据具有陈旧时效窗口**，越过有效期的报价或令牌无需继续耗费算力；**兜底打破罕见分布式死锁**，将永久卡死的死锁降级为带随机退避的可恢复活锁。调用树中触发取消的诱因主要有四类：**超时到期**、**用户主动中止**、**父操作取消**与**复制请求胜出取消**，现代 Go 推荐配合 `context.WithCancelCause` 与 `context.WithTimeoutCause`（Go 1.20+）传递取消根因，详见[学习指南 14.2 节](../go-guide/chapter-14#ch14-2)。

编写能够被干净抢占的协程须遵守三条工程准则：

1. **划分最大可抢占周期（Preemption Period）**：若要求协程在时长 `T` 内响应取消，内部任何不检查 `ctx.Done()` 的阻塞 I/O 或单步计算耗时都必须严格小于 `T`。
2. **局部累积中间结果、最小窗口提交共享状态**：修改外部共享状态中途被抢占会使回滚极易出错；应先在局部变量中算完中间结果，最后在单一极小临界区内原子提交。
3. **防范取消窗口期的流水线重复消息**：父协程发出取消与旧协程彻底停机之间存在时间差，过早拉起替代协程争抢输入可能导致重复处理，需借助心跳确认存活性或保证下游消费幂等。

## 4.3 心跳机制：间隔探活与工作单元确定性测试 {#ch4-3}

心跳是受管协程向外部监控方周期性报告存活性与健康度的信号通道，主要分为以下两种模式：

| 对比维度 | 固定时间间隔心跳 | 工作单元启动心跳 |
| --- | --- | --- |
| 触发时机 | 按固定周期 `pulseInterval` 定时触发 | 每轮循环开始处理新工作单元前触发一次 |
| 通道缓冲要求 | 无缓冲 `make(chan struct{})`，配合 `default` 丢弃 | 容量 `1` 的缓冲 `make(chan struct{}, 1)`，防首拍丢失 |
| 核心用途 | 探查长耗时计算或等待上下游的协程是否死锁、挂起 | 为调用方与测试提供确定性同步锚点，消除 `time.Sleep` |
| 局限边界 | 若只发心跳未推进业务，仍可能掩盖内部活锁 | 无法感知单次工作单元内部长达数分钟的卡死 |

### 4.3.1 固定时间间隔心跳与双向阻塞探活 {#ch4-3-1}

间隔心跳通常令工作协程按 `pulseInterval = timeout / 2` 发送脉冲，留出一拍抖动宽限。实现时须守住两条铁律：一是发送脉冲必须使用带 `default` 的非阻塞 `select` 辅助函数 `sendPulse`，**绝不能因无人监听心跳而反过来阻塞业务协程**；二是工作协程在**等待上游输入与阻塞写出 `results <- v` 的两个 `select` 中都必须响应 `<-pulse.C`**，防止上下游变慢时误判工作协程假死。自 **Go 1.23** 起，GC 已能自动回收脱引且未调用 `Stop()` 的 `time.Tick` 与 `time.After`，但高频循环显式使用 `time.NewTicker` 与 `Timer.Reset` 仍可减少分配，详见[学习指南 15.3.2 节](../go-guide/chapter-15#ch15-3-2)：

```go
func sendPulse(hb chan<- struct{}) {
	select {
	case hb <- struct{}{}:
	default: // 无人监听时立即跳过，绝不阻塞发送方
	}
}

func DoWorkInterval(
	done <-chan struct{}, work <-chan int, pulseInterval time.Duration,
) (<-chan struct{}, <-chan int) {
	heartbeat, results := make(chan struct{}), make(chan int)
	go func() {
		defer func() { close(heartbeat); close(results) }()
		pulse := time.NewTicker(pulseInterval)
		defer pulse.Stop()
		for {
			select { // 阶段 1：等待上游输入期间持续响应心跳
			case <-done: return
			case <-pulse.C: sendPulse(heartbeat)
			case v, ok := <-work:
				if !ok { return }
			sendOut:
				for { // 阶段 2：等待下游接收期间持续响应心跳
					select {
					case <-done: return
					case <-pulse.C: sendPulse(heartbeat)
					case results <- v * 2: break sendOut
					}
				}
			}
		}
	}()
	return heartbeat, results
}
```

即便有缺陷的协程漏关通道并在中途死锁，调用方也能在 `timeout` 内准时察觉，无需为整批不确定规模的任务拍脑袋设定粗粒度总超时；若还需识别“空转重试却照发心跳”的活锁，可在心跳负载中附带业务进度序号。

### 4.3.2 工作单元启动心跳与 synctest 虚拟时钟协同 {#ch4-3-2}

工作单元启动心跳须严守两项通道不变量：**`heartbeat` 容量必须设为 `1`**，防止工作协程抢在监听前跑起首轮而丢掉首拍；**心跳发送必须独占一个 `select`**（如直接调用 `sendPulse`），绝不能与 `out <- n` 合并为 `select { case heartbeat <- struct{}{}: case out <- n: }`——否则当 `out` 未就绪而 `heartbeat` 缓冲为空时，会直接走完心跳分支跳过本轮业务输出！配合 **Go 1.25+** `"testing/synctest"` 虚拟时钟气泡——见[学习指南 17.2 节](../go-guide/chapter-17#ch17-2)——既可用 `<-hb` 消除启动竞态，又能在微秒内测完多秒级间隔探活：

```go
func DoWorkUnit(done <-chan struct{}, nums ...int) (<-chan struct{}, <-chan int) {
	heartbeat, out := make(chan struct{}, 1), make(chan int)
	go func() {
		defer func() { close(heartbeat); close(out) }()
		for _, n := range nums {
			sendPulse(heartbeat) // 独立非阻塞发送，严禁与下方 out <- n 合并
			select {
			case <-done: return
			case out <- n:
			}
		}
	}()
	return heartbeat, out
}

// 另需导入 "testing" 与 "testing/synctest"：微秒级确定性验证 2 秒间隔心跳
func VerifyHeartbeatInBubble(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		done, work := make(chan struct{}), make(chan int)
		defer close(done)
		hb, _ := DoWorkInterval(done, work, 2*time.Second)
		<-hb // 虚拟时钟瞬间推进 2 秒，无需真实等待
	})
}
```

## 4.4 对冲复制请求（Replicated Requests）尾延迟治理 {#ch4-4}

面对偶发 GC 停顿或局部网络毛刺，可向 `N` 个后端副本并发派发同一请求，采纳首个成功响应并通过 `context` 立即取消其余 `N - 1` 个在途副本；下例导入 `"context"`：

```go
func ReplicatedQuery[T any](
	parent context.Context, replicas int, fn func(context.Context, int) (T, error),
) (T, error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	type res struct{ val T; err error }
	ch := make(chan res, replicas) // 缓冲等于副本数，慢副本退出写回绝不阻塞泄漏
	for id := range replicas {
		go func() { v, err := fn(ctx, id); ch <- res{v, err} }()
	}
	var lastErr error
	for range replicas {
		r := <-ch
		if r.err == nil { return r.val, nil } // defer cancel() 立即通知其余副本止损退出
		lastErr = r.err
	}
	var zero T
	return zero, lastErr
}
```

启用复制请求前必须满足两项架构前提：一是**操作只读或严格幂等**；二是**各副本具备相互独立的运行时故障域**。原书英文版明确指出 *“If your handlers are too uniform, the chances that any single one will be an outlier is smaller”*——意为**若各副本过于同质化，单个副本独自成为慢异常值的概率反而极低，慢时往往大家一起慢**；**原书中文版第 199 页将其误译为相反含义**，阅读时务必甄别。若多协程在同进程争抢同一把锁、同一块慢盘或同一个过载下游，复制请求只会白耗算力并加剧排队恶化。

## 4.5 多层多维令牌桶限流（MultiLimiter） {#ch4-5}

服务端限流能有效阻断客户端重试死螺旋、隔离噪吵租户并兜底计费配额。扩展库 `"golang.org/x/time/rate"` 基于令牌桶模型 `rate.NewLimiter(r, b)` 实现限流，其三种消费方式对比如下：

| 方法签名 | 桶内无足够令牌时的行为 | 典型工程场景 |
| --- | --- | --- |
| `Wait(ctx)` / `WaitN(ctx, n)` | 阻塞等待补充；**若预计等待超过 `ctx.Deadline()` 或 `n > b`，在 0ms 内立即报错返回** | 客户端 SDK 平滑整形、后台批处理与流水线背压 |
| `Allow()` / `AllowN(t, n)` | 不阻塞，立即判断当前能否放行并返回 `bool` | 网关入口超载时快速拒绝并返回 HTTP `429` |
| `Reserve()` / `ReserveN(t, n)` | 返回 `*Reservation`，可查 `.Delay()` 等待时长或调 `.Cancel()` 归还令牌 | 自定义延迟调度或跨资源协同预留 |

当业务同时受多层时间粒度与正交资源维度约束时，可定义 `RateLimiter` 接口并用 `MultiLimiter` 聚合成单一限流器；下例导入 `"cmp"`、`"context"`、`"slices"`、`"time"` 与 `"golang.org/x/time/rate"`：

```go
type RateLimiter interface {
	Wait(context.Context) error
	Limit() rate.Limit
}

func Per(eventCount int, duration time.Duration) rate.Limit {
	return rate.Every(duration / time.Duration(eventCount))
}

type multiLimiter struct{ limiters []RateLimiter }

func MultiLimiter(limiters ...RateLimiter) *multiLimiter {
	copied := slices.Clone(limiters)
	slices.SortFunc(copied, func(a, b RateLimiter) int { return cmp.Compare(a.Limit(), b.Limit()) })
	return &multiLimiter{limiters: copied}
}

func (l *multiLimiter) Wait(ctx context.Context) error {
	for _, lim := range l.limiters {
		if err := lim.Wait(ctx); err != nil { return err }
	}
	return nil
}
func (l *multiLimiter) Limit() rate.Limit { return l.limiters[0].Limit() }
```

按 `Limit()` 升序排列既让 `Limit()` 以 `O(1)` 返回最严苛速率，又让 `Wait` 优先阻塞在慢桶上，等待期间快桶自动并行补满。注意令牌桶是**按流逝时间连续线性回血**而非整分清零：组合 `Per(2, time.Second)` 与桶深 `10` 的 `Per(10, time.Minute)`——即每 `6s` 补 `1` 个令牌——时，第 1 次请求在 `t = 0` 扣掉首个分钟令牌后分钟桶即开始匀速补充；前 10 次请求耗去 `4s～4.5s` 期间已并行攒回大部分令牌，第 11 次请求只需等到 `t = 6.0s`，即再等 `1.5s～2s` 而非整整 `6s` 即可放行。

## 4.6 协程自愈监管模式（Steward 与 Ward） {#ch4-6}

将**存活监控与重启逻辑**（Steward）同**业务处理**（Ward）分离，并统一采用自相似的启动签名 `StartGoroutineFn`，可让 `NewSteward` 返回的监管器本身也能被更上层 Steward 递归监管。

> [!WARNING]
> **原书 `NewSteward` 的关闭通道空转缺陷**：原书 `monitorLoop` 直接写 `case <-wardHeartbeat: continue` 而未检查第二个布尔值 `ok`。由于读取已关闭通道会立即无阻塞返回零值，一旦受管协程异常退出并关闭 `wardHeartbeat`，Steward 将陷入 **100% CPU 死循环**且永远不会重启受管协程！

正确实现必须检查 `_, ok := <-wardHB`，在 `!ok` 或超时到期时立即关闭旧 `wardDone` 并拉起新实例；下例复用 [3.2.1 节](./chapter-03#ch3-2-1) 的 `or`、`sendPulse` 及 Go 1.23+ 安全重设语义 `timer.Reset`：

```go
type StartGoroutineFn func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{}

func NewSteward(timeout time.Duration, startGoroutine StartGoroutineFn) StartGoroutineFn {
	return func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
		heartbeat := make(chan struct{})
		go func() {
			defer close(heartbeat)
			var wardDone chan struct{}
			var wardHB <-chan struct{}
			timer := time.NewTimer(timeout)
			defer timer.Stop()
			restart := func() {
				if wardDone != nil { close(wardDone) }
				wardDone = make(chan struct{})
				wardHB = startGoroutine(or(wardDone, done), timeout/2)
				timer.Reset(timeout)
			}
			restart()
			pulse := time.NewTicker(pulseInterval)
			defer pulse.Stop()
			for {
				select {
				case <-pulse.C: sendPulse(heartbeat)
				case _, ok := <-wardHB:
					if !ok { restart() } else { timer.Reset(timeout) }
				case <-timer.C: restart()
				case <-done:
					close(wardDone)
					return
				}
			}
		}()
		return heartbeat
	}
}
```

若受管协程需向下游连续发送结果，可结合闭包状态与第 3 章的 [`bridge` 组合子](./chapter-03#ch3-4) 将多次重启产生的通道流拼接为单一输出流；同时需防范畸形输入引发的**毒丸（Poison Pill）闪退风暴**，为连续重启次数设置熔断阈值。

## 练习 {#ch4-exercises}

以下 2 道练习分别检验带连续重启熔断的 Steward 自愈监管器，以及基于 `MultiLimiter` 的多维限流与超时预算快速失败。代码默认复用 [3.2.1 节](./chapter-03#ch3-2-1) 的 `or` 及本章的 `sendPulse`、`StartGoroutineFn`、`MultiLimiter` 声明。建议先独立编写，再展开核对参考答案。

### 练习 1：实现修复关闭通道空转并带连续重启熔断的 `NewBoundedSteward`

实现 `NewBoundedSteward(timeout time.Duration, maxRestarts int, startGoroutine StartGoroutineFn) StartGoroutineFn`：当 `wardHB` 被关闭或超过 `timeout` 未收到脉冲时关闭旧 `wardDone` 并重启；每收到一次有效脉冲（`ok == true`）将连续重启计数清零；若连续异常重启次数超过 `maxRestarts`，则关闭当前 `wardDone` 并直接退出监管协程以关闭自身 `heartbeat`。

<details>
<summary>查看参考答案</summary>

```go
func NewBoundedSteward(
	timeout time.Duration, maxRestarts int, startGoroutine StartGoroutineFn,
) StartGoroutineFn {
	return func(done <-chan struct{}, pulseInterval time.Duration) <-chan struct{} {
		heartbeat := make(chan struct{})
		go func() {
			defer close(heartbeat)
			var wardDone chan struct{}
			var wardHB <-chan struct{}
			timer := time.NewTimer(timeout)
			defer timer.Stop()
			restarts := -1
			tryRestart := func() bool {
				if wardDone != nil { close(wardDone) }
				if restarts++; restarts > maxRestarts { return false }
				wardDone = make(chan struct{})
				wardHB = startGoroutine(or(wardDone, done), timeout/2)
				timer.Reset(timeout)
				return true
			}
			if !tryRestart() { return }
			pulse := time.NewTicker(pulseInterval)
			defer pulse.Stop()
			for {
				select {
				case <-pulse.C: sendPulse(heartbeat)
				case _, ok := <-wardHB:
					if !ok && !tryRestart() { return }
					if ok { restarts = 0; timer.Reset(timeout) }
				case <-timer.C:
					if !tryRestart() { return }
				case <-done:
					close(wardDone)
					return
				}
			}
		}()
		return heartbeat
	}
}
```

关键依据：检查 `_, ok := <-wardHB` 修复了空转缺陷；初值 `restarts := -1` 使首次拉起计为 `0`，仅在收到有效心跳时重新归零，超限退出时 `defer close(heartbeat)` 自动通知上层监管者。

</details>

### 练习 2：组合 API 与磁盘维度的 `MultiLimiter` 并验证预算不足快速失败

使用 `MultiLimiter` 组合 `apiLimit`（每分钟 `10` 次、桶深 `2`）与 `diskLimit`（每秒 `1` 次、桶深 `1`）封装 `Client.ReadFile(ctx)`。验证首次调用立即成功；紧接着以 `100ms` 超时预算发起第 2 次调用时，`ReadFile` 无需阻塞满 `100ms` 而是在毫秒级内立即返回错误。

<details>
<summary>查看参考答案</summary>

```go
type Client struct{ limiter RateLimiter }

func NewClient() *Client {
	return &Client{
		limiter: MultiLimiter(
			rate.NewLimiter(Per(10, time.Minute), 2), // ≈0.167/s，排第 1
			rate.NewLimiter(Per(1, time.Second), 1),  // 1.0/s，排第 2
		),
	}
}
func (c *Client) ReadFile(ctx context.Context) error { return c.limiter.Wait(ctx) }
```

关键依据：首次调用耗尽 `diskLimit` 的唯一令牌；紧接着发起第 2 次调用时，`diskLimit` 预计需等待 `1s` 才能补足令牌，超出传入 `ctx` 的 `100ms` 剩余截止时间，`rate.Limiter.Wait` 会取消内部预约并在 `0ms` 内直接返回超时错误。

</details>

## 面试题 {#ch4-interview}

以下 3 道面试题聚焦工作单元心跳通道不变量、复制请求故障域前提与令牌桶连续回血计算。代码约定同[练习部分](#ch4-exercises)，建议先独立作答再展开核对。

### 面试题 1：工作单元启动心跳模式中，为什么 `heartbeat` 缓冲必须设为 `1`，且不能把心跳发送与结果发送合并进同一个 `select`？

<details>
<summary>查看参考答案</summary>

1. **缓冲设为 `1` 防首拍丢失**：工作协程可能在外部监听方执行 `<-heartbeat` 前就跑起首轮循环；无缓冲通道配合 `default` 会直接丢弃首个启动脉冲导致监听方死等，容量 `1` 可暂存首拍。
2. **禁止合并进同一 `select` 防丢业务结果**：若写成 `select { case heartbeat <- struct{}{}: case out <- val: }`，只要下游尚未就绪读取 `out` 且 `heartbeat` 缓冲为空，就会命中 `heartbeat` 分支并跳过本轮 `out <- val`，导致业务数据静默丢失。

</details>

### 面试题 2：单进程内启动 5 个协程并发查询同一块 IO 打满的本地磁盘并取最快返回（复制请求），能否有效降低 P99 延迟？为什么？

<details>
<summary>查看参考答案</summary>

**不能，反而会恶化 P99 延迟与整体吞吐。**

复制请求削平尾延迟的前提是各副本拥有**相互独立的运行时故障域**——如跨物理节点、独立磁盘或不同网络路径——使单副本偶发抖动时其余副本保持正常。同进程 5 个协程并发访问同一块已饱和的本地磁盘，所有副本争抢同一个物理 I/O 队列，慢时大家同慢，冗余请求只会倍增磁盘排队深度。

</details>

### 面试题 3：`MultiLimiter` 组合“每秒 2 次（桶深 1）”与“每分钟 10 次（桶深 10）”时为何按 `Limit()` 升序排列？突发跑完前 10 次耗时 4 秒后，第 11 次请求为何只再等 2 秒而非 6 秒就放行？

<details>
<summary>查看参考答案</summary>

1. **升序排列的原因**：`Per(10, time.Minute)` 速率约 `0.167/s`，严于 `Per(2, time.Second)` 的 `2/s`。升序排列使 `Limit()` 以 `O(1)` 返回最严速率，且 `Wait` 先阻塞在最慢的分钟桶上，等待期间后面的秒级快桶并行自然补满。
2. **只再等 2 秒的原因**：令牌桶并非整分钟清零重置，而是从 `t = 0` 扣掉首个令牌起按每秒 `1/6` 个（每 `6s` 补 `1` 个）**连续线性补充**。前 10 次请求耗去的 `4s` 内分钟桶已并行攒回 `4/6` 个令牌，因此只需再补齐剩余 `2/6` 个令牌，即再等 `6 - 4 = 2s` 即可放行——若严格按秒级桶深 `1` 在 `t = 4.5s` 跑完第 10 次，则只需再等 `1.5s` 至 `t = 6.0s` 放行。

</details>

## 参考资料

- [Go 扩展库 `golang.org/x/time/rate`：令牌桶限流器文档](https://pkg.go.dev/golang.org/x/time/rate)
- [Go 标准库 `errors`：错误链包装与泛型 `AsType`](https://pkg.go.dev/errors)
- [Go 标准库 `log/slog`：并发安全的结构化日志](https://pkg.go.dev/log/slog)
- [Go 标准库 `testing/synctest`：并发测试隔离气泡与虚拟时钟](https://pkg.go.dev/testing/synctest)
- [Go 1.23 发布说明：`time.Timer` 与 `time.Ticker` 回收及 `Reset` 语义改进](https://go.dev/doc/go1.23#timer)
