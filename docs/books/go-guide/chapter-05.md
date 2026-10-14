---
title: 第 5 章 函数
description: 掌握 Go 函数的声明、组合、闭包、延迟调用和值语义，并把这些规则用于资源管理和 API 设计。
---

# 第 5 章 函数

## 本章要点

本章围绕“如何把一段行为设计成清晰的函数”展开：先掌握参数、返回值和错误的声明规则，再理解函数值、匿名函数与闭包如何让行为可以传递和组合，最后用 `defer` 管理资源并用值语义判断函数调用后的数据变化。

读完后，应能设计参数适量、错误边界明确的函数，读懂高阶函数和闭包捕获，判断延迟调用的执行顺序，并区分数组、结构体、切片和映射在传参时的可见变化。涉及循环变量闭包时，本文采用当前 Go 的语言版本规则，并标出旧模块的差异。

> 核对日期：2026 年 9 月 16 日；核对环境为 Go 1.27.1、Windows/AMD64。
>
> - 泛型函数需要 Go 1.18 或更新的语言版本。
> - 使用 `:=` 声明的 `for`/`range` 迭代变量按每次迭代独立处理，需要 Go 1.22 或更新的语言版本；模块的 `go` 指令决定语言语义。
> - `slices.SortFunc` 需要 Go 1.21 或更新的工具链。
> - `io.ReadAll` 和 `io.Discard` 需要 Go 1.16 或更新的工具链。

## 5.1 声明和调用函数 {#ch5-1}

本章整理依据 Jon Bodner《Go语言学习指南：惯例模式与编程实践（原书第 2 版）》第 5 章（原书 PDF 第 108–130 页），并按当前 Go 官方规范和标准库文档核对、改写示例。

函数声明由 `func`、名称、参数列表、结果列表和函数体组成。参数类型写在参数名之后，结果类型写在参数列表之后；没有参数或结果时分别省略相应内容。

```go
func div(num, denom int) (int, int, error) {
	if denom == 0 {
		return 0, 0, errors.New("cannot divide by zero")
	}
	return num / denom, num % denom, nil
}

result, remainder, err := div(5, 2)
if err != nil {
	log.Fatal(err)
}
fmt.Println(result, remainder) // 2 1
```

上例中的 `errors.New`、`log.Fatal` 和 `fmt.Println` 分别来自标准库包 `errors`、`log` 和 `fmt`。有结果的函数必须保证每条可达路径都返回结果；没有结果的函数可以在需要提前退出时使用不带表达式的 `return`。

连续参数类型相同时，可以只写一次类型，例如 `func div(num, denom int) int`。Go 不支持函数重载，也没有命名参数和默认参数。参数多到难以理解时，可以用结构体表达一组可选配置，但这不是为函数增加隐式默认值：

```go
type UserOptions struct {
	FirstName string
	LastName  string
	Age       int
}

func CreateUser(opts UserOptions) error {
	// 根据 opts 创建用户。
	return nil
}

err := CreateUser(UserOptions{LastName: "Smith", Age: 50})
```

结构体字面量使用字段名后，调用方可以省略不需要的字段，也不受字段声明顺序影响。应为真正相关的一组参数使用这种模式；如果只是为了逃避合理的少量参数，不必额外引入结构体。

### 5.1.1 可变参数

可变参数必须是参数列表中最后一个参数，写作 `name ...T`。在函数体内，它就是类型为 `[]T` 的切片；调用方可以传入零个或多个值，也可以用 `slice...` 展开一个同类型切片。

```go
func addTo(base int, values ...int) []int {
	out := make([]int, 0, len(values))
	for _, value := range values {
		out = append(out, base+value)
	}
	return out
}

fmt.Println(addTo(3))
fmt.Println(addTo(3, 2, 4))
values := []int{4, 3}
fmt.Println(addTo(3, values...))
```

输出依次为 `[]`、`[5 7]` 和 `[7 6]`。`addTo(3, values)` 不能编译，因为一个 `[]int` 不是单个 `int`；必须明确写出 `...`。展开调用不会把切片复制成一组独立参数，函数收到的仍是一个切片值。

### 5.1.2 多个返回值与错误

