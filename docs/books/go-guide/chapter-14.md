---
title: 第 14 章 context 取消与超时
description: 掌握 context.Context 接口契约与传参规范，运用取消传播、自定义取消原因、分层超时预算与私有键元数据传递管理调用链生命周期。
---

# 第 14 章 context 取消与超时

## 本章要点

服务端处理单次请求往往要跨越数层函数与多个并发 Goroutine：一方面需要沿途携带链路追踪 ID、调用方身份等横切元数据，另一方面在客户端断连或总预算超时时必须立即通知下游查询与远程请求停止工作。由于 Goroutine 会在操作系统线程间动态迁移，Go 不提供线程局部存储，而是通过标准库 `"context"` 的 `context.Context` 接口在函数首参上显式传递生命周期与元数据。本章依次梳理 `Context` 接口契约、取消与根因传播、分层超时预算、业务代码响应或脱离取消的方式，以及类型安全的请求级键值存取规范。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 14.1 Context 接口契约与传参规范 {#ch14-1}

`context.Context` 是标准库 `"context"` 定义的只读接口，仅包含四个方法；本节示例按需导入 `"context"`、`"time"` 与 `"net/http"`：

```go
type Context interface {
	Deadline() (deadline time.Time, ok bool)
	Done() <-chan struct{}
	Err() error
	Value(key any) any
}
```

全生态围绕 `Context` 共同遵守两条硬性规范：

1. **始终将 `ctx context.Context` 放在函数参数列表首位**：与将 `error` 放在返回值末位对称，让调用链信号流向一目了然。
2. **严禁将 `Context` 存入结构体字段长期持有**：`Context` 绑定单次请求或动态调用链的生命周期，塞入共享结构体会造成不同请求的超时与取消信号相互串台。

`"context"` 包的核心构造函数与辅助 API 职责速查如下：

| 函数签名 | 适用场景与核心行为 |
| --- | --- |
| `Background()` / `TODO()` | 进程入口、独立后台任务使用 `Background`；重构期来源未明时暂填 `TODO`；两者 `Done()` 均为 `nil` |
| `WithCancel(parent)` | 派生可手动取消的子上下文，必须配合 `defer cancel()` 释放父节点内部监听引用 |
| `WithCancelCause(parent)` | 手动取消时支持通过 `cancel(err)` 注入具体根因，下游调 `Cause(ctx)` 读取（Go 1.20+） |
| `WithTimeout` / `WithDeadline` | 经过指定时长或到达绝对时刻自动取消，支持附带自定义原因的 `*Cause` 变体（Go 1.21+） |
| `WithoutCancel(parent)` | 剥离父级取消信号与截止时间，完整保留父链上的全部 `Value` 元数据（Go 1.21+） |
| `WithValue(parent, key, val)` | 派生附加单个不可变键值对的子上下文，键必须可比较且应使用包内未导出类型 |
| `AfterFunc(ctx, fn)` | 注册 `ctx` 取消后在新 Goroutine 中执行一次的清理回调，返回 `stop()` 可提前注销（Go 1.21+） |

在 `net/http` 服务中，由于 `http.Handler` 接口签名早已固定，上下文挂载在 `*http.Request` 上传递：中间件通过 `r.Context()` 取出原上下文，派生子上下文后调用 `r.WithContext(ctx)` 生成浅拷贝请求交给下一层，出站调用则传入 `http.NewRequestWithContext`，完整实践详见[第 16 章](./chapter-16#ch16-2-2)：

```go
func TraceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

## 14.2 取消传播、取消原因与超时预算 {#ch14-2}

### 14.2.1 WithCancel、defer cancel() 与 WithCancelCause {#ch14-2-1}

调用 `context.WithCancel(parent)` 派生可取消子上下文时，必须牢记三条底层规则：

1. **拿到 `cancel` 后下一行立即写 `defer cancel()`**：子上下文会在父上下文内部登记取消监听引用；即便业务逻辑提前正常返回，漏调 `cancel()` 也会导致关联资源滞留到父上下文结束才释放。`go vet` 默认启用的 `lostcancel` 检查器专门拦截遗漏调用的分支。
2. **`cancel()` 幂等且并发安全**：首次调用会关闭 `ctx.Done()` 只读通道，广播唤醒所有监听协程并级联取消全部子孙上下文；后续重复调用均为空操作。
3. **根上下文的 `Done()` 返回 `nil` 通道**：放入 `select` 中天然永不就绪，但切勿在 `select` 之外直接读取 `<-context.Background().Done()`，否则会永久死锁（参见[通道四种状态行为速查表](./chapter-13#ch13-2-2)）。

普通 `WithCancel` 取消后，调用 `ctx.Err()` 只能拿到固定的类别[哨兵错误](./chapter-10#ch10-1-2)：显式调用 `cancel` 返回 `context.Canceled`，父级超时波及返回 `context.DeadlineExceeded`，无法区分到底是哪一路下游因何业务故障触发了拉闸。自 Go 1.20 起，使用 **`context.WithCancelCause(parent)`** 可在拉闸时传入具体 `error`，任意下游调用包级函数 **`context.Cause(ctx)`** 即可取回首次取消注入的根因；下例额外导入 `"errors"` 与 `"fmt"`：

```go
ctx, cancel := context.WithCancelCause(context.Background())
defer cancel(nil) // 若正常结束未报错，兜底释放资源

cancel(errors.New("inventory upstream 503"))

fmt.Println(ctx.Err())          // context canceled
fmt.Println(context.Cause(ctx)) // inventory upstream 503
```

若调用 `cancel(nil)`，`context.Cause(ctx)` 会回退为 `context.Canceled`；上下文尚未取消时返回 `nil`。注意 `Cause` 设计为包级函数而非 `Context` 接口的新方法，正是为了在不破坏全网已有 `Context` 实现的前提下向后兼容演进（参见[接口设计惯例](./chapter-08#ch8-2)）。

### 14.2.2 WithTimeout / WithDeadline 分层预算 {#ch14-2-2}

服务端防止被慢下游拖垮的核心手段是为调用链划定时间上限：`context.WithTimeout(parent, d)` 在相对时长 `d` 后自动取消，`context.WithDeadline(parent, t)` 在绝对时刻 `t` 自动取消。当新截止时间早于父上下文（或父级无截止时间）且尚未过期时，标准库会在内部创建定时器；若父上下文已存在更早的截止时间，则直接沿用父级截止时间并退化为返回 `WithCancel(parent)`，**不会新建定时器**。但无论内部是否新建定时器，子上下文都可能持有定时资源或挂载在父级上的取消监听引用，**正常提前返回时仍必须通过 `defer cancel()` 立即释放资源**。

当多层调用嵌套设置超时时，严格遵循**“谁先到期谁先算”**的收缩规则——子上下文绝不可能突破父上下文的剩余寿命：

```go
parent, cancelParent := context.WithTimeout(context.Background(), 2*time.Second)
defer cancelParent()

child, cancelChild := context.WithTimeout(parent, 5*time.Second)
defer cancelChild()

start := time.Now()
<-child.Done()
fmt.Println(time.Since(start).Truncate(time.Second)) // 2s
```

利用这一特性可自然实现**分层超时预算**：入口网关为整笔请求分配 `2s` 总预算，内部风控子调用设 `300ms`、库存子调用设 `800ms`；若前置步骤已耗去 `1.6s`，最后的库存调用即使声明了 `800ms` 也会在剩余 `400ms` 准时截止。可通过 `deadline, ok := ctx.Deadline()` 查询当前截止时刻，用 `errors.Is(ctx.Err(), context.DeadlineExceeded)` 判断是否因超时终止；若希望超时触发时 `context.Cause(ctx)` 也能携带可读的业务诊断信息，可使用 `context.WithTimeoutCause`（Go 1.21+）。

### 14.2.3 响应取消、AfterFunc 与 WithoutCancel 脱离取消 {#ch14-2-3}

标准库 HTTP 客户端、`net.Dialer` 与主流数据库驱动收到 `ctx` 后会自动在内部响应取消。自研代码在两类耗时点上必须主动检查信号，否则传入 `ctx` 无法真正止损：

- **阻塞在通道收发时**：放入 `select`，并列监听 `case <-ctx.Done(): return context.Cause(ctx)`。
- **执行纯计算大循环或分批任务时**：每轮或每批开头检查 `context.Cause(ctx)`，一旦非 `nil` 立即中断返回：

```go
func crunchBatches(ctx context.Context, batches [][]byte) error {
	for _, batch := range batches {
		if err := context.Cause(ctx); err != nil {
			return err
		}
		processBatch(batch)
	}
	return nil
}
```

此外，Go 1.21 补齐了两个专门处理生命周期边界的实用函数：

- **`stop := context.AfterFunc(ctx, cleanup)`（Go 1.21+）**：当 `ctx` 取消时自动在独立 Goroutine 中执行一次 `cleanup`；若操作在取消前已正常完成，调用 `stop()` 即可注销回调。它非常适合在取消瞬间主动 `Close()` 不支持传 `ctx` 的底层阻塞连接以唤醒等待协程。
- **`bgCtx := context.WithoutCancel(ctx)`（Go 1.21+）**：派生出一个剥离父级取消与超时、但完整保留父链所有 `Value` 键值对的新上下文。在 `net/http` 中，一旦 `ServeHTTP` 处理函数返回，`r.Context()` 就会被服务端立即取消；若返回前需要启动异步 Goroutine 写非关键审计日志，直接传 `r.Context()` 会因立即取消而失败，传 `context.Background()` 又会丢失链路 Trace ID。此时应先用 `context.WithoutCancel(r.Context())` 脱离请求取消，再外包一层独立的 `context.WithTimeout` 防止后台协程无限挂起。

## 14.3 请求级元数据传递（WithValue） {#ch14-3}

使用 `context.WithValue` 前必须守住职责边界：**订单号、分页参数、业务配置等显式输入必须写在函数参数列表里，绝不能把 `Context` 当作隐式传参袋**。只有横切整条调用链、中间业务层不应感知的请求级元数据——典型如链路追踪 ID、请求认证解出的身份标识——才适合放入 `Context`。`WithValue(parent, key, val)` 每次返回包裹新键值对的不可变子上下文，读取 `ctx.Value(key)` 时沿父链向上线性比对，不宜在单条链上挂载过多层级。

`WithValue` 的键类型必须可比较，且**严禁直接使用内置 `string` 或 `int` 作为键**，否则不同包使用同名字符串键时会静默互相覆盖。标准做法是在包内定义**未导出的专属空结构体键类型**，配套导出成对的类型安全读写函数：

```go
type userKey struct{}

func ContextWithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userKey{}, user)
}

