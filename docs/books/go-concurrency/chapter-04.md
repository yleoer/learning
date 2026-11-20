---
title: 第 4 章 Go 语言的并发模式
description: 掌握约束、for-select、防泄漏、泛型流水线、扇入扇出、通道组合器、排队定律以及 context 与 errgroup 实践。
---

# 第 4 章 Go 语言的并发模式

## 本章要点

掌握了独立的并发原语之后，下一步是研究如何把它们组合成可扩展、易维护的工程模式。本章沿着原书脉络，从通过词法约束消除不必要的同步讲起，建立“父协程负责停止子协程”的防泄漏契约，再用现代 Go 泛型构建生成器、流水线（Pipeline）、扇出扇入（Fan-Out/Fan-In）以及 `or`、`orDone`、`tee`、`bridge` 四大通道组合器，最后深入分析缓冲队列的 Little 定律、标准库 `context` 调用树以及并发错误处理模式。

读完本章后，应能对组合管道中的每一个 goroutine 回答三个问题：它为什么存在、遇到下游提前退出或上游失败时如何被取消、它拥有的输出通道由谁关闭；并能避开原书部分早期代码中的求值阻塞与容量越界隐患。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64。

## 4.1 约束：减少需要同步的状态 {#ch4-1}

编写并发安全的代码共有四种基本思路：用互斥锁同步共享内存、用通道通过通信共享内存、只使用不可变（Immutable）数据，以及通过**约束（Confinement）**保护可变数据。所谓约束，就是确保某份可变数据在任意时刻只能被唯一一个并发执行流访问——只要做到了这一点，即便不加任何锁或通道同步，这段代码也是隐式并发安全的。

原书将约束分为两类，并强烈推荐后者：

### 4.1.1 特定约束（Ad Hoc Confinement） {#ch4-1-1}

**特定约束**完全依赖团队口头或文档约定。例如原书给出的例子：在包或外层函数中声明切片 `data := make([]int, 4)`，虽然在语法上后续所有代码都能随时读写 `data`，但团队私下约定“只允许在 `loopData` 协程里读取它”。

这种靠自觉维持的约束在工程中极其脆弱：随着需求迭代、工期吃紧和新成员加入，迟早会有人在外层顺手改写 `data`，在毫无编译告警的情况下引入数据竞争。

### 4.1.2 词法约束（Lexical Confinement）与三索引切片边界 {#ch4-1-2}

**词法约束**则是利用语言的**词法作用域（Lexical Scope）与类型系统**，直接从编译器层面封死误用的可能——在正确的作用域内只暴露允许使用的只读视图或互不重叠的数据分片，让写出违规代码在语法上根本无法通过编译。