Go 的返回值是独立的多个值，不是一个可以任意解构的元组。调用方通常一次接收所有结果，并按约定把 `error` 放在最后：成功时为 `nil`，失败时携带原因。

```go
quotient, remainder, err := div(5, 2)
if err != nil {
	return err
}
fmt.Println(quotient, remainder)
```

如果只需要其中一部分结果，使用空白标识符 `_` 明确忽略它：

```go
quotient, _, err := div(5, 2)
```

函数调用语句也可以直接丢弃所有返回值，例如 `fmt.Println("done")`。这是少数允许隐式忽略结果的情形；在赋值表达式中不能把多个结果塞进一个变量，也不能留下未使用的普通变量。

命名结果参数会在函数进入时声明为结果变量并初始化为零值：

```go
func divNamed(num, denom int) (quotient, remainder int, err error) {
	if denom == 0 {
		return 0, 0, errors.New("cannot divide by zero")
	}
	quotient = num / denom
	remainder = num % denom
	return quotient, remainder, nil
}
```

命名结果可以让复杂函数的结果含义更明显，但它们不会强制调用方使用相同的变量名，也不要求 `return` 必须引用这些变量。应警惕在内层重新声明同名变量造成隐藏；如果结果简单，普通的显式返回通常更容易阅读。

### 5.1.3 裸返回应谨慎

有命名结果参数时，可以写不带表达式的 `return`，它返回当前结果变量的值：

```go
func divNamedReturn(num, denom int) (quotient, remainder int, err error) {
	if denom == 0 {
		err = errors.New("cannot divide by zero")
		return
	}
	quotient, remainder = num/denom, num%denom
	return
}
```