func UserFromContext(ctx context.Context) (string, bool) {
	user, ok := ctx.Value(userKey{}).(string)
	return user, ok
}
```

即使其他包也定义了同名的未导出 `type userKey struct{}`，在 Go 类型系统中它们也属于完全不同的类型，`==` 比较恒为 `false`，从根源上杜绝跨包键冲突。

读取后的元数据建议按用途分流：与业务规则直接相关的操作人身份，应在控制器入口调用 `UserFromContext(ctx)` 取出后转为普通 `string` 形参传给核心业务函数，使业务单元测试无需构造复杂上下文；纯可观测性追踪 ID 则保留在 `ctx` 中一路透传至底层日志器与 HTTP 客户端。

## 练习 {#ch14-exercises}

以下 2 道练习分别检验超时预算与自定义取消原因配合、以及私有键类型的安全读写封装。代码片段默认位于 `package main`，按需导入 `"context"`、`"errors"`、`"fmt"`、`"math/rand/v2"` 与 `"time"`。建议先独立编写，再展开核对参考答案。

### 练习 1：受 2 秒超时预算约束的计算循环与原因区分

使用 `context.WithTimeoutCause` 为任务设定 `2` 秒超时及自定义超时根因 `errors.New("sum budget 2s exceeded")`；在循环中调用 `rand.IntN(100_000_000)` 生成随机整数并累加，直至抽中 `1234` 或超时触发为止。退出时打印累加和、迭代轮数，以及超时分支下的 `ctx.Err()` 与 `context.Cause(ctx)`。

<details>
<summary>查看参考答案</summary>

```go
func runBoundedSum() {
	cause := errors.New("sum budget 2s exceeded")
	ctx, cancel := context.WithTimeoutCause(context.Background(), 2*time.Second, cause)
	defer cancel()

	var sum int64
	iters := 0
	for {
		if err := ctx.Err(); err != nil {
			fmt.Printf("stopped: err=%v, cause=%v, sum=%d, iters=%d\n",
				err, context.Cause(ctx), sum, iters)
			return
		}
		n := rand.IntN(100_000_000)
		sum += int64(n)
		iters++
		if n == 1234 {
			fmt.Printf("hit 1234: sum=%d, iters=%d\n", sum, iters)
			return
		}
	}
}
```

每轮开头检查 `ctx.Err()` 让纯内存计算循环也能及时响应超时；若因满 2 秒退出，`ctx.Err()` 保持标准哨兵 `context.DeadlineExceeded`，而 `context.Cause(ctx)` 返回具体的 `"sum budget 2s exceeded"`。

</details>

### 练习 2：使用未导出键类型封装请求级日志级别过滤

定义 `type Level string` 及常量 `Debug Level = "debug"`、`Info Level = "info"`：

1. 使用包内未导出键类型实现 `ContextWithLevel(ctx, level)` 与 `LevelFromContext(ctx) (Level, bool)`；
2. 实现 `Log(ctx context.Context, level Level, msg string)`：仅当 `ctx` 中存有合法级别，且消息级别不低于该阈值时才打印 `msg`——即上下文级别为 `Debug` 时打印 `Debug` 与 `Info`，为 `Info` 时仅打印 `Info`。

<details>
<summary>查看参考答案</summary>

```go
type Level string