我们在 [3.5.3 节](./chapter-03#ch3-5-3)见过的 `chanOwner` 函数就是词法约束的典型应用：双向通道 `results := make(chan int, 5)` 被严格封闭在 `chanOwner` 的局部变量作用域内，外部消费者只能拿到 `<-chan int` 只读句柄。

对于本身非并发安全的普通数据结构（如 `[]byte` 或 `bytes.Buffer`），同样可以施加词法约束。观察原书给出的字节切片分区并发处理示例（完整程序需导入 `"bytes"`、`"fmt"` 与 `"sync"`）：

```go
package main

import (
	"bytes"
	"fmt"
	"sync"
)

func main() {
	printData := func(wg *sync.WaitGroup, data []byte) {
		defer wg.Done()
		var buff bytes.Buffer
		for _, b := range data {
			fmt.Fprintf(&buff, "%c", b)
		}
		fmt.Println(buff.String())
	}

	var wg sync.WaitGroup
	wg.Add(2)
	data := []byte("golang")
	go printData(&wg, data[:3:3]) // 前三个字节 "gol"，且将容量上限锁死为 3
	go printData(&wg, data[3:])   // 后三个字节 "ang"
	wg.Wait()
}
```

这里 `printData` 函数并未通过闭包直接捕获外层的 `data`，而是通过参数接收不相交的两个子切片：第一个协程只触碰前 3 个字节，第二个协程只触碰后 3 个字节，因此无需加锁也不会产生竞争。

不过请注意上面代码相比原书所做的一处关键加固：**我们将原书的 `data[:3]` 改成了三索引完整切片表达式 `data[:3:3]`**！为什么？因为普通的 `data[:3]` 虽然长度为 `3`，但它的底层容量（`cap`）仍然是 `6`；如果 `printData` 未来被维护者加上了一句 `data = append(data, '!')`，原地扩容写入的第 4 个字节就会直接踩踏第二个协程正在并发读写的 `data[3]`！使用 `data[:3:3]` 将容量也截断为 `3` 后，任何 `append` 都会被迫分配新数组，从而让切片分区的词法约束真正滴水不漏。

## 4.2 for-select 循环与协作取消 {#ch4-2}

除另有说明外，本章后续代码片段位于函数或包作用域内，省略外层样板声明：`context`、`fmt`、`sync`、`time` 分别对应同名标准库包；泛型函数使用 **Go 1.18 起**支持的类型参数（原书成书于泛型诞生前，通篇使用 `chan interface{}`，本指南统一升级为类型安全的泛型实现）。

在 Go 并发代码中，`for-select` 循环无处不在，最常见的有三种形态：

1. **将序列转换为通道流，同时响应取消**：
   ```go
   for _, s := range []string{"a", "b", "c"} {
   	select {
   	case <-ctx.Done():
   		return
   	case stringStream <- s:
   	}
   }
   ```
2. **持续消费通道直到关闭或被取消**：
   ```go
   func Consume[T any](ctx context.Context, in <-chan T, use func(T)) {
   	for {
   		select {
   		case <-ctx.Done():
   			return
   		case v, ok := <-in:
   			if !ok {
   				return
   			}
   			use(v)
   		}
   	}
   }
   ```
3. **循环执行分步计算，每步间隙检查停止信号**：
   ```go
   for {
   	select {
   	case <-ctx.Done():
   		return
   	default:
   	}
   	doOneStepOfWork()
   }
   ```

编写 `for-select` 循环时，务必守住三条边界：

- **别在 `select` 里误用无标签 `break`**：Go 语言规范规定，不带标签的 `break` 只跳出最内层的 `for`、`switch` 或 `select`。在 `select` 分支里写 `break` 只会跳出本次 `select`，下一轮 `for` 循环还会照常继续！要终止循环应直接 `return`，或给外层循环加上标签执行 `break loop`。
- **绝不在纯等待的循环里写空 `default`**：第三种形态之所以能用 `default`，前提是下方的 `doOneStepOfWork()` 确实在执行实质性的分块计算；如果循环的目的只是等待通道消息，一旦加上 `default`，没消息时协程就会变成 100% CPU 空转的忙等待。
- **每一个可能阻塞的收发点都必须能被取消唤醒**：如果在循环开头用 `select + default` 检查了一次 `ctx.Done()`，紧接着在下面裸写一句阻塞发送 `out <- result`，那么一旦下游消费者提前离开，生产协程依然会永久卡死在 `out <- result` 上。

## 4.3 防止 goroutine 泄漏 {#ch4-3}

正如 [3.1.3 节](./chapter-03#ch3-1-3)所证，运行时不会垃圾回收一个被遗忘的阻塞 goroutine。原书总结道，一个健康的 goroutine 只会通过以下三种路径终止：

1. 它正常完成了自己的全部工作；
2. 它遇到了无法恢复的错误，主动中止工作；
3. 它收到了来自外部（父协程）的取消信号，被告知无需继续工作。

前两条路径由算法自身自然涵盖，而第三条“协作式取消”则是防止 goroutine 泄漏的核心。我们来看原书剖析的**接收端泄漏**与**发送端泄漏**两个经典反例及修复手法。

### 4.3.1 接收阻塞泄漏与修复 {#ch4-3-1}

先看原书展示的接收端泄漏：如果调用方把一个永远不会有数据的 `nil` 通道传给后台协程，且没有提供取消通道，该后台协程将在整个进程生命周期内永久泄漏：

```go
// 反例：若 strings 为 nil 或上游永不关闭，该 goroutine 永远无法退出
doWork := func(strings <-chan string) <-chan struct{} {
	completed := make(chan struct{})
	go func() {
		defer fmt.Println("doWork exited.")
		defer close(completed)
		for s := range strings {
			fmt.Println(s)
		}
	}()
	return completed
}
```

修复方法是在父子 goroutine 之间建立取消信号（原书使用只读通道 `done <-chan interface{}` 并将其作为第一个参数；现代 Go 统一使用 `ctx context.Context` 或 `done <-chan struct{}`），同时通过返回的 `terminated` 通道确认子协程真正退出：

```go
doWork := func(ctx context.Context, strings <-chan string) <-chan struct{} {
	terminated := make(chan struct{})
	go func() {
		defer fmt.Println("doWork exited.")
		defer close(terminated)
		for {
			select {
			case <-ctx.Done():
				return
			case s, ok := <-strings:
				if !ok {
					return
				}
				fmt.Println(s)
			}
		}
	}()
	return terminated
}
```

### 4.3.2 发送阻塞泄漏与修复 {#ch4-3-2}

再看相反的方向——**发送端泄漏**。假设一个随机数生成器源源不断地往通道里写随机数，而主协程只读了 3 个就转身离开了（假定已导入 `"math/rand/v2"`）：

```go
newRandStream := func(ctx context.Context) <-chan int {
	randStream := make(chan int)
	go func() {
		defer fmt.Println("newRandStream closure exited.")
		defer close(randStream)
		for {
			select {
			case <-ctx.Done():
				return
			case randStream <- rand.Int():
			}
		}
	}()
	return randStream
}
```

如果不在 `randStream <- rand.Int()` 外面包裹监听 `<-ctx.Done()` 的 `select`，那么当消费者读完第 3 个整数退出循环后，生成器就会在第 4 次发送时永远卡死，`defer fmt.Println("newRandStream closure exited.")` 永远不会执行。加上 `ctx.Done()` 分支并在消费方退出时调用 `cancel()` 后，生成器便能干净利落地收尾退出。

由此，原书提炼出了并发编程中最重要的生命周期军规：

> **如果一个 goroutine 负责创建另一个 goroutine，那么它也同时负责确保自己能够停止那个 goroutine。**

## 4.4 生成器与流水线（Pipeline） {#ch4-4}

### 4.4.1 批处理、流处理与通道流水线 {#ch4-4-1}

**流水线（Pipeline）**是一系列将数据读入、执行变换并把结果继续向下游传递的阶段（Stage）组合。每个阶段都满足两个特征：消费并返回同构的数据流，且阶段本身可以像普通函数一样自由组合与重排。

原书先对比了两种非通道写法：

- **批处理阶段（Batch Processing）**：如 `multiply(values []int, factor int) []int`，每次接收整个切片并分配一个等长的新切片存放结果。优点是写法直观，缺点是每经过一个阶段瞬时内存占用就会翻倍，且下游必须等上游把整批数据全部算完才能拿到第一个元素。
- **逐元素函数嵌套（Stream Function Call）**：在 `for _, v := range ints` 循环体内直接写 `multiply(add(multiply(v, 2), 1), 2)`。虽然消除了中间切片分配，但整条计算被绑死在单个循环体内，无法将耗时阶段独立扇出（Fan-Out）到多个 goroutine 并行加速。

将通道作为阶段间的连接件，就能构建真正的**并发流式流水线**。其中，将一组内存离散值或外部数据源转化为通道流的首个阶段称为**生成器（Generator）**。用现代 Go 泛型实现的生成器与算术流水线如下：

```go
func Generate[T any](ctx context.Context, values ...T) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for _, v := range values {
			select {
			case <-ctx.Done():
				return
			case out <- v:
			}
		}
	}()
	return out
}

func Map[T, R any](ctx context.Context, in <-chan T, fn func(T) R) <-chan R {
	out := make(chan R)
	go func() {
		defer close(out)
		for {
			var v T
			var ok bool
			select {
			case <-ctx.Done():
				return
			case v, ok = <-in:
				if !ok {
					return
				}
			}
			res := fn(v)
			select {
			case <-ctx.Done():
				return
			case out <- res:
			}
		}
	}()
	return out
}
```

现在我们可以像原书一样将“乘 2 → 加 1 → 乘 2”组装成一条并发流水线：

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

intStream := Generate(ctx, 1, 2, 3, 4)
multiply := func(in <-chan int, factor int) <-chan int {
	return Map(ctx, in, func(v int) int { return v * factor })
}
add := func(in <-chan int, additive int) <-chan int {
	return Map(ctx, in, func(v int) int { return v + additive })
}

pipeline := multiply(add(multiply(intStream, 2), 1), 2)
for v := range pipeline {
	fmt.Println(v) // 依次输出 6、10、14、18
}
```

仔细体会这条流水线为何在任何时刻都可以被 `cancel()` 安全关闭（归纳证明）：

1. **起点可取消**：生成器 `Generate` 在每次向 `out` 发送时都监听 `<-ctx.Done()`，一旦取消立即 `return` 并通过 `defer close(out)` 关闭输出通道；
2. **中间阶段归纳传递**：任一中间阶段要么正阻塞在等待上游输入 `<-in`（既监听 `<-ctx.Done()`，也会因上游关闭 `in` 而立即唤醒退出），要么正阻塞在向下游发送 `out <- res`（同样监听 `<-ctx.Done()`）；退出时它又会自动 `defer close(out)` 通知下一阶段；
3. **终点自然退出**：最末端的 `for v := range pipeline` 在最后一个阶段关闭输出通道后自动结束循环。

### 4.4.2 便利生成器：`Repeat`、`RepeatFn` 与 `Take`（及原书求值陷阱修正） {#ch4-4-2}

为了快速搭建测试流或无限数据流，原书设计了三个高频复用的流水线组件：

- **`Repeat`**：无限循环重复发送传入的一组值，直到收到取消信号；
- **`RepeatFn`**：无限循环调用函数 `fn()` 并将返回值发往输出通道，直到收到取消信号；
- **`Take`**：仅从上游通道读取前 `num` 个元素转发给下游，随后主动关闭自己的输出通道并退出。

在给出代码之前，**必须重点指出原书 `take` 实现中隐藏的一处经典语言规范陷阱**。原书（PDF 第 125 页）将 `take` 的内层循环写成了下面这样：

```go
// 原书写法（存在严重隐患！）：
for i := 0; i < num; i++ {
	select {
	case <-done:
		return
	case takeStream <- <-valueStream: // 陷阱：发送右侧的 <-valueStream 会在进入 select 前先求值！
	}
}
```

回顾 [3.6 节的 `select` 求值顺序规则](./chapter-03#ch3-6)：**进入 `select` 时，发送语句箭头右侧的表达式会先于分支选择被无条件求值**！把 `<-valueStream` 直接写在 `takeStream <-` 右侧会导致两个严重后果：

1. **取消信号失灵**：如果上游 `valueStream` 迟迟没有数据发来，程序会在进入 `select` 之前直接死等在 `<-valueStream` 上，上面的 `case <-done:` 分支根本没有机会生效！
2. **上游提前关闭时伪造零值**：如果上游一共只发了 2 个真实元素就关闭了 `valueStream`，而 `num` 设为 10，那么从第 3 轮开始 `<-valueStream` 会直接吐出 8 个零值（因为没检查 `ok`），并把这 8 个假零值当成正常数据发给下游！

修正这一缺陷並补齐空输入防御的现代泛型实现如下：

```go
func Repeat[T any](ctx context.Context, values ...T) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		if len(values) == 0 {
			return // 防止 values 为空时内层 range 不执行、外层 for 死循环空转
		}
		for {
			for _, v := range values {
				select {
				case <-ctx.Done():
					return
				case out <- v:
				}
			}
		}
	}()
	return out
}

