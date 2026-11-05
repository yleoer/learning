---
title: 第 5 章 函数
description: 掌握 Go 函数的多返回值与错误约定、函数值与闭包、defer 求值清理机制以及按值传参边界。
---

# 第 5 章 函数

## 本章要点

在 Go 中设计函数，核心是把输入契约、错误出口、资源生命周期和状态修改边界摆在明面上。本章沿着这条主线展开：先梳理参数、可变参数、多返回值与具名返回值的取舍；再理解一等函数值、匿名函数与闭包如何组合行为并捕获外层变量；接着拆解 `defer` 的实参求值时机、后进先出执行顺序及 `os.Exit`/`panic` 边界；最后结合复合类型的内存模型，判断按值传参后哪些修改对调用方可见、哪些必须通过返回值传回。

> 核对日期：2026 年 9 月 16 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 5.1 声明和调用函数 {#ch5-1}

除另有说明外，本章正文中的函数与类型声明位于包级作用域，调用示例位于函数体内，省略外层 `package main` 与 `import` 声明；涉及的标准库包在首次出现处注明导入路径。

函数声明由 `func`、函数名、参数列表、返回值列表和函数体组成。参数类型写在参数名之后，返回值列表写在参数列表之后；无参数或无返回值时分别省略对应部分：

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

上例中的 `errors.New`、`log.Fatal` 和 `fmt.Println` 分别来自标准库 `"errors"`、`"log"` 和 `"fmt"`。声明了返回值的函数，必须保证每一条可达执行路径都以 `return`（或 `panic`）结束；无返回值的函数可在需要提前退出时使用不带表达式的 `return`。

相邻参数类型相同时可以合并书写类型，如 `num, denom int`。Go 不支持函数重载，也没有命名参数和默认参数。当一个函数的可选配置项较多时，常见做法是用配置结构体收敛参数（注意未显式填写的字段取的是各类型的零值，而非隐式默认值）：

```go
type UserOptions struct {
	FirstName string
	LastName  string
	Age       int
}

func CreateUser(opts UserOptions) error {
	// 根据 opts 创建用户
	return nil
}

err := CreateUser(UserOptions{LastName: "Smith", Age: 50})
```

配合带字段名的结构体字面量，调用方只需填写关心的字段，也不必拘泥于字段声明顺序。不过这种写法只适合确属同一组配置或上下文的参数；两三个含义清楚的普通参数直接平铺在签名里反而更直观。

### 5.1.1 可变参数 {#ch5-1-1}

可变参数必须放在参数列表的最后一位，写作 `name ...T`。在函数体内部，它的类型就是普通切片 `[]T`；调用方既可以传入零个或多个离散实参，也可以用 `slice...` 直接把一个同类型切片展开传入：

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

三行输出依次为 `[]`、`[5 7]` 和 `[7 6]`。直接写 `addTo(3, values)` 无法通过编译，因为 `[]int` 不能当作单个 `int` 传入，必须显式加上 `...`。

还要留意底层存储的差别：传入离散实参（如 `addTo(3, 2, 4)`）时，编译器会构造一个新切片；不传可变实参（如 `addTo(3)`）时，函数收到的 `values` 是 `nil` 切片；而使用 **`values...` 展开现有切片传入时，不会复制底层数组**——函数内的形参切片直接复用调用方切片的底层存储，一旦在函数内部原地改写 `values[i]`，调用方的切片元素也会被同步修改。

### 5.1.2 多个返回值与错误 {#ch5-1-2}

Go 的多返回值是并列返回的一组独立值，而不是单个可拆包的元组对象。按社区惯例，可能失败的函数总是把 `error` 放在返回值列表的最后一位：成功时返回 `nil`，失败时返回具体错误原因，调用方先检查 `err != nil` 再使用其余返回值：

```go
quotient, remainder, err := div(5, 2)
if err != nil {
	return err
}
fmt.Println(quotient, remainder)
```

不需要其中某个返回值时，用空白标识符 `_` 显式丢弃：

```go
quotient, _, err := div(5, 2)
```

单独作为一条语句调用函数时，语法允许直接忽略全部返回值（最典型的就是 `fmt.Println("done")`）；但只要写成赋值或短变量声明，左侧接收变量的数量就必须与返回值个数严格一致，也不能把多返回值直接赋给单个变量。

返回值列表也可以像形参一样写上名字，称为**具名返回值**（Named Result Parameters，又称“命名返回值”）。它们在进入函数时即被声明为局部变量，并自动初始化为对应类型的零值：

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

具名返回值能充当签名级的自说明文档（例如区分两个同为 `int` 的结果谁是商、谁是余数），但它既不约束调用方用什么变量名接收，也不强制 `return` 必须返回这几个变量（比如提前出错时直接写 `return 0, 0, err` 完全合法）。使用具名返回值时要格外提防在嵌套块里用 `:=` 意外隐藏同名结果变量（见 [4.2 节](./chapter-04#ch4-2)）；签名含义本就一目了然时，不给返回值命名往往更清爽。

### 5.1.3 裸返回应谨慎 {#ch5-1-3}

声明了具名返回值后，语法允许直接写不带表达式的裸 `return`，把各个具名返回值变量当前的值原样返回：

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

函数稍长或分支稍多时，裸 `return` 会迫使阅读者倒着往上翻找每个结果变量最后一次被改写的位置，可读性很差，还容易与局部变量的隐藏搅在一起。因此日常编码应坚持写 `return quotient, remainder, nil` 这样的显式返回。具名返回值真正不可替代的用武之地，是配合 `defer` 闭包在函数退出前统一读取或修正最终返回的 `err`（见 [5.4 节](#ch5-4)）。

## 5.2 函数也是值 {#ch5-2}

在 Go 中函数是一等值（First-Class Value）。函数的类型由参数类型序列和返回值类型序列共同决定，参数与返回值的名称不影响类型身份。只要签名完全一致，不同函数就可以赋给同一个函数变量、放进映射或切片、作为参数传入其他函数，或者作为返回值传出：

```go
func length(text string) int { return len(text) }

var measure func(string) int
measure = length
fmt.Println(measure("hello")) // 5
```

函数类型的零值是 `nil`，直接调用值为 `nil` 的函数变量会触发运行期 `panic`。因此从映射、配置结构体或回调字段中取出函数后，若不能保证已初始化，调用前应先判空。同时要注意：**函数值不可相互比较**，只允许与 `nil` 做 `==` 或 `!=` 判等，不能写 `fn1 == fn2` 判断两个变量是不是同一个函数。

把同签名的函数装进映射，常用来把“按名称分发”与“具体处理逻辑”解耦：

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

这里同时检查 `!ok || op == nil` 是为了兼顾“键不存在”和“键虽存在但绑定的函数值为 `nil`”两种情况。涉及除法等可能失败的运算时，只需把 `BinaryOp` 的签名扩展为 `func(int, int) (int, error)` 即可保持一致的错误处理边界。

### 5.2.1 命名函数类型与泛型函数 {#ch5-2-1}

用 `type` 为长函数签名起一个贴合业务角色的名字（如中间件、校验器、钩子函数），既能省去重复书写复杂签名，也能让 API 意图一眼可读：

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

自 Go 1.18 起，函数还支持在函数名之后、普通参数列表之前声明类型参数（泛型函数）。调用泛型函数时，编译器通常能直接从实参推导出类型实参，无法推导或需要指定目标类型时也可显式写出：

```go
func Max[T int | float64](a, b T) T {
	if a > b {
		return a
	}
	return b
}

fmt.Println(Max(2, 3))          // 自动推导 T 为 int
fmt.Println(Max[float64](2, 3)) // 显式实例化 T 为 float64
```

注意未实例化的泛型函数本身还不是一个具体的函数值，如果要把它赋给函数变量或作为高阶函数参数传递，必须先绑定具体类型实参完成实例化，例如 `var maxInt func(int, int) int = Max[int]`。类型约束、底层类型近似（`~`）与类型推导细节将在后续泛型章节展开。

### 5.2.2 匿名函数 {#ch5-2-2}

不在包级用名称声明、直接以内联函数字面量写出的函数就是匿名函数。它既可以赋给变量反复调用，也可以在字面量末尾紧跟实参列表当场执行：

```go
printValue := func(value int) {
	fmt.Println("value:", value)
}
printValue(3)

func(value int) {
	fmt.Println("once:", value)
}(4)
```

匿名函数在三类位置最常见：传给高阶函数的短小回调、配合 `defer` 处理清理收尾，以及配合 `go` 关键字启动 Goroutine。虽然包级变量也能用 `var add = func(...)` 绑定匿名函数并在运行期改写指向，但可变的包级函数变量相当于全局可变状态，容易带来并发竞态与测试污染；除非确有受控的测试桩替换需求，否则包级行为应直接定义为不可重新赋值的普通具名函数。

## 5.3 闭包与高阶函数 {#ch5-3}

在函数内部定义的匿名函数，一旦引用了外层函数作用域里的变量，就构成了**闭包**（Closure）。理解闭包只需抓住一条核心规则：**闭包捕获的是外层变量本身（对同一存储单元的引用），而不是创建闭包那一刻的值拷贝**。因此闭包内外读写的是同一个变量；只要闭包仍然可达，被捕获的变量就会保持存活（若闭包逃逸出外层函数栈帧，编译器逃逸分析会将该变量移至堆上分配；未逃逸的局部闭包则仍可在栈上完成，不必然产生堆分配）：

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

两次打印依次输出 `20` 和 `30`。但如果在闭包里面误用 `:=` 写了同名变量，就会在闭包自己的函数体块里声明一个全新的局部变量，把外层变量隐藏掉：

```go
value := 20
change := func() {
	value := 30 // 新建局部 value；外层被捕获的 value 根本没变
	fmt.Println(value)
}
change()
fmt.Println(value) // 仍是 20
```

闭包很适合在局部拼装带上下文的回调或封装轻量状态，但一旦多个闭包或并发 Goroutine 同时读写同一个被捕获的可变变量，理解成本和数据竞态风险都会陡增——捕获状态越少、所有权越单一越好。

### 5.3.1 把函数作为参数传递 {#ch5-3-1}

接收函数作为参数，或者把函数作为返回值的函数统称为高阶函数（Higher-Order Function）。标准库的自定义排序就是最直观的例子——排序算法负责移动元素，调用方只需传入一个决定先后顺序的比较函数：

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

// 旧式按索引排序（需导入标准库 "sort"）：闭包直接捕获外层切片 people
sort.Slice(people, func(i, j int) bool {
	return people[i].LastName < people[j].LastName
})

// 现代泛型排序（Go 1.21+，需导入标准库 "slices" 与 "cmp"）：直接传入两个元素值比较
slices.SortFunc(people, func(a, b Person) int {
	return cmp.Compare(a.LastName, b.LastName)
})
```

对比两种写法可以清楚看到演进脉络：`sort.Slice` 接收 `any` 并在内部借助反射交换元素，比较函数只能拿到下标 `i`、`j`，必须靠闭包捕获外层 `people` 切片；而 Go 1.21 引入的 `slices.SortFunc` 直接通过泛型把两个元素传给比较函数（返回负数、零、正数分别代表小于、等于、大于），既省去了闭包捕获，又兼具编译期类型检查与更高性能。注意这两者都是**原地排序**，会直接改写传入切片底层数组的元素顺序；若调用方仍需保留原顺序，排序前应先调用 `slices.Clone` 复制一份。

### 5.3.2 从函数返回函数 {#ch5-3-2}

高阶函数也可以根据传入参数构造并返回一个闭包。每次调用外层工厂函数，都会生成一份彼此隔离的捕获环境：

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

HTTP 中间件、带预设参数的校验器和重试装饰器都大量采用这种模式。不过要留心：如果工厂函数接收并被闭包捕获的是指针、切片或映射，那么闭包持有的依然是那份底层存储引用——返回闭包并不会自动替引用数据做深拷贝。

### 5.3.3 循环变量与闭包 {#ch5-3-3}

在模块语言版本为 Go 1.22 及以上时，`for` 或 `for range` 循环头部用 `:=` 声明的迭代变量在每一轮都是独立实例，循环体内创建的闭包可以直接安全捕获当轮变量：

```go
func readers(words []string) []func() string {
	var result []func() string
	for _, word := range words {
		result = append(result, func() string { return word })
	}
	return result
}
```

当 `go.mod` 的 `go` 指令不低于 `1.22` 时，依次调用返回的三个闭包会得到 `"one"`、`"two"`、`"three"`；若维护的是 `go 1.21` 或更早语言版本的旧模块，整轮循环仍复用同一个 `word` 变量，所有闭包最终都会读到最后一轮的值。此外，如果循环变量是在循环外提前声明、循环头里用 `=` 赋值的，那么无论什么 Go 版本，所有闭包捕获的都是外部那同一个变量：

```go
var word string
for _, word = range []string{"one", "two"} {
	// 每轮都在改写同一个外部变量 word
}
```

完整的跨版本实验与作用域规则对照见 [4.4.5 节](./chapter-04#ch4-4-5)。

## 5.4 `defer` 与资源清理 {#ch5-4}

`defer` 用于把一次函数调用登记到当前外层函数的退出路径上：无论当前函数是通过哪一条 `return` 分支正常返回、顺着函数末尾自然结束，还是中途触发了 `panic` 展开调用栈，已成功登记的延迟调用都会在离开当前栈帧前执行；同一个函数内登记了多个 `defer` 时，严格按**后进先出**（LIFO，栈顺序）依次运行。

```go
func readFile(name string) ([]byte, error) {
	f, err := os.Open(name) // 需导入标准库 "os"
	if err != nil {
		return nil, err
	}
	defer f.Close()

	return io.ReadAll(f) // 需导入标准库 "io"（io.ReadAll 自 Go 1.16 起提供）
}
```

登记资源清理时需注意两点边界：

1. **在确认 `err == nil`、成功拿到资源后再登记 `defer`**：若在错误检查前就登记清理，打开失败时不仅平白多一次无效的延迟调用，而且对许多直接解引用接收者字段的自定义类型方法而言，`nil` 接收者会在退出时触发空指针 `panic`（标准库 `*os.File.Close` 自身对 `nil` 接收者做了保护并返回 `os.ErrInvalid`，不会 `panic`，但其他类型不能假定都有此保护）。
2. **区分用户态刷新、稳定存储同步与 `Close` 错误**：对只读文件，忽略 `Close` 返回的错误通常无妨；但对写入路径，`f.Close()` 既**不会**替外层包装的 `bufio.Writer`、`gzip.Writer` 等刷新用户态内存缓冲区（必须在关闭底层文件前先显式调用外层的 `Flush` 或 `Close`），也**不等同于**将数据持久化到物理磁盘（要求落盘持久性时需在关闭前显式调用 `f.Sync()`）。同时，底层文件或网络流的 `Close` 本身仍可能报告延迟写入或释放阶段的系统错误，不应静默丢弃，可通过具名返回值在 `defer` 闭包中检查并合并该错误。

### 5.4.1 求值时机与返回值修改 {#ch5-4-1}

推理 `defer` 行为最容易混淆的是“什么在登记时立刻算好，什么等到函数退出时才跑”：

- **`defer` 语句右侧的被调函数表达式及其实参，在执行到 `defer` 那一行时就立即求值并保存副本**；
- **真正的函数体调用则推迟到外层函数即将退出时按后进先出顺序执行**。

```go
func deferExample() int {
	value := 10
	defer func(captured int) {
		fmt.Println("first:", captured)
	}(value) // 登记时立即求值实参 value，拷入 10

	value = 20
	defer func(captured int) {
		fmt.Println("second:", captured)
	}(value) // 登记时立即求值实参 value，拷入 20

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

同样关键的是 **`return expr` 与 `defer` 的先后顺序**。在 Go 中，`return expr` 并不是一步直接跳出函数，而是按顺序拆成三步：

1. 先求值 `expr`，把结果写入当前函数的返回值槽位；
2. 按 LIFO 顺序执行当前函数已登记的全部 `defer` 调用；
3. 真正销毁栈帧、把返回值槽位里的结果交给调用方。

这就直接决定了 `defer` 能不能改掉最终返回值：

- 如果返回值**没有命名**（如 `func f() int`），第 1 步 `return value` 已经把当时 `value` 的值拷进了匿名返回槽位；哪怕第 2 步 `defer` 闭包把局部变量 `value` 改成了别的数，返回槽位里的值也不会再变。
- 如果使用了**具名返回值**（如 `func save() (err error)`），返回值槽位本身就是变量 `err`；第 2 步运行的 `defer` 闭包直接读取和改写 `err`，就能真正包装或替换最终传给调用方的结果：

```go
func save() (err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("save failed: %w", err)
		}
	}()
	return errors.New("disk full") // 调用方收到的是包装后的 "save failed: disk full"
}
```

另外两点也要注意：一是被 `defer` 直接调用的函数如果自身有返回值，这个返回值会被直接丢弃、无法在 `defer` 语句处接收（需要处理其返回错误时，必须包一层无参匿名闭包 `defer func() { ... }()`）；二是 **`defer` 绑定的是外层函数退出，而不是代码块或循环轮次退出**——如果在 `for` 循环体内直接写 `defer f.Close()`，整轮循环打开的所有文件句柄都会积压到外层函数返回时才关，极易耗尽文件描述符；需要在每轮结束立即释放资源时，应把单轮逻辑抽成一个独立小函数并在其中使用 `defer`。

### 5.4.2 事务收尾与进程退出边界 {#ch5-4-2}

具名返回值配合 `defer` 闭包，可以集中处理数据库事务的退出路径：提交前发生错误时回滚，正常路径尝试提交，并将提交错误作为最终错误返回。下例需导入标准库 `"context"` 与 `"database/sql"`，SQL 占位符语法依具体驱动而定：

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

这里需要准确区分标准库 `database/sql` 的两种退出路径：

- **进入 `defer` 前已出错（`err != nil`）**：尚未调用过 `Commit`，`tx.Rollback()` 会向底层连接发起回滚并归还连接。
- **执行到 `err = tx.Commit()` 时返回错误**：在 `database/sql` 实现中，一旦 `Commit` 越过上下文预检查进入提交阶段，就会通过原子状态把事务标记为已结束（`tx.done`）；此时若驱动提交失败，紧接着再调用的 `tx.Rollback()` 通常只会直接返回 `sql.ErrTxDone`，**并不会向数据库补发回滚指令**（只有在 `Commit` 因事务上下文已取消而提前在预检查阶段返回时，后续 `Rollback` 才可能继续执行）。因此不能把提交失败后的 `Rollback` 当作服务端一定已回滚的保证，提交报错后事务在数据库端的最终状态仍需按幂等查询或业务对账确认。即便如此，保留这种写法仍能统一覆盖“提交前失败主动回滚”与“提交自身报错向外传播 `err`”两条路径。

最后务必分清栈展开与进程强退的区别：**`defer` 不是进程级的退出钩子**。一旦代码调用了 `os.Exit`（包括内部直接调用 `os.Exit(1)` 的 `log.Fatal`、`log.Fatalf`），操作系统进程会当场终止，**当前所有栈帧里登记的 `defer` 一律不会执行**。因此普通业务函数和库函数应老老实实把 `error` 返回给上层，把决定是否终止进程的权力留在最顶层的 `main` 入口中。

而触发 `panic` 时，运行时会沿当前 Goroutine 的调用栈逐层向上展开，并照常执行沿途每一帧已登记的 `defer`；也只有在 `defer` 直接调用的函数体内调用 `recover()`，才能拦截正在传播的 `panic`。`recover` 只应用于顶层边界隔离（如防止单个 HTTP 请求崩溃拖垮整个服务进程），不应拿来替代常规的 `error` 返回流。

## 5.5 值传递和函数边界 {#ch5-5}

Go 语言只有一种传参规则：**所有参数和返回值一律按值传递（Pass by Value）**。调用函数时，实参的值一定会被复制一份赋给形参，在函数内对形参变量本身重新赋值（`p = ...`）永远不会改变调用方手里的变量。至于函数内的操作会不会让调用方观察到数据变化，完全取决于“被复制的那份值里到底装了什么”——与[第 3 章](./chapter-03#ch3-1)分析赋值复制的规律完全一致：

值数组和只含基本类型字段的结构体，传参时会把整块数据完整浅复制一份，函数内怎么改字段都与外部无关：

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
fmt.Println(person.Name) // 仍是 Alice
```

需要让函数就地修改调用方的结构体（或避免拷贝大型结构体）时，显式传入结构体指针 `*Person`——此时按值复制的是内存地址，函数顺着同一地址解引用改写目标对象，调用方自然能看到变化：

```go
func renameInPlace(p *Person) {
	p.Name = "Bob"
}

renameInPlace(&person)
fmt.Println(person.Name) // Bob
```

切片、映射、通道、函数和接口值内部本身就装有指向底层状态的指针或描述符。按值复制它们时，复制的是这份轻量描述符，底层数组或哈希表并未复制。因此“Go 严格按值传参”与“在函数内改映射键值或切片元素会被外部看到”一点也不矛盾：

```go
func modify(m map[int]string, values []int) {
	m[1] = "changed"
	for i := range values {
		values[i] *= 2
	}
	values = append(values, 10) // 只更新了局部形参 values 的切片描述符
}

data := map[int]string{1: "original"}
numbers := []int{1, 2, 3}
modify(data, numbers)
fmt.Println(data[1], numbers, len(numbers)) // changed [2 4 6] 3
```

映射的增删改全部落到共享的底层哈希表上，外部直接可见。而切片描述符把底层指针、`len` 和 `cap` 打包成了三个独立值字段：在函数里通过 `values[i] *= 2` 按下标改已有元素，改在共享底层数组上，外部可见；但 `values = append(values, 10)` 产生的新长度（以及可能扩容分配的新数组地址）只写进了局部形参 `values` 里，调用方的 `numbers` 长度依然停留在 `3`。凡是需要改变切片长度的函数，都应把更新后的切片作为返回值传回（这正是内置 `append` 本身的设计方式）：

```go
func doubledAndAppended(values []int) []int {
	for i := range values {
		values[i] *= 2
	}
	return append(values, 10)
}

numbers = doubledAndAppended(numbers)
```

同理，如果结构体内部带有切片、映射或指针字段，按值传入结构体也只是浅复制外层字段，里面的引用字段依然与外部共享底层存储。设计函数签名时，应当让“原地修改输入”还是“返回全新结果”保持边界分明；不希望外部数据被波及时，对元素为纯值类型的平坦切片或映射可在入口或出口处调用 `slices.Clone`、`maps.Clone` 隔离顶层容器，而这两者都只做**浅复制**——一旦涉及 `[][]T`、`map[K][]V` 等嵌套可变容器或指针元素，仍须按需逐层深拷贝。

## 练习 {#ch5-exercises}

以下四题分别检验显式错误返回、`defer` 文件清理与大文件计数、闭包工厂函数以及切片传参扩容边界。除题干另有说明外，函数声明位于包级作用域，调用代码位于返回 `error`（练习 1）或无返回值（练习 3、4）的函数体内；`fmt`、`errors` 对应标准库 `"fmt"`、`"errors"`，练习 2 还需使用标准库 `"os"` 与 `"io"`。建议先独立编写或推演，再展开核对参考答案。

### 练习 1：为除法函数补充错误结果

将下面的 `div` 改写为同时返回商与 `error`：当 `denom == 0` 时返回 `0` 和 `errors.New("division by zero")`，否则返回商和 `nil`；并补出调用方先检查错误再打印结果的代码。

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

先拦截除数为 `0` 的情况，把原本会直接崩溃的运行期整数除零 `panic` 转化为显式的 `error` 值；按惯例把 `error` 放在返回值末尾，失败分支的商位填对应类型的零值 `0`，调用方确认 `err == nil` 后再消费结果。若同时需要商和余数，签名可扩展为 `(int, int, error)`。

</details>

### 练习 2：实现带清理动作的 `fileLen`

实现函数 `fileLen(name string) (int, error)`：打开指定路径的文件，统计并返回文件的总字节数；打开或读取失败时返回对应错误。要求只要文件成功打开，无论后续读取成功还是中途出错，函数退出前都必须关闭该文件。

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

实现需导入标准库 `"os"` 与 `"io"`（其中丢弃写入流 `io.Discard` 自 Go 1.16 起提供；相比 `io.ReadAll` 把整个文件一次性读进内存，`io.Copy(io.Discard, file)` 使用固定缓冲区流式计数，遇到大文件也不会撑爆内存）。按惯例，`defer file.Close()` 应写在确认 `err == nil` 之后，避免打开失败时对无效的 `nil` `*os.File` 做多余的关闭调用（尽管 `*os.File.Close` 对 `nil` 会返回 `os.ErrInvalid` 而非 `panic`，其他资源类型未必具备同样的 `nil` 保护）。另外 `io.Copy` 返回 `int64`，在 32 位平台上遇到超过 2 GB 的文件转 `int` 会溢出；若自行设计生产级签名，返回值直接定为 `(int64, error)`（或直接查询文件元信息 `file.Stat()`）更为稳妥。

</details>

### 练习 3：用闭包构造前缀函数

实现高阶函数 `prefixer(prefix string) func(string) string`：返回的函数把固定的 `prefix`、一个空格和调用时传入的字符串拼接起来。以下调用应依次输出 `Hello Bob` 和 `Hello Maria`：

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

内部匿名函数捕获了外层形参 `prefix`。每次调用 `prefixer` 都会创建一份独立的捕获环境，因此再调用 `hiPrefix := prefixer("Hi")` 时，两个闭包各自持有自己的前缀字符串，互不干扰。

</details>

### 练习 4：让 `append` 的结果回到调用方

下面的 `modify` 会把切片原有元素翻倍，但调用方打印出来却看不到末尾追加的 `10`。解释原因，并修改函数签名与调用方式，使最终输出 `[2 4 6 10]`。

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

原代码只输出 `[2 4 6]`。原因是切片传参按值复制了切片描述符（包含底层数组指针、`len` 和 `cap`）：循环里按下标改写已有元素直接落在共享底层数组上，外部可见；但 `append(values, 10)` 返回的新长度（及扩容后的新底层数组指针）只赋给了局部形参 `values`，调用方变量的长度依然是 `3`。

把更新后的切片作为返回值传回调用方即可修复：

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

</details>

## 面试题 {#ch5-interview}

以下四题检验函数值的可比较性、`defer` 参数求值与 LIFO 顺序、`defer` 对具名与非具名返回值的修改差异，以及 `os.Exit` 对延迟调用的影响。代码片段均已导入标准库 `"fmt"`（面试题 4 另已导入 `"os"`、`"log"`、`"errors"`）。建议先独立作答，再展开核对参考答案。

### 面试题 1：两个函数值可以直接用 `==` 比较吗？

以下代码能否通过编译？若不能，原因是什么，又该如何检查函数变量是否为空？

```go
var first func(int) int
var second func(int) int
fmt.Println(first == second)
```

<details>
<summary>查看参考答案</summary>

不能通过编译（报错 `func can only be compared to nil`）。在 Go 类型系统中，函数类型属于不可比较类型，不支持用 `==` 或 `!=` 判断两个函数变量是否指向同一实现，**唯一允许的比较是与 `nil` 判等**。需要判空时只能分别写 `first == nil` 和 `second == nil`。

</details>

### 面试题 2：`defer` 的实参在什么时候求值？

调用下面的 `example()` 会输出什么？

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

`defer` 后面的函数实参在执行到该行登记语句时**立即求值**，因此两次登记分别把当时的 `1` 和 `2` 保存了下来，末尾的 `value = 3` 不会改变已保存的实参副本；函数退出时，多个 `defer` 按后进先出（LIFO）顺序依次执行。

</details>

### 面试题 3：`defer` 闭包为什么能改掉 `f2` 的返回值，却改不掉 `f1`？

分别写出 `fmt.Println(f1(), f2())` 的输出结果，并说明原因。

```go
func f1() int {
	x := 10
	defer func() { x++ }()
	return x
}

func f2() (x int) {
	defer func() { x++ }()
	return 10
}
```

<details>
<summary>查看参考答案</summary>

输出为 `10 11`。

`return expr` 按“先将返回值写入返回槽位 → 执行 `defer` → 真正返回”三步完成：

- `f1` 使用**非具名返回值**：`return x` 先把 `10` 拷入匿名返回槽位，随后 `defer` 闭包虽然把局部变量 `x` 自增到了 `11`，但返回槽位里的值仍是 `10`。
- `f2` 使用**具名返回值 `(x int)`**：返回槽位本身就是变量 `x`；`return 10` 先把 `10` 赋给 `x`，紧接着 `defer` 闭包将同一个 `x` 自增为 `11`，最终调用方收到的就是 `11`。

</details>

### 面试题 4：为什么 `log.Fatal` 前登记的 `defer` 不会执行？

在下面的函数中，一旦文件成功打开并走到 `log.Fatal("bad data")`，`file.Close()` 会被调用吗？应如何改造？

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

<details>
<summary>查看参考答案</summary>

**不会被调用。** `log.Fatal` 输出日志后会直接调用 `os.Exit(1)` 立即终止当前进程，不会展开调用栈，因此任何已登记的 `defer` 都不会执行。普通函数遇到错误应将 `log.Fatal("bad data")` 改为 `return errors.New("bad data")` 返回错误，让 `defer file.Close()` 正常完成清理，只在最外层 `main` 入口统一决定日志输出与进程退出码。

</details>

## 参考资料

- [Go 语言规范：函数声明（Function declarations）](https://go.dev/ref/spec#Function_declarations)
- [Go 语言规范：函数类型（Function types）](https://go.dev/ref/spec#Function_types)
- [Go 语言规范：函数字面量与闭包（Function literals）](https://go.dev/ref/spec#Function_literals)
- [Go 语言规范：调用与可变参数传递（Calls）](https://go.dev/ref/spec#Calls)
- [Go 语言规范：`return` 语句](https://go.dev/ref/spec#Return_statements)
- [Go 语言规范：`defer` 延迟语句](https://go.dev/ref/spec#Defer_statements)
- [Go 语言规范：内置函数 `panic` 与 `recover`](https://go.dev/ref/spec#Handling_panics)
- [Go 语言规范：类型参数声明（Type parameter declarations）](https://go.dev/ref/spec#Type_parameter_declarations)
- [Go 1.18 发布说明：泛型（Generics）](https://go.dev/doc/go1.18#generics)
- [Go 1.22 发布说明：循环变量语义](https://go.dev/doc/go1.22#language)
- [Go 标准库 `slices.SortFunc`](https://pkg.go.dev/slices#SortFunc)
- [Go 标准库 `cmp.Compare`](https://pkg.go.dev/cmp#Compare)
- [Go 标准库 `sort.Slice`](https://pkg.go.dev/sort#Slice)
- [Go 标准库 `io.ReadAll` 与 `io.Discard`](https://pkg.go.dev/io#ReadAll)
- [Go 标准库 `os.File.Close` 与 `os.File.Sync`](https://pkg.go.dev/os#File.Close)
- [Go 标准库 `bufio.Writer.Flush`](https://pkg.go.dev/bufio#Writer.Flush)
- [Go 标准库 `database/sql`：`Tx.Commit` 与 `Tx.Rollback`](https://pkg.go.dev/database/sql#Tx.Commit)
- [Go 标准库 `os.Exit`](https://pkg.go.dev/os#Exit)
- [Go 标准库 `log.Fatal`](https://pkg.go.dev/log#Fatal)
- [Effective Go：函数（Functions）](https://go.dev/doc/effective_go#functions)
- [Effective Go：`defer`、`panic` 与 `recover`](https://go.dev/doc/effective_go#defer)
