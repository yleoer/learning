---
title: 第 10 章 错误处理与 panic
description: 掌握 Go“错误即值”的构造、包装与解包检查机制，厘清哨兵错误、自定义错误类型以及 panic 与 recover 的边界。
---

# 第 10 章 错误处理与 panic

## 本章要点

Go 没有 `try/catch` 异常跳转机制，而是将错误作为普通值放在函数返回值列表末尾显式传递：成功时返回 `nil`，失败时返回满足 `error` 接口的值。本章顺着错误在调用栈中的传递生命周期展开，依次说明简单错误、哨兵错误与自定义错误结构体的构造规范，剖析 `%w` 单链包装、`errors.Join` 多错误合并与 `errors.Is`、`errors.AsType`、`errors.As` 解包匹配机制，最后划清 `panic`/`recover` 与常规错误处理的职责边界。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 10.1 错误即值与构造方式 {#ch10-1}

### 10.1.1 error 接口与返回惯例 {#ch10-1-1}

`error` 是宇宙块中预声明的单方法接口，其[零值](./chapter-02#ch2-1) `nil` 即代表“没有错误”：

```go
type error interface{ Error() string }
```

可能失败的函数按惯例将 `error` 放在返回值列表最后一位，调用方紧跟 `if err != nil` [卫语句](./chapter-04#ch4-4-1)先行拦截异常分支，让正常主干逻辑保持左对齐。下面结合标准库 `"errors"` 演示基本写法：

```go
func calcDivAndMod(num, den int) (int, int, error) {
	if den == 0 {
		return 0, 0, errors.New("denominator is 0")
	}
	return num / den, num % den, nil
}
```

日常编写与处理 `error` 需遵循三条工程惯例：

- **非 `nil` 错误通常搭配零值结果，但须留意“部分进度”特例**：常规函数出错时应将其余返回值置零，防止调用方误读半成品数据；但 `io.Reader.Read`、`io.Writer.Write` 会同时返回已读写字节数与错误，详见[读取契约](./chapter-15#ch15-1-1)，`strconv.ParseInt` 溢出时也会返回对应位宽极值与 `strconv.ErrRange`，调用时须以具体 API 契约为准。
- **错误文本小写开头，末尾不加句号和换行符**：除专有名词或首字母缩略词外一律小写，便于逐层向上拼接成 `"load config: open app.yaml: file does not exist"` 这样的连贯短语。
- **警惕复用 `err` 变量导致的漏检盲区**：编译器强制局部变量至少被读取一次，参见[未使用检查](./chapter-02#ch2-4-2)；但若同一个 `err` 被连续两次赋值、只检查第二次而漏检第一次，编译器不会报错，需借助 `staticcheck` 的 `SA4006` 规则拦截，参见[静态检查](./chapter-12#ch12-2-1)。

### 10.1.2 简单错误、哨兵错误与自定义错误类型 {#ch10-1-2}

按上层调用方是否需要编程介入恢复，错误构造分为三个层次：

1. **简单文本错误**：仅用于记录失败原因时，固定文本用 `errors.New`，需拼接运行期变量时用标准库 `"fmt"` 的 `fmt.Errorf`；配合 `"log/slog"` 输出结构化上下文的做法见[结构化日志](./chapter-16#ch16-3)。
2. **哨兵错误（Sentinel Error）**：当调用方需针对特定失败状态走不同分支时，包作者可导出以 `Err` 开头的包级变量，`io.EOF` 是少数历史命名特例；调用方统一用 `errors.Is` 比对。下面以标准库 `"archive/zip"` 与 `"bytes"` 为例：
   ```go
   data := []byte("not a zip file")
   _, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
   if errors.Is(err, zip.ErrFormat) {
   	fmt.Println("invalid zip archive")
   }
   ```
   导出哨兵错误属于包公开契约，发布后不可随意删改，也切勿在运行期改写其值；若标准库已有 `os.ErrNotExist`、`context.Canceled` 等贴切哨兵应优先复用。社区坚持 `var ErrXxx = errors.New(...)` 而非自定义字符串常量错误，是因为 `errors.New` 每次调用都返回**新分配结构体的指针**——即使提示文本完全相同，不同包创建的哨兵用 `==` 比较也绝不撞车。
3. **自定义错误结构体**：需要携带状态码、违规字段名或重试等待时间等结构化信息时，可定义实现 `Error() string` 的结构体：
   ```go
   type StatusErr struct {
   	Status  int
   	Message string
   }

   func (se StatusErr) Error() string { return se.Message }
   ```

实现自定义错误必须严守两条铁律：**函数签名返回类型一律写 `error` 接口**，绝不写具体错误类型；**成功路径直接写 `return nil`**，切勿先声明具体错误局部变量再无条件返回，否则会触发[有类型 `nil` 陷阱](./chapter-08#ch8-3-1)或装入非空零值结构体：

```go
func checkBroken(fail bool) error {
	var err *StatusErr // 即使换成值类型 var err StatusErr，装箱后接口同样 != nil
	if fail {
		err = &StatusErr{Status: 404, Message: "not found"}
	}
	return err // fail 为 false 时返回 (*StatusErr, nil)，调用方判断 err != nil 恒为 true！
}
```

确需跨分支暂存错误时，局部变量本身必须声明为 `var err error`，保持接口零值 `(nil, nil)`。

## 10.2 错误包装与解包检查 {#ch10-2}

### 10.2.1 单链包装（%w vs %v）与多错误合并（errors.Join） {#ch10-2-1}

错误沿调用栈上抛时，**错误包装（Error Wrapping）** 能在补充当前层操作上下文的同时保留底层根因。`fmt.Errorf` 提供两种行为迥异的动词：

- **`%w` 保留解包链**：生成实现 `Unwrap() error` 的包装错误，上层可通过 `errors.Is` / `errors.AsType` 穿透匹配底层错误。自定义错误结构体只需补充 `Unwrap() error` 方法即可接入同一机制。
- **`%v` 截断解包链**：仅将底层 `err.Error()` 文本格式化进新字符串，隐藏内部第三方驱动等实现细节，防止调用方耦合非公开的底层错误类型。

```go
func loadConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("load config %s: %w", path, err) // 保留 os.ErrNotExist 因果链
	}
	if len(data) == 0 {
		return fmt.Errorf("parse driver fault: %v", io.EOF) // 仅借用文本，对外屏蔽 io.EOF
	}
	return nil
}
```

当表单批量校验、并发收尾或“主操作与 `Close()` 双双失败”产生多个并列错误时，可使用 `errors.Join`（Go 1.20+）或含多个 `%w` 的 `fmt.Errorf`（Go 1.20+）合并为一棵多分支错误树。`errors.Join` 用换行符拼接非空错误文本并自动忽略 `nil`；若传入全为 `nil` 则直接返回 `nil`。

自定义多错误类型只需实现 `Unwrap() []error`。注意两条边界：一是标准库契约规定 **`Unwrap() []error` 返回的切片绝不能包含 `nil` 元素**，实现时必须先行过滤；二是 **`errors.Unwrap(err)` 仅解包单链 `Unwrap() error`**，对 `errors.Join`、多 `%w` 或自定义 `Unwrap() []error` 调用 `errors.Unwrap` 会直接返回 `nil`！穿透整棵错误树应统一交由下节的 `errors.Is` 与 `errors.AsType`。

### 10.2.2 errors.Is、errors.AsType 与 errors.As 选型速查 {#ch10-2-2}

错误构造、包装与解包 API 的职责分工汇总如下：

| 场景诉求 | 推荐写法 | 核心语义与边界 |
| --- | --- | --- |
| 构造纯文本错误 / 屏蔽底层依赖 | `errors.New` / `fmt.Errorf("...: %v", err)` | 每次新建错误实例；`%v` 仅格式化文本并切断解包链 |
| 附加单层上下文 / 合并并列错误 | `fmt.Errorf("...: %w", err)` / `errors.Join`（Go 1.20+） | 分别实现 `Unwrap() error` 与 `Unwrap() []error`；`errors.Unwrap` 对后者返回 `nil` |
| 判定是否命中特定哨兵值 | `errors.Is(err, target)` | 前序深度优先遍历错误树，逐节点用 `==` 或自定义 `Is` 比对 |
| 含不可比较字段或按部分字段匹配 | 自定义类型实现 `Is(target error) bool` | 规避切片等不可比较字段判等限制，支持按字段通配匹配 |
| 提取目标错误类型读字段（Go 1.26+） | `v, ok := errors.AsType[E](err)` | 泛型返回 `(E, bool)`，编译期校验 `E` 满足 `error`，零运行期传参崩溃风险 |
| 提取目标错误类型或接口（Go 1.13+） | `errors.As(err, &target)` | 第二个参数必须是指向错误类型或接口的非空指针，漏写 `&` 会触发运行期 `panic` |

当自定义错误含不可比较字段而无法直接用 `==` 判等——参见[接口判等边界](./chapter-08#ch8-3-2)——或希望忽略状态码只按资源名通配匹配时，可实现 `Is(error) bool`；提取结构化字段时，在 Go 1.26+ 模块中优先使用泛型 `errors.AsType`：

```go
type ResourceErr struct {
	Resource string
	Code     int
}

func (re ResourceErr) Error() string { return fmt.Sprintf("%s: %d", re.Resource, re.Code) }
func (re ResourceErr) Is(target error) bool {
	other, ok := target.(ResourceErr)
	return ok && (other.Resource == "" || other.Resource == re.Resource) &&
		(other.Code == 0 || other.Code == re.Code) && (other.Resource != "" || other.Code != 0)
}

if errors.Is(err, ResourceErr{Resource: "Database"}) { // 通配匹配任意状态码的 Database 错误
	fmt.Println("database fault:", err)
}
if re, ok := errors.AsType[ResourceErr](err); ok { // Go 1.26+ 泛型提取；旧版用 errors.As(err, &re)
	fmt.Println("error code:", re.Code)
}
```

使用旧版 `errors.As(err, &target)` 时，目标变量同样可以是行为接口类型，如 `var temp interface{ Temporary() bool }`；`go vet` 内置的 `errorsas` 分析器可在编译前静态揪出漏写 `&` 等误传。

### 10.2.3 用 defer 统一补充函数级错误上下文 {#ch10-2-3}

若函数内有多步顺序调用，且所有失败出口都需要冠以相同的函数级前缀，可结合[具名返回值与 `defer`](./chapter-05#ch5-3-1) 在出口统一包装，无需引用的返回值用 `_` 占位：

```go
func ProcessOrder(userID int, item string) (_ string, err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("process order (user=%d): %w", userID, err)
		}
	}()
	orderID, err := createDraft(userID, item)
	if err != nil {
		return "", err
	}
	return chargeOrder(orderID)
}
```

该模式仅适用于整函数共享同一外层上下文的场景；若各分支需拼入不同的局部中间变量，仍应在对应分支就地调用 `fmt.Errorf`。

## 10.3 panic、recover 与堆栈信息 {#ch10-3}

`panic` 专用于表达**不可恢复的程序级缺陷**——例如切片越界、空指针解引用、向已关闭通道发送数据——或启动期静态不变式损坏。触发 `panic` 后，当前函数立即中止，运行时按后进先出顺序执行当前 Goroutine 调用栈各帧已注册的 `defer`；若退至该 Goroutine 入口仍未被拦截，整个进程将打印调用栈并崩溃退出。

内置函数 `recover()` 是拦截 `panic` 的唯一手段，使用时须严守四条边界：

1. **仅在 `defer` 直接调用的函数体内生效**：写成 `defer recover()` 或在 `defer` 函数中再隔一层普通辅助函数调用 `recover()` 均无法捕获 `panic`。
2. **`panic(nil)` 非空保证（Go 1.21+）**：调用 `panic(nil)` 时，运行时会自动将其转换为非空的 `*runtime.PanicNilError`，确保发生 `panic` 时 `recover() != nil` 恒成立；仅当模块声明 `go 1.20` 及更早版本或设置 `GODEBUG=panicnil=1` 时才退回返回 `nil` 的历史行为。
3. **严格限于当前 Goroutine**：主 Goroutine 或父函数绝无法捕获子 Goroutine 内部触发的 `panic`，详见[Goroutine 边界](./chapter-13#ch13-1)；后台协程若需防崩必须在自身入口挂载 `defer` 恢复。
4. **严守工程职责边界**：文件缺失、网络超时、非法入参等可预期失败一律返回 `error`；公共库除 `regexp.MustCompile` 这类明确约定的 `MustXxx` 函数外不得向外泄漏内部 `panic`；服务端仅在 HTTP/RPC 顶层中间件统一 `recover`，记录堆栈并返回 `500` 状态码：

```go
func safeRun(fn func()) (err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("panic recovered: %v\n%s", v, debug.Stack())
		}
	}()
	fn()
	return nil
}
```

标准库 `errors.New` 与 `fmt.Errorf` 为保持极低分配开销，默认**不抓取调用栈**；绝大多数业务场景靠逐层 `%w` 拼接动作描述即可定位路径。确需保留源码行号堆栈时，可在自定义错误构造处调用标准库 `"runtime/debug"` 的 `debug.Stack()`。对外构建发布二进制时，建议加上 `go build -trimpath` 抹除编译机本地绝对目录前缀，避免堆栈泄露宿主路径。

## 练习 {#ch10-exercises}

以下 2 道练习围绕员工校验模块展开，依次检验哨兵错误、结构化自定义错误与多错误合并解包。代码均位于 `package main`，默认已导入 `"errors"` 与 `"fmt"`。建议先独立编写，再展开核对参考答案。

### 练习 1：结合哨兵错误与自定义错误分流处理

给定结构体 `type Employee struct { ID int; Name string }`，编写 `LookupEmployee(id int) (Employee, error)`：当 `id <= 0` 时返回经 `%w` 包装的包级哨兵错误 `ErrInvalidID`；当 `id == 1001` 时返回经 `%w` 包装的自定义错误 `EmptyFieldError{FieldName: "Name"}`；其余正数返回正常员工记录。编写调用函数 `handleLookup(id int)`，使用 `errors.Is` 与 `errors.AsType`（Go 1.26+）分别识别两类错误并打印关键信息。

<details>
<summary>查看参考答案</summary>

```go
var ErrInvalidID = errors.New("invalid employee ID")

type EmptyFieldError struct{ FieldName string }

func (e EmptyFieldError) Error() string {
	return fmt.Sprintf("field %s cannot be empty", e.FieldName)
}

func LookupEmployee(id int) (Employee, error) {
	if id <= 0 {
		return Employee{}, fmt.Errorf("lookup id %d: %w", id, ErrInvalidID)
	}
	if id == 1001 {
		return Employee{}, fmt.Errorf("lookup id %d: %w", id, EmptyFieldError{FieldName: "Name"})
	}
	return Employee{ID: id, Name: "Ada"}, nil
}

func handleLookup(id int) {
	emp, err := LookupEmployee(id)
	if errors.Is(err, ErrInvalidID) {
		fmt.Println("rejected: positive ID required")
	} else if fieldErr, ok := errors.AsType[EmptyFieldError](err); ok {
		fmt.Println("missing field:", fieldErr.FieldName)
	} else if err != nil {
		fmt.Println("unexpected error:", err)
	} else {
		fmt.Println("found:", emp.Name)
	}
}
```

即使 `LookupEmployee` 用 `%w` 包了一层上下文，`errors.Is` 与泛型 `errors.AsType[EmptyFieldError]` 依然能穿透包装链命中底层哨兵实例与结构化字段；若需兼容 Go 1.25 及更早版本，可将 `AsType` 替换为 `var fieldErr EmptyFieldError; if errors.As(err, &fieldErr)`。

</details>

### 练习 2：使用 `errors.Join` 聚合多字段校验错误

复用练习 1 的 `ErrInvalidID` 与 `EmptyFieldError`，编写 `ValidateEmployee(e Employee, managerID int) error`：同时检查 `e.ID <= 0`、`e.Name == ""` 及 `managerID < 0`，第三项用 `fmt.Errorf` 构造错误，将所有违规项合并为一个 `error` 返回，全部合法时返回 `nil`。在调用处提取并逐行打印直接子错误列表，同时验证 `errors.Is` 能否命中合并后的错误。

<details>
<summary>查看参考答案</summary>

```go
func ValidateEmployee(e Employee, managerID int) error {
	var errs []error
	if e.ID <= 0 {
		errs = append(errs, ErrInvalidID)
	}
	if e.Name == "" {
		errs = append(errs, EmptyFieldError{FieldName: "Name"})
	}
	if managerID < 0 {
		errs = append(errs, fmt.Errorf("invalid manager ID %d", managerID))
	}
	return errors.Join(errs...)
}

func main() {
	err := ValidateEmployee(Employee{ID: -1, Name: ""}, -5)
	if u, ok := err.(interface{ Unwrap() []error }); ok {
		for i, sub := range u.Unwrap() {
			fmt.Printf("%d: %v\n", i+1, sub)
		}
	}
	fmt.Println("has ErrInvalidID:", errors.Is(err, ErrInvalidID))
}
```

`errors.Join(errs...)`（Go 1.20+）在 `errs` 为空时直接返回 `nil`，非空时返回实现 `Unwrap() []error` 的聚合错误：前端展示层可通过匿名接口断言拆出直接子错误逐条渲染，逻辑层仍可直接用 `errors.Is` 与 `errors.AsType` 检索整棵错误树。

</details>

## 面试题 {#ch10-interview}

以下 3 道面试题聚焦错误判等、多路解包边界与 `panic`/`recover` 运行期规则，代码已导入 `"errors"`、`"fmt"` 与 `"os"`。建议先独立作答，再展开核对参考答案。

### 面试题 1：下面三项比较分别输出什么？为什么？

```go
e1 := errors.New("eof")
e2 := errors.New("eof")
w1 := fmt.Errorf("read: %w", os.ErrNotExist)
w2 := fmt.Errorf("read: %v", os.ErrNotExist)

fmt.Println(e1 == e2, errors.Is(w1, os.ErrNotExist), errors.Is(w2, os.ErrNotExist))
```

<details>
<summary>查看参考答案</summary>

输出 `false true false`。

1. `errors.New` 每次调用都会分配一个新的 `&errorString{s}` 结构体并返回其指针，两次调用的指针地址不同，因此 `e1 == e2` 为 `false`。
2. `%w` 会保留底层 `os.ErrNotExist` 实例构成解包链，`errors.Is(w1, os.ErrNotExist)` 为 `true`；`%v` 仅拼接错误字符串并截断解包链，因此 `errors.Is(w2, os.ErrNotExist)` 为 `false`。

</details>

### 面试题 2：对 `errors.Join` 返回的错误调用 `errors.Unwrap(err)` 会得到什么？自定义 `Unwrap() []error` 有何硬性约束？

<details>
<summary>查看参考答案</summary>

会直接返回 **`nil`**。

标准库区分单链包装 `Unwrap() error` 与多路包装 `Unwrap() []error`：`errors.Unwrap` 只识别单链方法，遇到 `errors.Join` 或多 `%w` 构造的多分支错误一律返回 `nil`，检查多分支错误树必须使用 `errors.Is`、`errors.AsType` 或 `errors.As`。此外，自定义实现 `Unwrap() []error` 时，返回的切片中**严禁包含值为 `nil` 的元素**，返回前必须过滤干净。

</details>

### 面试题 3：在 Go 1.21+ 中执行 `panic(nil)`，`recover()` 返回什么？能在 `main` 中捕获子 Goroutine 的 `panic` 吗？

<details>
<summary>查看参考答案</summary>

1. 在模块语言版本为 **Go 1.21 及以上**时，`recover()` 不会返回 `nil`，而是返回非空的 `*runtime.PanicNilError` 实例，保证发生 `panic` 时 `recover() != nil` 恒成立；仅当模块声明 `go 1.20` 及更早版本或显式设置 `GODEBUG=panicnil=1` 时才会返回 `nil`。
2. **不能跨 Goroutine 捕获**。`panic` 只会展开当前 Goroutine 自身的调用栈并执行该栈上的 `defer`；子 Goroutine 一旦发生未捕获的 `panic`，会直接导致整个进程崩溃，必须在子 Goroutine 自己的入口函数内设置 `defer` + `recover()`。

</details>

## 参考资料

- [Go 语言规范：`error` 接口定义](https://go.dev/ref/spec#Errors)
- [Go 语言规范：`panic` 与 `recover` 处理规则](https://go.dev/ref/spec#Handling_panics)
- [Go 标准库 `errors`：`New`、`Is`、`As`、`AsType`、`Join` 与 `Unwrap`](https://pkg.go.dev/errors)
- [Go 标准库 `fmt.Errorf` 包装动词说明](https://pkg.go.dev/fmt#Errorf)
- [Go 1.21 发布说明：`panic(nil)` 与 `runtime.PanicNilError`](https://go.dev/doc/go1.21#language)
- [`go vet` 分析器：`errorsas`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/errorsas)