func RepeatFn[T any](ctx context.Context, fn func() T) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for {
			v := fn()
			select {
			case <-ctx.Done():
				return
			case out <- v:
			}
		}
	}()
	return out
}

func Take[T any](ctx context.Context, in <-chan T, num int) <-chan T {
	out := make(chan T)
	go func() {
		defer close(out)
		for i := 0; i < num; i++ {
			var v T
			var ok bool
			select {
			case <-ctx.Done():
				return
			case v, ok = <-in:
				if !ok {
					return // 上游已关闭，立即正常结束，绝不向下游伪造零值
				}
			}
			select {
			case <-ctx.Done():
				return
			case out <- v:
			}
		}
	}()
	return out
}
```

把接收和发送拆成两个独立的 `select` 后，无论 `Take` 是在等上游来数还是等下游取数，都能即时响应 `ctx.Done()`，且上游提前关闭时能准确停手。还要记住：**`Take` 取满 `num` 个元素关闭自己的 `out` 通道，并不会反向关闭上游的 `Repeat`**；调用方在消费完 `Take` 后，仍须通过 `defer cancel()` 取消共享的 `ctx` 以通知上游无限生成器退出。

顺带一提，原书曾专门编写 `BenchmarkGeneric` 与 `BenchmarkTyped` 对比 `chan interface{}`（配合 `toString` 类型断言阶段）与具体类型 `chan string` 的性能，实测具体类型快约一倍。在 Go 1.18 引入泛型后，上面的 `Repeat[T]` 与 `Take[T]` 在编译期直接实例化为具体类型通道，既保留了通用组件的复用性，又天然拥有具体类型的最高性能，不再需要单独编写 `toString`、`toInt` 之类的类型断言阶段。

## 4.5 扇出、扇入与有限并发 {#ch4-5}

当流水线跑起来之后，如果中间某个阶段计算或 I/O 特别耗时（如原书第 4 章用试除法判断大整数是否为素数的 `primeFinder` 阶段，单协程找 10 个素数耗时达 23.4 秒），上游阶段就会频繁堵在发送端等待它。如何在不改动各阶段内部代码的前提下加速瓶颈阶段？答案就是**扇出（Fan-Out）与扇入（Fan-In）**：

- **扇出（Fan-Out）**：启动多个并发 goroutine 同时从同一个上游通道拉取任务，分摊瓶颈阶段的计算量；
- **扇入（Fan-In）**：将多个扇出工作者的输出通道多路复用（Multiplex），重新合并为单个输出通道交还给下游。

```text
                  ┌──► Worker 1 (primeFinder) ──┐
randintStream ────┼──► Worker 2 (primeFinder) ──┼──► Merge (Fan-In) ──► Take(10)
  (Fan-Out)       └──► Worker N (primeFinder) ──┘
```

原书指出，判断流水线中的某个阶段能否安全扇出，只需核对两个条件：

1. **顺序独立性（Order Independence）**：该阶段的计算不依赖前一个元素的历史状态，且下游不要求输出顺序与输入顺序严格一致（因为多个工作者并发执行的快慢是不确定的；若下游必须保序，需在输入元素中附带递增序号并在汇总端重排）。
2. **单次耗时显著（Duration）**：该阶段本身的耗时远大于通道收发与调度开销。原书在 8 核机器上将 `primeFinder` 扇出为 `runtime.NumCPU()`（8）个实例后，总耗时从 23.4 秒直接骤降至 5.4 秒。

使用 Go 1.25+ 的 `WaitGroup.Go` 实现扇入函数 `Merge` 非常简洁：

```go
func Merge[T any](ctx context.Context, channels ...<-chan T) <-chan T {
	out := make(chan T)
	var wg sync.WaitGroup

	for _, ch := range channels {
		wg.Go(func() {
			for {
				var v T
				var ok bool
				select {
				case <-ctx.Done():
					return
				case v, ok = <-ch:
					if !ok {
						return
					}
				}
				select {
				case <-ctx.Done():
					return
				case out <- v:
				}
			}
		})
	}

	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}
