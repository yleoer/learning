---
title: 第 9 章 错误处理
description: 掌握 Go“错误即值”的构造、包装与解包检查机制，厘清哨兵错误、自定义错误类型以及 panic 与 recover 的边界。
---

# 第 9 章 错误处理

## 本章要点

Go 没有 `try/catch` 异常捕获流，而是把错误当作普通值放到函数返回值列表的最后一位显式传递：无错时返回 `nil`，出错时返回实现了 `error` 接口的值。本章顺着错误在调用栈中的一生展开——如何用 `errors.New`、`fmt.Errorf`、哨兵错误和自定义结构体表达失败原因，如何避开有类型 `nil` 错误返回陷阱，如何用 `%w` 与 `errors.Join` 保留上下文错误树，如何用 `errors.Is`、`errors.As` 和 Go 1.26 新增的泛型 `errors.AsType` 穿透包装链做判断，最后划清 `panic`/`recover` 与常规错误处理的职责边界。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 9.1 错误即值 {#ch9-1}

除另有说明外，本章正文中的类型、变量与函数声明位于包级作用域，调用语句位于函数体内，省略外层 `package main` 与 `import` 声明；`fmt`、`errors`、`os` 分别对应标准库 `"fmt"`、`"errors"`、`"os"`，其余包在首次出现处注明导入路径。

在 Go 中，可能失败的函数按惯例把 `error` 放在返回值列表的最后一位。成功时返回 `nil`，失败时返回具体错误，调用方紧跟一句 `if err != nil` 先拦截异常分支：

```go
func calcDivAndMod(numerator, denominator int) (int, int, error) {
	if denominator == 0 {
		return 0, 0, errors.New("denominator is 0")
	}
	return numerator / denominator, numerator % denominator, nil
}

quotient, remainder, err := calcDivAndMod(20, 3)
if err != nil {
	fmt.Println(err)
	os.Exit(1)
}
fmt.Println(quotient, remainder) // 6 2
```

`error` 本身并不是什么特殊运行时魔术，它只是宇宙块里预声明的一个单方法接口；`nil` 能代表“没有错误”，正是因为接口类型的零值是 `nil`：

```go
type error interface {
	Error() string
}
```

写错误处理代码有三条常用的日常惯例：

- **常规函数在返回非 `nil` 错误时，其余返回值默认填对应类型的零值**，避免调用方在未区分部分成功语义时误读半成品数据。不过这不是没有例外的死规矩：凡是需要报告“出错前已完成进度”或“越界截断值”的 API——例如 `io.Reader.Read`、`io.Writer.Write`、`io.Copy` 会同时返回已读写的字节数与错误，`strconv.ParseInt` 在数值溢出时会返回对应位宽的极值与 `strconv.ErrRange`——都会在非 `nil` 错误旁附带有效返回值，实现与调用时应以具体函数的文档契约为准。
- **错误文本用小写字母开头，末尾不加句号和换行符**（专有名词、首字母缩略词开头除外）：因为错误往上传递时经常被拼成 `"in loadConfig: open app.yaml: file does not exist"` 这样的长链条，小写短语拼起来最自然。
- **错误分支缩进在 `if` 里提前返回，正常主干逻辑保持左对齐**，一眼就能顺着左边读完正常流程。

相比隐式抛异常跳转，显式返回 `error` 把每一处可能失败的调用都摆在了明面上；再加上编译器强制每个局部变量至少被读取一次（见 [2.7 节](./chapter-02#ch2-7)），逼着调用者要么检查 `err`、要么显式写 `_` 承认自己忽略了它。不过记得一个盲区：如果同一个 `err` 变量被连续两次赋值，只检查第二次而漏掉了第一次，编译器是不会报错的——这类漏检要靠 `staticcheck`（`SA4006`）或 `ineffassign` 抓出来（见 [11.4 节](./chapter-11#ch11-4)）。

## 9.2 构造简单错误 {#ch9-2}

只需要一段文字说明失败原因时，标准库提供了两个入口：固定文本用 `errors.New`，需要把运行期变量拼进消息时用 `fmt.Errorf`：

```go
func doubleEven(i int) (int, error) {
	if i%2 != 0 {
		return 0, fmt.Errorf("%d isn't an even number", i)
	}
	return i * 2, nil
}

_, err := doubleEven(3)
fmt.Println(err) // 3 isn't an even number
```

`fmt.Println`、`fmt.Sprintf` 发现参数满足 `error` 接口时，会自动调用它的 `Error()` 方法取出字符串；在线上服务里配合结构化日志 `"log/slog"` 记录错误上下文的做法见 [13.5 节](./chapter-13#ch13-5)。

## 9.3 哨兵错误 {#ch9-3}

如果调用方需要根据“特定的某种失败状态”走不同恢复分支（而不只是把消息打进日志），包作者可以导出一个包级错误变量，称为**哨兵错误（Sentinel Error）**。按惯例哨兵错误一律以 `Err` 开头（历史悠久的 `io.EOF` 是少数例外），例如标准库 `"archive/zip"` 的 `zip.ErrFormat`、`"os"` 的 `os.ErrNotExist` 以及 `"context"` 的 `context.Canceled`。

调用方拿到错误后，用 `errors.Is` 与哨兵错误比对（下例另需导入标准库 `"bytes"`）：

```go
data := []byte("This is not a zip file")
_, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
if errors.Is(err, zip.ErrFormat) {
	fmt.Println("not a valid zip archive")
}
```

（即便文档说明某函数直接返回未包装的哨兵错误、写 `err == zip.ErrFormat` 也能工作，日常也应养成统一写 `errors.Is` 的习惯，以免日后下游补了一层错误包装就导致 `==` 失灵。）

定义导出哨兵错误前要谨慎：一旦对外发布，它就成了包公开契约的一部分，调用方会写死对它的分支判断，后续小版本不能随便删改；如果标准库已经有语义贴切的哨兵错误（比如 `os.ErrNotExist`、`io.ErrUnexpectedEOF`），优先直接复用。同时，包级 `var ErrXxx = errors.New(...)` 在语法上没法标成只读，千万别在任何代码里改写它的值。

你可能会见过一种用字符串定义类型造“**常量哨兵错误**”的写法：

```go
type Sentinel string

func (s Sentinel) Error() string { return string(s) }

const (
	ErrFoo = Sentinel("foo error")
	ErrBar = Sentinel("bar error")
)
```

虽然 `const` 堵死了被意外重新赋值的可能，但因为字符串按内容判等，两个不同模块如果各自用这套手法定义了内容同为 `"not found"` 的常量错误（若共用同一底层字符串错误类型），它们做 `==` 时就会撞车相等。相比之下，标准库 `errors.New("not found")` 每次调用都会返回指向**新分配结构体实例的指针**——哪怕提示文字一字不差，两次 `errors.New` 造出来的错误也绝不相等。因此社区主流依然坚持 `var ErrXxx = errors.New(...)`。

## 9.4 自定义错误类型 {#ch9-4}

当调用方除了知道“出错了”，还需要读取错误码、失败字段名、重试等待时长等结构化信息时，就该自己定义一个实现 `error` 接口的结构体了：

```go
type Status int

const (
	InvalidLogin Status = iota + 1
	NotFound
)

type StatusErr struct {
	Status  Status
	Message string
}

func (se StatusErr) Error() string {
	return se.Message
}

func LoginAndGetData(uid, pwd, file string) ([]byte, error) {
	token, err := login(uid, pwd)
	if err != nil {
		return nil, StatusErr{
			Status:  InvalidLogin,
			Message: fmt.Sprintf("invalid credentials for user %s", uid),
		}
	}
	data, err := getData(token, file)
	if err != nil {
		return nil, StatusErr{
			Status:  NotFound,
			Message: fmt.Sprintf("file %s not found", file),
		}
	}
	return data, nil
}
```

写自定义错误类型必须守住两条铁律：

1. **函数签名的返回类型永远写 `error` 接口，绝不要写成具体的 `StatusErr` 或 `*StatusErr`**：否则不仅锁死了函数将来返回其他错误的自由，还会把下面的非空接口大坑直接传染给调用方。
2. **不要先声明具体错误类型的局部变量、最后不管三七二十一直接 `return` 它**：

```go
func GenerateErrorBroken(flag bool) error {
	var genErr *StatusErr
	if flag {
		genErr = &StatusErr{Status: NotFound}
	}
	return genErr
}

err := GenerateErrorBroken(false)
fmt.Println(err != nil) // true！明明没出错，err != nil 却是 true
```

不管这里把 `genErr` 声明成指针 `*StatusErr`（返回有类型 `nil`，内部为 `(*StatusErr, nil)`）还是声明成值类型 `StatusErr`（返回装箱后的零值结构体 `(StatusErr, StatusErr{})`），一旦装进 `error` 接口，接口的动态类型槽位就非空，`err != nil` 永远为 `true`（见 [7.6.1 节](./chapter-07#ch7-6-1)）。正确写法只有两种——最简单直接的是在成功路径**显式写 `return nil`**；确实需要用变量跨分支暂存时，把局部变量本身声明为 `error` 接口类型：

```go
func GenerateErrorOK(flag bool) error {
	if flag {
		return StatusErr{Status: NotFound}
	}
	return nil
}

func GenerateErrorWithVar(flag bool) error {
	var genErr error // 接口零值保持 (nil, nil)
	if flag {
		genErr = StatusErr{Status: NotFound}
	}
	return genErr
}
```

## 9.5 包装错误 {#ch9-5}

错误顺着调用栈一路往上传时，如果每层都原样 `return err`，顶层日志只剩一句干巴巴的 `"connection refused"`，根本看不出是查用户还是扣库存连不上；如果每层都用 `errors.New` 换一个新错误，底下真正的根因又丢了。把“补充当前层上下文”和“保留底层原错误”合二为一的做法，就是**错误包装（Error Wrapping）**。

最常用的是 `fmt.Errorf` 里的 `%w` 占位符：它既把原错误文本拼进新消息，又把原错误实例挂在新错误内部形成一条包装链：

```go
func fileChecker(name string) error {
	f, err := os.Open(name)
	if err != nil {
		return fmt.Errorf("in fileChecker: %w", err)
	}
	f.Close()
	return nil
}

err := fileChecker("not_here.txt")
fmt.Println(err)                // in fileChecker: open not_here.txt: ...
fmt.Println(errors.Unwrap(err)) // open not_here.txt: ...
```

`errors.Unwrap` 会剥出一层直接内嵌的错误（没有包装时返回 `nil`），但日常业务代码几乎不用手动调它——穿透整条链做判断请统一交给 [9.7 节](#ch9-7)的 `errors.Is` / `errors.As` / `errors.AsType`。

自定义错误结构体如果想把底层错误包进来，只需多加一个 `Unwrap() error` 方法：

```go
type StatusErr struct {
	Status  Status
	Message string
	Err     error
}

func (se StatusErr) Error() string  { return se.Message }
func (se StatusErr) Unwrap() error { return se.Err }
```

注意：**不是所有底层错误都应该用 `%w` 暴露出去**。一旦用了 `%w`，被包在里面的底层错误类型和哨兵值就相当于间接成了你对外行为的一部分；如果那只是你包内部选用的第三方驱动实现细节、不希望调用方绑定在上面，就改用 **`%v`**：

```go
return fmt.Errorf("storage unavailable: %v", err)
```

一句话分清两者：**`%w` 保留因果链供上层解包检查，`%v` 只借用错误文本并切断解包链**。

## 9.6 包装多个错误 {#ch9-6}

有些场景一次调用会攒出好几个并列错误（比如表单批量校验、并发子任务收尾，或者主操作失败后连 `Close()` 也报错），但函数签名只返回一个 `error`。自 Go 1.20 起，标准库提供了 `errors.Join`，把一批错误合并成一个多分支错误树（用换行符连接各条错误文本，自动忽略其中的 `nil` 元素；若传入的全是 `nil` 或空切片则直接返回 `nil`）：

```go
func ValidatePerson(p Person) error {
	var errs []error
	if p.FirstName == "" {
		errs = append(errs, errors.New("field FirstName cannot be empty"))
	}
	if p.LastName == "" {
		errs = append(errs, errors.New("field LastName cannot be empty"))
	}
	if p.Age < 0 {
		errs = append(errs, errors.New("field Age cannot be negative"))
	}
	return errors.Join(errs...)
}
```

同样自 Go 1.20 起，单条 `fmt.Errorf` 里也允许同时写多个 `%w`：

```go
err := fmt.Errorf("write failed: %w; close failed: %w", writeErr, closeErr)
```

自定义错误类型如果想一次性包裹多个子错误，只需实现返回切片的 `Unwrap() []error` 方法即可。实现时务必守住两处边界：一是 `errors.Join` 在没有非 `nil` 子错误时会直接返回 `nil`，`Error()` 方法不能不加判空就链式调 `.Error()`；二是按照标准库 `"errors"` 的包装契约，**`Unwrap() []error` 返回的切片中绝不能包含值为 `nil` 的元素**，必须先把 `nil` 过滤干净：

```go
type MultiError struct {
	Code   int
	Errors []error
}

func (m MultiError) Error() string {
	if joined := errors.Join(m.Errors...); joined != nil {
		return joined.Error()
	}
	return fmt.Sprintf("error code %d", m.Code)
}

func (m MultiError) Unwrap() []error {
	var out []error
	for _, err := range m.Errors {
		if err != nil {
			out = append(out, err)
		}
	}
	return out
}
```

注意一个细节：单链包装实现的是 `Unwrap() error`，多路包装实现的是 `Unwrap() []error`；对后者调用 `errors.Unwrap(err)` 会直接返回 **`nil`**！而 `errors.Is`、`errors.As` 与 `errors.AsType` 则会自动按前序深度优先遍历这两种 `Unwrap` 拼出来的整棵错误树。如果真要自己手写代码逐个列出直接子错误，可以用匿名接口做 `type switch`：

```go
switch u := err.(type) {
case interface{ Unwrap() error }:
	inner := u.Unwrap()
	_ = inner
case interface{ Unwrap() []error }:
	for _, inner := range u.Unwrap() {
		_ = inner
	}
}
```

## 9.7 `errors.Is`、`errors.As` 与 `errors.AsType` {#ch9-7}

只要错误经过了包装，直接写 `err == target` 或 `err.(MyErr)` 就会立刻失效。标准库针对“查特定值”和“取特定类型”分别给出了配套函数。

### 9.7.1 用 `errors.Is` 匹配特定错误值 {#ch9-7-1}

`errors.Is(err, target)` 沿着错误树逐节点检查：只要某一层与 `target` 用 `==` 比较相等（前提是该层动态类型可比较），或者该层自定义实现的 `Is(error) bool` 方法返回 `true`，整体就返回 `true`：

```go
err := fileChecker("not_here.txt")
if errors.Is(err, os.ErrNotExist) {
	fmt.Println("file does not exist")
}
```

当自定义错误类型内部含有切片等不可比较字段，或者你想支持“按部分字段通配匹配”时，可以给错误类型实现 `Is(target error) bool` 方法：

```go
type ResourceErr struct {
	Resource string
	Code     int
}

func (re ResourceErr) Error() string {
	return fmt.Sprintf("%s: %d", re.Resource, re.Code)
}

func (re ResourceErr) Is(target error) bool {
	other, ok := target.(ResourceErr)
	if !ok {
		return false
	}
	matchResource := other.Resource == "" || other.Resource == re.Resource
	matchCode := other.Code == 0 || other.Code == re.Code
	return matchResource && matchCode && (other.Resource != "" || other.Code != 0)
}

// 忽略具体状态码，只要是 Database 资源报错就命中：
if errors.Is(err, ResourceErr{Resource: "Database"}) {
	fmt.Println("database fault:", err)
}
```

### 9.7.2 用 `errors.AsType` 或 `errors.As` 提取错误类型 {#ch9-7-2}

想从错误树里找出第一个属于某具体错误类型（或满足某接口）的节点并读它的字段时，有两种写法：

- **Go 1.26+ 推荐优先用泛型 `errors.AsType[E](err)`**：直接返回 `(E, bool)`，无需预先声明目标变量，编译期就能校验 `E` 必须实现 `error` 接口，也不会因为传错指针而运行期崩溃：
  ```go
  if statusErr, ok := errors.AsType[StatusErr](err); ok {
  	fmt.Println(statusErr.Status)
  }
  ```
- **兼容全版本（Go 1.13+）用 `errors.As(err, &target)`**：先声明目标错误类型或目标接口的零值变量，再把**它的非空指针 `&target`** 传进去；命中时 `target` 被就地赋值并返回 `true`：
  ```go
  var statusErr StatusErr
  if errors.As(err, &statusErr) {
  	fmt.Println(statusErr.Status)
  }

  // 目标同样可以是某个行为接口：
  var temporary interface{ Temporary() bool }
  if errors.As(err, &temporary) {
  	fmt.Println(temporary.Temporary())
  }
  ```

用 `errors.As` 时千万别漏写 `&`：它的第二个参数类型是 `any`，如果传了非指针、空指针或指向未实现 `error` 类型的指针，运行期会直接 `panic`（好在 `go vet` 默认开启的 `errorsas` 检查器能在静态阶段揪出绝大部分误传）。记住一句话就行：**比对已知错误实例用 `Is`，提取具体错误类型读字段用 `AsType`（或 `As`）**。

## 9.8 用 `defer` 统一包装错误 {#ch9-8}

如果一个函数里有四五步顺序调用，每一步出错时都要补上同一个函数名前缀（如 `"in DoSomeThings: %w"`），到处手写一模一样的 `fmt.Errorf` 既啰嗦又容易漏。这时可以结合 [5.4.1 节](./chapter-05#ch5-4-1)讲过的**具名返回值 + `defer` 闭包**，在函数出口统一包一层：

```go
func DoSomeThings(val1 int, val2 string) (_ string, err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("in DoSomeThings: %w", err)
		}
	}()

	val3, err := doThing1(val1)
	if err != nil {
		return "", err
	}
	val4, err := doThing2(val2)
	if err != nil {
		return "", err
	}
	return doThing3(val3, val4)
}
```

只要返回值列表给其中一个起了名字，其余返回值也必须写名字，不需要引用的字符串返回值用空白标识符 `_` 占位即可。这个技巧只适合“整个函数共用同一句外层上下文”的情况；如果不同分支需要把各自不同的局部参数拼进报错信息里，还是老老实实在各分支就地写 `fmt.Errorf` 更清楚。

## 9.9 `panic` 与 `recover` {#ch9-9}

`panic` 代表程序撞上了“当前逻辑根本不知道该怎么往下走”的致命错误——要么是数组/切片下标越界、空指针解引用、向已关闭通道写入这类**纯代码 Bug**，要么是启动期必需的静态配置或不变式彻底损坏。

一旦某处触发 `panic`，当前函数会立刻停止往下执行，按后进先出顺序跑完当前栈帧已登记的 `defer`，再一层层往外展开当前 Goroutine 的调用栈并依次运行沿途的 `defer`。如果一直退到该 Goroutine 的入口函数都没被拦截，整个进程就会打印出 `panic` 值与完整调用栈并直接退出——注意**一个 Goroutine 里的 `panic` 绝不可能在另一个 Goroutine（包括 `main`）里被捕获**（见 [12.2 节](./chapter-12#ch12-2)）。

唯一能拦住 `panic` 继续蔓延的内置函数是 `recover()`，而且它**只有在被 `defer` 直接调用的函数体内执行时才有效**：

```go
func div60(i int) {
	defer func() {
		if v := recover(); v != nil {
			fmt.Println("recovered:", v)
		}
	}()
	fmt.Println(60 / i)
}

for _, val := range []int{1, 2, 0, 6} {
	div60(val)
}
// 依次输出：60、30、recovered: runtime error: integer divide by zero、10
```

这里顺带记一个 Go 1.21 修补好的历史坑：在 Go 1.20 及更早版本中，如果有人写了 `panic(nil)`，延迟函数里的 `recover()` 虽然把 `panic` 吞掉了，返回值却是 `nil`，跟“压根没发生 `panic`”一模一样。**自 Go 1.21 起，`panic(nil)` 会自动转换成非空的 `*runtime.PanicNilError`**，保证发生 `panic` 时 `recover() != nil` 恒成立（只有显式设置环境变量或指令 `GODEBUG=panicnil=1`，或者模块 `go.mod` 声明为 `go 1.20` 及更早版本时，才会退回旧行为）。

日常写代码务必守住 `panic`/`recover` 的边界，别把它们当成其他语言的 `throw/catch` 用：

- **可预期的外部或输入失败（文件不存在、网络断连、参数非法、除数为 0）一律返回 `error`**，绝不拿 `panic` 偷懒；
- **公共库函数不要把内部 `panic` 漏给调用方**（除非 API 文档本身明确约定如 `regexp.MustCompile`）：如果库内部因复杂递归解析用到了 `panic`，必须在公开入口函数的 `defer` 里 `recover()` 并转换成普通 `error` 返回；
- **服务端只在顶层请求边界兜底 `recover`**：比如 HTTP 中间件或 RPC 框架拦截单个请求里的意外 Bug，打下完整堆栈日志并返回 `500` 错误，避免一个脏请求把整台实例上的其他正常请求一起拖死。

## 9.10 错误与栈跟踪 {#ch9-10}

标准库的 `errors.New` 和 `fmt.Errorf` 默认只存文本与包装引用，**不会自动抓取调用栈**——因为在 Go 里高频构造普通错误值的开销必须保持极低，而按层用 `%w` 拼上操作名（如 `"create order: charge card: %w"`）在绝大多数业务日志里已经足够定位问题路径。

确实需要记录精确行号堆栈时，有三种常见做法：

1. 在每一层 `%w` 包装消息里写清当前动作与关键标识；
2. 在构造自定义错误类型的源头调用标准库 `"runtime/debug"` 的 `debug.Stack()` 把当前 Goroutine 的栈切片存进错误字段；
3. 引入兼容标准库 `errors.Is`/`As` 生态的增强错误库（如 `github.com/cockroachdb/errors`），用 `%+v` 打印带源码位置的错误链。

另外，栈跟踪默认会带上编译机器上的源码绝对路径；对外分发二进制产物时，构建命令加上 `go build -trimpath` 可以抹掉本地目录前缀，既干净又不泄露构建机路径信息。

## 练习 {#ch9-exercises}

以下三题基于同一段员工查询与校验代码层层递进，依次练习哨兵错误、自定义错误类型与多错误聚合检查。代码片段位于 `package main`，已导入标准库 `"errors"` 与 `"fmt"`。建议先独立改写，再展开核对参考答案。

```go
type Employee struct {
	ID      int
	Name    string
	Manager int
}

func getEmployee(id int) (Employee, error) {
	if id <= 0 {
		return Employee{}, errors.New("bad id")
	}
	if id == 1001 {
		return Employee{}, errors.New("no name")
	}
	return Employee{ID: id, Name: "Ada", Manager: 1000}, nil
}
```

### 练习 1：用哨兵错误表示无效 ID

声明包级哨兵错误 `ErrInvalidID`，替换 `getEmployee` 中 `id <= 0` 分支的临时错误，并在调用处用 `errors.Is` 判断打印专门提示。

<details>
<summary>查看参考答案</summary>

```go
var ErrInvalidID = errors.New("invalid employee ID")

func getEmployee(id int) (Employee, error) {
	if id <= 0 {
		return Employee{}, ErrInvalidID
	}
	if id == 1001 {
		return Employee{}, errors.New("no name")
	}
	return Employee{ID: id, Name: "Ada", Manager: 1000}, nil
}

_, err := getEmployee(-1)
if errors.Is(err, ErrInvalidID) {
	fmt.Println("please provide a positive employee ID")
} else if err != nil {
	fmt.Println("unexpected error:", err)
}
```

哨兵错误命名为 `Err` 开头的包级变量；调用方统一使用 `errors.Is` 检查，即使后续 `getEmployee` 外层再套一层 `fmt.Errorf("...: %w", err)` 也能照常命中。

</details>

### 练习 2：用自定义错误类型携带缺失字段名

定义结构体 `EmptyFieldError`（含字段 `FieldName string`）实现 `error` 接口，替换 `id == 1001` 分支返回的错误；在调用处提取出缺失的字段名并打印。

<details>
<summary>查看参考答案</summary>

```go
type EmptyFieldError struct {
	FieldName string
}

func (e EmptyFieldError) Error() string {
	return fmt.Sprintf("field %s cannot be empty", e.FieldName)
}

func getEmployee(id int) (Employee, error) {
	if id <= 0 {
		return Employee{}, ErrInvalidID
	}
	if id == 1001 {
		return Employee{}, EmptyFieldError{FieldName: "Name"}
	}
	return Employee{ID: id, Name: "Ada", Manager: 1000}, nil
}

_, err := getEmployee(1001)
// Go 1.26+ 可直接用泛型 AsType：
if fieldErr, ok := errors.AsType[EmptyFieldError](err); ok {
	fmt.Println("missing field:", fieldErr.FieldName)
}
```

如果模块需要兼容 Go 1.25 及更早版本，把最后三行写成 `var fieldErr EmptyFieldError; if errors.As(err, &fieldErr) { ... }` 即可。结构化字段让调用方不必靠截取错误字符串猜是哪个字段出了问题。

</details>

### 练习 3：聚合全部字段校验错误并逐项检查

编写 `ValidateEmployee(e Employee) error`，一次性检查 `ID <= 0`（加入 `ErrInvalidID`）、`Name == ""`（加入 `EmptyFieldError{FieldName: "Name"}`）和 `Manager < 0`（加入格式化错误），将所有违规合并为一个 `error` 返回（全部合法时返回 `nil`）；在 `main` 中对返回错误同时演示逐条遍历子错误以及用 `errors.Is`、`errors.AsType` 穿透匹配。

<details>
<summary>查看参考答案</summary>

```go
func ValidateEmployee(e Employee) error {
	var errs []error
	if e.ID <= 0 {
		errs = append(errs, ErrInvalidID)
	}
	if e.Name == "" {
		errs = append(errs, EmptyFieldError{FieldName: "Name"})
	}
	if e.Manager < 0 {
		errs = append(errs, fmt.Errorf("invalid manager ID %d", e.Manager))
	}
	return errors.Join(errs...)
}

err := ValidateEmployee(Employee{ID: -1, Name: "", Manager: -5})
if err != nil {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for i, sub := range joined.Unwrap() {
			fmt.Printf("%d: %v\n", i+1, sub)
		}
	}
	fmt.Println("invalid ID?", errors.Is(err, ErrInvalidID))
	if fieldErr, ok := errors.AsType[EmptyFieldError](err); ok {
		fmt.Println("empty field:", fieldErr.FieldName)
	}
}
```

`errors.Join(errs...)`（Go 1.20+）在 `errs` 为空时直接返回 `nil`，省去了额外的 `if len(errs) == 0` 判断；当存在多条错误时，它生成的对象实现了 `Unwrap() []error`，既支持拆出直接子错误列表展示给前端表单，也支持 `errors.Is`、`errors.As` 和 `errors.AsType` 直接穿透整棵错误树。

</details>

## 面试题 {#ch9-interview}

以下四题分别检验 `errors.New` 判等与 `%w`/`%v` 差异、值类型自定义错误的非空接口陷阱、`Is`/`As`/`AsType` 的分工以及 `panic(nil)` 的跨版本行为。代码片段已导入 `"errors"`、`"fmt"` 与 `"os"`。建议先独立作答，再展开核对参考答案。

### 面试题 1：下面三项比较分别输出什么？

```go
e1 := errors.New("boom")
e2 := errors.New("boom")

w1 := fmt.Errorf("wrap: %w", os.ErrNotExist)
w2 := fmt.Errorf("wrap: %v", os.ErrNotExist)

fmt.Println(e1 == e2, errors.Is(w1, os.ErrNotExist), errors.Is(w2, os.ErrNotExist))
```

<details>
<summary>查看参考答案</summary>

输出 `false true false`。

1. `errors.New` 每次调用都会返回一个新分配的 `&errorString{s}` 指针，两个指针地址不同，哪怕字符串内容相同，`e1 == e2` 也是 `false`。
2. `fmt.Errorf` 中 `%w` 会保留底层 `os.ErrNotExist` 引用供 `errors.Is` 穿透命中；`%v` 只把错误文本格式化进新字符串，切断了包装链，所以 `errors.Is(w2, os.ErrNotExist)` 为 `false`。

</details>

### 面试题 2：不使用指针、改成值类型的自定义错误局部变量，能避开 `err != nil` 陷阱吗？

```go
type CodeErr struct{ Code int }

func (e CodeErr) Error() string { return fmt.Sprintf("code %d", e.Code) }

func check() error {
	var e CodeErr
	return e
}

fmt.Println(check() != nil)
```

写出输出结果并解释原因。

<details>
<summary>查看参考答案</summary>

依然输出 `true`，避不开。

虽然 `e` 不是指针，但 `check()` 的返回类型是 `error` 接口：返回 `e` 时会把具体类型 `CodeErr` 和零值 `CodeErr{Code: 0}` 一并装箱进接口变量。接口只有动态类型和动态值**同时为空**时才等于 `nil`，这里动态类型已经是 `CodeErr`，所以 `check() != nil` 恒为 `true`。无错时必须直接写 `return nil`（或把 `var e` 声明成 `var e error`）。

</details>

### 面试题 3：`errors.Is`、`errors.As` 和 `errors.AsType` 各自在什么场景使用？

<details>
<summary>查看参考答案</summary>

- **`errors.Is(err, target)`**：判断错误树里是否包含某个**特定的错误值实例**（典型如 `io.EOF`、`os.ErrNotExist`、`context.Canceled` 等哨兵错误），沿树按 `==` 或自定义 `Is` 方法匹配。
- **`errors.AsType[E](err)`（Go 1.26+）与 `errors.As(err, &target)`（Go 1.13+）**：判断错误树里是否存在**某种具体错误类型或接口实现**，并将其提取出来读取字段或调用方法。在 Go 1.26+ 模块中优先使用泛型的 `AsType`，编译期即可保证类型合法且无需提前声明变量。

</details>

### 面试题 4：执行 `panic(nil)` 后，`recover()` 会返回 `nil` 吗？

<details>
<summary>查看参考答案</summary>

在模块语言版本为 **Go 1.21 及以上**时，**不会返回 `nil`**：运行时会把 `panic(nil)` 自动替换为非空的 `*runtime.PanicNilError`，因此 `if v := recover(); v != nil` 能可靠捕获它。只有在模块声明为 `go 1.20` 及更早版本，或显式开启了兼容开关 `GODEBUG=panicnil=1` 时，`recover()` 才会像旧版那样返回 `nil`。

</details>

## 参考资料

- [Go 语言规范：`error` 接口（Errors）](https://go.dev/ref/spec#Errors)
- [Go 语言规范：`panic` 与 `recover`（Handling panics）](https://go.dev/ref/spec#Handling_panics)
- [Go 标准库 `errors`：`New`、`Is`、`As`、`AsType`、`Join` 与 `Unwrap`](https://pkg.go.dev/errors)
- [Go 标准库 `fmt.Errorf` 与 `%w` 包装动词](https://pkg.go.dev/fmt#Errorf)
- [Go 1.20 发布说明：多错误包装与 `errors.Join`](https://go.dev/doc/go1.20#errors)
- [Go 1.21 发布说明：`panic(nil)` 与 `runtime.PanicNilError`](https://go.dev/doc/go1.21#language)
- [Go 向后兼容性与 `GODEBUG`（`panicnil` 说明）](https://go.dev/doc/godebug)
- [Go 官方博客：Working with Errors in Go 1.13](https://go.dev/blog/go1.13-errors)
- [`go vet` 分析器：`errorsas`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/errorsas)