这种写法在很短的函数中可能尚可，但读者必须回溯每个结果变量的最后一次赋值才能知道返回内容。尤其在长函数和存在变量隐藏时，优先写 `return quotient, remainder, nil` 这样的显式返回。命名结果对需要由 `defer` 修改最终错误值的函数有实际用途，相关模式见 [5.4 节](#ch5-4)。

## 5.2 函数也是值 {#ch5-2}

函数类型由参数和结果的类型共同决定，参数名不参与类型匹配。具有相同签名的函数可以赋给同一个函数变量、作为参数传递，或作为结果返回。

```go
func length(text string) int { return len(text) }

var measure func(string) int
measure = length
fmt.Println(measure("hello")) // 5
```

函数变量的零值是 `nil`。调用 `nil` 函数值会触发运行时 `panic`，所以从映射、配置或接口中取出函数后，应先确认它不是 `nil`。函数值只能与 `nil` 比较，不能用 `==` 比较两个函数是否指向同一个实现。

把函数放进映射可以把分支选择与算法实现分开：

```go
type BinaryOp func(int, int) int

func add(a, b int) int { return a + b }
func sub(a, b int) int { return a - b }

var operations = map[string]BinaryOp{
	"+": add,
	"-": sub,
}

op, ok := operations["+"]
if !ok || op == nil {
	return errors.New("unsupported operator")
}
fmt.Println(op(2, 3)) // 5
```

这里的 `ok` 只区分键是否存在；如果键存在但函数值为 `nil`，仍需通过 `op == nil` 拦截。真实计算器还应验证输入、处理除零等错误；函数值只负责选择操作，并不会替代错误处理。

### 5.2.1 命名函数类型与泛型函数

使用 `type` 为函数签名命名，可以把领域含义写进 API，并减少重复的函数类型表达式：

```go
type Validator func(string) error

func validateAll(value string, validators ...Validator) error {
	for _, validate := range validators {
		if err := validate(value); err != nil {
			return err
		}
	}
	return nil
}
```

当前 Go 还支持带类型参数的泛型函数。类型参数位于函数名后、普通参数列表前；调用时编译器通常能根据实参推断类型，也可以显式实例化：

```go
func Max[T int | float64](a, b T) T {
	if a > b {
		return a
	}
	return b
}

fmt.Println(Max(2, 3))          // 推断 T 为 int
fmt.Println(Max[float64](2, 3)) // 显式指定 T
```

泛型函数在作为值使用前需要先实例化，例如 `var maxInt func(int, int) int = Max[int]`。未实例化的泛型函数本身不是一个可以直接调用的具体函数值；类型集合、约束和推断规则将在泛型专题中展开。

### 5.2.2 匿名函数

匿名函数是没有名称的函数字面量，可以赋给变量，也可以在定义后立即调用：

```go
printValue := func(value int) {
	fmt.Println("value:", value)
}
printValue(3)

func(value int) {
	fmt.Println("once:", value)
}(4)
```

匿名函数常用于只需要一次的回调、`defer` 和启动 goroutine。包级变量也可以保存匿名函数，但这会引入可变的包级状态：

```go
var add = func(a, b int) int { return a + b }

func replaceAdd() {
	add = func(a, b int) int { return a + b + b }
}
```

除非确实需要在运行时替换行为，否则优先使用不可变的普通函数或构造后不再改变的函数值，以便追踪数据流。

## 5.3 闭包与高阶函数 {#ch5-3}

在函数内部创建的函数如果引用了外层变量，就形成闭包。闭包捕获的是变量本身，而不是创建闭包那一刻的值，因此可以读取并修改该变量；只要闭包仍被使用，被捕获变量就会保持可用。

```go
func main() {
	value := 20
	change := func() {
		fmt.Println(value)
		value = 30
	}
	change()
	fmt.Println(value)
}
```

输出为 `20` 和 `30`。闭包内部用 `:=` 会声明新变量并隐藏外层变量，用 `=` 才会更新被捕获的变量：

```go
value := 20
change := func() {
	value := 30 // 新变量；外层 value 仍为 20
	fmt.Println(value)
}
change()
fmt.Println(value) // 20
```

闭包适合限制辅助逻辑的作用域、共享少量状态，以及把策略作为参数传递。捕获的可变状态也会增加理解和并发安全的成本，应让生命周期和所有权清楚。

### 5.3.1 把函数作为参数传递

接受函数参数或返回函数的函数称为高阶函数。标准库排序 API 就是典型应用：比较函数作为策略传入，排序函数负责遍历和交换元素。

```go
type Person struct {
	FirstName string
	LastName  string
	Age       int
}

people := []Person{
	{FirstName: "Pat", LastName: "Patterson", Age: 37},
	{FirstName: "Tracy", LastName: "Bobdaughter", Age: 23},
	{FirstName: "Fred", LastName: "Fredson", Age: 18},
}

// sort.Slice 的函数参数需要导入标准库 "sort"。
sort.Slice(people, func(i, j int) bool {
	return people[i].LastName < people[j].LastName
})
```

传入 `sort.Slice` 的闭包捕获了 `people`，但 `i` 和 `j` 是比较函数自己的参数。排序会原地修改切片的元素顺序；如果不希望调用方看到修改，应先复制切片。Go 1.21 及更新版本对有具体元素类型的切片也可以使用泛型的 `slices.SortFunc`，其比较函数返回负数、零或正数，表达“小于、相等或大于”。

### 5.3.2 从函数返回函数

函数可以返回捕获了参数的闭包。每次调用构造函数都会得到一份独立的捕获状态：

```go
func makeMultiplier(base int) func(int) int {
	return func(factor int) int {
		return base * factor
	}
}

double := makeMultiplier(2)
triple := makeMultiplier(3)
fmt.Println(double(4), triple(4)) // 8 12
```

这类模式适合构造带配置的处理器、中间件和验证器。若闭包捕获了指针、切片或映射，返回它之后仍可能与调用方共享底层数据，不能把“返回了函数”误认为自动完成了深复制。

### 5.3.3 循环变量与闭包

从 Go 1.22 语言版本开始，使用 `:=` 声明的 `for`/`range` 变量每次迭代都有独立的变量，因此闭包可以直接捕获当次值：

```go
func readers(words []string) []func() string {
	var result []func() string
	for _, word := range words {
		result = append(result, func() string { return word })
	}
	return result
}
```

在 `go.mod` 的 `go` 指令为 1.22 或更高时，调用这些函数得到 `one`、`two`、`three`。声明 1.21 或更早语言版本的模块仍使用旧规则，所有闭包可能读取最后一次迭代的值。若循环变量预先声明并使用 `=`，变量仍在迭代之间复用：

```go
var word string
for _, word = range []string{"one", "two"} {
	// 每次都给同一个 word 赋值。
}
```

变量作用域和版本差异的完整对照见[第 4 章的循环变量小节](./chapter-04#ch4-4-5)。

## 5.4 `defer` 与资源清理 {#ch5-4}

`defer` 把一个函数调用登记到当前函数的返回路径上。当前函数通过 `return` 正常返回、发生 panic，或执行到函数末尾时，已登记的延迟调用会执行；多个延迟调用按后进先出（LIFO）顺序执行。

```go
func readFile(name string) ([]byte, error) {
	f, err := os.Open(name) // 需要导入 "os"
	if err != nil {
		return nil, err
	}
	defer f.Close()

	return io.ReadAll(f) // 需要导入 "io"
}
```

资源成功获取后立即登记清理动作，可以覆盖函数中的多个返回路径。若 `Close` 本身的错误不能忽略，应使用命名结果参数和延迟闭包合并该错误；对只读文件的简单示例通常可以明确记录为何忽略它。

### 5.4.1 求值时机和执行顺序

`defer` 后面的调用参数在登记时立即求值，调用本身延迟到函数退出：

```go
func deferExample() int {
	value := 10
	defer func(captured int) {
		fmt.Println("first:", captured)
	}(value)

	value = 20
	defer func(captured int) {
		fmt.Println("second:", captured)
	}(value)

	value = 30
	fmt.Println("exiting:", value)
	return value
}
```

输出为：

```text
exiting: 30
second: 20
first: 10
```

延迟函数在返回值确定后、控制权真正离开函数前运行。它可以通过闭包读取或修改命名结果参数：

```go
func save() (err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("save failed: %w", err)
		}
	}()
	return errors.New("disk full")
}
```

延迟函数的返回值没有接收者，不能通过 `defer someFunc()` 读取它。要在每次循环迭代结束时清理资源，应把迭代体放进一个辅助函数；直接在循环中 `defer` 会把所有清理动作推迟到外层函数返回。

### 5.4.2 事务和退出边界

命名结果参数适合表达“提交失败也要成为函数错误”的事务清理模式：

```go
func insert(ctx context.Context, db *sql.DB, value string) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	_, err = tx.ExecContext(ctx, "INSERT INTO items (value) VALUES (?)", value)
	return err
}
```

示例需要导入 `context` 和 `database/sql`；实际 SQL 占位符由驱动决定。`defer` 不是进程级 finally：调用 `os.Exit`（包括 `log.Fatal` 的退出路径）不会运行延迟调用。因此需要确保文件或事务清理时，应返回错误给调用方，而不是在已登记 `defer` 后调用 `log.Fatal`。

发生 panic 时，当前栈帧中的延迟调用仍会执行；只有直接由延迟函数调用 `recover` 才能捕获正在传播的 panic。恢复 panic 应限于明确的边界（例如服务请求隔离），不能把它当作普通错误处理的替代品。

## 5.5 值传递和函数边界 {#ch5-5}

Go 的参数和结果始终按值传递：调用函数时会复制传入值，函数内给参数重新赋值不会改变调用方变量。复制的内容取决于类型，不能笼统地说“所有对象都复制”或“所有对象都共享”。

数组和只含值字段的结构体会复制全部元素：

```go
type Person struct {
	Name string
	Age  int
}

func rename(p Person) {
	p.Name = "Bob"
}

person := Person{Name: "Alice", Age: 20}
rename(person)
fmt.Println(person.Name) // Alice
```

字符串值是不可变的字节序列，函数内给字符串参数重新赋值不会改变调用方变量。指针参数复制的是地址值；通过该地址修改对象，其他持有同一地址的代码就能观察到修改：

```go
func renameInPlace(p *Person) {
	p.Name = "Bob"
}

renameInPlace(&person)
fmt.Println(person.Name) // Bob
```

切片、映射、通道、函数和接口值都包含指向或描述底层状态的部分。复制这些值会复制描述符或引用，而不是自动复制底层数据。因而“按值传递”和“函数内可见共享状态”可以同时成立。

```go
func modify(m map[int]string, values []int) {
	m[1] = "changed"
	for i := range values {
		values[i] *= 2
	}
	values = append(values, 10) // 只更新本地切片描述符
}

data := map[int]string{1: "original"}
numbers := []int{1, 2, 3}
modify(data, numbers)
fmt.Println(data[1], numbers, len(numbers)) // changed [2 4 6] 3
```

映射元素的修改通过共享的映射状态可见。切片参数包含指针、长度和容量：通过索引修改已有元素通常可见，但 `append` 可能分配新的底层数组，且无论是否重新分配，本地更新后的长度都不会自动写回调用方。因此需要把新切片返回给调用方：

```go
func doubledAndAppended(values []int) []int {
	for i := range values {
		values[i] *= 2
	}
	return append(values, 10)
}

numbers = doubledAndAppended(numbers)
```

结构体中的切片或映射字段仍会共享其底层状态；复制外层结构体不等于深复制字段。设计函数时应明确它是原地修改输入，还是返回新的值，并在文档和名称中表达这项约定。需要完全隔离状态时，显式复制切片、映射或所指向对象。

## 练习 {#ch5-exercises}

四题依次检查错误返回、`defer` 资源管理、闭包捕获和值传递。先独立分析题目，再展开参考答案；代码片段中的标准库导入按答案中的说明补齐。

### 练习 1：为除法函数补充错误结果

将下面的函数改为同时返回商和 `error`。除数为零时返回 `errors.New("division by zero")`；其他情况返回商和 `nil`。调用方必须检查错误后再使用商。

```go
func div(num, denom int) int {
	return num / denom
}
```

<details>
<summary>查看参考答案</summary>

```go
func div(num, denom int) (int, error) {
	if denom == 0 {
		return 0, errors.New("division by zero")
	}
	return num / denom, nil
}

result, err := div(10, 2)
if err != nil {
	return err
}
fmt.Println(result)
```

先检查除数，避免整数除零触发 panic；错误作为最后一个结果返回，调用方通过 `err != nil` 判断失败。需要保留余数时，应扩展为 `(quotient, remainder int, err error)`，并在每条返回路径提供三个值。

</details>

### 练习 2：实现带清理动作的 `fileLen`

编写 `fileLen(name string) (int, error)`，打开文件、读取文件内容并返回读取的字节数；打开或读取失败时返回对应错误。文件成功打开后，无论读取成功还是失败，都必须关闭文件。

<details>
<summary>查看参考答案</summary>

```go
func fileLen(name string) (int, error) {
	file, err := os.Open(name)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	count, err := io.Copy(io.Discard, file)
	if err != nil {
		return 0, err
	}
	return int(count), nil
}
```

这里需要导入 `io` 和 `os`。`defer` 必须放在确认 `os.Open` 成功之后，否则可能对空指针调用 `Close`。`io.Copy` 返回 `int64`，题目要求的 `int` 在转换前应结合应用支持的文件大小评估溢出风险；若要支持任意文件大小，更稳妥的 API 是返回 `int64`。

</details>

### 练习 3：用闭包构造前缀函数

实现 `prefixer(prefix string) func(string) string`，返回的函数把前缀、一个空格和输入字符串连接起来。下面的调用应输出 `Hello Bob` 和 `Hello Maria`。

```go
helloPrefix := prefixer("Hello")
fmt.Println(helloPrefix("Bob"))
fmt.Println(helloPrefix("Maria"))
```

<details>
<summary>查看参考答案</summary>

```go
func prefixer(prefix string) func(string) string {
	return func(name string) string {
		return prefix + " " + name
	}
}
```

返回的匿名函数捕获 `prefix`。每次调用 `prefixer` 都会创建一份独立的捕获状态，因此 `prefixer("Hello")` 和 `prefixer("Hi")` 得到的函数互不影响。

</details>

### 练习 4：让 `append` 的结果回到调用方

下面的函数会把元素加倍，但调用方看不到追加的 `10`。解释原因，并修改函数或调用方式，使最终切片为 `[2 4 6 10]`。

```go
func modify(values []int) {
	for i := range values {
		values[i] *= 2
	}
	values = append(values, 10)
}

values := []int{1, 2, 3}
modify(values)
fmt.Println(values)
```

<details>
<summary>查看参考答案</summary>

切片参数是描述符的副本，包含独立的长度和容量字段。函数内的索引写入通过共享底层数组可见，但 `append` 返回的新描述符只赋给了本地 `values`，调用方的长度仍为 3。让函数返回切片即可：

```go
func modify(values []int) []int {
	for i := range values {
		values[i] *= 2
	}
	return append(values, 10)
}

values := modify([]int{1, 2, 3})
fmt.Println(values) // [2 4 6 10]
```

另一种设计是让调用方执行 `values = append(values, 10)`；关键是不能只依赖函数参数副本的长度变化。

</details>

## 面试题 {#ch5-interview}

三题直接检查函数类型、返回值和 `defer`。先回答“能否编译、输出什么或如何修复”，再展开参考答案。

### 面试题 1：两个函数值可以直接比较吗？

下面代码能否编译？如果不能，如何判断两个函数变量是否为空？

```go
var first func(int) int
var second func(int) int
fmt.Println(first == second)
```

<details>
<summary>查看参考答案</summary>

不能编译。函数值只能与 `nil` 比较，不能相互比较。可以分别写 `first == nil` 和 `second == nil`；调用值为 `nil` 的函数会触发 panic。

</details>

### 面试题 2：`defer` 的参数何时求值？

下面函数输出什么？说明两个延迟调用的先后顺序。

```go
func example() {
	value := 1
	defer fmt.Println("first", value)
	value = 2
	defer fmt.Println("second", value)
	value = 3
}
```

<details>
<summary>查看参考答案</summary>

输出为：

```text
second 2
first 1
```

`defer` 调用的参数在登记时求值，分别保存了 1 和 2；延迟调用按 LIFO 顺序执行。最后赋值为 3 不会改变已经保存的参数。

</details>

### 面试题 3：为什么 `log.Fatal` 后的 `defer` 不执行？

```go
func load() error {
	file, err := os.Open("data.txt")
	if err != nil {
		return err
	}
	defer file.Close()
	log.Fatal("bad data")
	return nil
}
```

`file.Close` 是否一定会被调用？应如何设计这段代码？

<details>
<summary>查看参考答案</summary>

不会一定调用。`log.Fatal` 会记录消息后调用 `os.Exit(1)`，进程直接退出，运行时不会执行延迟调用。应让 `load` 返回错误，由更高层统一记录和决定退出；例如将 `log.Fatal` 改为 `return errors.New("bad data")`，并保留 `defer file.Close()`。

</details>

## 参考资料

- [Go 语言规范：函数声明](https://go.dev/ref/spec#Function_declarations)
- [Go 语言规范：函数类型](https://go.dev/ref/spec#Function_types)
- [Go 语言规范：函数字面量与闭包](https://go.dev/ref/spec#Function_literals)
- [Go 语言规范：调用与参数传递](https://go.dev/ref/spec#Calls)
- [Go 语言规范：延迟语句](https://go.dev/ref/spec#Defer_statements)
- [Go 语言规范：内置函数 `panic` 与 `recover`](https://go.dev/ref/spec#Handling_panics)
- [Go 语言规范：类型参数](https://go.dev/ref/spec#Type_parameter_declarations)
- [Go 1.18 发布说明：泛型](https://go.dev/doc/go1.18#generics)
- [Go 1.22 发布说明：循环变量语义](https://go.dev/doc/go1.22#language)
- [标准库 `slices.SortFunc`](https://pkg.go.dev/slices#SortFunc)
- [标准库 `sort.Slice`](https://pkg.go.dev/sort#Slice)
- [标准库 `os.Exit`](https://pkg.go.dev/os#Exit)
- [标准库 `log.Fatal`](https://pkg.go.dev/log#Fatal)
- [Effective Go：函数](https://go.dev/doc/effective_go#functions)
- [Effective Go：延迟、 panic 和恢复](https://go.dev/doc/effective_go#defer)
