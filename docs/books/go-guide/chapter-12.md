---
title: 第 12 章 Go 中的并发性
description: 掌握 Goroutine、通道与 select 的通信模型，运用取消清理、背压、超时、WaitGroup 与互斥锁写出无泄漏的并发代码。
---

# 第 12 章 Go 中的并发性

## 本章要点

写 Go 并发代码最怕掉进两个误区：一是误把“并发（组织独立任务的方式）”当成“并行（一定跑得更快）”到处乱起 Goroutine，二是只管启动不管退出，留下一堆永久卡死泄漏的后台协程。本章从何时真正需要并发切入，先把 Goroutine、有向/缓冲通道的各状态读写关闭规则和 `select` 随机公平调度摸透；再逐个拆解工程里最常用的并发模式——API 隐藏并发细节、`context` 取消防泄漏、有界并发信号量背压、`nil` 通道屏蔽已关闭分支、超时包装、`sync.WaitGroup`（含 Go 1.25 新增的 `wg.Go`）多写单关、`sync.OnceValue` 单次初始化以及多下游超时编排，最后划清“何时传通道、何时加互斥锁”的决策边界。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 12.1 何时使用并发 {#ch12-1}

除另有说明外，本章正文中的类型与函数声明位于包级作用域，语句片段位于函数体内，省略外层 `package main` 与 `import` 声明；`fmt`、`errors`、`time`、`sync`、`context` 分别对应各自同名标准库包。

动手加 `go` 关键字之前先泼一盆冷水：**把顺序代码拆成并发并不会自动变快**。并发（Concurrency）是代码层面把互不依赖的步骤拆开组织的结构手段，并行（Parallelism）则是硬件层面多个 CPU 核心在同一时刻真正同时跑指令。如果一段纯内存计算几百纳秒就跑完了，硬拆成几个 Goroutine 再走通道收发同步，光调度和通信的开销就比原计算慢好几倍。

判断是否值得引入并发，主要看数据流向和等待类型：

- **合并多个互不依赖的外部 I/O 是并发的绝对主场**：查两次独立的下游 HTTP 接口或两张无关的数据库表，网络来回动辄几毫秒到几十毫秒，并发发起能把总耗时从“两者相加”压到“取较慢者”；
- **纯 CPU 密集计算只有在单块任务粒度足够大、且多核并行收益经实测盖过同步开销时才值得拆分**——拿不准时先写干净的顺序版，再写并发版跑[基准测试](./chapter-15#ch15-6)对比。

[12.5.9 节](#ch12-5-9)会用一个真实的后端编排例子收尾：同时调下游服务 A 和 B，凑齐两份响应后再调服务 C，并为整条调用链设置 50 毫秒的超时预算。

## 12.2 Goroutine {#ch12-2}

操作系统线程（OS Thread）栈空间大、创建和内核态上下文切换成本高；**Goroutine 则是 Go 运行时在用户态自己调度的轻量级执行单元**。进程启动后，运行时维护少量操作系统工作线程，把成千上万个 Goroutine 多路复用到这些线程上执行：每个 Goroutine 初始栈只有几 KiB 且按需动态伸缩，一旦某个 Goroutine 在通道或网络 I/O 上阻塞，运行时调度器在用户态直接切走去跑别的就绪 Goroutine，不需要惊动操作系统内核切换线程。

在任意函数或闭包调用前面加上 `go` 关键字，就会启动一个新 Goroutine 异步执行它（注意被 `go` 直接调用的函数如果有返回值，**返回值会被直接丢弃**）。日常编码有个很好的习惯：**让底层核心业务函数保持纯粹的同步签名，用外层小闭包专门负责通道收发等“并发记账”**：

```go
func process(val int) int {
	// 纯同步计算，完全不感知自己是不是跑在并发环境里，单测极好写
	return val * 2
}

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

这样既没有 `async/await` 语言里“一旦底层异步、整条调用链全得传染改签名”的函数染色问题，又把核心逻辑和并发调度解耦开了。另外千万记住 [9.9 节](./chapter-09#ch9-9)强调过的铁律：**子 Goroutine 里未捕获的 `panic` 会直接把整个进程炸掉，`main` 或其他 Goroutine 里的 `recover()` 根本救不了它**——需要兜底 `recover` 时，必须写在该子 Goroutine 自己的顶层 `defer` 里。

### 12.2.1 循环中启动 Goroutine {#ch12-2-1}

在循环里起闭包 Goroutine 时，留心模块的 Go 语言版本边界：当 `go.mod` 声明为 **Go 1.22 及以上**时，`for` 头部的 `:=` 变量每轮都会新建独立实例（见 [4.4.5 节](./chapter-04#ch4-4-5)），下面的 5 个 Goroutine 会各自拿到独立的 `v`：

```go
nums := []int{2, 4, 6, 8, 10}
ch := make(chan int, len(nums))
for _, v := range nums {
	go func() {
		ch <- v * 2
	}()
}
for range nums {
	fmt.Println(<-ch)
}
```

如果你维护的老仓库 `go.mod` 还停在 `go 1.21` 或更低版本，5 个闭包会共享同一个循环变量 `v`，大概率打出一串 `20`（此时需改成显式传参 `go func(val int) { ch <- val * 2 }(v)` 或在循环体内加一行 `v := v`）。同时别忘了：Go 1.22 只管循环头 `:=` 声明的迭代变量；如果闭包捕获的是你在循环外或普通代码块里随后还会继续修改的变量，依然存在并发读写竞态，把当前值作为参数显式传给闭包最稳妥。

## 12.3 通道 {#ch12-3}

Goroutine 之间传递数据与同步信号靠**通道（Channel）**。通道和切片、映射一样是内置的引用描述符类型，零值为 `nil`，用 `make` 初始化：

```go
ch := make(chan int)
```

### 12.3.1 读写、方向约束与缓冲容量 {#ch12-3-1}

通道读写都用左箭头 `<-`，看箭头相对通道变量的位置就能分清读写——箭头离通道而去是读，箭头指向通道是写：

```go
val := <-ch // 从 ch 接收一个值赋给 val
ch <- x     // 把 x 发送进 ch
```

写进通道的每一条消息只会被**某一个**接收者取走（不是广播：如果三个工人 Goroutine 同时从同一个 `ch` 读取，每条消息只落入其中一个工人口袋）。在函数参数与返回值签名中，应尽量把双向通道 `chan T` 收窄为**单向通道**——**`<-chan T`（只读通道）**或 **`chan<- T`（只写通道）**（双向通道可隐式赋给单向通道，反之不行），让编译器直接拦住“消费方手滑调了 `close` 或反向写入”这类低级失误。

`make(chan T)` 不传第二个参数时创建的是**无缓冲通道（Unbuffered Channel）**：发送方必须死等另一个 Goroutine 来读，接收方也必须死等另一个 Goroutine 来写，两边像接力赛交棒一样当面同步完成传递。传入正整数容量 `make(chan T, 10)` 则创建**缓冲通道（Buffered Channel）**：在缓冲区填满之前发送不会阻塞，在缓冲区排空之前接收不会阻塞（`len(ch)` 和 `cap(ch)` 分别返回当前积压元素数和总容量）。除非明确知道为什么需要缓冲（见 [12.5.4 节](#ch12-5-4)），否则默认先用无缓冲通道，别靠拍脑袋加个 `1000` 缓冲去掩盖死锁。

### 12.3.2 `for range` 读取与关闭责任 {#ch12-3-2}

用 `for v := range ch` 可以持续从通道消费数据，直到该通道被 `close(ch)` 关闭**并且缓冲区里积压的元素全部读完**后，循环自动结束：

```go
for v := range ch {
	fmt.Println(v)
}
```

通道一旦关闭，不能再往里写，但**依然可以无限次读取**：如果缓冲里还有没读完的旧数据，先按顺序把旧数据吐完；排空之后再读，每次都会**不阻塞地立即返回元素类型的零值**！所以单次读取如果遇到零值，必须用**逗号 `ok` 写法**区分“对方真的发来了一个 `0`”还是“通道已经关了”：

```go
v, ok := <-ch // ok == false 说明通道已关闭且缓冲已排空，v 只是兜底零值
```

关于 `close(ch)` 牢记两条保命规矩：

1. **永远只由写入方关闭通道，读取方绝不要去 `close`**（读取方不知道写入方下一微秒会不会还要发一条，关了对方一写就直接 `panic`；如果有多个写入方共用一个通道，见 [12.5.7 节](#ch12-5-7)的协调关法）；
2. **不是每个通道用完都非得 `close` 不可**：通道不是文件句柄或 Socket，只要没有任何活跃 Goroutine 还拿着它的引用，哪怕没关过，GC 也会照常回收它；只有当下游确实在靠 `for range` 或 `<-done` 等待“没有后续数据/广播结束”信号时，才需要显式 `close`。

### 12.3.3 通道状态行为速查表 {#ch12-3-3}

把四种通道状态下的读、写、`close` 放在一张表里对比，遇到阻塞或崩溃一查便知：

| 通道状态 | 读取 `<-ch` | 写入 `ch <- v` | 关闭 `close(ch)` |
| --- | --- | --- | --- |
| 零值 `nil` 通道 | **永久阻塞** | **永久阻塞** | **`panic`** |
| 已打开、无缓冲 | 阻塞直到有写入方配对 | 阻塞直到有读取方配对 | 正常关闭 |
| 已打开、有缓冲 | 缓冲空时阻塞，非空立即读出 | 缓冲满时阻塞，未满立即写入 | 正常关闭 |
| 已关闭 | 先读完残留缓冲，此后**立即返回零值与 `false`** | **`panic`** | **`panic`** |

三格 `panic`（关 `nil` 通道、重复关已关闭通道、往已关闭通道写）都是硬伤 Bug；而第一行“`nil` 通道读写永久阻塞”看似是个坑，放进 `select` 里反倒成了动态关掉某个分支的妙招（见 [12.5.5 节](#ch12-5-5)）。

## 12.4 `select` 多路复用 {#ch12-4}

当一个 Goroutine 需要同时等待多个通道上的收发事件时，不能顺序排队阻塞读，而要用并发专用的 `select` 语句：

```go
select {
case v := <-inCh:
	fmt.Println("received:", v)
case outCh <- result:
	fmt.Println("sent:", result)
}
```

`select` 的执行规则跟普通 `switch` 有两处本质差别：

- **多个分支同时就绪时，运行时会伪随机公平挑一个执行**，而不是按从上到下的源码顺序偏心第一个分支，避免某个高频通道把别的通道饿死；
- **没有任何分支就绪时，默认整个 `select` 挂起阻塞**，直到至少有一个分支可通信为止；如果写了 `default:` 分支，则在所有通道都未就绪时**不阻塞、立即走 `default`**（常用于非阻塞试探读写）。

`select` 还能解开交叉等待造成的死锁。看下面这段典型死锁代码：子 Goroutine 想先写 `ch1` 再读 `ch2`，主 Goroutine 却想先写 `ch2` 再读 `ch1`，两个无缓冲通道谁也不让谁，运行时发现所有 Goroutine 全睡死了，直接报 `fatal error: all goroutines are asleep - deadlock!`：

```go
func main() {
	ch1 := make(chan int)
	ch2 := make(chan int)
	go func() {
		inGoroutine := 1
		ch1 <- inGoroutine
		fromMain := <-ch2
		fmt.Println("goroutine:", inGoroutine, fromMain)
	}()

	inMain := 2
	ch2 <- inMain // 永久卡死：子 Goroutine 正卡在 ch1 <- 1 等人接，根本走不到 <-ch2
	fromGoroutine := <-ch1
	fmt.Println("main:", inMain, fromGoroutine)
}
```

如果在 `main` 里把两次操作放进 `select`，主 Goroutine 看到 `<-ch1` 已经就绪就会先接过 `1`：

```go
var fromGoroutine int
select {
case ch2 <- inMain:
case fromGoroutine = <-ch1:
}
```

不过仔细看！这只是让 `main` 不死锁退出了——`main` 接完 `ch1` 走出 `select` 后根本没再往 `ch2` 写，那个子 Goroutine 其实还傻等在 `fromMain := <-ch2` 上直到整个进程结束！如果这不是 `main` 而是长生命周期的 HTTP 服务函数，就妥妥漏了一个永久挂起的 Goroutine。

最后记住写 **`for { select { ... } }` 循环**的两条军规：一是循环里必须留好明确的退出分支（如 `case <-ctx.Done(): return`，注意在 `select` 内部写不带标签的 `break` 只跳出 `select` 本身，跳不出外层 `for`！）；二是**千万别在持续监听的 `for-select` 里随手加 `default` 分支**，否则没消息时循环不会休眠等待，而是一秒钟空转上千万次把单核 CPU 直接跑满 100%。

## 12.5 并发实践与常见模式 {#ch12-5}

### 12.5.1 让公开 API 与并发细节解耦 {#ch12-5-1}

设计导出函数或结构体方法时，**尽量别把通道或互斥锁直接摆在公开签名里**（专门做并发调度的底层工具包除外）。一旦把 `chan Result` 暴露给调用方，谁负责建缓冲、谁负责关通道、写满卡住了算谁的锅，全甩给了外部使用者；把 Goroutine 和通道藏在函数或未导出字段内部，对外依然呈现普通的同步入参与 `(Result, error)` 返回值，日后你想调并发度还是换实现都完全可控。

### 12.5.2 Goroutine 泄漏与清理责任 {#ch12-5-2}

垃圾回收器只回收没人引用的内存，**永远不会自动杀掉一个卡在通道读写或锁上的 Goroutine**。每起一个 `go func()`，写下它的那一刻就必须答得出：“它在什么条件下退出？”

最容易漏掉退出的就是下面这种提前中断的生成器：

```go
func countTo(max int) <-chan int {
	ch := make(chan int)
	go func() {
		for i := range max {
			ch <- i
		}
		close(ch)
	}()
	return ch
}

for i := range countTo(10) {
	if i > 5 {
		break // 消费方拍拍屁股走了，后台 Goroutine 永远卡死在 ch <- 7 上！
	}
	fmt.Println(i)
}
```

### 12.5.3 用 `context` 终止后台 Goroutine {#ch12-5-3}

修掉上面泄漏的标准手法是传入 `context.Context`：让后台生产者在“发送数据”和“`<-ctx.Done()` 取消信号”之间做 `select`，调用方一退出，`defer cancel()` 立刻关闭 `ctx.Done()` 通道，生产者收到信号当场收工退出（`context` 完整机制见[第 14 章](./chapter-14#ch14-3)）：

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

ctx, cancel := context.WithCancel(context.Background())
defer cancel()
for i := range countTo(ctx, 10) {
	if i > 5 {
		break
	}
	fmt.Println(i)
}
```

### 12.5.4 缓冲通道与背压限流 {#ch12-5-4}

缓冲通道在两类明确场景下最趁手：

**第一类：已知确切子任务数量，让每个工人写完结果立刻下班**。比如固定派 10 个 Goroutine 各算一个结果，把结果通道容量恰好设为 `10`，工人算出结果往里一丢就能直接退出，根本不用在原地干等主协程挨个来取：

```go
func processChannel(ch <-chan int) []int {
	const conc = 10
	results := make(chan int, conc)
	for range conc {
		go func() {
			v := <-ch
			results <- process(v)
		}()
	}
	out := make([]int, 0, conc)
	for range conc {
		out = append(out, <-results)
	}
	return out
}
```

**第二类：实现背压（Backpressure）限制最大在途并发数**。如果下游数据库最多扛得住 20 个并发慢查询，与其放一万个请求进来把服务拖雪崩，不如用一个容量为 `limit` 的空结构体缓冲通道充当**有界并发信号量（Bounded Semaphore）**——抢到槽位才开始执行、执行完 `defer` 归还槽位，槽位已满时走 `default` 立刻快速失败（HTTP 层直接回 `429 Too Many Requests`；注意这限制的是**同一时刻正在运行的任务数**，若需要按每秒固定速率补充配额的令牌桶限流器，应使用 `golang.org/x/time/rate`）：

```go
type PressureGauge struct {
	ch chan struct{}
}

func NewPressureGauge(limit int) *PressureGauge {
	return &PressureGauge{ch: make(chan struct{}, limit)}
}

func (pg *PressureGauge) Process(f func()) error {
	select {
	case pg.ch <- struct{}{}:
		defer func() { <-pg.ch }()
		f()
		return nil
	default:
		return errors.New("no more capacity")
	}
}
```

### 12.5.5 用 `nil` 通道屏蔽已关闭的 `select` 分支 {#ch12-5-5}

用 `for-select` 同时合并两个输入通道 `in1` 和 `in2` 时，如果 `in1` 先发完关闭了，而 `in2` 还在慢慢发，继续把已关闭的 `in1` 留在 `select` 里会出大事——因为已关闭通道随时可读（立即返回零值和 `false`），循环会疯狂抽中 `in1` 分支空转！

解法正好用到 [12.3.3 节](#ch12-3-3)的规则：一旦检测到 `!ok`，当场把局部通道变量赋为 **`nil`**，利用 `nil` 通道永久阻塞的特性把这条 `case` 彻底关掉，等两边都变成 `nil` 后自然退出循环：

```go
for in1 != nil || in2 != nil {
	select {
	case v, ok := <-in1:
		if !ok {
			in1 = nil // 从下一轮起该 case 永久不再就绪
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

### 12.5.6 给阻塞调用包一层超时 {#ch12-5-6}

遇到本身不支持传 `ctx` 的老函数需要限时返回时，可以用 `context.WithTimeout` 配合容量为 **`1`** 的结果通道包一层：

```go
func timeLimit[T any](worker func() T, limit time.Duration) (T, error) {
	out := make(chan T, 1) // 容量必须为 1！防止超时返回后 worker 写结果时永久卡死
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()

	go func() {
		out <- worker()
	}()

	select {
	case result := <-out:
		return result, nil
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}
```

注意两点：`make(chan T, 1)` 的容量 `1` 绝对省不得——如果写成无缓冲通道，一旦走超时分支提前返回，没人再去读 `out`，后台迟到的 `worker` 执行完往 `out` 写时就会永久泄漏；另外这种外包写法只能做到“调用方不等了先走”，如果 `worker` 自己死循环不退，它还是会在后台占着资源，所以能往 `worker` 里直接传 `ctx` 响应取消永远是上策。

### 12.5.7 `WaitGroup` 与“多写单关” {#ch12-5-7}

需要等一批后台 Goroutine 全都跑完再往下走时，用标准库 `"sync"` 的 `sync.WaitGroup`（零值直接可用，注意含状态严禁按值复制传递）。

- **自 Go 1.25 起，优先直接使用 `wg.Go` 方法**：它会在启动新 Goroutine 前自动加计数、函数返回时自动减计数，彻底省掉了手算 `Add(n)` 和怕漏写 `defer wg.Done()` 的心智负担（注意传给 `wg.Go` 的函数不应放任未恢复的 `panic`）：
  ```go
  var wg sync.WaitGroup
  wg.Go(doThing1)
  wg.Go(doThing2)
  wg.Go(doThing3)
  wg.Wait()
  ```
- **兼容 Go 1.24 及更早版本时**，使用经典的 `wg.Add` + `defer wg.Done()` 组合——切记 **`wg.Add` 必须在启动 Goroutine 之前（外层线程里）调用**，否则主协程如果先跑到 `wg.Wait()` 看到计数还是 `0` 就会直接溜走：
  ```go
  var wg sync.WaitGroup
  wg.Add(2)
  go func() { defer wg.Done(); doThing1() }()
  go func() { defer wg.Done(); doThing2() }()
  wg.Wait()
  ```

`WaitGroup` 最经典的一个组合技是解决**“多个生产者往同一个输出通道写数据，到底谁来 `close(out)`”**：任何单个工人都不知道别的工人写完没有，于是专门单起一个收尾 Goroutine 等 `wg.Wait()` 归零后统一 `close(out)`，主协程则在外面安心 `for v := range out` 收集全部结果：

```go
func processAndGather[T, R any](in <-chan T, processor func(T) R, num int) []R {
	out := make(chan R, num)
	var wg sync.WaitGroup
	for range num {
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

	var result []R
	for v := range out {
		result = append(result, v)
	}
	return result
}
```

记住 `WaitGroup` 只管“数人头等退场”，不负责收集 `error` 也不联动取消。如果业务需求是“并发跑 3 个下游请求，只要其中 1 个报错就立刻取消其余 2 个并拿回首个错误”，实战中直接用官方扩展包 `golang.org/x/sync/errgroup` 的 `errgroup.WithContext(ctx)` 比自己手搓省事得多。

### 12.5.8 单次延迟初始化（`sync.Once` 与 `OnceValue`） {#ch12-5-8}

有些昂贵资源（解析大字典、建连接句柄）不想在包启动 `init` 时无条件拖慢冷启动，只想等到第一次真有人调用时再初始化一次，且必须保证高并发同时冲进来也严格只跑一遍。

早期写法是声明包级 `var once sync.Once` 搭配 `once.Do(func() { ... })`；自 **Go 1.21** 起，标准库直接提供了三个更干净的泛型函数包装器：`sync.OnceFunc`（无返回值）、`sync.OnceValue[T]`（单返回值）和 `sync.OnceValues[T1, T2]`（如 `(Client, error)` 双返回值）：

```go
var getParser = sync.OnceValue(initSlowParser)

func Parse(input string) string {
	return getParser().Parse(input)
}
```

无论多少个 Goroutine 同时调 `getParser()`，`initSlowParser` 都只会执行一次，后续所有调用直接拿到缓存好的同一个返回值，连包级结果变量都省得单独声明了。

### 12.5.9 综合实战：限时三服务并发编排 {#ch12-5-9}

现在把前面的技巧合起来实现 [12.1 节](#ch12-1)提过的需求：并行请求服务 A 与服务 B，拿到两边结果拼成 `cIn` 后再请求服务 C，并为整条调用链设定 50 毫秒的超时截止时间（注意 `context.WithTimeout` 提供的是协作式取消信号而非硬实时保证：定时器唤醒与调度器切换存在轻微延迟，且当结果通道与 `ctx.Done()` 恰好同时就绪时，`select` 仍按伪随机规则二选一）。

先把顶层主流程写得像顺序代码一样一目了然——并发通道细节全收进未导出的辅助结构体里：

```go
func GatherAndProcess(ctx context.Context, data Input) (COut, error) {
	ctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()

	ab := newABProcessor()
	ab.start(ctx, data)
	inputC, err := ab.wait(ctx)
	if err != nil {
		return COut{}, err
	}

	c := newCProcessor()
	c.start(ctx, inputC)
	return c.wait(ctx)
}
```

再看 `abProcessor` 的内部设计：给 `outA`、`outB` 各留 `1` 个缓冲槽位，给 `errs` 留 `2` 个缓冲槽位——这样就算一边已经报错或外层 50 毫秒超时先退出了，另一边跑完往通道里塞结果或错误时也**不会因发送而阻塞**（前提是 `getResultA`、`getResultB` 本身会响应 `ctx` 取消或最终返回，见下文说明）：

```go
type abProcessor struct {
	outA chan aOut
	outB chan bOut
	errs chan error
}

func newABProcessor() *abProcessor {
	return &abProcessor{
		outA: make(chan aOut, 1),
		outB: make(chan bOut, 1),
		errs: make(chan error, 2),
	}
}

func (p *abProcessor) start(ctx context.Context, data Input) {
	go func() {
		a, err := getResultA(ctx, data.A)
		if err != nil {
			p.errs <- err
			return
		}
		p.outA <- a
	}()
	go func() {
		b, err := getResultB(ctx, data.B)
		if err != nil {
			p.errs <- err
			return
		}
		p.outB <- b
	}()
}

func (p *abProcessor) wait(ctx context.Context) (cIn, error) {
	var cData cIn
	for range 2 {
		select {
		case a := <-p.outA:
			cData.a = a
		case b := <-p.outB:
			cData.b = b
		case err := <-p.errs:
			return cIn{}, err
		case <-ctx.Done():
			return cIn{}, ctx.Err()
		}
	}
	return cData, nil
}
```

`cProcessor` 只是单路简化版（一个容量 `1` 的结果通道、一个容量 `1` 的错误通道，单次 `select` 等待结果、错误或 `<-ctx.Done()`）。整段代码做到了三件事：A 和 B 谁先回就先收谁、任一报错或超时立即止损并经 `defer cancel()` 通知下游停手、后台 Goroutine 不会卡在结果或错误的发送上。

注意缓冲通道只消除了“发送时无人接收”这一种阻塞，并不能让后台 Goroutine 自动退出。只有当 `getResultA`、`getResultB` 和服务 C 的调用函数都检查传入的 `ctx`（例如把它传给 `http.NewRequestWithContext`）或保证在有限时间内返回时，这些 Goroutine 才会在 `GatherAndProcess` 返回后陆续结束；若某个下游忽略 `ctx` 且一直阻塞，即使 `ab.wait` 已经因超时返回，对应的 Goroutine 仍会卡在下游调用里，形成泄漏。

## 12.6 互斥锁还是通道 {#ch12-6}

Go 社区常念叨一句名言：“不要通过共享内存来通信，而要通过通信来共享内存。”数据顺着通道在不同阶段之间交接时，同一时刻只有一个 Goroutine 经手它，权责非常清楚。但如果你的场景根本不是流水线移交，而只是**多个 Goroutine 原地读写同一份进程内缓存或状态表**，硬套通道反而又绕又慢。

比如维护一张内存里的玩家积分榜 `map[string]int`：如果非要用单个管理 Goroutine 加函数通道来做，连读一次分数都得临时造一个回传通道排队串行执行：

```go
type ChannelScoreboardManager chan func(map[string]int)

func (csm ChannelScoreboardManager) Read(name string) (int, bool) {
	type result struct {
		out int
		ok  bool
	}
	ch := make(chan result)
	csm <- func(m map[string]int) {
		out, ok := m[name]
		ch <- result{out: out, ok: ok}
	}
	res := <-ch
	return res.out, res.ok
}
```

换成标准库 `"sync"` 的读写互斥锁 `sync.RWMutex`（写操作 `Lock`/`Unlock` 独占，读操作 `RLock`/`RUnlock` 允许多协程并发同读；读写均衡或临界区极短时直接用 `sync.Mutex` 即可），代码既短又支持并发读：

```go
type MutexScoreboardManager struct {
	mu         sync.RWMutex
	scoreboard map[string]int
}

func NewMutexScoreboardManager() *MutexScoreboardManager {
	return &MutexScoreboardManager{scoreboard: map[string]int{}}
}

func (msm *MutexScoreboardManager) Update(name string, val int) {
	msm.mu.Lock()
	defer msm.mu.Unlock()
	msm.scoreboard[name] = val
}

func (msm *MutexScoreboardManager) Read(name string) (int, bool) {
	msm.mu.RLock()
	defer msm.mu.RUnlock()
	val, ok := msm.scoreboard[name]
	return val, ok
}
```

日常二选一只需看一句话：**跨 Goroutine 编排协作、移交任务与结果流水线时用通道；守护某个结构体内部字段（映射、计数器、状态位）的原地并发读写时用互斥锁**。

使用 `Mutex` / `RWMutex` 千万守住三条底线：

1. **Go 的互斥锁不可重入（Non-reentrant）**：同一个 Goroutine 在没解锁前如果自己（或调内部辅助函数）再去 `Lock` 同一把锁（哪怕已持 `RLock` 时再等写锁介入），会当场把自己死锁卡死！
2. **绝对禁止按值拷贝锁**：含锁的结构体方法一律用指针接收者，传参一律传指针，靠 `go vet ./...`（内置 `copylocks` 检查）把关。
3. **不留任何无锁裸读写的侥幸口子**：哪怕“只是读一下布尔标志或 `int`”与另一边的写并发撞上，也属于必须消除的数据竞争（Data Race）缺陷——虽然 [Go 内存模型](https://go.dev/ref/mem)对单机器字及更小内存单元的竞争读取做了比 C/C++ 完全未定义行为更严格的实现约束，但开启 `-race` 时程序可直接报错终止；切片、字符串和接口值由多个机器字组成（切片头为指针、长度、容量，字符串头为指针、长度，接口值为类型或方法表指针加数据指针），竞争读写可能读到各字段来自不同写入的撕裂状态，进而越界访问甚至崩溃。映射的风险则不同：映射值本身只是指向运行时内部结构的单机器字句柄（Go 1.27.1/AMD64 实测 `unsafe.Sizeof(m)` 为 8 字节），问题在于多个 Goroutine 并发读写同一映射的内部哈希表，运行时检测到并发写或读写冲突时会直接抛出 `fatal error: concurrent map writes` 或 `concurrent map read and map write` 并终止进程，而且这类致命错误无法用 `recover` 捕获。测试时务必加上 `-race` 检测（见 [15.10 节](./chapter-15#ch15-10)）。至于 `sync.Map`，只适合“键写一次后几乎只读”或“不同协程写完全不相交的键集合”这两类极端多核争用场景，普通业务缓存老老实实用 `Mutex + map[K]V` 还能保留完整的编译期类型检查。

## 12.7 原子操作 {#ch12-7}

标准库 `"sync/atomic"` 提供底层 CPU 指令级的单变量原子读写、累加与比较并交换（CAS），自 Go 1.19 起还提供了防止误做非原子访问的强类型封装（如 `atomic.Int64`、`atomic.Bool`、`atomic.Pointer[T]`）。如果确实只需要一个独立的并发安全布尔开关或请求计数器，`atomic.Bool` / `atomic.Int64` 很轻巧；但一旦涉及两个及以上字段必须保持一致更新，单个原子操作就护不住不变式了，应果断退回 `sync.Mutex` 或通道，别徒手拼装复杂的无锁状态机。

## 练习 {#ch12-exercises}

以下三题分别练习多生产者单消费者的汇聚关闭、`for-select` 双通道读取与 `nil` 屏蔽技巧，以及 `sync.OnceValue` 并发安全缓存。代码片段位于 `package main`，按需导入 `"fmt"`、`"math"` 与 `"sync"`。建议先独立编写，再展开核对参考答案。

### 练习 1：两个生产者汇聚到同一个消费者

编写函数启动三个协同工作的 Goroutine：前两个生产者分别向**同一个通道**写入 `0`～`9` 和 `10`～`19` 共 20 个整数，第三个消费者从该通道读出全部 20 个数打印出来；要求所有数值打印完毕后函数正常返回，且不残留任何泄漏 Goroutine。

<details>
<summary>查看参考答案</summary>

Go 1.25+ 使用 `wg.Go` 写法如下（Go 1.24 及更早版本改为 `wg.Add` + `defer wg.Done()` 即可）：

```go
func fanInAndPrint() {
	ch := make(chan int)
	var wg sync.WaitGroup

	wg.Go(func() {
		for i := range 10 {
			ch <- i
		}
	})
	wg.Go(func() {
		for i := 10; i < 20; i++ {
			ch <- i
		}
	})

	go func() {
		wg.Wait()
		close(ch)
	}()

	var consumerWG sync.WaitGroup
	consumerWG.Go(func() {
		for v := range ch {
			fmt.Println(v)
		}
	})
	consumerWG.Wait()
}
```

两个生产者共用同一个 `ch` 时，任何一方都不能私自 `close(ch)`；专门起一个协调协程等两边 `wg.Wait()` 全退后再关通道，就能让第三个消费者协程的 `for range` 读空 20 个数后平滑退出，最后 `consumerWG.Wait()` 确保打印全部落地后函数才返回。

</details>

### 练习 2：同时消费两个独立通道并标注来源

启动两个 Goroutine 分别向各自独立的通道 `c1`、`c2` 写入 10 个整数并在写完后关闭自己的通道；在主函数中用 `for-select` 循环读取两路数据并打印来自哪个通道，要求两个通道都读空关闭后循环正常退出，不发生空转或死锁。

<details>
<summary>查看参考答案</summary>

```go
func readBoth() {
	c1 := make(chan int)
	c2 := make(chan int)

	go func() {
		defer close(c1)
		for i := range 10 {
			c1 <- i
		}
	}()
	go func() {
		defer close(c2)
		for i := range 10 {
			c2 <- i
		}
	}()

	for c1 != nil || c2 != nil {
		select {
		case v, ok := <-c1:
			if !ok {
				c1 = nil
				continue
			}
			fmt.Println("from c1:", v)
		case v, ok := <-c2:
			if !ok {
				c2 = nil
				continue
			}
			fmt.Println("from c2:", v)
		}
	}
}
```

每个通道只有一个生产者，各自 `defer close` 即可；消费端的核心是读到 `!ok` 后立刻将对应的通道变量设为 `nil`，用 `nil` 通道永久阻塞的特性关掉已经结束的那条 `case` 分支，直到 `c1` 和 `c2` 全变为 `nil` 退出循环。

</details>

### 练习 3：用 `sync.OnceValue` 延迟构建平方根查表缓存

编写一个构造 `0`～`99_999` 整数平方根映射表 `map[int]float64` 的函数，再用 `sync.OnceValue` 包装成并发安全的懒加载访问器，在 `main` 中每隔 `1_000` 打印一次查表结果。

<details>
<summary>查看参考答案</summary>

```go
func buildSqrtTable() map[int]float64 {
	table := make(map[int]float64, 100_000)
	for i := range 100_000 {
		table[i] = math.Sqrt(float64(i))
	}
	return table
}

var getSqrtTable = sync.OnceValue(buildSqrtTable)

func main() {
	table := getSqrtTable()
	for i := 0; i < 100_000; i += 1_000 {
		fmt.Println(i, table[i])
	}
}
```

`sync.OnceValue`（Go 1.21+）保证哪怕首次有几十个 Goroutine 同时调用 `getSqrtTable()`，`buildSqrtTable` 也只跑一次，且后续所有读取方拿到已初始化完毕的只读映射表（注意缓存返回后切勿再向该共享映射并发写入）。

</details>

## 面试题 {#ch12-interview}

以下五题分别检验 `nil` 通道行为、已关闭缓冲通道读取、`select` 分支选择策略、`WaitGroup` 的职责边界以及跨 Goroutine 的 `panic` 传播规则。建议先独立作答，再展开核对参考答案。

### 面试题 1：对未初始化的零值通道读写或关闭会发生什么？

```go
var ch chan int
ch <- 1
```

<details>
<summary>查看参考答案</summary>

对 `nil` 通道执行读取 `<-ch` 或写入 `ch <- 1` 都会**永久阻塞**当前 Goroutine（在上面的单协程程序里，因没有任何其他活跃协程可唤醒它，运行时会直接报 `fatal error: all goroutines are asleep - deadlock!`）；对 `nil` 通道调用 `close(ch)` 则会当场触发运行期 **`panic`**。

</details>

### 面试题 2：关闭一个还有残留元素的缓冲通道后，连续读取三次输出什么？

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

输出 `10 true 20 true 0 false`。

关闭通道并不会丢弃缓冲区里已写入的数据：前两次读取依次取出残留的 `10` 和 `20`，`ok` 均为 `true`；缓冲区排空后第三次读取不会阻塞，而是立即返回元素类型零值 `0` 和 `okC == false`（表明该零值并非发送方写入，而是通道已关闭排空）。

</details>

### 面试题 3：当 `select` 里同时有三个 `case` 分支就绪可读时，Go 按什么顺序选？如果在 `for-select` 里随手加一个空的 `default:` 会怎样？

<details>
<summary>查看参考答案</summary>

多个通信分支同时就绪时，运行时采用**均匀伪随机选择**挑其中一个执行，防止排在前面的通道长期饥饿其他分支。如果在持续循环的 `for-select` 里加了 `default:`，只要某时刻所有通道都没数据，循环就不会挂起让出 CPU，而是紧贴着 `default:` 死循环忙等空转，瞬间把单核 CPU 打满。

</details>

### 面试题 4：使用 `sync.WaitGroup` 最容易踩哪三个坑？Go 1.25 对此做了什么改进？

<details>
<summary>查看参考答案</summary>

传统手写 `WaitGroup` 最高频的三个坑：

1. **把 `wg.Add(1)` 写进了 `go func()` 内部**，导致外层 `wg.Wait()` 可能赶在 `Add` 执行前看到计数为 `0` 提前返回（或触发并发误用异常）；
2. **把 `WaitGroup` 按值传给子函数**，子函数里 `Done()` 减的只是局部拷贝，外层 `Wait()` 永久死锁；
3. **某条提前 `return` 分支漏调了 `Done()`**（未用 `defer wg.Done()`）。

Go 1.25 新增了 **`wg.Go(func() { ... })`** 方法，把启动前加计数和退出后减计数原子封装在一起，直接消除了第 1 和第 3 类手误（按指针传递或闭包直接捕获原变量这一条依然要遵守）。

</details>

### 面试题 5：在 `main` 函数顶部写了 `defer recover()`，能拦住子 Goroutine 里的数组越界 `panic` 吗？

<details>
<summary>查看参考答案</summary>

**完全拦不住**，整个进程依然会崩溃退出。`panic` 只沿着发生故障的**当前那一个 Goroutine** 的调用栈向上展开，`recover()` 也只能接住同一个 Goroutine 里的 `panic`。如果后台协程任务决不能拖垮主进程，必须在每个后台协程自己的入口函数里单独写 `defer func() { if r := recover(); r != nil { ... } }()`。

</details>

## 参考资料

- [Go 语言规范：`go` 语句（Go statements）](https://go.dev/ref/spec#Go_statements)
- [Go 语言规范：通道类型与收发操作（Channel types）](https://go.dev/ref/spec#Channel_types)
- [Go 语言规范：`select` 语句（Select statements）](https://go.dev/ref/spec#Select_statements)
- [Go 内存模型（The Go Memory Model）](https://go.dev/ref/mem)
- [Go 官方博客：Share Memory By Communicating](https://go.dev/blog/codelab-share)
- [Go 官方博客：Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)
- [Go 官方博客：Concurrency is not Parallelism（Rob Pike）](https://go.dev/blog/waza-talk)
- [Go 标准库 `sync`：`WaitGroup`（含 `WaitGroup.Go`）、`OnceValue` 与 `RWMutex`](https://pkg.go.dev/sync)
- [Go 标准库 `sync/atomic`：强类型原子操作](https://pkg.go.dev/sync/atomic)
- [`golang.org/x/sync/errgroup`：带错误收集与取消传播的并发组](https://pkg.go.dev/golang.org/x/sync/errgroup)