```

这里体现了 [3.2.2 节](./chapter-03#ch3-2-2)和 [2.5 节](./chapter-02#ch2-5)强调的**多写单关模式**：每个转发协程只负责从各自的输入流 `ch` 读取并写入公共的 `out`，谁也不调用 `close(out)`；专门启动的一个收尾协程阻塞在 `wg.Wait()` 上，等所有转发协程全部退出后，唯一一次调用 `close(out)`。

## 4.6 or-channel、or-done、tee 与 bridge {#ch4-6}

在复杂系统中组合通道时，经常需要处理多路取消合流、读取包装、单流复制以及动态通道序列展开。原书提炼了四个极具代表性的高阶通道组合模式。

### 4.6.1 `or-channel`：递归合并任意数量的完成信号 {#ch4-6-1}

有时一个组件同时受多个独立模块的生命周期约束，希望将若干个 `<-chan struct{}`（或任意通知通道）合并为一个总通道：**只要其中任意一个子通道关闭或收到消息，合并后的总通道就立即关闭**。如果在编译期不知道通道数量，原书利用递归与二分树思想给出了精妙的 `Or` 模式：

```go
func Or[T any](channels ...<-chan T) <-chan T {
	switch len(channels) {
	case 0:
		return nil
	case 1:
		return channels[0]
	}

	orDone := make(chan T)
	go func() {
		defer close(orDone)
		switch len(channels) {
		case 2:
			select {
			case <-channels[0]:
			case <-channels[1]:
			}
		default:
			select {
			case <-channels[0]:
			case <-channels[1]:
			case <-channels[2]:
			case <-Or(append(channels[3:], orDone)...):
			}
		}
	}()
	return orDone
}
```

这段代码有两处设计细节非常值得细品：

1. **为什么每层递归一次吃掉 3 个通道（共产生 $\lfloor N/2 \rfloor$ 个 goroutine）**：递归调用 `Or(append(channels[3:], orDone)...)` 时，往切片末尾追加了一个 `orDone` 通道。如果外层只取 1 个通道，递归切片长度将永远不会缩减；每层直接监听 3 个输入通道外加 1 个递归子通道，能以更浅的树高合并通道。
2. **为什么必须把当前层的 `orDone` 传进下一层递归 `append(channels[3:], orDone)`**：这是防止树中其余监视协程泄漏的神来之笔！假设共传入 10 个通道，而排在最前面的 `channels[0]` 在第 1 秒就关闭了——此时顶层 goroutine 从 `case <-channels[0]:` 退出并执行 `defer close(orDone)`；因为 `orDone` 被作为输入传给了下层递归子树，顶层 `orDone` 的关闭会立刻顺着递归树向下广播，唤醒并终止所有还在等待 `channels[3:]` 的下层监视协程！

在现代 Go 标准库 `context` 体系中，如果只是合并两个独立的 `context.Context`，也可以借助 **Go 1.21+** 的 `context.AfterFunc` 将第二个上下文的取消事件桥接到派生上下文上（详见 [4.8.2 节](#ch4-8-2)）。

### 4.6.2 `or-done-channel`：收敛繁琐的可取消读取循环 {#ch4-6-2}

当你消费一个外部传入的通道 `in` 时，并不能保证“当前协程的 `ctx` 被取消时，上游一定会立刻关闭 `in`”。为了防止永久卡在读取上，每次都不得不写带 `<-ctx.Done()` 和 `v, ok := <-in` 的双分支 `select`。原书通过封装 `OrDone` 辅助函数，让调用方重新回到清爽的 `for val := range OrDone(ctx, in)` 循环：

```go
func OrDone[T any](ctx context.Context, in <-chan T) <-chan T {
	valStream := make(chan T)
	go func() {
		defer close(valStream)
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-in:
				if !ok {
					return
				}
				select {
				case valStream <- v:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return valStream
}
```

### 4.6.3 `tee-channel`：将单路流无损复制到两条输出 {#ch4-6-3}

正如 [3.5.1 节](./chapter-03#ch3-5-1)所讲，如果两个消费者直接从同一个通道读取，消息会被它们瓜分（分摊），而不是各自拿到一份完整副本。如果你需要像 Unix 的 `tee` 命令那样，把一条指令流同时一式两份地发给“业务执行器”和“审计日志记录器”，就可以使用原书的 `Tee` 模式：

```go
func Tee[T any](ctx context.Context, in <-chan T) (<-chan T, <-chan T) {
	out1 := make(chan T)
	out2 := make(chan T)
	go func() {
		defer close(out1)
		defer close(out2)
		for val := range OrDone(ctx, in) {
			var out1, out2 = out1, out2 // 创建遮蔽外层同名变量的局部通道副本
			for range 2 {
				select {
				case <-ctx.Done():
					return
				case out1 <- val:
					out1 = nil // 写入成功后置为 nil，下一轮循环不再重复向 out1 发送
				case out2 <- val:
					out2 = nil // 写入成功后置为 nil，下一轮循环不再重复向 out2 发送
				}
			}
		}
	}()
	return out1, out2
}
```

`Tee` 的核心技巧在于内层循环：每从 `in` 读出一个 `val`，先用局部变量 `out1, out2` 拷贝两个输出通道引用，然后循环 2 次执行 `select`——哪一路先被取走，就把哪一路的局部变量设为 `nil`（利用 `nil` 通道永久阻塞的特性在第二次循环中屏蔽它），从而做到**不限定 `out1` 和 `out2` 谁先谁后，但必须两路都收下当前 `val` 后，才去读下一个输入值**。

这也决定了使用 `Tee` 的一条硬性约束：**调用方必须并发消费 `out1` 和 `out2`**！如果在同一个单协程里写“先用 `for range out1` 把左路全部读完，再去读 `out2`”，那么在发第一个元素时左路读完后右路无人接手，`Tee` 永远走不出内层第 2 次循环，左路也永远不会关闭，两边当场死锁。

### 4.6.4 `bridge-channel`：按序展平“通道的通道” {#ch4-6-4}

在某些架构中（例如[第 5 章的管理员重启守卫协程](./chapter-05#ch5-6)，每次工作者崩溃重启都会产出一个全新的结果通道），上游吐出的本身就是一个“装着通道的通道” `<-chan (<-chan T)`。下游消费者只想用一个简单的 `for v := range stream` 顺序读取所有数据，不想操心内层通道如何切换。**桥接模式（`Bridge`）**正是用来把 `<-chan (<-chan T)` 展平为单一 `<-chan T` 的适配器：

```go
func Bridge[T any](ctx context.Context, chanStream <-chan (<-chan T)) <-chan T {
	valStream := make(chan T)
	go func() {
		defer close(valStream)
		for {
			var stream <-chan T
			select {
			case maybeStream, ok := <-chanStream:
				if !ok {
					return
				}
				stream = maybeStream
			case <-ctx.Done():
				return
			}
			for val := range OrDone(ctx, stream) {
				select {
				case valStream <- val:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return valStream
}
```

请特别区分 `Bridge` 与 `Merge`（扇入）的语义差异：**`Merge` 是并发地同时消费所有输入通道（结果相互交错）；而 `Bridge` 是严格按外层顺序，必须把前一个内层 `stream` 彻底排空并等到它关闭后，才会去取下一个内层 `stream`**。因此，如果前一代工作者卡死且未关闭其输出通道，后续新一代工作者的输出也会被 `Bridge` 堵在后面。

## 4.7 队列排队、背压与 Little 定律 {#ch4-7}

### 4.7.1 引入缓冲队列并不会加快流水线总耗时 {#ch4-7-1}

很多开发者在遇到流水线性能问题时，第一反应是在两个阶段之间塞一个大容量带缓冲通道（即引入内存队列）。原书明确警告：**队列几乎永远不会缩短整条流水线处理完一批数据的总运行时间，它只改变了阶段处于阻塞状态的时间分布**，而且过早引入缓冲队列还会掩盖死锁与活锁缺陷。

原书用一条包含 3 个元素的四阶段流水线做了精确推演：

```text
zeros := Take(ctx, Repeat(ctx, 0), 3) ──► short(每项耗时 1s) ──► long(每项耗时 4s)
```

- **无缓冲时**：`short` 每花 1 秒算出一个结果，都必须干等 `long` 花 4 秒处理完上一项后才能交接。处理完 3 个元素，`short` 到第 9 秒才退出，整条管道总耗时约 **13 秒**（$1 + 4 \times 3 = 13\text{s}$）。
- **在 `short` 与 `long` 之间加入容量为 2 的缓冲队列后**：`short` 连续跑 3 秒把 3 个元素塞进通道与缓冲区后，在第 3 秒就潇洒退出了（`short` 自身的存活时间缩短了三分之二）；但下游的瓶颈 `long` 依然要实打实地花 $3 \times 4 = 12$ 秒慢慢消化，**整条管道的总完成时间依然是 13 秒，一毫秒都没有减少**！

那么队列真正的价值在哪里？在于**解耦上下游阶段的瞬时速率差异，减少上游阶段被下游阻塞的时间**。原书指出，只有以下两类场景引入队列才能真正提升系统整体表现：

1. **批处理分块（Chunking）能显著摊薄单次操作固定开销**：例如标准库 `bufio.Writer` 先将零碎字节写入内存缓冲队列，攒够一整块再发起一次磁盘写入系统调用（或合并开启一次数据库事务、计算整块消息校验和）。
2. **在管道入口处吸收瞬时洪峰，打破负反馈“死亡螺旋（Death Spiral）”**：当下游处理偶发变慢时，若入口毫无缓冲直接阻塞上游连接接受器（`acceptConnection`），会导致客户端大面积连接超时并疯狂发起重试，进一步压垮系统形成死亡螺旋。在入口处设置合理队列可以把“立即拒绝服务”转化为“可控排队延迟”——但**前提是出队时必须检查请求是否已经超时取消**，一旦发现是已超时的僵尸请求必须立即丢弃，否则花算力处理死请求照样会拖垮整条管道！

### 4.7.2 用 Little 定律评估队列与在途内存 {#ch4-7-2}

队列应该建在哪里？通常建在**流水线入口处**，或是天然产生批次数据的阶段之后，而不是盲目加在耗时计算阶段后面。至于队列容量需要多大，原书引入了排队论中的经典公式——**利特尔法则（Little's Law）**：

```text
L = λ × W
```

其中：
- $L$：系统中的平均在途负载数量（正在处理的任务数 + 队列中排队的任务数）；
- $\lambda$：负载的平均有效到达率（单位：请求数/秒）；
- $W$：单个负载在系统中停留的平均总时间（单位：秒）。

Little 定律成立的前提是**系统处于稳态（即入口到达速率等于出口完成速率）**。它直接从数学上证明了：在不提升瓶颈阶段处理速率 $\lambda$ 的情况下，把队列容量扩大 $n$ 倍（使在途量变为 $nL$），只会让每个请求在系统里干等的时间也同比膨胀为 $nW$！此外，进程内存中的 `chan` 队列不具备持久化能力——一旦进程崩溃重启，积压在缓冲通道里的所有请求都会瞬间丢失；若业务要求零丢失，必须将队列外置到持久化消息系统中。

## 4.8 context 包：请求范围的生命周期与元数据 {#ch4-8}

### 4.8.1 取消树与 `Deadline` 快速失败 {#ch4-8-1}

自 **Go 1.7** 起，`context` 包正式并入标准库 `"context"`，取代了早期的实验路径 `golang.org/x/net/context` 以及零散の手搓 `done` 通道。它承担两大核心职责：**在调用图（Call Graph）中向下游分支传播取消信号与截止时间（Deadline）**，以及**跨 API 与进程边界传递请求范围的只读元数据**。

`context.Context` 接口本身是不可变的，且**不包含任何允许被调用方反向取消父上下文的方法**。要控制子树生命周期，必须通过派生函数从父上下文生成子上下文：

```go
func WithCancel(parent Context) (ctx Context, cancel CancelFunc)
func WithDeadline(parent Context, d time.Time) (Context, CancelFunc)
func WithTimeout(parent Context, timeout time.Duration) (Context, CancelFunc)
```

原书通过 `main` 同时启动 `printGreeting` 和 `printFarewell` 两个分支、底层共同调用耗时 1 分钟的 `locale(ctx)` 的完整例子，展示了 `Context` 相比单纯 `done` 通道的两大显著优势：

1. **任意层级按需收紧超时且互不污染**：`genGreeting` 内部调用 `ctx, cancel := context.WithTimeout(ctx, time.Second); defer cancel()`，只在自己的子调用树上施加 1 秒超时，绝不会意外取消兄弟分支 `printFarewell`；而当 `printGreeting` 因超时向 `main` 返回错误后，`main` 再主动调用顶层的 `cancel()`，把 `printFarewell` 分支一并干净取消。
2. **利用 `ctx.Deadline()` 实现前置快速失败（Fast-Fail）**：如果被调函数事先知道自己至少需要 1 分钟才能跑完，它在真正发起昂贵调用前可以先检查上下文剩余寿命：
   ```go
   if deadline, ok := ctx.Deadline(); ok {
   	if time.Until(deadline) < time.Minute {
   		return "", context.DeadlineExceeded // 剩余时间注定不够，立即快速失败！
   	}
   }
   ```

### 4.8.2 Go 1.20—1.21 的现代 `context` 扩展 {#ch4-8-2}

在原书出版后，标准库 `context` 针对生产痛点补充了四组非常实用的现代 API：

- **自定义取消原因（Go 1.20 起：`WithCancelCause` 与 `Cause`；Go 1.21 起：`WithTimeoutCause` 与 `WithDeadlineCause`）**：传统 `ctx.Err()` 只会机械地返回 `context.Canceled` 或 `context.DeadlineExceeded`，下游无从得知究竟是因为哪个上游故障触发了取消。使用 `WithCancelCause` 可以在取消时附带具体的业务错误：
  ```go
  ctx, cancel := context.WithCancelCause(context.Background())
  cancel(fmt.Errorf("quota service unreachable"))

  fmt.Println(ctx.Err())          // 输出：context canceled（保持向后兼容）
  fmt.Println(context.Cause(ctx)) // 输出：quota service unreachable
  ```
  注意只以**首次**触发取消的 `cause` 为准，后续重复调用 `cancel(otherErr)` 不会覆盖已记录的原因。
- **取消后异步回调（Go 1.21 起：`context.AfterFunc`）**：`stop := context.AfterFunc(ctx, fn)` 注册一个在 `ctx` 取消后于独立新 goroutine 中执行的清理函数 `fn`。若在 `ctx` 取消前不再需要该回调，调用 `stop()` 会注销它并返回 `true`；**如果 `stop()` 返回 `false`，说明 `fn` 已经在新 goroutine 中启动（或此前已被注销），且 `stop()` 不会阻塞等待 `fn` 执行完毕**——若清理逻辑与主流程共享可变资源，仍需显式同步。
- **剥离取消信号（Go 1.21 起：`context.WithoutCancel`）**：返回一个保留父上下文全部 `Value` 元数据（如 TraceID），但永远不会随父上下文取消而取消的新 `Context`（其 `Done()` 为 `nil`），适合在请求返回后需要继续记录审计日志等受控收尾动作（但仍应为后台动作单独包裹新的 `WithTimeout` 并纳入服务退出等待）。

### 4.8.3 `WithValue` 的类型安全封装与五条启发式准则 {#ch4-8-3}

`context.WithValue(parent, key, val)` 用于携带请求范围的数据。由于键和值都是 `any`（`interface{}`），为防止不同包使用相同字符串键（如 `"userID"`）发生静默覆盖，**标准做法是在包内定义未导出的自定义键类型，并通过导出的强类型函数提供存取**：

```go
type ctxKey int

const (
	ctxUserID ctxKey = iota
	ctxAuthToken
)

func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, ctxUserID, userID)
}

func UserID(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxUserID).(string)
	return v, ok
}
```

到底什么数据才应该放进 `context.Value`？原书给出了五条非常值得在团队代码评审中落实的**启发式准则**：

1. **数据必须跨越进程或 API 边界**：如果是进程内部自己生成且只在内部几层函数间流转的数据，直接作为显式参数传递即可。
2. **数据必须是不可变的（Immutable）**：同一个 `Context` 会被传给多个并发 goroutine 读取，存入可变对象且并发修改会直接引发竞争。
3. **数据应趋向简单基础类型**：避免让消费方为了从 `Context` 取一个值而被迫导入庞大的业务领域包图。
4. **存入的应当是纯数据，而非带方法的服务对象**：不要把数据库连接池、Logger 实例或业务控制器塞进 `Context`。
5. **数据应当用于“修饰（Decorate）”操作，而非“驱动（Drive）”核心算法分支**：如果函数因为 `Context` 里有没有某个键而执行截然不同的核心业务逻辑，说明它其实是伪装成 `Context` 的隐式可选参数，应当提拔为显式函数参数！

参照这五条标准，像 **Request ID / Trace ID、认证令牌（Auth Token）、客户端来源 IP** 非常适合放入 `Context`；而像数据库连接句柄、业务查询条件或函数配置开关则绝不应塞入 `Context`。

## 4.9 并发错误处理与 errgroup {#ch4-9}

在同步代码中，错误直接通过函数返回值向上传递；而在并发 goroutine 中，工作者独立运行，无法直接 `return err` 给创建者。原书提出了并发错误处理的根本问题：**“谁应该负责处理错误？”**

### 4.9.1 将错误视为一等公民打包进结果流 {#ch4-9-1}

如果让底层工作 goroutine 遇到错误时自己打一行日志然后 `continue` 吞掉，或者直接把半截流程停掉，调用方由于缺乏错误反馈，根本无法做出“累计失败达 3 次就熔断取消剩余请求”这类全局决策。

原书的解决方案是：**将可能产生的 `error` 与正常返回值绑定为同一个 `Result` 结构体，通过同一个结果通道传回给拥有完整上下文知识的父协程处理**：

```go
type Result[T any] struct {
	Value T
	Err   error
}
```

例如在批量检查 URL 状态的 `checkStatus` 中，工作协程只管把每次请求得到的 `*http.Response` 和 `err` 组装成 `Result[*http.Response]` 发往结果通道；外层 `main` 协程在 `for result := range checkStatus(ctx, urls...)` 中统一检查 `result.Err != nil`，一旦累计错误达到 3 次便立即 `break` 并通过 `defer cancel()` 终止后台协程。

### 4.9.2 全成功任务组：官方扩展包 `errgroup` {#ch4-9-2}

对于上述“需要逐条消费成功结果、并对单条错误做细粒度计数或跳过”的流式场景，使用 `Result[T]` 通道最合适。而在另一种同样高频的工程场景中——**并发执行一组子任务，只要其中任何一个任务返回非 `nil` 错误，就立即取消其余所有任务，并在全部任务退出后返回首个错误**——使用官方扩展包 **`golang.org/x/sync/errgroup`**（安装方式见[附录 A](./appendix-a#cha-1)）能省去大量手工编排模板代码：

```go
// 假定已导入 "golang.org/x/sync/errgroup"，jobs 为 []func(context.Context) error
g, ctx := errgroup.WithContext(parentCtx)
g.SetLimit(4) // 限制组内同一时刻最多运行 4 个活跃 goroutine

for _, job := range jobs {
	g.Go(func() error {
		return job(ctx)
	})
}

if err := g.Wait(); err != nil {
	return err
}
```

使用 `errgroup` 时务必牢记四条契约细节：

1. **首个错误触发取消，`Wait()` 保证等待全部任务退出**：任一任务返回非 `nil` 错误时，派生的 `ctx` 会立即被取消；`g.Wait()` 会阻塞直到所有已启动的任务全部返回，然后返回那**第一个**非 `nil` 错误。
2. **不要复用派生出的 `ctx`**：当 `g.Wait()` 正常返回时（哪怕全部任务都成功返回 `nil`），`errgroup.WithContext` 内部也会自动调用 `cancel()` 关闭该派生 `ctx`！因此绝不能把 `g, ctx := errgroup.WithContext(parent)` 里的 `ctx` 拿去传给 `g.Wait()` 之后的后续请求。
3. **`g.SetLimit(n)` 的阻塞位置**：当活跃任务数达到 `n` 时，是在外层调用 **`g.Go(...)` 的那一刻直接阻塞等待空槽位**（且 `g.Go` 本身不直接监听 `ctx.Done()`）。因此，如果子任务内部要向某个无缓冲结果通道写数据，而主协程又必须等全部 `g.Go` 调完后才去读那个结果通道，当任务数超过 `n` 时就会立刻形成“子任务等主协程读通道、主协程在 `g.Go` 等子任务腾槽位”的死锁！
4. **不自动捕获 `panic`**：`errgroup` 同样要求子任务不能让未恢复的 `panic` 逃逸。

## 练习 {#ch4-exercises}

以下四道练习分别考察 `for-select` 取消漏洞、`Tee` 双路消费死锁、流水线提前终止后的上游清理，以及 `errgroup.SetLimit` 与无缓冲通道结合时的死锁环。建议先独立分析写出修复代码，再展开参考答案核对。

### 练习 1：只在循环顶部非阻塞检查取消为什么仍然会泄漏？

阅读下面这段生产者代码（其中 `out` 为无缓冲 `chan int`，下游消费者随时可能提前退出并调用 `cancel()`），指出其中导致生产者无法正常退出的**两处独立错误**，并给出修复后的代码：

```go
for {
	select {
	case <-ctx.Done():
		break
	default:
	}
	out <- 1
}
```

<details>
<summary>查看参考答案</summary>

1. **错误一（误用无标签 `break`）**：在 `select` 内部写不带标签的 `break`，只会跳出当前的 `select` 块，紧接着依然会向下执行 `out <- 1` 并进入下一轮 `for` 循环，根本退不出外层循环。
2. **错误二（阻塞发送未纳入 `select` 监听取消）**：即便把 `break` 改成 `return`，它也只在循环顶部瞬间做了一次非阻塞检查。如果在走完 `default` 之后、执行 `out <- 1` 之前（或正卡在 `out <- 1` 期间）消费者退出了，由于无缓冲通道 `out <- 1` 没有和 `<-ctx.Done()` 放在同一个 `select` 里，生产者将永远卡死在 `out <- 1` 上。
3. **修复代码**：直接将发送操作与取消分支合并在同一个 `select` 中：
   ```go
   for {
   	select {
   	case <-ctx.Done():
   		return
   	case out <- 1:
   	}
   }
   ```

</details>

### 练习 2：顺序读完 `Tee` 的左路再去读右路为什么会卡死？

某开发者调用 [4.6.3 节](#ch4-6-3)的 `left, right := Tee(ctx, Generate(ctx, 1, 2, 3))` 后，在同一协程中先写了一个循环读取 `left`，打算等 `left` 读完后再写第二个循环读取 `right`：

```go
for v := range left {
	fmt.Println("left:", v)
}
for v := range right {
	fmt.Println("right:", v)
}
```

请问：这段程序会打印出什么现象？把 `left` 和 `right` 的通道容量从无缓冲改成容量 `1` 能否作为通用修复方案？正确的消费方式是什么？

<details>
<summary>查看参考答案</summary>

1. **运行现象**：程序打印出一行 `left: 1` 后就会永久阻塞（若无其他活跃协程则直接报 `deadlock!`）。因为 `Tee` 的内层循环规定：对于第一个元素 `1`，必须向 `left` 和 `right` 各成功发送一次，才会进入下一轮去取元素 `2` 或关闭通道。主协程读走 `left` 的 `1` 后，继续在第一个 `for range left` 里等待第 2 个值，此时根本没人去读 `right` 的 `1`，导致 `Tee` 卡死在 `right <- 1` 上，双方互相死等。
2. **加容量 `1` 不能作为通用修复**：容量为 `1` 只能让第 1 个元素的右路写入暂时落入缓冲；一旦输入流长度超过缓冲容量（如本例有 3 个元素），在第 2 个元素写右路时依然会再次填满缓冲并卡死。
3. **正确消费方式**：必须并发消费 `left` 和 `right`（或者像原书示例那样在同一轮循环中交替各读一次）：
   ```go
   // 方式 A：同一循环内同步配对读取
   for v1 := range left {
   	v2 := <-right
   	fmt.Println("left:", v1, "right:", v2)
   }

   // 方式 B：启动独立协程并发消费两路
   var wg sync.WaitGroup
   wg.Go(func() {
   	for v := range left {
   		fmt.Println("left:", v)
   	}
   })
   wg.Go(func() {
   	for v := range right {
   		fmt.Println("right:", v)
   	}
   })
   wg.Wait()
   ```

</details>

### 练习 3：手写一个带取消与序号保序的并发扇出映射函数

[4.5 节](#ch4-5)指出，普通的扇出 + `Merge` 会打乱元素的先后顺序。请编写一个泛型函数 `OrderedParallelMap[T, R any](ctx context.Context, inputs []T, workers int, fn func(context.Context, T) (R, error)) ([]R, error)`：
- 最多启动 `workers` 个并发任务处理 `inputs`；
- 若全部成功，返回的 `[]R` 必须与 `inputs` 的下标顺序严格一致；
- 若任一元素处理返回错误，立即取消其余任务并返回该错误。

<details>
<summary>查看参考答案</summary>

利用 [4.1.2 节](#ch4-1-2)的**词法/下标约束**配合 [4.9.2 节](#ch4-9-2)的 `errgroup`，可以让每个任务直接把结果写回预分配切片 `results[i]` 对应的独立下标槽位，既无需加锁，又天然保序：

```go
func OrderedParallelMap[T, R any](
	parent context.Context,
	inputs []T,
	workers int,
	fn func(context.Context, T) (R, error),
) ([]R, error) {
	results := make([]R, len(inputs))
	g, ctx := errgroup.WithContext(parent)
	if workers > 0 {
		g.SetLimit(workers)
	}

	for i, item := range inputs {
		g.Go(func() error {
			res, err := fn(ctx, item)
			if err != nil {
				return err
			}
			results[i] = res // 每个下标 i 由唯一子任务写入，wg.Wait 后安全可见
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}
```

这里结合了 Go 1.22+ 的循环变量 `i, item` 按次独立分配语义、`errgroup` 的首错取消与并发限制，以及下标分片约束，代码既简短又没有任何通道重排开销。

</details>

### 练习 4：为什么加了 `g.SetLimit(2)` 后，原本正常的代码反而死锁了？

阅读下面这段使用 `errgroup` 的代码（共 3 个任务，限制并发度为 2，结果通道 `results` 为无缓冲通道）：

```go
g, ctx := errgroup.WithContext(parent)
g.SetLimit(2)
results := make(chan int)

for i := range 3 {
	g.Go(func() error {
		results <- i * 10
		return nil
	})
}

go func() {
	_ = g.Wait()
	close(results)
}()

for r := range results {
	fmt.Println(r)
}
```

请解释为什么这段代码会在第 3 次调用 `g.Go` 时永久卡死？并给出两种修复方案。

<details>
<summary>查看参考答案</summary>

1. **死锁原因**：`g.SetLimit(2)` 限制同时最多只有 2 个活跃子协程，超出时**外层的 `g.Go` 调用本身会阻塞等待前两个子协程退出腾出槽位**。然而，前两个子协程启动后都阻塞在无缓冲发送 `results <- i * 10` 上，等待主协程执行最下面的 `for r := range results` 来接收；而主协程此时正卡在第 3 次 `g.Go(...)` 调用上，根本走不到下面的接收循环！于是形成了“主协程等子协程退场腾名额、子协程等主协程往下走来读通道”的死锁环。
2. **修复方案一（将派发循环放入独立协程，让主协程立即开始消费 `results`）**：
   ```go
   go func() {
   	for i := range 3 {
   		g.Go(func() error {
   			select {
   			case <-ctx.Done():
   				return ctx.Err()
   			case results <- i * 10:
   				return nil
   			}
   		})
   	}
   	_ = g.Wait()
   	close(results)
   }()
   for r := range results {
   	fmt.Println(r)
   }
   ```
3. **修复方案二（已知固定任务总数时，为 `results` 分配足够缓冲 `make(chan int, 3)` 或直接按练习 3 写入预分配切片）**：这样前两个子协程发送结果后不会阻塞，能够立即返回并释放 `SetLimit` 槽位。

</details>

## 面试题 {#ch4-interview}

以下四题检验 `context` 取消语义、`AfterFunc` 停止边界、`Bridge` 与 `Merge` 对比以及 `errgroup` 上下文寿命。请先独立作答，再展开核对。

### 面试题 1：调用 `cancel()` 返回的那一刻，后台子 goroutine 一定已经退出了吗？

父协程通过 `ctx, cancel := context.WithCancel(parent)` 启动了一个正在读写本地临时文件的后台工作协程。请问父协程在调用 `cancel()` 返回后，能否立刻接着调用 `os.RemoveAll(tmpDir)` 删除该临时目录？

<details>
<summary>查看参考答案</summary>

**不能。`cancel()` 只是异步广播“请尽快停止”的通知信号，绝不等价于等待子协程退出（Join）。**

调用 `cancel()` 返回时，仅完成了关闭 `ctx.Done()` 通道的动作；此时后台工作协程可能正运行在两处 `select` 检查之间的磁盘写入系统调用中，尚未观察到取消信号，也尚未执行 `defer file.Close()`。如果父协程立刻删除临时目录，轻则因文件句柄未关闭在 Windows 上报错失败，重则引发并发访问冲突。正确顺序永远是：**先调用 `cancel()` 发出通知 → 再通过 `wg.Wait()` 或完成通道等待子协程彻底退出 → 最后安全清理外部共享资源**。

</details>

### 面试题 2：`context.AfterFunc` 返回的 `stop()` 函数返回 `false` 代表什么？

Go 1.21 引入了 `stop := context.AfterFunc(ctx, cleanup)`。如果调用 `stop()` 时返回了 `false`，能否据此断定 `cleanup()` 函数已经执行完毕了？

<details>
<summary>查看参考答案</summary>

**不能。**

`stop()` 返回 `false` 只表示“未能成功阻止回调启动”，原因可能是：
1. `ctx` 已经取消，`cleanup` 已经被调度到独立的新 goroutine 中开始执行（但此时 **`cleanup` 可能才刚跑了第一行，远未执行完毕**，因为 `stop()` 不会阻塞等待 `cleanup` 结束）；
2. 或者此前已经有人调用过一次 `stop()`。

如果主流程必须等待已经启动的 `cleanup` 执行完毕才能继续，应当在 `cleanup` 内部通过关闭完成通道（如 `defer close(cleanupDone)`）或 `sync.WaitGroup` 与主流程显式同步。

</details>

### 面试题 3：为什么不能把 `errgroup.WithContext` 派生出的 `ctx` 继续传给 `g.Wait()` 之后的下游调用？

阅读下面这段代码：

```go
g, ctx := errgroup.WithContext(reqCtx)
g.Go(func() error { return checkAuth(ctx) })
g.Go(func() error { return loadProfile(ctx) })
if err := g.Wait(); err != nil {
	return err
}
return saveAuditLog(ctx) // 这里直接传了上面的 ctx
```

当 `checkAuth` 和 `loadProfile` 都成功返回 `nil` 时，最后一行的 `saveAuditLog(ctx)` 会遇到什么问题？

<details>
<summary>查看参考答案</summary>

**`saveAuditLog(ctx)` 会立即因为 `context canceled` 而失败！**

根据 `errgroup.WithContext` 的文档契约：派生出的 `ctx` 不仅会在任一子任务返回非 `nil` 错误时被取消，**还会在 `g.Wait()` 返回时被无条件取消**（目的是及时释放关联的上下文监听器资源）。因此，哪怕所有子任务都圆满成功，一旦跨过 `g.Wait()`，那个局部 `ctx` 就已经处于已取消状态了！切勿用同名变量 `ctx` 遮蔽外层的 `reqCtx`（建议命名为 `g, gCtx := errgroup.WithContext(ctx)`），`g.Wait()` 之后的后续步骤应继续使用外层未取消的 `reqCtx`。

</details>

### 面试题 4：同为合并多个通道，`Bridge` 模式和 `Merge`（扇入）模式有什么本质区别？

什么时候应该用 `Merge`，什么时候必须用 `Bridge`？

<details>
<summary>查看参考答案</summary>

1. **输入形态与并发方式不同**：
   - **`Merge`（扇入）**接收固定或已知的一批 `...<-chan T`，同时为每一路启动转发协程**并发读取**，哪一路先来数据就先往外发哪一路，多路数据在输出流中相互交错；
   - **`Bridge`（桥接）**接收的是动态到达的通道流 `<-chan (<-chan T)`，它在单个外层循环中**严格按先后顺序逐个排空内层通道**——只有当前内层通道关闭后，才会去取下一个内层通道。
2. **适用场景**：当多个无状态工作者并行处理任务、不关心结果先后顺序时用 `Merge`；当多个通道代表具有先后代次关系的有序分片流（如分页拉取流、或守卫协程重启前后的连续多代输出流），要求严格消费完上一代再消费下一代时，则必须使用 `Bridge`。

</details>

## 参考资料

- [Sameer Ajmani：Go Concurrency Patterns: Pipelines and cancellation（Go 官方博客）](https://go.dev/blog/pipelines)
- [Sameer Ajmani：Go Concurrency Patterns: Context（Go 官方博客）](https://go.dev/blog/context)
- [Go 语言规范：完整切片表达式（Full slice expressions）](https://go.dev/ref/spec#Slice_expressions)
- [Go 语言规范：`break` 语句的作用范围](https://go.dev/ref/spec#Break_statements)
- [标准库 `context` 包文档（`WithCancelCause`、`AfterFunc`、`WithoutCancel`）](https://pkg.go.dev/context)
- [官方扩展包 `golang.org/x/sync/errgroup` 文档](https://pkg.go.dev/golang.org/x/sync/errgroup)
- [John D. C. Little：A Proof for the Queuing Formula: $L = \lambda W$（1961）](https://doi.org/10.1287/opre.9.3.383)
