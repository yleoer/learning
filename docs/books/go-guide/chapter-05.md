---
title: 第 5 章 函数、闭包与 defer
description: 掌握 Go 函数的可变参数与多返回值约定、一等函数值与闭包捕获规则，以及 defer 求值和清理退出边界。
---

# 第 5 章 函数、闭包与 defer

## 本章要点

在 Go 中设计函数，核心是让输入契约、错误出口与资源生命周期清晰可见。本章依次梳理参数组织、可变参数的底层共享边界、多返回值与具名返回值的取舍，剖析一等函数值与闭包捕获外层变量的存储机制，最后拆解 `defer` 的实参立即求值、后进先出执行顺序，以及循环泄漏与进程直接退出的清理盲区。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 5.1 函数声明、可变参数与多返回值 {#ch5-1}

### 5.1.1 参数、配置结构体与可变参数 {#ch5-1-1}

相邻同类型参数可合并书写类型；凡声明了返回值的函数，每条可达执行路径都必须以 `return` 或 `panic` 结束。下例用到的 `errors.New` 和 `fmt.Println` 分别来自标准库 `"errors"` 与 `"fmt"`：

```go
func div(num, denom int) (int, int, error) {
	if denom == 0 {
		return 0, 0, errors.New("cannot divide by zero")
	}
	return num / denom, num % denom, nil
}
```

Go 不支持函数重载、命名参数和默认参数。两三个语义明确的参数宜直接平铺；当同一组可选配置较多时，可用配置结构体收敛签名，但需注意未填写字段取的是各类型的[零值](./chapter-02#ch2-1)而非隐式默认值：

```go
type UserOptions struct {
	FirstName, LastName string
	Age                 int
}

func CreateUser(opts UserOptions) error { return nil }
_ = CreateUser(UserOptions{LastName: "Smith", Age: 50})
```

**可变参数**必须位于参数列表末尾，写作 `name ...T`，在函数体内等价于切片 `[]T`。调用方既可传入零个或多个离散实参，也可用 `slice...` 将现有切片展开传入：

```go
func addTo(base int, values ...int) []int {
	out := make([]int, 0, len(values))
	for _, v := range values {
		out = append(out, base+v)
	}
	return out
}

fmt.Println(addTo(3), addTo(3, 2, 4), addTo(3, []int{4, 3}...)) // [] [5 7] [7 6]
```

三种传法的底层存储行为不同：

- **不传可变实参**：如 `addTo(3)`，形参 `values` 为 `nil` 切片。
- **传入离散实参**：如 `addTo(3, 2, 4)`，编译器会分配并填充一个新切片。
- **用 `slice...` 展开现有切片**：**不会复制底层数组**，形参切片直接与调用方共享底层存储；若在函数内原地改写 `values[i]`，调用方的切片元素会被同步修改，完整传参共享边界详见 [6.2 节](./chapter-06#ch6-2)。

### 5.1.2 多返回值、具名返回值与裸返回边界 {#ch5-1-2}

Go 的多返回值是一组并列独立值而非元组对象。按惯例，可能失败的函数将 `error` 放在返回值末尾，调用方须先确认 `err == nil` 再使用结果。不需要的返回值用空白标识符 `_` 丢弃；赋值或短变量声明左侧的变量个数必须与返回值数量严格一致。

返回值也可以像形参一样命名，称为**具名返回值**（Named Result），进入函数时即初始化为零值：

```go
func divNamed(num, denom int) (quotient, remainder int, err error) {
	if denom == 0 {
		return 0, 0, errors.New("cannot divide by zero")
	}
	return num / denom, num % denom, nil
}
```

声明具名返回值后，语法允许写不带表达式的**裸 `return`**，但多分支函数中裸 `return` 迫使读者倒推变量最后一次赋值位置，还容易与内层代码块的 `:=` [变量隐藏](./chapter-04#ch4-2)纠缠。日常编码应坚持显式返回表达式，仅在需要签名自说明文档（如区分商和余数）或配合 `defer` 闭包统一修改返回错误时使用具名返回值。

## 5.2 函数值、匿名函数与闭包 {#ch5-2}

### 5.2.1 一等函数值与命名函数类型 {#ch5-2-1}

在 Go 中函数是一等值（First-Class Value），其类型由参数与返回值类型序列共同决定。函数类型的零值是 `nil`，直接调用 `nil` 函数变量会触发运行期 `panic`；**函数值属于不可比较类型**，只允许与 `nil` 做 `==` 或 `!=` 判等，不能写 `fn1 == fn2`。

用 `type` 定义命名函数类型能让回调、校验器或分发表的意图更清晰：

```go
type BinaryOp func(int, int) int

var ops = map[string]BinaryOp{
	"+": func(a, b int) int { return a + b },
	"-": func(a, b int) int { return a - b },
}
if op, ok := ops["+"]; ok && op != nil {
	fmt.Println(op(2, 3)) // 5
}
```

这里同时检查 `ok && op != nil`，可兼顾键不存在与函数值为 `nil` 两种情形。未实例化的泛型函数还不是具体函数值，赋值前须先指定类型实参（如 `Max[int]`），详见 [9.1.2 节](./chapter-09#ch9-1-2)。无需包级名称时，可直接编写**匿名函数**赋给局部变量或当场执行，如 `func(v int) { ... }(4)`；但应避免暴露可改写的包级全局函数变量，以防并发竞态与测试污染。

### 5.2.2 闭包捕获规则与高阶函数 {#ch5-2-2}

函数内部定义的匿名函数一旦引用了外层作用域变量，就构成了**闭包**（Closure）。核心规则只有一条：**闭包捕获的是外层变量本身的存储单元引用，而非创建闭包那一刻的值拷贝**。闭包内外读写同一变量；若闭包逃逸出外层栈帧，编译器会通过[逃逸分析](./chapter-18#ch18-1)将该变量移至堆上保活：

```go
value := 20
change := func() { value = 30 } // 若误写成 value := 30 则会新建局部变量隐藏外层
change()
fmt.Println(value) // 30
```

接收函数参数或返回函数的函数统称为**高阶函数**。标准库 `"slices"` 的 `slices.SortFunc`（Go 1.21+）配合 `"cmp"` 的 `cmp.Compare` 原地改写切片元素顺序；若需保留原切片顺序，排序前应先调用 `slices.Clone`：

```go
words := []string{"go", "closure", "defer"}
slices.SortFunc(words, func(a, b string) int {
	return cmp.Compare(len(a), len(b))
})
fmt.Println(words) // [go defer closure]
```

高阶函数也可作为工厂返回闭包，每次调用都会生成彼此隔离的捕获环境：

```go
func makeMultiplier(base int) func(int) int {
	return func(factor int) int { return base * factor }
}
double, triple := makeMultiplier(2), makeMultiplier(3)
fmt.Println(double(4), triple(4)) // 8 12
```

对于循环体内创建的闭包，在 Go 1.22+ 模块中，`for` 头部用 `:=` 声明的迭代变量按轮独立创建，闭包可直接安全捕获当轮变量；但用 `=` 改写外部同一变量时仍会共享该变量，详见 [4.3.3 节](./chapter-04#ch4-3-3)。

## 5.3 defer 延迟执行与清理边界 {#ch5-3}

`defer` 用于将函数调用登记到当前外层函数的退出路径上。申请文件、连接或锁等资源时，应**先确认 `err == nil` 再登记 `defer`**，避免打开失败时对无效句柄触发清理：

```go
func readAllFile(name string) ([]byte, error) {
	f, err := os.Open(name) // 标准库 "os"
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f) // 标准库 "io"
}
```

对于写入路径，还需守住三条边界：关闭底层文件前须先调用外层 `bufio.Writer.Flush` 或 `gzip.Writer.Close` 刷新用户态缓冲；要求物理落盘持久性时须显式调用 `f.Sync()`；同时应在 `defer` 闭包中检查并合入 `Close()` 返回的延迟写入错误。

### 5.3.1 实参立即求值、LIFO 与修改具名返回值 {#ch5-3-1}

推理 `defer` 行为需严格区分登记与执行两个时刻：

- **`defer` 右侧的被调函数及其实参，在执行到 `defer` 语句当行立即求值并保存副本**；
- **延迟函数体在外层函数即将退出时，按后进先出（LIFO）栈顺序依次执行**。

同时，`return expr` 并非一步跳出，而是按三步完成：**先求值 `expr` 写入返回值槽位 → 按 LIFO 执行全部 `defer` → 销毁栈帧返回调用方**。因此非具名返回值的槽位无法被 `defer` 改写，只有使用**具名返回值**时，`defer` 闭包才能读取并替换最终传出的结果：

```go
func save() (err error) {
	v := 1
	defer fmt.Println("first:", v) // 登记时立即求值 v，保存 1
	v = 2
	defer func() {
		fmt.Println("second:", v) // 闭包捕获变量 v，退出时读到 2
		if err != nil {
			err = fmt.Errorf("save failed: %w", err)
		}
	}()
	return errors.New("disk full") // 打印 second: 2、first: 1，返回包装错误
}
```

### 5.3.2 循环内 defer 陷阱与 os.Exit 退出边界 {#ch5-3-2}

**`defer` 绑定的是外层函数退出，而非代码块或循环单轮结束。** 在 `for` 循环内直接写 `defer f.Close()`，会导致所有打开的文件句柄一直积压到外层函数返回才释放，极易耗尽文件描述符。需在每轮结束立即释放资源时，应将单轮逻辑抽成独立辅助函数：

```go
func processOne(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() // 每次 processOne 返回时立即关闭当轮文件
	return nil
}
```

此外，`defer` 不是进程级退出钩子，不同退出路径对 `defer` 的触发行为差异如下：

| 退出方式 | 是否执行已登记的 `defer` | 调用栈行为与使用边界 |
| --- | --- | --- |
| `return` / 函数自然结束 | 执行（当前栈帧，LIFO） | 常规返回路径，可配合具名返回值统一收尾或包装 `error` |
| `panic` | 执行（沿当前协程逐帧展开） | 仅在 `defer` 直接调用的函数内调 `recover()` 可拦截，详见 [10.3 节](./chapter-10#ch10-3) |
| `os.Exit` / `log.Fatal` | **一律不执行** | 操作系统进程当场终止；业务与库函数严禁调 `log.Fatal`（标准库 `"log"`），应返回 `error` 交由 `main` 决策 |

## 练习 {#ch5-exercises}

以下 2 道练习检验 `defer` 资源安全清理与闭包工厂高阶函数编写。除题干另有说明外，函数声明位于包级作用域，`fmt`、`os`、`io` 对应同名标准库包。建议先独立作答，再展开核对参考答案。

### 练习 1：使用 `defer` 安全统计文件字节数

实现函数 `fileLen(name string) (int64, error)`：流式统计并返回指定文件的总字节数；只要文件成功打开，函数退出前都必须关闭句柄，且读取大文件时不得一次性载入全部字节。

<details>
<summary>查看参考答案</summary>

```go
func fileLen(name string) (int64, error) {
	f, err := os.Open(name)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(io.Discard, f)
}
```

`defer f.Close()` 紧跟在确认 `err == nil` 之后登记，确保后续任意分支返回前都能关闭句柄。`io.Copy(io.Discard, f)` 借助固定缓冲区流式统计并返回 `(int64, error)`，既不会撑爆内存，也避免了 32 位平台处理超过 2 GiB 文件时的 `int` 溢出。

</details>

### 练习 2：用闭包工厂构造带前后缀的格式化器

实现高阶函数 `wrapWith(prefix, suffix string) func(string) string`：返回的函数在每次调用时将固定的 `prefix`、传入正文和 `suffix` 拼接返回，并验证两次调用生成的闭包状态彼此独立。

<details>
<summary>查看参考答案</summary>

```go
func wrapWith(prefix, suffix string) func(string) string {
	return func(body string) string { return prefix + body + suffix }
}

tagCode, bracket := wrapWith("<code>", "</code>"), wrapWith("[", "]")
fmt.Println(tagCode("defer"), bracket("INFO")) // <code>defer</code> [INFO]
```

每次调用 `wrapWith` 都会在各自的调用帧上创建独立的形参变量 `prefix` 与 `suffix`，两个返回闭包分别捕获各自的变量存储单元，互不干扰。

</details>

## 面试题 {#ch5-interview}

以下 3 道面试题聚焦函数值比较限制、`defer` 求值与具名返回值修改机制以及进程强退边界，代码约定同[练习部分](#ch5-exercises)，另使用标准库 `"log"` 与 `"errors"`。建议先独立作答，再展开核对参考答案。

### 面试题 1：两个同类型的函数变量可以直接用 `==` 比较吗？

以下代码能否通过编译？为什么？应如何检查函数变量是否已初始化？

```go
var fn1, fn2 func(int) int
fmt.Println(fn1 == fn2)
```

<details>
<summary>查看参考答案</summary>

**不能通过编译**，报错 `invalid operation: fn1 == fn2 (func can only be compared to nil)`。函数类型属于不可比较类型，不支持用 `==` 或 `!=` 判断两个函数值是否指向同一实现，也不能用作映射键；唯一合法的比较对象是 `nil`，判空时须分别写 `fn1 == nil` 和 `fn2 == nil`。

</details>

### 面试题 2：`defer` 实参何时求值，为什么能改掉 `f2` 的返回值却改不掉 `f1`？

写出 `f1()` 与 `f2()` 的返回值及标准输出内容，并说明依据。

```go
func f1() int {
	x := 10
	defer fmt.Println("f1 defer:", x)
	defer func() { x += 5 }()
	x = 20
	return x
}

func f2() (x int) {
	defer func() { x += 5 }()
	return 20
}
```

<details>
<summary>查看参考答案</summary>

标准输出打印 `f1 defer: 10`，返回值为 `f1() == 20`、`f2() == 25`。`defer fmt.Println("f1 defer:", x)` 在登记当行立即求值保存了 `10`，退出时按 LIFO 先执行 `x += 5` 再打印已保存的 `10`。同时 `return expr` 先写入返回槽位再运行 `defer`：`f1` 返回值未命名，`return x` 已将 `20` 拷入匿名槽位；`f2` 的具名返回值 `(x int)` 本身就是返回槽位，`return 20` 后被闭包原地加 `5` 变为 `25`。

</details>

### 面试题 3：为什么 `log.Fatal` 前登记的 `defer` 不会执行？

下面的 `loadConfig` 走到 `log.Fatal` 时，`f.Close()` 会执行吗？应如何修复？

```go
func loadConfig(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	log.Fatal("invalid config")
	return nil
}
```

<details>
<summary>查看参考答案</summary>

**不会执行。** `log.Fatal` 输出日志后直接调用 `os.Exit(1)` 立即终止进程，不会展开 Goroutine 调用栈，任何已登记的 `defer` 都不会运行。应将 `log.Fatal("invalid config")` 改为 `return errors.New("invalid config")`，仅在顶层 `main` 函数中统一决定日志输出与进程退出码。

</details>

## 参考资料

- [Go 语言规范：函数声明与函数类型](https://go.dev/ref/spec#Function_declarations)
- [Go 语言规范：`return` 与 `defer` 延迟语句](https://go.dev/ref/spec#Defer_statements)
- [Go 标准库 `slices.SortFunc` 与 `cmp.Compare`](https://pkg.go.dev/slices#SortFunc)
- [Go 标准库 `os.Exit` 与 `log.Fatal`](https://pkg.go.dev/os#Exit)
- [Effective Go：函数与 `defer`](https://go.dev/doc/effective_go#defer)
