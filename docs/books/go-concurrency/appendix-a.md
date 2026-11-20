---
title: 附录 A 并发诊断与测试
description: 使用 race、goroutine 与泄漏 profile、执行跟踪和 testing/synctest 建立可复现的并发验证流程。
---

# 附录 A 并发诊断与测试

## 本章要点

并发诊断需要把“存在什么错误”与“哪些证据能说明它”对应起来。本附录在原书的 panic 栈、竞态检测和 pprof 基础上，补充执行跟踪、Go 1.27 泄漏 profile 与虚拟时间测试，给出可以独立复现的命令和短例子。

读完后，应能根据数据竞争、等待、资源积压或超时行为选择工具，保留足够的环境信息，并区分实际运行观察和规则推导。工具的通过结果不替代所有权与退出协议的检查。

> 核对日期：2026 年 11 月 10 日；核对环境为 Go 1.27.3、Windows/AMD64，CGO_ENABLED=0，未配置 C 编译器；扩展库为 golang.org/x/sync v0.25.0、golang.org/x/time v0.16.0。本机无法执行 -race，见 [A.2 节](#cha-2)。

## A.1 准备可复现的实验 {#cha-1}

先记录工具链、平台和模块语言版本。以下命令使用 PowerShell，省略提示符：

```powershell
go version
go env GOOS GOARCH CGO_ENABLED CC
```

若需要在独立目录中运行本指南的例子，可以在一个新目录执行：

```powershell
go mod init example.com/concurrency-lab
go mod edit -go=1.27.0
go get golang.org/x/sync@v0.25.0 golang.org/x/time@v0.16.0
```

两个扩展模块的这些版本都声明最低 Go 1.26.0；它们是本次实际下载和核对的版本，不代表旧 Go 工具链可直接使用。只运行标准库例子时，无需安装扩展模块。不要把原书成书时的依赖版本、`x/net/context` 路径和基准结果直接当成现代环境配置。

正文中的省略导入片段不能未经补齐直接保存为一个 Go 文件。独立程序需要 `package main`、使用到的导入和 `main`；测试函数放入 `_test.go` 文件，且不能把不同示例中的同名声明重复拼进同一包。

## A.2 panic 栈、静态检查与竞态检测 {#cha-2}

### A.2.1 从栈判断阻塞与创建位置

panic 输出通常包含发生位置、调用栈以及 goroutine 创建位置。先定位自己的源码帧，再区分当前函数和 `created by` 对应的启动位置；不要把 goroutine 编号当成稳定业务标识。

需要在未恢复 panic 时查看其他 goroutine，可在启动程序前设置：

```powershell
$env:GOTRACEBACK = 'all'
go run .
Remove-Item Env:GOTRACEBACK
```

`GOTRACEBACK` 控制崩溃时的输出范围，不会主动对正常运行的程序生成快照。运行中应使用 [goroutine profile](#cha-3)。Go 1.27 对采用 `go 1.27` 或更高模块语言版本的程序，还会在 traceback 头中显示 goroutine 的 pprof labels；可用 `tracebacklabels=0` 关闭。不要依赖旧版本栈文本逐字符不变。

### A.2.2 vet 与 race 各负责什么

```powershell
go vet ./...
go test -race ./...
go run -race .
```

`go vet` 检查一部分可疑模式，例如复制锁、部分不正确的 `WaitGroup` 使用和丢失取消函数。它是静态分析，不能证明并发协议正确。

竞态检测器通过带插桩的执行发现数据竞争。报告中的两个访问栈说明冲突发生在哪里，goroutine 创建栈说明对应工作从何处启动；报告顺序不是业务调用顺序，也不能把一次输出相同当成不存在竞争。

检测器只观察实际执行路径，且需要支持的平台和工具链配置。官方文档列出了 `-race` 的平台、cgo 与 C 编译器要求；本次环境 `CGO_ENABLED=0` 且没有 C 编译器，因此竞态运行未验证，不能把普通 `go test` 的通过写成 `-race` 通过。

`GORACE` 接收的是小写选项，例如 `log_path`、`strip_path_prefix` 与 `history_size`，不是原书转写中容易误认的独立大写环境变量。`history_size` 表示每个 goroutine 的访问历史容量指数，不能直接把它解释成固定 KB 数。

## A.3 profile、泄漏检测与执行跟踪 {#cha-3}

### A.3.1 选择 profile

`pprof` 在下文程序中导入 `"net/http/pprof"` 以注册 HTTP 处理器；如果直接在代码里调用 `pprof.Lookup`，则应导入 `"runtime/pprof"`。两者名称相近，职责不同。

| 证据 | 回答的问题 | 主要限制 |
| --- | --- | --- |
| goroutine | 当前有哪些执行栈与等待点 | 一张快照不能证明某等待永久存在 |
| goroutineleak | 哪些永久阻塞可由当前运行时识别 | 不是所有泄漏都能识别 |
| CPU | CPU 时间主要消耗在哪里 | 等待时间通常不会体现为 CPU 热点 |
| heap / allocs | 当前保留与历史分配压力 | 两者含义不同，需区分存活量与分配量 |
| block | 同步等待主要发生在哪里 | 需要启用采样，且关注的多是已结束的阻塞事件 |
| mutex | 哪些持锁临界区造成争用等待 | 需要启用采样，不是逐次获取锁的完整日志 |
| trace | 调度、唤醒、I/O 与 GC 如何随时间发生 | 数据量与采集成本需要控制 |

下面是可单独保存为 `main.go` 的诊断服务例子。`SetBlockProfileRate(1)` 记录全部相应阻塞事件，`SetMutexProfileFraction(1)` 采样全部争用事件，适合受控实验；生产采样率应根据开销调整。

```go
package main

import (
	"log"
	"net/http"
	_ "net/http/pprof"
	"runtime"
)

func main() {
	runtime.SetBlockProfileRate(1)
	runtime.SetMutexProfileFraction(1)
	log.Fatal(http.ListenAndServe("127.0.0.1:6060", nil))
}
```

在另一个 PowerShell 终端采集：

```powershell
Invoke-WebRequest 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2' -OutFile goroutine.txt
go tool pprof 'http://127.0.0.1:6060/debug/pprof/profile?seconds=10'
go tool pprof 'http://127.0.0.1:6060/debug/pprof/block'
go tool pprof 'http://127.0.0.1:6060/debug/pprof/mutex'
```

这个最小服务本身没有业务负载，空或很小的 profile 不能说明某项业务的表现。实际调查应在复现负载下，对照请求完成前后的多次快照和业务指标。

### A.3.2 Go 1.27 的 goroutineleak profile

**Go 1.27 起，`goroutineleak` profile 正式可用**；Go 1.26 中需要实验开关，Go 1.27 已删除该实验开关，无需沿用。可以通过前述服务采集：

```powershell
Invoke-WebRequest 'http://127.0.0.1:6060/debug/pprof/goroutineleak?debug=2' -OutFile goroutineleak.txt
```

运行时利用垃圾回收的可达性信息，发现一些不可能再被可推进 goroutine 唤醒的永久阻塞。例如汇总方提前返回，剩余发送者堵在只能被这些发送者引用的无缓冲 channel 上，就属于可识别情形。

若等待对象仍能从全局变量或可运行 goroutine 的局部变量到达，检测器可能无法证明它永远不会被操作；忙循环、不受管理但仍可运行的后台任务、增长中的工作积压，也不能仅靠这项 profile 排除。它提供诊断证据，不提供自动回收或取消。

### A.3.3 trace 与近期窗口

对已有测试可以采集执行跟踪：

```powershell
go test -run TestCancel -count=1 -trace trace.out .
go tool trace trace.out
```

这里要求包里存在匹配的测试，例如 [A.4 节](#cha-4)的 `TestCancel`。`-count=1` 避免复用测试结果；`-run` 没匹配到测试时不能视为该场景已验证。

trace 用来关联等待与唤醒的时序，不能从可视化中的一次先后关系推出所有执行都遵循该顺序。Go 1.25 起的 `runtime/trace.FlightRecorder` 则保留近期跟踪窗口，可在异常条件触发时导出；启用前仍需明确保留范围和导出策略。

## A.4 用 testing/synctest 测试时间行为 {#cha-4}

### A.4.1 用确定事件替代真实休眠

**Go 1.25 起，`testing/synctest` 正式可用**；Go 1.24 的实验 API 不作为本指南写法。`synctest.Test` 创建隔离的 bubble，其中启动的 goroutine 也属于该 bubble；其时钟虚拟化。只有其他执行单元都进入符合文档定义的持久阻塞状态时，虚拟时间才适合推进。

**Go 1.27 起新增 `synctest.Sleep`**，等价于先 `time.Sleep` 再 `synctest.Wait`。它既推进当前 bubble 的时钟，又等待其余 goroutine 再次稳定阻塞，避免测试与被测代码在同一时刻唤醒时争抢执行顺序。

下面是完整的 `cancel_test.go`：

```go
package concurrencylab

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

func TestCancel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		done := make(chan struct{})
		go func() {
			defer close(done)
			<-ctx.Done()
		}()

		synctest.Sleep(time.Second - time.Nanosecond)
		if err := ctx.Err(); err != nil {
			t.Fatalf("canceled too early: %v", err)
		}
		synctest.Sleep(time.Nanosecond)
		if ctx.Err() != context.DeadlineExceeded {
			t.Fatalf("got %v, want DeadlineExceeded", ctx.Err())
		}
		select {
		case <-done:
		default:
			t.Fatal("worker did not exit")
		}
	})
}
```

这里虚拟的一秒不要求真实等待一秒。两个检查分别证明不会提前取消，以及截止后工作者已经观察信号并退出。若面向 Go 1.25 或 1.26，可把两次 `synctest.Sleep(d)` 分别替换为 `time.Sleep(d)` 后紧跟 `synctest.Wait()`。

### A.4.2 bubble 的边界

它不是把所有外部依赖变成虚拟时间。真实网络、系统调用、bubble 外 goroutine 和互斥锁等待，不都属于可以驱动其时钟前进的持久阻塞。应尽量用 bubble 内 channel、明确事件与可替代依赖构造场景，避免真实 I/O。

**Go 1.27 起的 `net/http/httptest.NewTestServer`** 默认使用内存网络，适合与 synctest 配合；这与旧的 `httptest.NewServer` 不同。需要通过该测试服务器的 `Client()` 访问，不能假设普通网络客户端可以连接内存服务器。

测试仍要让所有自己启动的 goroutine 退出。synctest 不会把永久死锁变成正确结果，也不能代替 `-race` 检查未同步访问。

## A.5 本次验证记录 {#cha-5}

本指南的验证分为规则核对、片段编译和代表性行为测试。章节中的完整程序及可补齐上下文的片段在独立临时模块中编译；用于展示错误的示例只核对其语法与错误性质，不把它们当作正确模板。

临时核对模块提取了 35 个 Go 代码块，补上正文已说明的导入、变量和函数上下文后，使用 `go test -vet=off -run '^$' ./snippets/...` 全部编译通过。这里关闭 vet 是因为其中刻意包含不正确的 `WaitGroup` 等反例；正确示例组成的行为测试模块另用 `go test -count=1 -timeout=60s -v .` 运行，12 项测试通过，`go vet .` 也通过。

本次在 Go 1.27.3、Windows/AMD64 下验证以下行为：

- 有限生成与变换的值和顺序；多路合流的完整性与取消后的结束。
- tee 的双路交付及单侧停止后通过取消退出；心跳在等待输出时仍可被观察。
- 复制请求忽略快速失败、返回首个成功，并在返回前完成落败任务收尾；全部失败保留错误链。
- 虚拟时间下的超时边界、定时器重置及内存 HTTP 测试服务器。
- errgroup 的错误取消与成功后的上下文结束；令牌桶的初始突发和 deadline 拒绝行为。

这些验证说明所覆盖场景的行为，不构成所有调度交错的证明。尝试 `go test -race -run TestCancel .` 时，工具报告 `-race requires cgo; enable cgo by setting CGO_ENABLED=1`，没有进入竞态测试；Linux 容器配额与跨进程故障恢复也未在本地模拟，不记为实测结论。

## 练习 {#cha-exercises}

本节通过诊断流程与测试设计检查工具选择。先独立列出证据和判断边界，再展开答案；无需实际采集或运行。本附录以完整诊断流程为主，关键判断已由练习覆盖，因此不另设面试题。

### 练习 1：race 通过但请求不结束

一个请求的测试没有报告数据竞争，却在并发量升高后长期不返回。请设计调查顺序，至少区分锁等待、channel 协议和外部 I/O，并说明为什么不能只重复运行 race。

<details>
<summary>查看参考答案</summary>

先记录超时请求、在途数和多次 goroutine 栈，识别等待点是否随时间变化。锁等待可结合 mutex、block profile 与持锁代码，channel 等待应画发送者、接收者和关闭责任，外部 I/O 则核对上下文传播、客户端 deadline 与下游指标。

必要时采集 trace 关联调度和唤醒；Go 1.27 可再查看 goroutineleak profile，但没有条目也不能排除协议问题。race 主要检查执行到的数据竞争，无法证明请求最终能结束。

</details>

### 练习 2：把定时器测试改成可重复的测试

旧测试创建 100ms 超时，真实休眠 110ms 后检查工作者是否退出，在繁忙 CI 上偶尔失败。如何用 Go 1.27 的工具重写？还应验证什么边界？

<details>
<summary>查看参考答案</summary>

在 `synctest.Test` 内创建上下文和工作者，用 `synctest.Sleep` 推进到 deadline 之前，确认尚未取消；再推进至 deadline，确认错误类型及完成通知。这样通过虚拟时间与稳定阻塞状态检查事件，不依赖真实的 10ms 裕量。

还应覆盖手动提前取消、正常完成后释放资源，以及消费者提前退出等独立路径。真实网络与外部 goroutine 需要隔离或替换，不能把它们未经处理直接放进 bubble。

</details>

## 参考资料

- [Go 竞态检测器：平台要求、报告与 GORACE](https://go.dev/doc/articles/race_detector)
- [cmd/vet：静态检查及其限制](https://pkg.go.dev/cmd/vet)
- [runtime：GOTRACEBACK、采样与运行时配置](https://pkg.go.dev/runtime)
- [runtime/pprof：profile 类型与采样语义](https://pkg.go.dev/runtime/pprof)
- [net/http/pprof：采集端点与参数](https://pkg.go.dev/net/http/pprof)
- [runtime/trace：跟踪与 FlightRecorder](https://pkg.go.dev/runtime/trace)
- [testing/synctest：虚拟时间、持久阻塞与隔离](https://pkg.go.dev/testing/synctest)
- [net/http/httptest.NewTestServer：内存测试服务器](https://pkg.go.dev/net/http/httptest#NewTestServer)
- [Go 1.25：正式提供 synctest](https://go.dev/doc/go1.25#new-testingsynctest-package)
- [Go 1.26：泄漏 profile 的实验阶段](https://go.dev/doc/go1.26#runtime)
- [Go 1.27：泄漏 profile、traceback labels 与测试 API](https://go.dev/doc/go1.27)
