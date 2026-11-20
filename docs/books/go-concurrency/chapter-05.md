---
title: 第 5 章 大规模并发
description: 为并发系统设计错误传播、超时预算、心跳、复制请求、限流与工作者监督机制。
---

# 第 5 章 大规模并发

## 本章要点

局部并发代码能够运行，不代表系统在下游超时、部分任务失败或负载突增时仍能保持稳定。本章沿原书的错误传递、心跳、复制请求、速率限制与监督重启展开，把这些技巧统一放进资源预算与失败语义中理解。

读完后，应能为一次请求分配时间和并发预算，区分“活着”与“取得进展”，并解释取消、重试和重启为什么都需要幂等性、等待与有界策略。原书的“异常”在涉及普通 `error` 时统一称为“错误”，避免与 `panic` 混淆。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64；扩展库为 golang.org/x/sync v0.25.0、golang.org/x/time v0.16.0。版本基线见[专题首页](./index#version-policy)。

## 5.1 错误如何穿过并发边界 {#ch5-1}

### 5.1.1 错误包含原因与操作语境

工作者知道“读取文件失败”，汇总方知道“为哪个请求计算摘要失败”，API 边界决定如何向用户呈现。各层应补充自身的操作语境，保留可判断的原因，同时避免在每层重复记录同一条错误。

本章 `context`、`errors`、`fmt`、`sync`、`time` 分别导入同名标准库路径。Go 1.13 起可以用 `fmt.Errorf("read %q: %w", path, err)` 包装原因，再用 `errors.Is` 与 `errors.As` 判断；不必为得到错误链照搬原书的第三方错误框架。

**Go 1.26 起还提供 `errors.AsType[E error]`**，适合已知目标错误类型的场景。例如下面的 `err` 为待检查错误，`os` 导入 `"os"`：

```go
if pe, ok := errors.AsType[*os.PathError](err); ok {
	fmt.Println(pe.Op, pe.Path)
}
```

它和 `errors.As` 都沿错误树查找，而不是只检查最外层。是否包装并暴露底层错误，仍属于 API 契约：调用者一旦依赖某个底层类型，未来更换实现就可能产生兼容问题。

### 5.1.2 先定义汇总策略

| 请求语义 | 常见策略 | 返回时要回答的问题 |
| --- | --- | --- |
| 所有任务必须成功 | 首个失败取消其余，等待任务结束 | 哪个错误作为请求失败原因 |
| 允许部分成功 | 每项结果携带自己的错误 | 哪些项目成功，失败是否可重试 |
| 冗余读取，只需一个成功 | 首个成功取消其余，全部失败才报错 | 快速失败是否遮蔽慢速成功 |
| 必须保留全部失败原因 | 收集错误，再聚合 | 聚合顺序是否稳定，如何限制错误体积 |

**Go 1.20 起的 `errors.Join`** 可以聚合多个错误，忽略 nil，全部为 nil 时返回 nil；`Is`、`As` 与 `AsType` 能遍历其错误树。它不包含错误收集所需的同步，也不替你定义重试策略。

普通错误应作为返回值传播。只有发生于同一 goroutine 的展开栈中的 `defer` 才能 `recover` 相应 panic；在调用方放一个 `recover` 无法捕获另一个 goroutine 的 panic。恢复未知 panic 后盲目继续运行，也可能让已经损坏的业务状态留在系统中。

## 5.2 超时预算与取消 {#ch5-2}

### 5.2.1 总预算包含排队与收尾

一次请求的预算应从入口开始计算，包括等待名额、排队、网络操作和必要收尾。不要每到一层就用 `context.Background()` 重新开始相同长度的超时；它会丢掉父取消和总体 deadline。

调用方可以从父上下文派生更短预算：

```go
ctx, cancel := context.WithTimeout(parent, 200*time.Millisecond)
defer cancel()
err := call(ctx)
_ = err
```

其中 `parent` 为 `context.Context`，`call` 为 `func(context.Context) error`。子预算不能延长父预算。业务是否需要为回退或响应序列化保留时间，应在分配子预算时明确，而不是把所有时间都消耗在最深的下游调用中。

只给等待结果的 `select` 加超时，不会中断工作者的真实 I/O。应把 `Context` 传到支持取消的客户端，必要时同时设置连接、读写或驱动层的超时。重试也要共享总预算，并有最大次数、退避和幂等约束。

### 5.2.2 Go 1.23 至 1.27 的定时器变化

原书时代的定时器结论需要分版本阅读：

| 版本 | channel 定时器的主要边界 |
| --- | --- |
| Go 1.22 及更早 | 旧 channel 行为可能留下已到期的时间值，停止与重置协议需要处理残留值；未停止的不可达定时器回收也有旧限制 |
| Go 1.23—1.26 | 新行为使用同步 channel，`Stop`、`Reset` 后不再收到旧配置的残留值；是否启用受主模块 `go` 版本与 `asynctimerchan` 兼容设置影响 |
| Go 1.27 起 | 移除 `asynctimerchan` 开关，`time` 包创建的 channel 始终采用同步行为，不再由旧模块版本切回旧实现 |

Go 1.23 起，垃圾回收也能回收不可达且未停止的 timer、ticker。不能继续把每个未 `Stop` 的 `time.After` 都描述成永久泄漏；但循环反复创建计时器仍有分配成本，且仍可达的定时器不因这项变化而自动停止。

在本章 Go 1.27 基线下，由单个 goroutine 拥有的 channel 定时器可以直接 `Reset`，无需照抄旧的“停止后排空”模板。兼容旧版本的库必须另行设计并核对旧协议，不能让多个消费者同时排空同一 timer channel。

仍建议对自己拥有的 `NewTimer`、`NewTicker` 明确停止，因为停止也表达业务生命周期。`Stop` 不关闭它们的 channel，因此 `for range ticker.C` 不能依赖 `Stop` 退出。`time.AfterFunc` 是回调定时器，停止或重置不等待已经开始的回调，其行为不能与 channel 定时器混同。

## 5.3 心跳：区分存活与进展 {#ch5-3}

心跳可能表达“监视循环仍能运行”，也可能表达“最近完成了一个工作单元”。前者是存活信号，后者更接近进展信号。一个独立的心跳 goroutine 仍在跳动，不代表真正执行工作的 goroutine 没有卡住。

下面的中继在等待输入或等待输出时持续发送尽力而为的心跳；`interval` 必须大于零，消费者允许丢失心跳。它报告的是该中继循环的存活，不是业务处理成功：

```go
func HeartbeatRelay[T any](ctx context.Context, in <-chan T, interval time.Duration) (<-chan struct{}, <-chan T) {
	heartbeat := make(chan struct{}, 1)
	out := make(chan T)
	go func() {
		defer close(heartbeat)
		defer close(out)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		pulse := func() {
			select {
			case heartbeat <- struct{}{}:
			default:
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pulse()
			case v, ok := <-in:
				if !ok {
					return
				}
			send:
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						pulse()
					case out <- v:
						break send
					}
				}
			}
		}
	}()
	return heartbeat, out
}
```

心跳 channel 的容量 1 用于保留一次尚未观察的通知，非阻塞发送避免监视者变慢时阻塞业务。上例的带标签 `break` 结束内部发送循环，然后继续等待下一项输入。

监视者应使用自己的超时定时器，每次收到有效心跳后重置；心跳 channel 关闭时必须检查 `ok`，防止把关闭后不断返回的零值当成永不间断的心跳。若要求检测业务停滞，可以携带单调增加的序号、最近完成任务时间或队列进度，而不是只重复发送空结构体。

测试应通过启动通知、完成通知或[虚拟时间](./appendix-a#cha-4)等待明确事件，不应把原书中放大的真实休眠时间当成稳定测试方案。

## 5.4 复制请求：等待首个成功 {#ch5-4}

复制请求让同一逻辑读取在多个执行端尝试，借助不同的延迟分布降低尾延迟。它会增加下游负载，只有共享瓶颈较少、结果等价且重复执行可以接受时才可能有收益。

**首个返回不等于首个成功。**最快的任务可能立刻失败，其他任务却稍后成功。下面的实现选择首个成功值，全部失败时聚合错误；每个调用只发送一次，因此结果缓冲按调用总数分配。任务通过 `WaitGroup.Go` 启动，需要 Go 1.25 或更高版本：

```go
func FirstSuccess[T any](parent context.Context, calls ...func(context.Context) (T, error)) (T, error) {
	var zero T
	if len(calls) == 0 {
		return zero, fmt.Errorf("no calls")
	}
	ctx, cancel := context.WithCancel(parent)
	type result struct {
		value T
		err   error
	}
	results := make(chan result, len(calls))
	var wg sync.WaitGroup
	defer func() {
		cancel()
		wg.Wait()
	}()
	for _, call := range calls {
		wg.Go(func() {
			v, err := call(ctx)
			results <- result{v, err}
		})
	}
	var failures []error
	for range calls {
		select {
		case <-parent.Done():
			return zero, parent.Err()
		case r := <-results:
			if r.err == nil {
				return r.value, nil
			}
			failures = append(failures, r.err)
		}
	}
	return zero, errors.Join(failures...)
}
```

契约是每个 `call` 非 nil、有限时间返回、协作响应上下文且不让 panic 逃逸；调用数量本身也必须有上限。函数在选出结果后取消其他任务，并等待它们退出，所以实际返回时间包含落败任务的收尾。若下游忽略取消，这个实现无法保证及时返回；需要解耦后台回收时，应明确把这些任务交给服务级生命周期管理，而不是默默遗留。

如果父取消与成功同时就绪，`select` 不规定谁优先；这不是具有严格提交边界的事务协议。失败错误的聚合顺序也是完成顺序，不是输入顺序。

对数据库写入、扣款或发消息做复制请求尤其需要明确幂等键与提交规则。取消客户端等待不能撤回远端已经提交的写入。工程中也常采用延迟后才启动额外副本的对冲请求，并给额外流量设置预算。

## 5.5 速率限制、并发限制与排队 {#ch5-5}

三者分别约束不同维度：

| 机制 | 限制什么 | 下游突然变慢时 |
| --- | --- | --- |
| 速率限制 | 一段时间内允许开始多少工作 | 在途任务仍可能积累 |
| 并发限制 | 同时执行多少工作 | 后续任务等待或拒绝 |
| 队列上限 | 允许积压多少未开始工作 | 队列满时按策略阻塞、拒绝或丢弃 |

原书的令牌桶思路仍有效。扩展包 `golang.org/x/time/rate` 提供令牌桶实现：速率决定长期补充速度，burst 决定可积累的令牌数和瞬时突发规模。它是标准库之外的包，不应与 `time` 混同。

下面 `rate` 导入 `"golang.org/x/time/rate"`，代码位于接收 `ctx context.Context` 并返回 `error` 的函数中，`serve` 为 `func(context.Context) error`：

```go
limiter := rate.NewLimiter(rate.Limit(10), 20)
if err := limiter.Wait(ctx); err != nil {
	return err
}
return serve(ctx)
```

这里初始桶允许 burst 规模的突发，不是严格的“任意一秒至多十个请求”。`Wait` 可以因取消或等待超出 deadline 失败；`Allow` 立即判断并拒绝；`Reserve` 会预留未来容量，决定不执行时应按其文档取消预留。

上例展示单次调用方式；生产中若要限制整个服务，应在组件初始化时创建并共享 limiter，不能每个请求都新建一个装满的桶。多个 limiter 依次等待也不等于原子地取得所有配额，前一个配额可能已经消耗，需要根据业务接受这个代价或设计统一调度。

使用容量为 N 的 `chan struct{}` 作信号量时，应在启动昂贵任务前取得名额，取得后保证释放，并允许等待名额时取消。还应独立限制排队量。跨实例的全局配额不由单进程 limiter 提供，需要额外的协调或配额分配机制。

## 5.6 监督与重启：恢复协议 {#ch5-6}

原书用 steward/ward 模式表达“监督者监视工作者，失去心跳后重启”。它适合具有明确重启边界的后台工作，但不能把它理解成强制结束一个卡住的 goroutine。

一个可审查的监督流程应是：

1. 创建当前一代工作者的上下文、心跳、结果流与完成通知，并赋予代次标识。
2. 监视进展与退出；正常完成不应被当成故障无限重启。
3. 超时或失败时取消这一代，等待完成或进入明确的收尾超时处理。
4. 确认旧工作者不再拥有输出、资源或提交权限后，按退避和重启预算启动新一代。
5. 达到重启上限或父上下文取消时，把失败交给更高层并结束监督。

如果旧工作者不能停止，立即创建新工作者可能积累更多泄漏并重复执行副作用。`recover` 也不能修复永久阻塞；需要硬隔离的不可控任务可以考虑进程边界，而不是假设 Go 有通用的 goroutine kill API。

重启不提供自动重放与恰好一次执行。任务领取、持久化检查点、幂等键以及过时代次的结果拒收，都需要按业务协议实现。原书的 bridge 模式可以串起每一代结果流，但它仍要求前一流能结束，详见[bridge](./chapter-04#ch4-6)。

## 练习 {#ch5-exercises}

下面检查失败策略、时间预算、心跳与负载约束。先独立写出决策和反例，再展开答案；不要求运行。涉及 API 时，沿用正文的标准库与扩展库导入约定。

### 练习 1：复制请求遇到快速失败

三个等价读取分别在 5ms 失败、20ms 成功和 200ms 成功。业务要求返回第一个成功值。若只接收第一个结果就取消全部请求，会发生什么？给出完整的成功、全部失败与父取消策略。

<details>
<summary>查看参考答案</summary>

会把 5ms 的失败当成整个请求失败，错过 20ms 的成功。应继续收集，任一成功后取消其余；全部失败后再返回聚合错误；父取消后按契约返回父错误并取消、收尾所有任务。

还要确保结果发送不会因汇总者退出而永久阻塞。固定 N 个、每个只发送一次的任务可用容量 N 的结果 channel，或让发送同时监听取消。及时返回仍依赖底层调用有限时间响应取消。

</details>

### 练习 2：预算能否每层重开

入口请求 deadline 为 300ms。请求先排队 150ms，再依次调用两个下游，每个都从 `Background()` 派生 200ms 超时。指出协议问题，并说明怎样保留统一预算。

<details>
<summary>查看参考答案</summary>

下游丢失入口的取消和 deadline，总耗时可能超过入口预算。所有调用应从请求上下文派生，必要时分配更短的子预算；排队已经消耗的时间不能重新获得。

开始下一步之前还应检查剩余时间是否足够，并为必要收尾留出空间。外层等待超时不代表真实 I/O 已经停止，仍须传播上下文到实际调用。

</details>

### 练习 3：心跳正常为什么业务仍停滞

业务工作者卡在一个不返回的调用中，独立心跳 goroutine 每秒仍成功发送一次通知。监视器据此认为工作者健康，这个结论有什么缺陷？如何改进信号语义？

<details>
<summary>查看参考答案</summary>

信号只证明心跳 goroutine 能运行，无法证明业务取得进展。可以在完成工作单元后更新进度序号或最后成功时间，由监视器检测进度长期不变；长任务则应设计可观测且可取消的阶段。

应为合理的空闲与下游延迟设置阈值，避免无任务可做时误判。超时后也不能靠无限重启替代旧工作者收尾。

</details>

### 练习 4：限速为什么没有限制在途数量

服务允许平均每秒开始 100 个请求，burst 为 100。下游平均延迟从 10ms 升至 10s，但最终仍能完成。为什么仅使用速率限制不足以保护连接与内存？给出补充方案。

<details>
<summary>查看参考答案</summary>

速率限制约束开始频率，没有限制每个请求占用资源多久。稳定条件下平均在途量约为 `100 × 10 = 1000`，突发和尾延迟还会改变峰值；它不是固定 100 的并发上限。

应另设并发预算与有限队列，名额获取也受请求取消和 deadline 约束，超出容量时按策略拒绝。不要每个请求新建 limiter，也不要先创建无限 goroutine 再让它们等待名额。

</details>

## 面试题 {#ch5-interview}

这里检查定时器与重启的关键边界。先给结论，再展开答案；版本条件在题干中给出。

### 面试题 1：Go 1.27 还需要排空旧 timer 值吗

在 Go 1.27 中，一个 goroutine 独占使用 `time.NewTimer` 创建的 channel 定时器。它在 `Reset` 返回后，会不会读到上一次配置遗留的时间值？`Stop` 会关闭 `C` 吗？

<details>
<summary>查看参考答案</summary>

不会读到旧配置的残留值；这是同步 timer channel 的保证。`Stop` 不关闭 `C`，因此必须用独立退出信号结束等待。该结论不应直接套到 Go 1.22 的旧实现或 `time.AfterFunc` 回调上。

</details>

### 面试题 2：取消超时后能否直接重启

监督者发现工作者超时，调用 `cancel()` 后立即启动新一代，并宣称任意时刻最多一代工作者执行副作用。这个保证成立吗？

<details>
<summary>查看参考答案</summary>

不成立。旧工作者可能没有观察取消，或远端写入已经提交。需要等待旧一代退出，或用外部租约、代次校验、幂等提交等协议拒绝过时工作；这些也不意味着可以强制杀死旧 goroutine。

</details>

## 参考资料

- [errors：错误链、AsType 与 Join](https://pkg.go.dev/errors)
- [Go 1.26：errors.AsType](https://go.dev/doc/go1.26#errorspkgerrors)
- [Go：错误包装与 API 契约](https://go.dev/blog/go1.13-errors)
- [context：deadline、取消与原因](https://pkg.go.dev/context)
- [time.NewTimer：回收与同步 channel](https://pkg.go.dev/time#NewTimer)
- [time.Timer.Reset：channel 与回调定时器的区别](https://pkg.go.dev/time#Timer.Reset)
- [Go 1.23 定时器 channel 行为与兼容开关](https://go.dev/wiki/Go123Timer)
- [Go 1.27：移除 asynctimerchan](https://go.dev/doc/go1.27#runtime)
- [rate：令牌桶、Wait、Allow 与 Reserve](https://pkg.go.dev/golang.org/x/time/rate)
- [Go 规范：panic 与 recover](https://go.dev/ref/spec#Handling_panics)