const (
	Debug Level = "debug"
	Info  Level = "info"
)

type levelKey struct{}

func ContextWithLevel(ctx context.Context, level Level) context.Context {
	return context.WithValue(ctx, levelKey{}, level)
}

func LevelFromContext(ctx context.Context) (Level, bool) {
	lvl, ok := ctx.Value(levelKey{}).(Level)
	return lvl, ok
}

func Log(ctx context.Context, level Level, msg string) {
	inLevel, ok := LevelFromContext(ctx)
	if !ok {
		return
	}
	if level == Debug && inLevel == Debug {
		fmt.Println(msg)
	}
	if level == Info && (inLevel == Debug || inLevel == Info) {
		fmt.Println(msg)
	}
}
```

未导出空结构体 `levelKey{}` 零内存开销且彻底隔离跨包同名键冲突；成对辅助函数把 `any` 类型断言收拢在包内部，对外暴露编译期类型安全的签名。

</details>

## 面试题 {#ch14-interview}

以下 3 道面试题考察 `Context` 存储与键类型禁忌、漏调 `cancel()` 的资源隐患以及异步任务脱离请求取消的正确做法。代码约定同[练习部分](#ch14-exercises)，建议先独立作答再展开核对。

### 面试题 1：为什么不能把 `ctx` 存进结构体字段，也不能用内置 `string` 做 `WithValue` 的键？

<details>
<summary>查看参考答案</summary>

1. 结构体实例通常跨多个请求长期存活或并发共享，而 `ctx` 代表**单条请求调用链**的超时与取消边界；存入结构体字段会导致不同请求的生命周期混杂串台，因此必须作为函数首参显式传递。
2. `WithValue` 使用 `==` 比较键：若两个包都直接拿内置 `string`（如 `"trace_id"`）做键，后写入的值会静默覆盖前者。改用包内未导出的自定义类型——例如 `type traceKey struct{}`——做键，不同包的同名未导出类型在类型系统中绝不相等，可彻底避免冲突。

</details>

### 面试题 2：`ctx, cancel := context.WithTimeout(parent, 5*time.Second)` 若业务 10 毫秒就正常返回了，不调 `cancel()` 有什么后果？

<details>
<summary>查看参考答案</summary>

会导致关联资源延迟泄漏。子上下文为了监听父级取消会在父上下文内部挂载引用，且当自身 5 秒截止时间早于父级（或父级无截止时间）时还会创建并持有内部定时器；业务提前返回却不调用 `cancel()`，这些内部状态就要白白滞留到截止时间到达（或等到父上下文结束）才能释放，高并发场景下会造成显著内存膨胀。即便父级截止时间已更早、内部退化为 `WithCancel(parent)` 而未新建定时器，调用方也仍须紧跟 `defer cancel()` 及时摘除父级监听引用。

</details>

### 面试题 3：HTTP 处理函数返回前启动异步 Goroutine 写审计日志，为什么不能直接传 `r.Context()`？应如何处理？

<details>
<summary>查看参考答案</summary>

不能直接传 `r.Context()`，因为外层 `ServeHTTP` 一旦返回，`net/http` 服务端会立即取消 `r.Context()`，后台协程拿着已取消上下文访问数据库或下游接口会当场因 `context canceled` 失败。

若直接改传 `context.Background()`，则会丢失请求链路上存入 `r.Context()` 的 Trace ID 等元数据。正确做法是使用 **`context.WithoutCancel(r.Context())`**（Go 1.21+）剥离父级取消信号并完整保留请求元数据，再为其包裹一层独立的 `context.WithTimeout` 兜底限时。

</details>

## 参考资料

- [Go 标准库 `context`：`Context` 接口、取消原因与 `WithoutCancel`](https://pkg.go.dev/context)
- [Go 官方博客：Go Concurrency Patterns: Context](https://go.dev/blog/context)
- [Go 官方博客：Contexts and structs](https://go.dev/blog/context-and-structs)
- [Go 1.20 发布说明：`WithCancelCause` 与 `Cause`](https://go.dev/doc/go1.20#context)
- [Go 1.21 发布说明：`WithoutCancel`、`AfterFunc` 与 `WithTimeoutCause`](https://go.dev/doc/go1.21#context)
- [`go vet` 分析器：`lostcancel`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/lostcancel)
