---
title: 第 13 章 Goroutine、通道与同步
description: 掌握 Goroutine、通道与 select 多路复用机制，运用取消清理、有界背压、WaitGroup 与互斥锁编写无泄漏的并发程序。
---

# 第 13 章 Goroutine、通道与同步

## 本章要点

编写 Go 并发程序最常见的两类隐患，一是误将并发当作无条件提速手段而滥用 Goroutine，二是只负责启动协程却未设计退出路径，导致阻塞协程长期驻留内存形成泄漏。本章从并发与并行的适用边界切入，梳理 Goroutine 调度特性、通道在四种状态下的读写关闭规则以及 `select` 多路复用机制；随后聚焦防泄漏取消、有界背压、`nil` 通道屏蔽分支、`sync.WaitGroup` 多写单关与 `sync.OnceValue` 单次初始化等高频工程模式，最后明确通道、互斥锁与原子操作的选型准则。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 13.1 并发适用边界与 Goroutine {#ch13-1}

动手添加 `go` 关键字前，需先区分两个概念：**并发（Concurrency）**是在代码结构上将互不依赖的任务拆解开独立推进，**并行（Parallelism）**则是多核 CPU 在同一物理时刻同时执行指令。把几百纳秒即可完成的内存计算拆成多个 Goroutine 并经通道同步，调度与通信成本反而远超计算本身。是否引入并发主要看等待类型：

- **合并互不依赖的外部 I/O 是并发的首要主场**：并发发起多次独立的下游 HTTP 请求或数据库查询，可将总耗时从各路相加压缩为最慢单路耗时。
- **纯 CPU 密集计算需靠实测验证**：仅当单块任务粒度足够大、多核收益足以抵消同步开销时才值得拆分，应先写顺序实现，再通过[基准测试](./chapter-17#ch17-4-2)对比吞吐与分配指标。

操作系统线程栈固定偏大且内核态切换昂贵，而 **Goroutine 是 Go 运行时在用户态调度的轻量级执行单元**。每个 Goroutine 初始栈仅数 KiB 并按需动态扩缩；当协程阻塞在通道或网络 I/O 上时，运行时直接在用户态切换执行其他就绪协程。

在函数或闭包调用前加 `go` 即可启动新协程；若被调函数有返回值，返回值会被直接丢弃。推荐**让核心业务函数保持纯同步签名，由外层小闭包专门负责通道收发**：

```go
func process(val int) int { return val * 2 } // 纯同步逻辑，便于直接编写单元测试

func runWorkers(in <-chan int, out chan<- int, workers int) {
	for range workers {
		go func() {
			for val := range in {
				out <- process(val)
			}
		}()
	}
}
```

这种分层既避免了异步签名沿调用链传染，也解耦了业务逻辑与并发调度。启动后台协程还须遵守两条安全规则：

- **子协程独立兜底 `recover`**：子 Goroutine 内未捕获的 `panic` 会直接终止整个进程，外层无法跨协程拦截，恢复逻辑必须写在该子协程自身的顶层 `defer` 中，详见[panic、recover 与堆栈信息](./chapter-10#ch10-3)。
- **闭包捕获变量的并发边界**：模块版本为 Go 1.22+ 时，`for` 循环头声明的迭代变量按轮独立创建，旧版本行为详见[迭代变量按轮创建](./chapter-04#ch4-3-3)；若捕获循环外仍被修改的变量，仍应通过参数显式传值。

## 13.2 通道（channel）与 select 多路复用 {#ch13-2}

### 13.2.1 单向通道、缓冲容量与关闭责任 {#ch13-2-1}

Goroutine 之间通过**通道（Channel）**传递数据与同步信号。通道零值为 `nil`（见[零值与预声明基础类型](./chapter-02#ch2-1)），用 `make` 初始化；箭头离开通道为读，指向通道为写，单次读取可通过逗号 `ok` 区分真实零值与关闭状态：

```go
ch := make(chan int)
ch <- 42       // 发送值
v, ok := <-ch  // 接收值：ok 为 false 表示通道已关闭且缓冲已排空，v 为零值
```

写入通道的每条消息只会被**单个**接收者取走而非广播。函数参数与返回值应尽量将双向 `chan T` 收窄为只读 `<-chan T` 或只写 `chan<- T`，借助编译器拦截消费方误写或误调 `close`。

`make(chan T)` 创建**无缓冲通道**，收发双方必须同步配对交接，否则先到方阻塞；`make(chan T, cap)` 创建**缓冲通道**，未满时发送不阻塞、非空时接收不阻塞，`len` 与 `cap` 分别返回当前积压数与容量。无明确解耦或限流需求时默认使用无缓冲通道，切勿靠盲目调大缓冲掩盖死锁。

`for v := range ch` 会持续读取直至通道关闭且残留元素读尽。通道关闭后严禁再写，但仍可无限次读取：先按序读完残留缓冲，此后立即返回零值与 `false`。关闭通道须遵守两条原则：

1. **只由写入方关闭通道**：读取方擅自调用 `close` 会导致仍在发送的写入方触发 `panic`；多写入方共享通道时须由协调协程统一关闭，见 [13.3.2 节](#ch13-3-2)。
2. **无须强行关闭每个通道**：只要没有任何活跃协程持有引用，未关闭的通道也会被 GC 回收；仅当下游依赖 `for range` 或关闭广播感知结束时才需显式 `close`。

### 13.2.2 通道四种状态行为速查表 {#ch13-2-2}

通道在不同状态下的读取、写入与关闭行为对照如下：

| 通道状态 | 读取 `<-ch` | 写入 `ch <- v` | 关闭 `close(ch)` |
| --- | --- | --- | --- |
| 零值 `nil` 通道 | **永久阻塞** | **永久阻塞** | **`panic`** |
| 已打开、无缓冲 | 阻塞直至有写入方配对 | 阻塞直至有读取方配对 | 正常关闭 |
| 已打开、有缓冲 | 缓冲空时阻塞，非空立即读出 | 缓冲满时阻塞，未满立即写入 | 正常关闭 |
| 已关闭 | 先读尽残留缓冲，此后立即返回零值与 `false` | **`panic`** | **`panic`** |

关闭 `nil` 通道、重复关闭或向已关闭通道写入这三种 `panic` 均属并发缺陷；而 `nil` 通道读写永久阻塞的特性可用于在 `select` 中动态屏蔽分支。

### 13.2.3 select 伪随机选择与 for-select 铁律 {#ch13-2-3}

单个 Goroutine 同时等待多路通道通信时使用 `select` 语句，在多个分支同时就绪时按**均匀伪随机**方式从中挑选一个执行；无就绪分支时默认挂起等待，若含 `default:` 分支则不阻塞并立即执行 `default`。注意：`select` 的均匀伪随机语义只在统计意义上避免按声明顺序产生固定饥饿，**既不保证分支优先级（例如不会优先选中 `<-ctx.Done()`），也不保证在有限轮内必然选中某个分支**；若业务需要严格优先响应取消或高优通道，应在进入主 `select` 前先做带 `default` 的非阻塞预检，或在嵌套 `select` / 二次检查中显式处理优先级。编写持续监听的 `for-select` 循环须严守两条铁律：

1. **严禁随手添加 `default` 分支**：否则无消息时协程不会休眠，而是忙等空转跑满单核 CPU。
2. **牢记无标签 `break` 仅跳出 `select` 本身**：不会终止外层 `for` 循环；退出循环须使用 `return` 或带外层标签的 `break loop`，详见[外层循环标签与 goto 限制](./chapter-04#ch4-4-3)。

## 13.3 高频并发模式 {#ch13-3}

### 13.3.1 防 Goroutine 泄漏与有界并发背压 {#ch13-3-1}

设计导出 API 时应隐藏内部通道与锁细节，对外保持普通入参与 `(Result, error)` 返回值。由于 GC 不会回收卡死在通道或锁上的活跃协程，每个 `go func()` 都必须明确退出条件：

- **传入 `context.Context` 终止后台生成器**：让发送分支与标准库 `"context"` 的 `<-ctx.Done()` 并列放入 `select`，调用方一旦提前退出，`defer cancel()` 即可唤醒后台协程收工，详见[取消传播与超时预算](./chapter-14#ch14-2)。
- **为限时或并行汇聚结果预留缓冲槽位**：给单次阻塞调用外包超时，或派发 `N` 个子协程并行拉取下游结果时，结果与错误通道容量应设为子任务数——例如单路限时用 `make(chan Result, 1)`——防止外层因超时或早退返回后，迟到的子协程永久卡死在发送语句上：

```go
func countTo(ctx context.Context, max int) <-chan int {
	ch := make(chan int)
	go func() {
		defer close(ch)
		for i := range max {
			select {
			case <-ctx.Done():
				return
			case ch <- i:
			}
		}
	}()
	return ch
}
```

缓冲通道还常充当**有界信号量（Bounded Semaphore）**实现**背压（Backpressure）**，限制同一时刻的最大在途并发数，超载请求走 `default` 立即快速失败；下例使用标准库 `"errors"`，初始化时调用 `make(Semaphore, limit)`：

```go
type Semaphore chan struct{}

func (s Semaphore) Run(fn func()) error {
	select {
	case s <- struct{}{}:
		defer func() { <-s }()
		fn()
		return nil
	default:
		return errors.New("no more capacity")
	}
}
```

有界信号量限制的是并发在途任务数；若需按固定速率补充配额的令牌桶限流器，应使用 `golang.org/x/time/rate`。

### 13.3.2 nil 通道屏蔽分支与 WaitGroup（含 wg.Go）多写单关 {#ch13-3-2}

用 `for-select` 合并两个独立输入通道时，先关闭的一路若继续留在 `select` 中会因“已关闭通道随时可读”引发无限空转。一旦检测到 `!ok`，立即将该通道变量赋为 `nil`，即可利用 `nil` 通道永久阻塞的特性屏蔽该分支：

```go
for in1 != nil || in2 != nil {
	select {
	case v, ok := <-in1:
		if !ok {
			in1 = nil
			continue
		}
		handle(v)
	case v, ok := <-in2:
		if !ok {
			in2 = nil
			continue
		}
		handle(v)
	}
}
```

等待一组后台协程全部完成时使用标准库 `"sync"` 的 `sync.WaitGroup`。`WaitGroup` 零值可用，但严禁按值复制，详见[值语义与指针语义](./chapter-06#ch6-3)：

- **优先使用 `wg.Go`（Go 1.25+）**：自动完成启动前加计数与返回后减计数，消除漏调 `Done` 或放错 `Add` 位置的风险；传入函数不得放任未恢复的 `panic`。
- **兼容 Go 1.24 及更早版本**：**必须在 `go func()` 外部先调用 `wg.Add(n)`**，协程内首行写 `defer wg.Done()`。

多个工作协程共写同一输出通道时，标准**“多写单关”**写法是单独起一个协调协程等 `wg.Wait()` 归零后统一 `close(out)`：

```go
func processAndGather[T, R any](in <-chan T, processor func(T) R, workers int) []R {
	out := make(chan R, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for v := range in {
				out <- processor(v)
			}
		})
	}
	go func() {
		wg.Wait()
		close(out)
	}()

	var res []R
	for v := range out {
		res = append(res, v)
	}
	return res
}
```

`WaitGroup` 不收集 `error` 也不联动取消；需要“任一子任务报错即取消其余任务并返回首个错误”时，优先选用 `golang.org/x/sync/errgroup` 的 `errgroup.WithContext(ctx)`。

### 13.3.3 单次延迟初始化（sync.OnceValue） {#ch13-3-3}

需要把高开销初始化推迟到首次调用，并保证高并发下严格只执行一次时，直接使用 `sync.OnceFunc`、`sync.OnceValue[T]` 或 `sync.OnceValues[T1, T2]`（Go 1.21+）：

```go
var getParser = sync.OnceValue(initSlowParser)

func Parse(input string) string { return getParser().Parse(input) }
```

无论多少协程并发调用 `getParser()`，`initSlowParser` 都只执行一遍，后续调用直接返回缓存值。

## 13.4 互斥锁、原子操作与同步选型 {#ch13-4}

日常并发同步应根据数据流向与保护粒度按表选型：

| 同步方案 | 核心适用场景 | 关键特征与选型提示 |
| --- | --- | --- |
| 通道 `chan T` | 跨协程移交数据所有权、流水线编排、事件通知与超时取消 | 天然配合 `select` 多路组合，明确阶段间权责边界 |
| `sync.Mutex` / `RWMutex` | 守护结构体内部共享状态（如缓存映射）的原地并发读写 | 临界区短选 `Mutex`；读远多于写时选 `RWMutex` |
| `sync/atomic` | 单个独立标量计数、布尔开关或指针的无锁原子读写 | 优先用强类型 `atomic.Int64`、`atomic.Bool`、`atomic.Pointer[T]`（Go 1.19+） |

例如维护内存积分榜 `map[string]int`（初始化时须 `make` 映射）时，使用 `sync.RWMutex` 原地保护清晰高效：

```go
type Scoreboard struct {
	mu     sync.RWMutex
	scores map[string]int
}

func (s *Scoreboard) Set(name string, val int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scores[name] = val
}

func (s *Scoreboard) Get(name string) (int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, ok := s.scores[name]
	return val, ok
}
```

使用互斥锁与原子操作须严守三条底线：

1. **互斥锁不可重入**：同一 Goroutine 未解锁前再次对同一把锁请求 `Lock`，或已持 `RLock` 等待写锁介入，都会当场死锁。
2. **严禁按值复制锁**：含锁结构体方法一律用指针接收者，传参一律传指针，靠 `go vet ./...` 的 `copylocks` 检查把关。
3. **杜绝无锁数据竞争**：任何并发读写都不得留无锁裸读口子。切片、字符串和接口等多机器字值竞争读写会产生撕裂状态；并发读写原生映射更会触发不可 `recover` 的致命崩溃，详见[映射并发边界](./chapter-03#ch3-4-2)，测试时须开启 `-race` 验证（见[竞态检测](./chapter-17#ch17-4-2)）。`sync.Map` 仅适用于读多写极少或协程写不相交键集的高争用场景；跨多字段保持一致更新时不可单靠多个 `atomic` 变量拼凑，应退回 `sync.Mutex`。

## 练习 {#ch13-exercises}

以下 2 道练习分别检验多生产者汇聚关闭与 `for-select` 双通道 `nil` 屏蔽技巧。代码片段默认位于 `package main`，按需导入 `"fmt"` 与 `"sync"`。建议先独立编写，再展开核对参考答案。

### 练习 1：使用 WaitGroup 实现多生产者扇入并安全关闭通道

编写函数 `fanInSum() int`：启动两个生产者 Goroutine 向**同一个通道**分别发送 `1`～`10` 和 `11`～`20` 的整数，主协程通过 `for range` 累加全部整数并返回总和，要求无死锁或协程泄漏。

<details>
<summary>查看参考答案</summary>

```go
func fanInSum() int {
	ch := make(chan int)
	var wg sync.WaitGroup
	sendRange := func(lo, hi int) {
		wg.Go(func() {
			for i := lo; i <= hi; i++ {
				ch <- i
			}
		})
	}
	sendRange(1, 10)
	sendRange(11, 20)

	go func() {
		wg.Wait()
		close(ch)
	}()

	sum := 0
	for v := range ch {
		sum += v
	}
	return sum // 210
}
```

两个生产者共用 `ch` 时不能各自关闭；由协调协程等待 `wg.Wait()` 确认双方写完后统一 `close(ch)`，主协程 `for range` 读尽 20 个数后正常退出。

</details>

### 练习 2：使用 select 与 nil 通道合并消费两个独立通道

启动两个 Goroutine 分别向独立通道 `c1`、`c2` 发送 5 个整数并在写完后关闭各自通道；消费端用 `for-select` 读取两路数据并打印来源，要求两路排空后正常退出且不发生忙等空转。

<details>
<summary>查看参考答案</summary>

```go
func mergeTwo() {
	produce := func(start int) <-chan int {
		ch := make(chan int)
		go func() {
			defer close(ch)
			for i := start; i < start+5; i++ {
				ch <- i
			}
		}()
		return ch
	}
	c1, c2 := produce(0), produce(10)

	for c1 != nil || c2 != nil {
		select {
		case v, ok := <-c1:
			if !ok {
				c1 = nil
				continue
			}
			fmt.Println("c1:", v)
		case v, ok := <-c2:
			if !ok {
				c2 = nil
				continue
			}
			fmt.Println("c2:", v)
		}
	}
}
```

每路通道仅有唯一写入方，各自 `defer close` 即可；消费端读到 `!ok` 后立即将对应通道变量置为 `nil` 屏蔽该分支，直至两路均为 `nil` 退出循环。

</details>

## 面试题 {#ch13-interview}

以下 3 道面试题聚焦通道关闭读取边界、`for-select` 常见陷阱与 `WaitGroup` 演进。代码约定同[练习部分](#ch13-exercises)，建议先独立作答再展开核对。

### 面试题 1：关闭仍有缓冲元素的通道后连续读取会输出什么？

```go
ch := make(chan int, 2)
ch <- 10
ch <- 20
close(ch)

a, okA := <-ch
b, okB := <-ch
c, okC := <-ch
fmt.Println(a, okA, b, okB, c, okC)
```

<details>
<summary>查看参考答案</summary>

输出 `10 true 20 true 0 false`。关闭通道不会丢弃缓冲内已有元素：前两次依次读出 `10` 和 `20`，`ok` 均为 `true`；排空后第三次读取不阻塞，立即返回零值 `0` 与 `false`。

</details>

### 面试题 2：在持续监听的 `for-select` 循环中加空 `default` 或写无标签 `break` 有何后果？

<details>
<summary>查看参考答案</summary>

1. 添加空 `default:` 会导致所有通道无消息时协程无法休眠挂起，紧贴 `default` 死循环忙等空转，瞬间跑满单核 CPU。
2. `select` 内的无标签 `break` 仅跳出当前这轮 `select`，无法终止外层 `for` 循环；退出循环应使用 `return` 或带外层标签的 `break loop`。

</details>

### 面试题 3：传统手写 `sync.WaitGroup` 最容易踩哪三个坑？Go 1.25 的 `wg.Go` 做了什么改进？

<details>
<summary>查看参考答案</summary>

1. 把 `wg.Add(1)` 写进 `go func()` 内部，外层 `wg.Wait()` 可能赶在 `Add` 前看到零计数而提前返回。
2. 把 `WaitGroup` 按值传给子函数，子函数内 `Done()` 只改局部副本，外层 `Wait()` 永久死锁。
3. 提前返回分支漏掉 `defer wg.Done()`。

Go 1.25 的 `wg.Go(fn)` 将启动前加计数与返回后减计数原子封装在一起，消除了第 1 和第 3 类错误；但禁止按值复制及不在任务内放任未捕获 `panic` 的约束仍须遵守。

</details>

## 参考资料

- [Go 语言规范：`go` 语句（Go statements）](https://go.dev/ref/spec#Go_statements)
- [Go 语言规范：通道类型与收发操作（Channel types）](https://go.dev/ref/spec#Channel_types)
- [Go 语言规范：`select` 语句（Select statements）](https://go.dev/ref/spec#Select_statements)
- [Go 内存模型（The Go Memory Model）](https://go.dev/ref/mem)
- [Go 官方博客：Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)
- [Go 标准库 `sync`：`WaitGroup.Go`、`OnceValue` 与 `RWMutex`](https://pkg.go.dev/sync)
- [Go 标准库 `sync/atomic`：强类型原子操作](https://pkg.go.dev/sync/atomic)
- [`golang.org/x/sync/errgroup`：带错误传播与取消联动的并发组](https://pkg.go.dev/golang.org/x/sync/errgroup)
