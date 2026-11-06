---
title: 第 15 章 编写测试
description: 掌握单元测试、表格驱动测试、模糊测试、基准测试、测试桩、httptest、集成测试隔离与数据竞争检测。
---

# 第 15 章 编写测试

## 本章要点

Go 不靠繁琐的第三方断言 DSL 写测试，测试能力从第一天起就做进了标准库 `"testing"` 和 `go test` 命令里。本章沿着测试金字塔由浅入深展开：先理清 `_test.go` 的白盒/黑盒包边界、`Error` 与 `Fatal` 的取舍、`t.Cleanup` / `t.TempDir` / `t.Context` 的生命周期管理以及 `go-cmp` 结构化比对；再掌握表格驱动子测试、并行执行、覆盖率盲区识别、自动变异输入的模糊测试（Fuzzing）和 `b.Loop` 基准测试；最后结合消费端小接口测试桩、`httptest`、构建标签隔离集成测试与 `-race` 数据竞争检测器，让“好不好测”反过来检验代码设计是否干净。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 15.1 测试的基础知识 {#ch15-1}

除另有说明外，本章正文中的测试代码位于以 `_test.go` 结尾的源文件中，默认已导入标准库 `"testing"`；其余标准库与第三方包在首次出现处注明导入路径。

### 15.1.1 第一个单元测试 {#ch15-1-1}

Go 的测试文件直接跟被测源码放在**同一个目录**下，文件名以 `_test.go` 结尾（如 `adder.go` 对应 `adder_test.go`；`go build` 编译正式产物时会自动忽略所有 `*_test.go` 文件）。普通单元测试函数必须满足固定的签名约定：名字以 `Test` 开头（注意 `Test` 紧跟的第一个字符**不能是小写英文字母**，可写 `TestAddNumbers` 或测未导出函数时写 `Test_addNumbers`），唯一参数为 `t *testing.T`，无返回值：

```go
func addNumbers(x, y int) int {
	return x + x // 故意留一个写错成 x + x 的 Bug
}

func Test_addNumbers(t *testing.T) {
	got := addNumbers(2, 3)
	if got != 5 {
		t.Errorf("addNumbers(2, 3) = %d, want 5", got)
	}
}
```

在模块目录下跑 `go test ./...` 就会递归编译并执行所有包的测试（加 `-v` 打印每个用例的名字和 `t.Log` 输出）。把上面的 `x + x` 修回 `x + y` 再跑一遍，立刻全绿通过。

### 15.1.2 报告失败：`Error`、`Fatal` 与 `t.Helper` {#ch15-1-2}

测试断言没过时，报错方法分两档，选错会让排查变累：

- **`t.Error` / `t.Errorf`**：把当前测试标为失败，但**继续往下跑完当前测试函数**。检查同一个返回结构体的好几个独立字段时优先用它，跑一次就能把所有错掉的字段全列出来，不用修一个跑一次。
- **`t.Fatal` / `t.Fatalf`**：把当前测试标为失败，并通过内部调用 `runtime.Goexit()` **当场终止当前这一个测试函数**（其他测试函数照常运行）。当前置步骤已经挂了（比如 `err != nil`、`got == nil`、打开测试样本失败），继续往下走只会引发空指针 `panic` 或报出一堆无意义的连锁假错时，果断用 `Fatal` 停手。

顺带记两条实战铁律：一是如果把重复断言抽成了测试辅助函数（如 `assertNoErr(t, err)`），记得在辅助函数第一行加上 **`t.Helper()`**，这样报错行号才会指向外层真正的测试用例行，而不是全指在辅助函数内部；二是**绝对不要在测试自己新起的子 Goroutine 里调 `t.Fatal` / `t.Fatalf`**（它只能退出当前协程，退不出主测试协程，`go vet` 的 `testinggoroutine` 检查器会直接报错），子协程出错应通过通道传回主测试协程或改调 `t.Errorf`。

### 15.1.3 `TestMain`、`t.Cleanup`、`t.TempDir` 与 `t.Context` {#ch15-1-3}

如果整个测试包跑之前需要统一建一次容器或连一次测试库，可以定义一个包级入口函数 `func TestMain(m *testing.M)`（每个包最多一个）：在里面做好全局准备、调用 `code := m.Run()` 跑完包内全部测试、做完清理后再退出（注意如果最后显式调用了 `os.Exit(code)`，清理动作必须写在 `os.Exit` **之前**，因为 `os.Exit` 不会跑 `defer`！日常没有跨全包的重型外部资源时，尽量别写 `TestMain` 和包级共享状态）。

单个测试自己的收尾工作，优先用 **`t.Cleanup(func() { ... })`**（按后进先出顺序在当前测试及全部子测试结束时执行）。它比裸 `defer` 强在能直接写进测试辅助函数里——辅助函数负责建资源，顺手就把关资源的动作挂到 `t` 上，外层调用方拿来就用：

```go
func writeSampleFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sample.txt")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write sample file: %v", err)
	}
	return path
}
```

上面用到的 **`t.TempDir()`** 会为当前测试单独创建一个临时目录，并自动通过 `t.Cleanup` 在测试结束时整目录递归删掉（注意在 Windows 平台上，如果测试在 `t.TempDir()` 里用 `os.Open` / `os.Create` 打开了文件句柄却忘了 `Close()`，测试结束自动删目录时会因为文件仍被进程占用报错导致测试失败！所以凡是打开了 `*os.File`，务必配合 `t.Cleanup(func() { _ = f.Close() })` 或 `defer f.Close()` 关干净）。

此外自 **Go 1.24** 起，`testing.T`（以及 `B`、`F`）还内置了 **`t.Context()`**：返回一个会在当前测试结束、即将执行 `t.Cleanup` 前夕自动取消的 `context.Context`，测带 `ctx` 参数的函数时直接传 `t.Context()`，再也不用每个测试手写两行 `context.WithCancel` 了。

### 15.1.4 环境变量、`testdata` 与结果缓存 {#ch15-1-4}

单个测试需要临时改环境变量或切换工作目录时，分别使用 `t.Setenv("KEY", "val")`（Go 1.17+）和 `t.Chdir(dir)`（Go 1.24+），测试跑完会自动恢复原状。注意这两者修改的都是整个操作系统进程共享的全局状态，因此**决不能与 `t.Parallel()` 同时使用**（混用会当场 `panic`）。

存放测试输入样本文件（JSON 报文、证书样本、黄金对比文件）统一建一个名叫 **`testdata`** 的子目录：`go` 工具链专门保留了这个目录名，既不会尝试编译里面的文件，又保证跑 `go test` 时当前工作目录固定设在**当前被测包所在的目录**，因此在测试里直接写相对路径 `"testdata/sample.json"` 在任何机器上都稳稳命中。

还要知道 `go test ./...`（指定包列表模式时）默认开启**测试结果缓存**：只要源码、编译器参数和测试实际读过的 `testdata` 文件及环境变量都没变，第二次跑会直接秒回 `(cached)`；排查偶发时序问题需要强制真跑一遍时，加上 **`-count=1`** 即可绕过缓存。

### 15.1.5 白盒测试与 `xxx_test` 黑盒测试包 {#ch15-1-5}

默认测试文件写 `package pubadder`（与被测代码同包），可以直接测包内小写未导出的辅助函数，属于白盒测试。如果你只想站在纯外部调用者的视角检验公开 API 好不好用、有没有漏导出关键类型，可以把测试文件首行改成 **`package pubadder_test`**——虽然文件还躺在同一个文件夹里，编译器却会把它当成一个完全独立的外部包编译，必须显式 `import` 被测包且只能访问大写导出符号：

```go
package pubadder_test

import (
	"testing"

	"example.com/project/pubadder"
)

func TestAddNumbers(t *testing.T) {
	if got := pubadder.AddNumbers(2, 3); got != 5 {
		t.Errorf("got %d, want 5", got)
	}
}
```

同一个目录下允许同时并存 `package foo` 和 `package foo_test` 两类测试文件。黑盒测试包还有一个实战妙用：**打破测试期的循环依赖**——当包 `a` 的测试需要借用包 `b` 里的测试辅助工具，而包 `b` 本身已经导入了包 `a` 时，把测试放进 `package a_test` 就能完美解开循环。

### 15.1.6 用 `go-cmp` 对比复杂结构体与容器 {#ch15-1-6}

测返回嵌套结构体、切片或映射的函数时，别再用老旧的 `reflect.DeepEqual`（一旦不等只能你自己把两边整坨 `%+v` 打出来肉眼找茬，还会把 `NaN != NaN` 等细节混在一起）。Google 开源的 `github.com/google/go-cmp/cmp` 是社区事实标准，`cmp.Diff(want, got)` 在相等时返回空字符串 `""`，不等时直接打出精确到字段路径的加减号 Diff：

```go
func TestCreatePerson(t *testing.T) {
	want := Person{Name: "Dennis", Age: 37}
	got := CreatePerson("Dennis", 37)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("CreatePerson mismatch (-want +got):\n%s", diff)
	}
}
```

用 `cmp.Diff` 留心两处默认严格行为：一是结构体如果含有未导出小写字段，直接 `cmp.Diff` 默认会拒绝比较并 `panic`（强迫你显式传入 `cmp.Comparer` 自定义比较器或 `cmpopts.IgnoreUnexported` 决定怎么比）；二是它默认严格区分 **`nil` 切片与非 `nil` 空切片 `[]T{}`**（如果业务上视二者等价，传入 `cmpopts.EquateEmpty()` 选项即可）。

## 15.2 表格驱动测试 {#ch15-2}

同一套被测函数往往要验证正常值、零值、边界值和好几种报错输入。复制粘贴十遍 `if got != want` 太难维护，Go 最地道的写法是**表格驱动测试（Table-Driven Tests）**：用匿名结构体切片把所有用例的“名字 + 输入 + 期望输出”列成一张表，循环里调 `t.Run(tc.name, ...)` 拆成独立命名的子测试（下例需导入 `"errors"` 与 `"fmt"`）：

```go
func DoMath(num1, num2 int, op string) (int, error) {
	switch op {
	case "+":
		return num1 + num2, nil
	case "-":
		return num1 - num2, nil
	case "*":
		return num1 * num2, nil
	case "/":
		if num2 == 0 {
			return 0, errors.New("division by zero")
		}
		return num1 / num2, nil
	default:
		return 0, fmt.Errorf("unknown operator %s", op)
	}
}

func TestDoMath(t *testing.T) {
	cases := []struct {
		name    string
		num1    int
		num2    int
		op      string
		want    int
		wantErr string
	}{
		{name: "addition", num1: 2, num2: 2, op: "+", want: 4},
		{name: "subtraction", num1: 2, num2: 2, op: "-", want: 0},
		{name: "multiplication", num1: 2, num2: 3, op: "*", want: 6},
		{name: "division", num1: 6, num2: 2, op: "/", want: 3},
		{name: "divide_by_zero", num1: 2, num2: 0, op: "/", wantErr: "division by zero"},
		{name: "unknown_op", num1: 2, num2: 2, op: "?", wantErr: "unknown operator ?"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DoMath(tc.num1, tc.num2, tc.op)
			if got != tc.want {
				t.Errorf("DoMath(%d, %d, %q) = %d, want %d", tc.num1, tc.num2, tc.op, got, tc.want)
			}
			var errMsg string
			if err != nil {
				errMsg = err.Error()
			}
			if errMsg != tc.wantErr {
				t.Errorf("DoMath error = %q, want %q", errMsg, tc.wantErr)
			}
		})
	}
}
```

用 `t.Run` 拆出子测试有两个立竿见影的好处：一是某个用例挂了输出会直接标明 `TestDoMath/divide_by_zero`，不用数第几行；二是调试时可以用 `-run` 正则只重跑那一条子测试：`go test -run ^TestDoMath$/^divide_by_zero$`。另外如果被测函数返回的是哨兵错误或自定义错误类型，表里的期望错误应存 `wantErr error` 并改用 `errors.Is` / `errors.AsType` 校验，别绑死易变的报错文案字符串。

## 15.3 并行测试与确定性并发测试 {#ch15-3}

只要测试之间不改任何包级全局变量、不抢同一个磁盘路径或端口，都可以在测试函数首行调 `t.Parallel()` 让它们并发跑。在表格驱动测试中要分清两层独立的控制粒度：**只需在每个 `t.Run` 子测试闭包内调用 `t.Parallel()`，就能让同一个父测试下的各个子测试彼此并发执行**（父测试跑完外层循环后会等待所有并行子测试收尾）；而在外层 `TestXxx` 首行调用 `t.Parallel()`，控制的则是 `TestXxx` 整体与同包内**其他顶层 `TestYyy` 函数**能否并发运行。

这里顺带回扣一下 [4.4.5 节](./chapter-04#ch4-4-5)：在 `go 1.21` 及更早语言版本的模块里，并行子测试 `t.Run` 会在外层 `for` 循环跑完后才真正并发启动，导致所有子测试闭包全都读到表格最后一行 `tc`（以前必须手动在循环里补一句 `tc := tc`）；自 **Go 1.22** 语言版本起，`for` 头部 `:=` 变量按轮独立创建，这个陈年大坑已经彻底成为历史。

如果被测代码本身包含复杂的定时器（`time.Sleep`、`context.WithTimeout`）与多 Goroutine 协调，靠真实墙上时钟 `Sleep` 测既慢又容易在负载高的 CI 机器上偶发抖动失败。自 **Go 1.25** 起，标准库正式提供了 **`"testing/synctest"`** 包：用 `synctest.Test(t, func(t *testing.T) { ... })` 把并发测试包进一个隔离“气泡（Bubble）”里，气泡内部自动接管虚拟时钟——只有当气泡内所有 Goroutine 都稳定阻塞在通道或定时器上时，虚拟时钟才会瞬间快进到下一个唤醒时刻，原本要等 5 秒超时的并发用例不到 1 毫秒就能确定性地跑完，调用 `synctest.Wait()` 还能精确卡住等后台协程全部跑到稳定阻塞点后再做断言。

## 15.4 检查代码覆盖率 {#ch15-4}

想知道哪些错误处理分支根本没测到，跑一遍带覆盖率导出的 `go test` 再用浏览器打开着色视图最直观：

```sh
$ go test -coverprofile=coverage.out ./...
$ go tool cover -html=coverage.out
```

绿字是跑过的语句，红字是从头到尾没进过的死角。但看覆盖率数字千万别犯迷信病：**没覆盖到的代码一定没测过，但 100% 覆盖率绝不等于逻辑没 Bug**！拿上一节的 `DoMath` 举例：倘若把 `case "*":` 里的乘号手滑写成了加号 `num1 + num2`，而你的乘法测试用例偏偏只写了一组 `2 * 2 = 4`，`2 + 2` 碰巧也等于 `4`——覆盖率漂漂亮亮 100%，Bug 却大摇大摆漏过去了。覆盖率只适合帮你找漏测分支，不能拿来给低质量断言背书。

## 15.5 模糊测试（Fuzzing） {#ch15-5}

人工写表格用例，永远只能测到你脑子里想得到的输入；面对解析器、编解码器、协议拆包这类接收外部不可信字节的代码，畸形截断、超长计数、负数长度、孤立回车符 `\r` 往往藏在思维盲区里。自 Go 1.18 起原生内置的**模糊测试（Fuzzing）**会拿你给的几条种子输入做覆盖率引导变异，自动喂进去成千上万组千奇百怪的输入看代码会不会 `panic` 或违背不变量。

假设有个数据解析函数 `ParseData(io.Reader) ([]string, error)` 和配套的反序列化函数 `ToData([]string) []byte`，模糊测试函数以 `Fuzz` 开头、接收 `f *testing.F`（下例另需导入 `"bytes"` 和 `"github.com/google/go-cmp/cmp"`）：

```go
func FuzzParseData(f *testing.F) {
	f.Add([]byte("3\nhello\ngoodbye\ngreetings\n"))
	f.Add([]byte("0\n"))

	f.Fuzz(func(t *testing.T, in []byte) {
		out, err := ParseData(bytes.NewReader(in))
		if err != nil {
			return // 正常识别出非法输入并返回 error 符合预期，直接跳过后续检查
		}
		roundTrip := ToData(out)
		out2, err := ParseData(bytes.NewReader(roundTrip))
		if err != nil {
			t.Fatalf("round-trip parse failed: %v", err)
		}
		if diff := cmp.Diff(out, out2); diff != "" {
			t.Errorf("round-trip mismatch (-first +second):\n%s", diff)
		}
	})
}
```

写模糊测试抓住三个要点：

1. **种子参数类型有限制**：`f.Add(...)` 只支持 `[]byte`、`string`、`bool`、各类整数/字符和浮点数，且 `f.Fuzz` 回调函数除首个 `*testing.T` 外的参数类型顺序必须与 `f.Add` 完全一致；
2. **靠“通用性质（Property）”做断言**：输入是随机变异出来的，你不可能预知标准答案是什么，所以断言写的是对一切合法输入都必须成立的定律——比如“非法输入只准返回 `error` 绝不准 `panic` 或把内存撑爆”“解析成功的数据编码回去再解析一遍，结果必须分毫不差（往返一致性）”；
3. **失败样本自动沉淀为回归测试**：平时直接跑 `go test ./...` 时，不会启动耗时费内存的变异引擎，而是只把 `f.Add` 的种子和历史失败样本像普通单测一样快速跑一遍；专门做模糊挖掘时加上 `-fuzz` 和时间上限：
   ```sh
   $ go test -fuzz=^FuzzParseData$ -fuzztime=30s
   ```
   一旦变异引擎抓到某组输入触发了 `panic` 或断言失败，会自动把输入缩减到最短复现形态写进 `testdata/fuzz/FuzzParseData/` 目录——把这份文件一起提交进 Git，以后每次普通 `go test` 都会永久回归防复发！

## 15.6 基准测试 {#ch15-6}

性能优化前先跑基准测试立下基线。基准函数放在 `_test.go` 里，以 `Benchmark` 开头、接收 `b *testing.B`。自 **Go 1.24** 起，循环统一使用 **`for b.Loop()`**（它会自动在首次进入循环时重置计时器、排除前置准备耗时，并阻止编译器把被测调用当死代码消除掉；兼容 Go 1.23 及更早版本时则写 `for i := 0; i < b.N; i++` 并将结果赋给包级导出或未导出黑洞变量）：

```go
func BenchmarkFileLen(b *testing.B) {
	for _, bufSize := range []int{64, 1024, 4096, 32768} {
		b.Run(fmt.Sprintf("buf=%d", bufSize), func(b *testing.B) {
			for b.Loop() {
				_, err := FileLen("testdata/data.txt", bufSize)
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
```

默认 `go test` 不跑基准测试，需显式加 `-bench`（通常搭配 `-run=^$` 跳过普通单元测试，加 `-benchmem` 一并查看堆内存分配）：

```sh
$ go test -run=^$ -bench=^BenchmarkFileLen$ -benchmem
```

输出的五列核心数据依次是：`基准名称-CPU核数`、`循环总跑次数`、`ns/op（单次耗时）`、`B/op（单次分配字节数）` 和 `allocs/op（单次堆分配次数）`。优化前后可以把两份输出交给官方工具 `golang.org/x/perf/cmd/benchstat` 做统计显著性比对，确认真变快了而不是机器风扇抖动；遇到耗时或分配异常高时，再加 `-cpuprofile=cpu.out` / `-memprofile=mem.out` 用 `go tool pprof` 打开火焰图精准捉虫。

## 15.7 用小接口与函数字段写测试桩 {#ch15-7}

当被测业务逻辑依赖外部数据库或第三方服务时，[第 7 章](./chapter-07#ch7-5-1)讲过的“消费端最小接口”立刻就能兑现收益——接口只有一两个方法时，随手在测试文件里写几行测试桩（Stub）比引任何重型 Mock 框架都清爽：

```go
type MathSolver interface {
	Resolve(ctx context.Context, expression string) (float64, error)
}

type solverStub struct {
	resolveFn func(ctx context.Context, expression string) (float64, error)
}

func (s solverStub) Resolve(ctx context.Context, expr string) (float64, error) {
	return s.resolveFn(ctx, expr)
}
```

注意上面这种**“结构体包同签名函数字段”**的写法极其顺手：哪怕接口有三四个方法，也只需要定义这一个桩结构体，表格驱动测试的每一行用例直接往 `resolveFn` 里塞不同的匿名闭包（第一行模拟正常返回 `22`，第二行模拟返回超时错误，第三行顺手校验传进来的 `expr` 字符串对不对），连按场景建一堆 `successStub`、`errorStub` 类型都省了。

万一接手老代码撞上了一个包含十几个方法的庞大接口，当前测试其实只调其中 1 个方法，可以在桩结构体里**匿名内嵌那个接口本身**（`type bigStub struct { BigInterface }`），然后只实现用到的那 1 个方法即可通过编译——不过记得内嵌接口字段零值是 `nil`，一旦被测代码意外调到了没实现的方法，运行期会立刻空指针 `panic`。

## 15.8 用 `httptest` 测试 HTTP 客户端与服务端 {#ch15-8}

测 HTTP 相关代码千万别去连公网地址，标准库 `"net/http/httptest"` 把出站客户端和入站 Handler 两头的本地测试全包圆了：

- **测入站 `http.Handler`（连端口都不用开）**：用 `httptest.NewRequest` 造一个内存请求、用 `httptest.NewRecorder()` 接住写回的状态码与响应体，直接调 `handler.ServeHTTP(rec, req)`，微秒级就能跑完：
  ```go
  req := httptest.NewRequest(http.MethodGet, "/hello/Ada", nil)
  rec := httptest.NewRecorder()
  mux.ServeHTTP(rec, req)

  res := rec.Result()
  defer res.Body.Close()
  // 断言 res.StatusCode 与 rec.Body.String()
  ```
- **测出站 HTTP 客户端代码（走真实本地回环 TCP 协议栈）**：用 `httptest.NewServer(handler)` 在本机随机空闲端口拉起一个真 HTTP 服务（自 **Go 1.27** 起还可直接调 `httptest.NewTestServer(t, handler)`，自动把 `Close()` 挂进 `t.Cleanup`！），再把 `srv.URL` 和 `srv.Client()` 注入你的客户端结构体：

```go
func TestRemoteSolver(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("expression"); got != "2+2" {
			http.Error(w, "unexpected expression: "+got, http.StatusBadRequest)
			return
		}
		w.Write([]byte("4"))
	}))
	defer srv.Close() // Go 1.27+ 若用 httptest.NewTestServer(t, ...) 可省去手动 defer

	solver := RemoteSolver{BaseURL: srv.URL, Client: srv.Client()}
	got, err := solver.Resolve(t.Context(), "2+2")
	if err != nil || got != 4 {
		t.Fatalf("got (%v, %v), want (4, nil)", got, err)
	}
}
```

## 15.9 用构建约束隔离集成测试 {#ch15-9}

`httptest` 只能验证“你的代码符合你想象中的下游协议”；要确认跟真实 PostgreSQL、Redis 或第三方沙箱真的对得上，还是得有一批连真实外部实例的**集成测试**。因为集成测试慢且依赖外部环境就绪，不能让每次日常敲 `go test ./...` 都卡在上面，最清楚的隔离办法是在集成测试文件顶部加自定义[构建约束](./chapter-11#ch11-9-3)（注意下方留空行）：

```go
//go:build integration

package storage_test
```

平时本地秒跑 `go test ./...` 时完全跳过它们；在配好容器环境的 CI 阶段显式带上标签即可全量跑通：

```sh
$ go test -tags=integration -v ./...
```

相比仅靠 `if testing.Short() { t.Skip(...) }` 切一刀快慢，构建标签支持按依赖种类细分成 `db_integration`、`s3_integration` 等多组，环境没起对应服务时连编译都不会混进来。

## 15.10 数据竞争检测器（`-race`） {#ch15-10}

只要有两个及以上 Goroutine 访问同一个变量，其中至少一个是写操作，且中间没有任何通道、锁或原子操作建立同步偏序，就构成了**数据竞争（Data Race）**。比如下面这段五个协程无锁并发给同一个 `counter` 自增 1000 次的代码，每次跑出来的数字都可能小于 `5000`（在更复杂的切片/映射/接口并发改写下还会直接把内存写花崩溃）：

```go
func brokenCounter() int {
	var counter int
	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			for range 1000 {
				counter++
			}
		})
	}
	wg.Wait()
	return counter
}
```

肉眼审代码很容易漏掉深层回调里的共享读写，跑测试时加上 **`-race`** 标志即可启用编译器插桩的数据竞争检测器（注意在 Windows 等平台上 `-race` 依赖 Cgo，需装有 MinGW-w64 等 C 工具链且 `CGO_ENABLED=1`）：

```sh
$ go test -race ./...
```

一旦运行期间真实撞上无同步冲突访问，终端会立刻打出 `WARNING: DATA RACE`，把“哪一行在写、由哪一行启动的协程”和“哪一行在读、由哪一行启动的协程”两边完整调用栈并排摆在你面前。记住关于 `-race` 的三条铁律：

1. **零误报**：只要 `-race` 报了告警，100% 是真数据竞争，必须加互斥锁、改通道传递或换 `sync/atomic` 修掉，**绝对不要靠塞一句 `time.Sleep` 把时间错开自欺欺人**；
2. **只抓本次运行实际走到的路径**：它是运行期动态检测而非编译期全路径证明，测试用例得真的并发触发到那条代码路径才抓得住；
3. **CI 必开**：开启 `-race` 会让 CPU 慢约 2～10 倍、内存涨约 5～10 倍，因此通常不直接上全量生产流量，但本地并发包测试与 CI 流水线应当默认常开 `go test -race ./...`。

## 练习 {#ch15-exercises}

以下三题分别动手实践表格驱动测试捉虫、`-race` 数据竞争检测与修复，以及基于往返性质的模糊测试。建议先独立编写并本地运行 `go test`，再展开核对参考答案。

### 练习 1：用表格驱动测试抓出切片预分配 Bug

下面的 `DoubleOdd` 意图过滤出输入切片里的全部奇数并将其乘以 `2` 返回。为它编写覆盖全偶数、全奇数、奇偶混合与空切片的表格驱动单元测试，定位其中的隐藏 Bug 并修复。

```go
func DoubleOdd(nums []int) []int {
	out := make([]int, len(nums))
	for _, n := range nums {
		if n%2 != 0 {
			out = append(out, n*2)
		}
	}
	return out
}
```

<details>
<summary>查看参考答案</summary>

使用标准库 `"slices"`（或 `go-cmp`）编写表格驱动测试：

```go
func TestDoubleOdd(t *testing.T) {
	cases := []struct {
		name string
		in   []int
		want []int
	}{
		{name: "all_even", in: []int{2, 4}, want: nil},
		{name: "all_odd", in: []int{1, 3, -5}, want: []int{2, 6, -10}},
		{name: "mixed", in: []int{1, 2, 5}, want: []int{2, 10}},
		{name: "empty", in: nil, want: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DoubleOdd(tc.in)
			if !slices.Equal(got, tc.want) {
				t.Errorf("DoubleOdd(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
```

跑测试立刻现原形：`DoubleOdd([]int{1, 2, 5})` 返回的是 `[0 0 0 2 10]`！这正是 [3.2.2 节](./chapter-03#ch3-2-2)强调过的典型失误——`make([]int, len(nums))` 把初始**长度 `len`** 设成了 `3`，先塞了 3 个 `0`，后面的 `append` 全排在了 3 个 `0` 尾巴后面。把长度改为 `0`、容量预留为 `len(nums)` 即可修复（同时注意 `-5 % 2 == -1 != 0`，写 `n%2 != 0` 比写 `n%2 == 1` 还能正确兼容负奇数！）：

```go
func DoubleOdd(nums []int) []int {
	out := make([]int, 0, len(nums))
	for _, n := range nums {
		if n%2 != 0 {
			out = append(out, n*2)
		}
	}
	return out
}
```

（若断言改用 `cmp.Diff(tc.want, got)`，记得 `make([]int, 0, ...)` 返回非 `nil` 空切片 `[]int{}`，表里的空期望值应同步写成 `[]int{}` 或传入 `cmpopts.EquateEmpty()`。）

</details>

### 练习 2：用 `-race` 复现并修复并发计数器竞争

为 [15.10 节](#ch15-10)的 `brokenCounter` 写一个单元测试，先运行 `go test -race` 观察告警，再用互斥锁（或 `atomic.Int64`）将其修复，确认 `go test -race -count=10` 稳定通过且返回 `5000`。

<details>
<summary>查看参考答案</summary>

使用 `sync.Mutex` 修复如下（也可直接将 `counter` 换为 `var counter atomic.Int64` 并调 `counter.Add(1)`）：

```go
func safeCounter() int {
	var (
		mu      sync.Mutex
		counter int
		wg      sync.WaitGroup
	)
	for range 5 {
		wg.Go(func() {
			for range 1000 {
				mu.Lock()
				counter++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	return counter
}

func TestSafeCounter(t *testing.T) {
	if got := safeCounter(); got != 5000 {
		t.Fatalf("got %d, want 5000", got)
	}
}
```

运行 `go test -race -count=10 -run ^TestSafeCounter$` 验证：不加 `-race` 只看 `got == 5000` 可能在小并发量下侥幸蒙混过关，加上 `-race` 才能从内存访问偏序层面确认彻底消除了数据竞争。

</details>

### 练习 3：为单词逆序函数编写性质模糊测试

实现 `ReverseWords(s string) string`（按空白字符切分单词，将单词顺序倒排后用单个空格连接返回），并编写模糊测试 `FuzzReverseWords` 验证对任意随机输入字符串都成立的对合性质：“连续反转两次的结果，恒等于把原字符串按空白分词后再用单空格拼接的结果”。

<details>
<summary>查看参考答案</summary>

需导入标准库 `"slices"` 与 `"strings"`：

```go
func ReverseWords(s string) string {
	words := strings.Fields(s)
	slices.Reverse(words) // Go 1.21+ 标准库原地反转切片
	return strings.Join(words, " ")
}

func FuzzReverseWords(f *testing.F) {
	f.Add("the quick brown fox")
	f.Add("  leading   and\ttrailing\n")
	f.Add("")

	f.Fuzz(func(t *testing.T, s string) {
		once := ReverseWords(s)
		twice := ReverseWords(once)
		normalized := strings.Join(strings.Fields(s), " ")
		if twice != normalized {
			t.Errorf("involution broken for %q: once=%q twice=%q want=%q", s, once, twice, normalized)
		}
	})
}
```

运行 `go test -fuzz=^FuzzReverseWords$ -fuzztime=10s`：变异引擎会自动构造包含多字节 UTF-8 字符、制表符、换行符甚至非法 UTF-8 字节序列的字符串喂给 `ReverseWords`，检验它既不会越界崩溃，也不会在空白归一化和顺序翻转中丢字。

</details>

## 面试题 {#ch15-interview}

以下四题分别考察 `Error` 与 `Fatal` 的适用边界、同包测试与 `_test` 包的差异、`t.Setenv` 的并发禁令以及 `-race` 检测器的原理与局限。建议先独立作答，再展开核对参考答案。

### 面试题 1：测试里什么时候用 `t.Errorf`，什么时候用 `t.Fatalf`？能在子 Goroutine 里调 `t.Fatalf` 吗？

<details>
<summary>查看参考答案</summary>

多项断言彼此独立（如核对返回结构体的多个字段）时用 `t.Errorf`，跑一次就能把所有不匹配的字段全报出来；当前置条件已失败（如 `err != nil` 或返回指针为 `nil`）、继续往下跑只会空指针崩溃或报一串假错时，用 `t.Fatalf` 立即中止当前测试函数。

**不能在测试自己启动的子 Goroutine 里调 `t.Fatalf`**（及 `t.FailNow`、`t.SkipNow`）：它底层调用 `runtime.Goexit()`，只会终止子协程自身而无法立刻停掉主测试协程，违背测试框架契约（`go vet` 会直接拦截报错）；子协程内应改调 `t.Errorf` 或把错误通过通道发回主测试协程再 `t.Fatalf`。

</details>

### 面试题 2：同一目录下的 `package order` 测试文件与 `package order_test` 测试文件有什么区别？

<details>
<summary>查看参考答案</summary>

- `package order` 与生产代码同包编译（白盒测试），可以直接访问包内未导出的辅助函数与私有字段；
- `package order_test` 作为独立的外部测试包编译（黑盒测试），必须显式 `import` `order` 包且只能调用导出 API，既能检验公开接口设计是否自洽好用，又能在测试需要引入反向依赖 `order` 的辅助包时打破导入循环。

</details>

### 面试题 3：为什么同一个测试里同时调用 `t.Setenv` 和 `t.Parallel` 会直接触发 `panic`？

<details>
<summary>查看参考答案</summary>

进程环境变量属于整个操作系统进程共享的全局可变状态，无法按单个 Goroutine 隔离。如果一个并行测试改了环境变量并在结束时还原，同时在跑的其他并行测试就会读到被篡改的脏值，因此 `testing` 框架在运行期直接禁止 `t.Setenv`（以及切换工作目录的 `t.Chdir`）与 `t.Parallel()` 混用。想让测试支持并行，应把环境变量在程序入口解析成配置参数注入业务函数，而不是在业务代码深处直接调 `os.Getenv`。

</details>

### 面试题 4：`go test -race` 跑过了是不是就证明代码里绝对没有数据竞争？为什么线上一般不开它？

<details>
<summary>查看参考答案</summary>

**不能百分百证明绝对没有竞争**。`-race` 基于编译期内存读写插桩与运行期逻辑时钟（Vector Clock）追踪，属于动态检测：只要它报出了告警，就一定是真实存在的数据竞争（无误报）；但如果某条带竞争的分支在本次测试运行期间压根没被执行到，或者两个协程没有在同一次运行中接触同一内存位置，就不会触发报告。

开启 `-race` 后 CPU 开销约增大 2～10 倍、内存占用增大约 5～10 倍，因此适合在本地测试、CI 流水线或极少数灰度排障实例上开启，不作为常规全量生产编译参数。

</details>

## 参考资料

- [Go 标准库 `testing`：单元、基准（含 `B.Loop` 与 `T.Context`）及模糊测试](https://pkg.go.dev/testing)
- [Go 标准库 `testing/synctest`：确定性并发与虚拟时钟测试（Go 1.25+）](https://pkg.go.dev/testing/synctest)
- [Go 命令文档：`go test` 标志与缓存规则](https://pkg.go.dev/cmd/go#hdr-Testing_flags)
- [Go 官方指南：Go Fuzzing 模糊测试教程](https://go.dev/security/fuzz/)
- [Go 标准库 `net/http/httptest`：HTTP 客户端与服务端测试工具](https://pkg.go.dev/net/http/httptest)
- [Go 官方文档：Data Race Detector 数据竞争检测器](https://go.dev/doc/articles/race_detector)
- [`github.com/google/go-cmp/cmp`：结构体与容器差异比对](https://pkg.go.dev/github.com/google/go-cmp/cmp)
