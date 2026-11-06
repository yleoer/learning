---
title: 第 14 章 context
description: 掌握用 context.Context 沿调用链显式传递请求级元数据、取消信号、自定义取消原因与分层截止时间。
---

# 第 14 章 context

## 本章要点

服务端处理一个请求往往要跨好几层函数和多个并发 Goroutine：一方面要一路带着追踪 ID、调用方身份这类横切元数据，另一方面一旦客户端断连或总预算超时，又得立刻通知下游数据库查询与远程请求集体收手。Go 没有隐式的线程局部变量（Thread-Local Storage，毕竟 Goroutine 随时在线程间切换），而是用标准库 `"context"` 的 `context.Context` 接口把这两件事全摆在函数第一个参数上显式传递。本章依次梳理 `ctx` 的传参约定、用未导出键类型安全存取请求级值、`WithCancel` / `WithCancelCause` 的取消传播、`WithTimeout` 的分层超时继承，以及如何让自己的计算与后台操作正确响应或脱离取消。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 14.1 什么是 `context` {#ch14-1}

除另有说明外，本章正文中的类型与函数声明位于包级作用域，语句片段位于函数体内，省略外层 `package main` 与 `import` 声明；`context`、`fmt`、`errors`、`time`、`sync`、`http`（`"net/http"`）分别对应各自标准库包。

`context.Context` 并不是什么编译器特殊语法，它只是标准库 `"context"` 定义的一个包含四个只读方法（`Deadline`、`Done`、`Err`、`Value`）的普通接口。全 Go 生态共同遵守两条签名与存储惯例：

1. **永远把 `ctx context.Context` 放在函数参数列表的第一位**（就像 `error` 永远放在返回值最后一位一样）：
   ```go
   func loadOrder(ctx context.Context, orderID string) (Order, error) {
   	// ...
   }
   ```
2. **不要把 `Context` 塞进结构体字段长期存着**：`Context` 绑定的是“这一次请求/这一条动态调用链”的生命周期，存进共享结构体会导致不同请求的超时与取消信号串台。

在 `main` 入口、命令行初始化或独立后台任务的源头，用 `context.Background()` 创建空的根上下文；重构老代码时如果一时还没理清该从哪一层把上层上下文传过来，先临时填 `context.TODO()` 占位（方便上线前全局搜索清掉）。

在 `net/http` 服务里，上下文顺着三条固定接力棒往下传：

- **中间件往里填信息**：因为 `http.Handler` 接口早在 `context` 进标准库之前就已经定型了，不能改签名加参数，所以上下文挂在 `*http.Request` 上——先调 `req.Context()` 取出原上下文，派生出新子上下文后，再用 `req.WithContext(ctx)` 生成绑定了新上下文的浅拷贝请求传给下一层：
  ```go
  func Middleware(next http.Handler) http.Handler {
  	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
  		ctx := req.Context()
  		// 基于 ctx 派生携带元数据或超时的子上下文……
  		req = req.WithContext(ctx)
  		next.ServeHTTP(w, req)
  	})
  }
  ```
- **Handler 交给业务层**：处理函数首行取 `ctx := req.Context()`，作为第一个参数传进业务逻辑函数；
- **客户端发往下游服务**：用 `http.NewRequestWithContext(ctx, ...)` 或 `db.QueryContext(ctx, ...)` 把取消与剩余时间一路带进底层网络套接字。

## 14.2 请求级值传递 {#ch14-2}

先立一条原则：**普通业务参数（订单号、页码、配置结构体）老老实实写在函数参数列表里，绝不要拿 `context.WithValue` 当偷懒的万能传参袋**！塞进 `Context` 不仅丢掉了编译期类型与必填项检查，还让函数的真实依赖在签名上彻底隐身。只有真正横切整条调用链、中间层根本不关心也不该感知的**请求级元数据**——最典型的就是链路追踪 Trace ID、请求认证解出来的身份标识——才适合放进 `Context`。

`context.WithValue(parent, key, val)` 不会修改父上下文，而是包出一层携带该键值对的新不可变子上下文；读取时调 `ctx.Value(key)` 顺着父链一路往上线性比对，命中返回 `any`，未命中返回 `nil`（因此数据只能自上而下传递，不能靠它把下层算出来的结果塞回给上层；也别往链上挂几十层键值对）。

用 `WithValue` 最关键的一步是**选对键的类型**：键本身必须可比较，而且**绝对不要直接拿内置 `string` 或 `int` 做键**！如果鉴权包和审计包都图省事写了 `context.WithValue(ctx, "user", ...)`，后者会一声不吭把前者的值覆盖掉。标准防撞车写法是在你自己的包里定义一个**未导出的专属键类型**，再配套导出成对的读写辅助函数（习惯命名为 `ContextWithXxx` 和 `XxxFromContext`），把 `any` 类型断言严密收拢在包内部：

```go
// 单一键常用 0 字节的未导出空结构体类型；同包需要多个键时可用未导出 int 类型配合 iota
type userKey struct{}

func ContextWithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userKey{}, user)
}

func UserFromContext(ctx context.Context) (string, bool) {
	user, ok := ctx.Value(userKey{}).(string)
	return user, ok
}
```

因为 `userKey` 是未导出类型，哪怕别的包也定义了一个同名的未导出 `type userKey struct{}`，在 Go 类型系统里它们也是两个完全不同的类型，`==` 永远为 `false`，天生不可能跨包撞键！

至于取出来的元数据该怎么往下传，分两种角色对待：

- **跟业务规则直接相关的身份（如当前操作人 `user`）**：中间件从请求头验签塞进 `ctx`，到了 HTTP 控制器层一调 `UserFromContext(ctx)` 读出来，**立刻转成显式的 `string` 参数**传给 `BusinessLogic(ctx, user, input)`——让核心业务逻辑脱离 `Context` 键也能清清楚楚写单测；
- **纯可观测性运维标识（如链路追踪 GUID）**：业务计算压根不用它，只有最底层的日志器和出站 HTTP 客户端需要把它打进日志字段或请求头，那就让它静静留在 `ctx` 里一路透传到底即可。

## 14.3 取消信号与取消原因 {#ch14-3}

[12.5.3 节](./chapter-12#ch12-5-3)已经见过用取消信号关停后台 Goroutine，这里把 `context.WithCancel(parent)` 的三条底层规矩补全：

1. **拿到 `cancel` 函数的下一行立刻写 `defer cancel()`**：可取消的子上下文会在父上下文内部登记监听引用；就算正常业务分支提前跑完了，只要不调 `cancel()`，在父上下文销毁前这份内部挂载就不会释放（`go vet` 默认开启的 `lostcancel` 检查器专门抓漏调 `cancel` 的路径）。
2. **`cancel()` 是幂等且并发安全的**：第一次调用会关闭 `ctx.Done()` 返回的只读通道，通知所有监听它的协程和子孙上下文一并取消；后面不管再被哪个协程重复调多少次，都是安全的空操作。
3. **没有挂任何取消源的根上下文（如 `context.Background()`），其 `ctx.Done()` 返回的是 `nil` 通道**：放进 `select` 里天然不就绪，但千万别在外面直接裸写 `<-context.Background().Done()`，那会当场永久死锁（见 [12.3.3 节](./chapter-12#ch12-3-3)）。

看一个“双路轮询、任一出错即通知全局紧急刹车”的完整协作骨架（注意每次 HTTP 请求读完状态后都要及时关掉响应体，避免在循环里积压泄漏连接）：

```go
func checkEndpoint(ctx context.Context, client *http.Client, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

func watchEndpoints(client *http.Client) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan string)
	var wg sync.WaitGroup
	wg.Go(func() {
		for {
			code, err := checkEndpoint(ctx, client, "https://example.com/health")
			if err != nil || code >= http.StatusInternalServerError {
				cancel() // 发现故障，拉响全局取消信号
				return
			}
			select {
			case ch <- "health ok":
			case <-ctx.Done():
				return
			}
		}
	})
	// 第二个轮询 Goroutine 结构相同……

loop:
	for {
		select {
		case msg := <-ch:
			fmt.Println(msg)
		case <-ctx.Done():
			break loop
		}
	}
	wg.Wait()
}
```

普通 `WithCancel` 有个小遗憾：别的协程看到 `<-ctx.Done()` 关闭后调 `ctx.Err()`，只能拿到固定的取消类别哨兵（显式调用 `cancel` 时为 `context.Canceled`；若外层父上下文先到达截止时间，子上下文跟着取消时则为 `context.DeadlineExceeded`），看不出到底是哪一路因为什么具体业务错误拉的闸。自 **Go 1.20** 起，标准库新增了 **`context.WithCancelCause(parent)`**——它返回的 `cancel(err)` 允许在拉闸时塞入具体根因错误，任何一侧调包级函数 **`context.Cause(ctx)`** 就能取回第一次取消时传入的那个错误（若传了 `cancel(nil)`，则退回 `context.Canceled`；尚未取消时返回 `nil`）：

```go
ctx, cancel := context.WithCancelCause(context.Background())
defer cancel(nil) // 若正常走完未曾报错，兜底清理

// 故障协程拉闸并附上具体错误：
cancel(errors.New("upstream returned 503"))

// 任意位置读取根因：
fmt.Println(ctx.Err())          // context canceled（保持稳定的类别哨兵）
fmt.Println(context.Cause(ctx)) // upstream returned 503（保留具体失败根因）
```

顺带想想为什么 `context.Cause(ctx)` 做成了包级函数而不是 `ctx.Cause()` 接口方法？正是 [7.5.3 节](./chapter-07#ch7-5-3)讲过的教训：`context.Context` 是对外公开的接口，一旦往里面加新方法，全网所有自定义的 `Context` 实现都会瞬间编译失败；做成包级函数是零破坏演进的唯一办法。

## 14.4 截止时间与超时预算 {#ch14-4}

除了手动拉闸，服务端保护自己不被慢下游拖垮更靠给单次请求划死时间红线：`context.WithTimeout(parent, duration)` 在经过指定时长后自动取消，`context.WithDeadline(parent, time)` 则在到达某个具体时刻时自动取消（若传入的时刻已经过去则立即处于已取消状态）。**注意这两个函数同样会注册内部定时资源，返回的 `cancel` 函数即使在正常提前跑完时也必须 `defer cancel()` 调掉！**

当调用链多层嵌套都设置了超时时，遵循一条非常符合物理直觉的规则：**子上下文的实际寿命永远不可能突破父上下文的剩余寿命，永远是“谁先到期谁先算”**：

```go
parent, cancelParent := context.WithTimeout(context.Background(), 2*time.Second)
defer cancelParent()

child, cancelChild := context.WithTimeout(parent, 5*time.Second)
defer cancelChild()

start := time.Now()
<-child.Done()
fmt.Println(time.Since(start).Truncate(time.Second)) // 2s：父上下文一到期，子上下文当场跟着取消
```

这就让网关与服务内部可以自然地做**分层超时预算**：入口网关给整笔请求划 `2s` 总预算，里面先花 `300ms` 子超时查风控、再花 `800ms` 子超时调库存，万一前面步骤已经耗掉了 `1.6s`，最后一步就算写着 `800ms` 也会在剩余的 `400ms` 准时截止。需要查看当前上下文还剩多少时间，可以调用 `deadline, ok := ctx.Deadline()`。

取消发生后，`ctx.Err()` 会返回两个标准[哨兵错误](./chapter-09#ch9-3)之一：主动调用 `cancel` 返回 `context.Canceled`，到期自动触发则返回 `context.DeadlineExceeded`（判断统一用 `errors.Is`）。如果想让超时触发时 `context.Cause(ctx)` 也能返回一段带业务含义的自定义错误（比如 `"inventory rpc timed out after 800ms"`），自 **Go 1.21** 起可以直接用 `context.WithTimeoutCause(parent, d, causeErr)` 或 `context.WithDeadlineCause`。

## 14.5 让自己的代码响应取消 {#ch14-5}

标准库的 HTTP 客户端、`net.Dialer` 和主流数据库驱动只要收到了你传下去的 `ctx`，都会在内部自动监听取消并断开阻塞等待。而你自己写的代码在两类耗时点上必须主动配合检查，否则传了 `ctx` 也白传：

- **阻塞在通道收发上时**：一律放进 `select`，并排摆上 `case <-ctx.Done(): return ctx.Err()` 分支；
- **跑在纯 CPU 大循环或分批处理里时**：每隔合理的步数（或每处理完一批）主动看一眼 `ctx.Err()` 或 `context.Cause(ctx)`，一旦非 `nil` 立即停手返回：

```go
func crunchBatches(ctx context.Context, batches []Batch) error {
	for _, batch := range batches {
		if err := context.Cause(ctx); err != nil {
			return err
		}
		processBatch(batch)
	}
	return nil
}
```

最后记两个 **Go 1.21** 补齐的实用配套函数：

- **`stop := context.AfterFunc(ctx, cleanupFn)`（Go 1.21+）**：注册一个回调函数，一旦 `ctx` 被取消，运行时自动单起一个 Goroutine 执行一次 `cleanupFn`（若在取消发生前正常结束了，调 `stop()` 即可注销该回调），非常适合把不支持 `ctx` 的底层阻塞连接在取消那一刻强行 `Close()` 唤醒。
- **`bgCtx := context.WithoutCancel(ctx)`（Go 1.21+）**：基于原 `ctx` 派生出一个**剥离了父级取消信号与截止时间、但完整保留全部 `Value` 键值对**的新上下文。典型场景是 HTTP 处理函数即将结束返回前，想异步起个后台协程继续写一条非关键的审计日志或异步刷缓存——注意单次向 `ResponseWriter` 写入或刷新 `200 OK` 本身并不会取消 `r.Context()`，但**一旦外层 `ServeHTTP` 函数返回（或客户端提前断开连接），`net/http` 服务端就会立即取消 `r.Context()`**！此时后台协程若直接拿原 `r.Context()` 会很快因上下文已取消而失败，换成 `context.Background()` 又会把请求里的 Trace ID 丢光，用 `context.WithoutCancel(r.Context())`（最好再套一层独立的 `context.WithTimeout(..., 5*time.Second)` 防后台无限挂死）刚好两全其美。

## 练习 {#ch14-exercises}

以下三题分别练习可配置超时 HTTP 中间件、响应超时的计算循环，以及使用私有键类型封装请求级动态日志级别。代码片段按需导入 `"context"`、`"fmt"`、`"math/rand/v2"`、`"net/http"` 与 `"time"`。建议先独立编写，再展开核对参考答案。

### 练习 1：编写可配置毫秒数的请求超时中间件

实现高阶函数 `Timeout(ms int) func(http.Handler) http.Handler`：为每个进入的请求在其原有 `r.Context()` 之上叠加一个 `ms` 毫秒的子超时上下文，确保请求处理结束后及时释放取消资源。

<details>
<summary>查看参考答案</summary>

```go
func Timeout(ms int) func(http.Handler) http.Handler {
	limit := time.Duration(ms) * time.Millisecond
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), limit)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

必须基于 `r.Context()`（而不是 `context.Background()`）派生子超时：这样客户端如果半路主动断开 TCP 连接，服务器照样能立刻感知取消；`defer cancel()` 则保证正常快速跑完的请求立即清掉内部定时器，不等够 `ms` 毫秒。

</details>

### 练习 2：受 2 秒超时约束的随机累加循环

使用标准库 `"math/rand/v2"` 的 `rand.IntN(100_000_000)` 循环生成 `[0, 100_000_000)` 范围内的随机整数并累加，直到抽中数字 `1234` **或者**总运行时间满 `2` 秒为止；退出时打印累加和、总循环轮数以及退出原因（抽中目标还是超时）。

<details>
<summary>查看参考答案</summary>

```go
func runBoundedSum() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var sum int64
	iterations := 0
	for {
		if err := ctx.Err(); err != nil {
			fmt.Printf("stopped by %v: sum=%d iterations=%d\n", err, sum, iterations)
			return
		}
		n := rand.IntN(100_000_000)
		sum += int64(n)
		iterations++
		if n == 1234 {
			fmt.Printf("hit 1234: sum=%d iterations=%d\n", sum, iterations)
			return
		}
	}
}
```

每轮循环开头调 `ctx.Err()`（超时到期后返回 `context.DeadlineExceeded`）做轻量状态检查，让纯内存计算循环也能毫秒级响应外部时间预算；累加和用 `int64` 避免在 32 位平台上迅速整数回绕。

</details>

### 练习 3：通过私有上下文键传递请求级日志级别

定义 `type Level string` 及常量 `Debug = "debug"`、`Info = "info"`：

1. 用未导出键类型实现 `ContextWithLevel` 与 `LevelFromContext`；
2. 编写 HTTP 中间件从 URL 查询参数 `log_level` 读取级别，仅在值为 `"debug"` 或 `"info"` 时写入请求上下文；
3. 补全 `Log(ctx context.Context, level Level, message string)`：只有上下文里带有合法级别，且满足级别阈值（请求为 `Debug` 时输出 `Debug` 和 `Info`；请求为 `Info` 时只输出 `Info`）才打印消息。

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
	level, ok := ctx.Value(levelKey{}).(Level)
	return level, ok
}

func LevelMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lvl := Level(r.URL.Query().Get("log_level"))
		if lvl == Debug || lvl == Info {
			r = r.WithContext(ContextWithLevel(r.Context(), lvl))
		}
		next.ServeHTTP(w, r)
	})
}

func Log(ctx context.Context, level Level, message string) {
	inLevel, ok := LevelFromContext(ctx)
	if !ok {
		return
	}
	if level == Debug && inLevel == Debug {
		fmt.Println(message)
	}
	if level == Info && (inLevel == Debug || inLevel == Info) {
		fmt.Println(message)
	}
}
```

把白名单校验卡在 `LevelMiddleware` 入口，非法或未传参数根本不写进 `Context`，`Log` 里只需靠 `!ok` 就能一步过滤掉所有未授权调试日志，而且私有的 `levelKey{}` 绝不会和其他中间件的上下文键冲突。

</details>

## 面试题 {#ch14-interview}

以下四题分别考察 `Context` 放置位置与键类型规范、漏调 `cancel` 的后果、父子超时嵌套与后台脱离取消，以及 `ctx.Err()` 与 `context.Cause(ctx)` 的分工。建议先独立作答，再展开核对参考答案。

### 面试题 1：为什么不能把 `ctx` 存进结构体字段，也不能用字符串 `"trace_id"` 直接做 `WithValue` 的键？

<details>
<summary>查看参考答案</summary>

1. 结构体实例往往跨多个请求长久存活或并发共享，而 `ctx` 代表**单次请求调用链**的截止时间与取消范围；存进结构体字段会让多个请求的生命周期混杂串台，所以应始终作为函数第一个参数显式传递。
2. `WithValue` 按 `==` 比较键：如果两个不同包都拿内置 `string` 类型 `"trace_id"` 当键，后写入的值会静默覆盖前者的值。使用包内**未导出的自定义类型**（如 `type traceKey struct{}`）做键，即使不同包起名相同，类型身份也绝不相等，彻底杜绝跨包冲突。

</details>

### 面试题 2：`ctx, cancel := context.WithTimeout(parent, 5*time.Second)` 如果业务 10 毫秒就正常返回了，不调 `cancel()` 有问题吗？

<details>
<summary>查看参考答案</summary>

**有问题！** 子上下文为了监听父上下文取消并维护自己的 5 秒倒计时，会在内部挂载引用与定时结构；正常提前返回却不调 `cancel()`，这些关联资源就会一直白白挂到 5 秒超时（或父上下文结束）才释放，高并发请求下会积压出可观的内存膨胀。拿到 `cancel` 后紧跟一句 `defer cancel()` 是无脑必写的习惯（重复调用 `cancel` 完全安全）。

</details>

### 面试题 3：HTTP 请求处理完准备返回前，想异步起一个 Goroutine 写审计记录，直接把 `r.Context()` 传进去会出什么事？怎么改最合适？

<details>
<summary>查看参考答案</summary>

直接传 `r.Context()` 会导致后台审计十有八九失败：`ServeHTTP` 一返回，`net/http` 服务端就会立刻取消该请求的 `r.Context()`，后台协程拿着已取消的上下文调数据库会当场报 `context canceled`。

如果直接换成 `context.Background()`，虽然不会被取消，但请求链路上存进 `r.Context()` 的 Trace ID、租户标识等 `Value` 全丢了。最合适的做法是用 **`context.WithoutCancel(r.Context())`**（Go 1.21+）剥离父级取消信号并保留全部请求元数据，再套一层独立的 `context.WithTimeout(..., 3*time.Second)` 给后台写库加上兜底超时。

</details>

### 面试题 4：`ctx.Err()` 和 `context.Cause(ctx)` 返回的错误有什么区别？

<details>
<summary>查看参考答案</summary>

- **`ctx.Err()`**：只返回固定的取消**类别哨兵**——未取消时为 `nil`，主动取消为 `context.Canceled`，到期超时为 `context.DeadlineExceeded`，适合用 `errors.Is` 判断是超时还是取消。
- **`context.Cause(ctx)`（Go 1.20+）**：配合 `WithCancelCause` 或 `WithTimeoutCause`（Go 1.21+）使用时，返回触发首次取消时传入的**具体业务根因 `error`**（若未提供自定义原因，则返回值与 `ctx.Err()` 相同），适合打日志和向上层汇报真实失败原因。

</details>

## 参考资料

- [Go 标准库 `context`：`Context` 接口、取消、超时与 `WithoutCancel`](https://pkg.go.dev/context)
- [Go 官方博客：Go Concurrency Patterns: Context](https://go.dev/blog/context)
- [Go 官方博客：Contexts and structs](https://go.dev/blog/context-and-structs)
- [Go 1.20 发布说明：`WithCancelCause` 与 `Cause`](https://go.dev/doc/go1.20#context)
- [Go 1.21 发布说明：`WithoutCancel`、`AfterFunc` 与 `WithTimeoutCause`](https://go.dev/doc/go1.21#context)
- [Go 标准库 `net/http`：`Request.Context` 与 `Request.WithContext`](https://pkg.go.dev/net/http#Request.Context)
- [`go vet` 分析器：`lostcancel`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/lostcancel)
