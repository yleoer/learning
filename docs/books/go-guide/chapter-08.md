---
title: 第 8 章 泛型
description: 用类型参数编写适配多种类型的函数与数据结构，掌握接口约束、类型集合、类型推断与标准库泛型实践。
---

# 第 8 章 泛型

## 本章要点

当一套容器或算法需要服务多种类型、又不想退回 `any` 丢失编译期类型检查时，就轮到**泛型（Generics，Go 1.18+）**出场了。本章从纯接口方案在同构容器上的类型缺口切入，依次梳理泛型类型、泛型函数、递归接口约束、类型项与 `~` 底层类型匹配、`cmp.Ordered` 与常量可表示性限制、类型推断边界以及泛型二叉搜索树的实现；随后拆解 `comparable` 遇到接口实参时的运行期陷阱、Go 刻意克制的语言边界（含 Go 1.27 新增的具体类型泛型方法及其接口限制），最后总结“何时用泛型、何时用接口”与标准库泛型工具集。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 8.1 为什么需要泛型 {#ch8-1}

除另有说明外，本章正文中的类型、函数与方法声明位于包级作用域，调用语句位于函数体内，省略外层 `package main` 与 `import` 声明；`fmt` 对应标准库 `"fmt"`，其余标准库包在首次出现处注明导入路径。

Go 的切片、映射、通道以及 `len`、`make`、`append` 等内置机制从第一天起就能搭配任意元素类型工作；但在 Go 1.18 之前，开发者自己写的类型和函数没有类型参数，想让同一套数据结构支持 `int`、`string` 和 `float64`，只能拿接口硬凑。

比如想把[第 7 章的二叉搜索树](./chapter-07#ch7-2-3)改造成通用树，不用泛型时只能定义一个接收 `any` 的比较接口：

```go
type Orderable interface {
	// Order 返回负数表示当前值小于参数，正数表示大于，0 表示相等
	Order(any) int
}

type OrderableInt int

func (oi OrderableInt) Order(val any) int {
	other := val.(OrderableInt)
	if oi < other {
		return -1
	}
	if oi > other {
		return 1
	}
	return 0
}
```

这套写法能跑，但 `Order(any)` 把最关键的“同一棵树里只能放同一种类型”的约束给丢了：如果再定义一个 `OrderableString`，往已经装了 `OrderableInt` 的树里插一条字符串，编译期完全不报错，直到运行期执行 `val.(OrderableInt)` 才当场 `panic`。

函数层面同样憋屈：没有类型参数时，想写通用的切片映射、过滤、归约，要么按类型复制粘贴好几份，要么像旧版 `sort.Slice` 那样接收 `any` 靠反射搬运元素；早年标准库 `"math"` 里的 `math.Max`、`math.Min` 全声明成 `float64` 参数，也是当年没有类型参数时的折中（超过 2⁵³ 的大整数转 `float64` 还会丢精度）。

## 8.2 泛型类型：以栈为例 {#ch8-2}

泛型类型把**类型参数列表**写在类型名后面的方括号 `[...]` 里，每一项由类型参数名（习惯用单个大写字母如 `T`、`E`、`K`、`V`）和**类型约束（Type Constraint）**组成。下面用切片实现一个先进后出的泛型栈，`any` 约束表示任何类型都可以作为类型实参：

```go
type Stack[T any] struct {
	vals []T
}

func (s *Stack[T]) Push(val T) {
	s.vals = append(s.vals, val)
}

func (s *Stack[T]) Pop() (T, bool) {
	if len(s.vals) == 0 {
		var zero T
		return zero, false
	}
	top := s.vals[len(s.vals)-1]
	var zero T
	s.vals[len(s.vals)-1] = zero // 清空弹出槽位，避免 T 含指针时残留底层引用
	s.vals = s.vals[:len(s.vals)-1]
	return top, true
}
```

实例化时在类型名后填上具体类型实参 `Stack[int]`，此后一旦混入其他类型，编译期直接拦截：

```go
var intStack Stack[int]
intStack.Push(10)
intStack.Push(20)
v, ok := intStack.Pop()
fmt.Println(v, ok) // 20 true
// intStack.Push("nope") // 编译错误：cannot use "nope" (untyped string constant) as int value
```

这段栈实现里有三个高频细节值得记牢：

- **方法接收者必须带上类型参数**：写作 `func (s *Stack[T]) Push(...)`，不能省掉 `[T]`（在 Go 1.26 及更早版本中方法自身还不能声明额外类型参数，Go 1.27 起已放开，详见 [8.8 节](#ch8-8)）。
- **用 `var zero T` 构造通用零值**：空栈 `Pop` 时不能写 `return nil, false`，因为当 `T` 是 `int` 或结构体时 `nil` 根本不合法；声明 `var zero T` 利用[零值规则](./chapter-02#ch2-1)就能拿到任意类型 `T` 的零值。
- **缩短切片前清零尾部槽位**：如 [3.2.4 节](./chapter-03#ch3-2-4)所述，当 `T` 是指针或含引用字段的结构体时，先把 `s.vals[len(s.vals)-1]` 赋成 `zero`（或调 `clear`）再缩减长度，能防止被弹出的大对象被底层数组死死拽住无法 GC。

如果还想给 `Stack` 加一个判断元素是否存在的 `Contains` 方法，继续用 `any` 约束会报错——因为不是所有类型都支持 `==`（比如 `[]int`）。这时要把约束收紧为宇宙块预声明的 `comparable` 接口：

```go
type Stack[T comparable] struct {
	vals []T
}

func (s Stack[T]) Contains(val T) bool {
	for _, v := range s.vals {
		if v == val {
			return true
		}
	}
	return false
}
```

注意自 Go 1.20 起，`comparable` 从“严格可比较类型”放宽到了所有语法上允许写 `==` 的类型——这意味着普通接口类型也满足 `comparable`，但如果接口里装的动态值不可比较，运行期判等依然会 `panic`（详见 [8.7 节](#ch8-7)）。

## 8.3 泛型函数抽象算法 {#ch8-3}

泛型函数把类型参数列表放在函数名之后、普通参数列表之前。用三个经典的序列变换函数就能看清跨类型抽象的写法：

```go
func Map[T1, T2 any](s []T1, f func(T1) T2) []T2 {
	r := make([]T2, len(s))
	for i, v := range s {
		r[i] = f(v)
	}
	return r
}

func Reduce[T1, T2 any](s []T1, initializer T2, f func(T2, T1) T2) T2 {
	r := initializer
	for _, v := range s {
		r = f(r, v)
	}
	return r
}

func Filter[T any](s []T, f func(T) bool) []T {
	var r []T
	for _, v := range s {
		if f(v) {
			r = append(r, v)
		}
	}
	return r
}
```

调用时编译器会自动从实参推导 `T1`、`T2`，无需手写方括号：

```go
words := []string{"One", "Potato", "Two", "Potato"}
filtered := Filter(words, func(s string) bool { return s != "Potato" })
lengths := Map(filtered, func(s string) int { return len(s) })
sum := Reduce(lengths, 0, func(acc, val int) int { return acc + val })
fmt.Println(filtered, lengths, sum) // [One Two] [3 3] 6
```

Go 标准库刻意没有把 `Map`、`Reduce`、`Filter` 加进 `"slices"` 包（简单 `for range` 循环在 Go 里往往更直观，也不多分配中间切片）；但对于排序、查找、去重、克隆等通用切片与映射操作，应直接复用标准库 `"slices"` 和 `"maps"`（见 [8.9.2 节](#ch8-9-2)）。

## 8.4 泛型与接口约束 {#ch8-4}

在 Go 中，**类型约束的语法载体就是接口**——任何普通接口都能直接拿来做类型约束。比如要求 `Pair` 的两个元素同属一种类型，且都实现了 `fmt.Stringer`：

```go
type Pair[T fmt.Stringer] struct {
	Val1 T
	Val2 T
}
```

接口自身也可以带类型参数。下面定义一个除了能转字符串、还能计算“与同类型另一个值的距离”的泛型接口 `Differ[T]`：

```go
type Differ[T any] interface {
	fmt.Stringer
	Diff(T) float64
}
```

再写一个比较两组点对谁靠得更近的函数 `FindCloser`。注意这里的约束 `T Differ[T]`——类型参数 `T` 出现在它自己的约束实参里，用来强制 `Diff` 方法接收的必须是同一种具体类型 `T`（而不是像 8.1 节那样退回 `Diff(any)`）：

```go
func FindCloser[T Differ[T]](pair1, pair2 Pair[T]) Pair[T] {
	if pair1.Val1.Diff(pair1.Val2) < pair2.Val1.Diff(pair2.Val2) {
		return pair1
	}
	return pair2
}
```

只要具体类型实现了 `String() string` 和 `Diff(Point2D) float64`，就能直接传进去（下例使用标准库 `"math"`）：

```go
type Point2D struct{ X, Y int }

func (p Point2D) String() string { return fmt.Sprintf("{%d,%d}", p.X, p.Y) }

func (p Point2D) Diff(from Point2D) float64 {
	dx := p.X - from.X
	dy := p.Y - from.Y
	return math.Sqrt(float64(dx*dx + dy*dy))
}

pairA := Pair[Point2D]{Val1: Point2D{X: 1, Y: 1}, Val2: Point2D{X: 5, Y: 5}}
pairB := Pair[Point2D]{Val1: Point2D{X: 10, Y: 10}, Val2: Point2D{X: 15, Y: 5}}
fmt.Println(FindCloser(pairA, pairB)) // {{1,1} {5,5}}
```

如果另一个结构体把签名写成了 `Diff(Point3D) float64` 或漏了 `String()`，调用 `FindCloser` 时在编译期就会直接被拦下来。

## 8.5 类型项与类型集合 {#ch8-5}

### 8.5.1 用类型项约束运算符 {#ch8-5-1}

传统接口只能列方法签名，没法表达“这个类型支持 `+`、`/`、`%` 或 `<` 运算符”。为此 Go 扩展了接口语法：专门用作约束的接口可以在花括号里用竖线 `|` 列出允许的**类型项（Type Term）**，共同围出该约束的**类型集合（Type Set）**：

```go
type Integer interface {
	int | int8 | int16 | int32 | int64 |
		uint | uint8 | uint16 | uint32 | uint64 | uintptr
}
```

一旦把 `T` 约束在 `Integer` 上，函数体内就可以放心使用类型集合里**所有成员共同支持**的运算符（如 `/` 和 `%`；下例导入标准库 `"errors"`）：

```go
func divAndRemainder[T Integer](num, denom T) (T, T, error) {
	if denom == 0 {
		return 0, 0, errors.New("cannot divide by zero")
	}
	return num / denom, num % denom, nil
}
```

注意区分两类接口：普通只含方法的接口（基本接口）既能做变量/参数类型，也能做类型约束；而**含有类型项（或内嵌了含类型项接口）的接口只能用作泛型类型约束**，不能声明 `var x Integer`。

### 8.5.2 `~` 匹配底层类型 {#ch8-5-2}

不加前缀的类型项要求**精确匹配类型身份**。如果有自定义整型 `type MyInt int`，拿它调上一小节的 `divAndRemainder` 会直接编译失败，编译器提示也非常直白：

```text
MyInt does not satisfy Integer (possibly missing ~ for int in Integer)
```

在类型项前加上近似符号 `~`，含义就变成“所有**底层类型**为该类型的类型都算满足”（注意 `~` 后面的类型自身必须已经是底层类型，不能写 `~MyInt` 或 `~fmt.Stringer`）：

```go
type Integer interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}
```

平时写数值或字符串约束几乎都应该加上 `~`，否则任何业务定义类型（如 `UserID`、`Score`）都会被拒之门外。另外 `byte` 和 `rune` 本身就是 `uint8` 和 `int32` 的类型别名，不必重复列出。

### 8.5.3 `cmp.Ordered` 与组合约束 {#ch8-5-3}

把所有原生支持 `<`、`<=`、`>`、`>=` 大小比较的类型（全部整数、浮点数与 `string`）用 `~` 联合起来，就是最常用的有序约束。标准库 `"cmp"`（Go 1.21+）已经内置了它，同时配套提供了 `cmp.Compare(x, y)`（返回 `-1`、`0`、`1`，且妥善定义了 `NaN` 排在最前的全序规则）和 `cmp.Less(x, y)`：

```go
type Ordered interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
		~float32 | ~float64 | ~string
}
```

日常代码直接用 `cmp.Ordered` 即可，不用自己再抄一遍联合列表。

约束接口里还可以同时写**类型项 + 方法签名**（换行代表交集“且”）。比如要求“底层类型是 `int` **并且**实现了 `String() string` 方法”：

```go
type PrintableInt interface {
	~int
	String() string
}
```

这里如果漏写了 `~`，变成精确匹配预声明 `int` 且拥有 `String()` 方法，由于内置 `int` 不可能挂方法，这个约束的类型集合就会变成**空集**！Go 语法允许声明空类型集合的约束，但只要尝试用任何具体类型实例化它，编译期就会报错 `int does not implement PrintableInt (missing String method)`。除基本类型外，`~[]byte`、`~map[string]int`、结构体和函数类型同样可以作为类型项参与组合约束。

### 8.5.4 类型项限制常量 {#ch8-5-4}

在泛型函数体内把无类型常量赋给类型参数 `T`（或与 `T` 做运算）时，编译器有一条严格规则：**该常量必须对约束类型集合中的每一个类型都满足[可表示性（Representability）](https://go.dev/ref/spec#Representability)**——对集合中的整数类型，常量不能带非零小数部分且不能超出该整型的取值范围；对浮点或复数类型，允许按目标类型精度舍入（如向 `~float32 | ~float64` 返回 `0.1` 合法），但不能溢出为无穷大。因此下面第一个函数无法通过编译——`Integer` 里包含 `int8`（上限 `127`）和 `uint8`（上限 `255`），`1_000` 超出了它们的可表示范围：

```go
// 编译失败：cannot convert 1000 (untyped constant) to type T
func PlusOneThousand[T Integer](in T) T {
	return in + 1_000
}

// 合法：100 在 int8、uint8 等全部整数类型的可表示范围内
func PlusOneHundred[T Integer](in T) T {
	return in + 100
}
```

### 8.5.5 类型推断的边界 {#ch8-5-5}

大多数时候调用泛型函数无需手写类型实参，编译器能顺着函数实参自动推导出来。但当**某个类型参数只出现在返回值里、实参列表中完全没有线索**时，类型推断无从下手，调用处必须显式写出类型实参：

```go
func Convert[T1, T2 Integer](in T1) T2 {
	return T2(in)
}

b := Convert[int, int64](10) // T2 无法从实参 10 推导，必须显式实例化
```

把泛型函数当作函数值赋值或传参时，推断规则随版本逐步完善：自 Go 1.21 起（并在 Go 1.27 推广到所有涉及函数的赋值上下文），只要目标位置的函数类型已经固定了具体类型（如 `var cmpInt func(int, int) int = cmp.Compare`），编译器就能反向推导出 `[int]`；但如果外层接收它的也是一个泛型函数（如 `NewTree(cmp.Compare)`，内外两边的 `T` 都还没定），就仍须显式写明其中一处（`NewTree(cmp.Compare[int])` 或 `NewTree[int](cmp.Compare)`）。

## 8.6 泛型二叉树 {#ch8-6}

把类型参数、函数类型和 [7.2.3 节](./chapter-07#ch7-2-3)的方法表达式结合起来，就能写出既保证编译期同构类型安全、又支持任意自定义类型排序的二叉搜索树。核心做法是把“怎么比大小”抽成一个泛型比较函数类型：

```go
type OrderableFunc[T any] func(t1, t2 T) int
```

把树结构（持比较函数和根指针）与节点结构（利用 `nil` 指针接收者做递归）拆开写最清爽：

```go
type Tree[T any] struct {
	f    OrderableFunc[T]
	root *Node[T]
}

type Node[T any] struct {
	val         T
	left, right *Node[T]
}

func NewTree[T any](f OrderableFunc[T]) *Tree[T] {
	return &Tree[T]{f: f}
}

func (t *Tree[T]) Add(v T) {
	t.root = t.root.Add(t.f, v)
}

func (t *Tree[T]) Contains(v T) bool {
	return t.root.Contains(t.f, v)
}

func (n *Node[T]) Add(f OrderableFunc[T], v T) *Node[T] {
	if n == nil {
		return &Node[T]{val: v}
	}
	switch r := f(v, n.val); {
	case r < 0:
		n.left = n.left.Add(f, v)
	case r > 0:
		n.right = n.right.Add(f, v)
	}
	return n
}

func (n *Node[T]) Contains(f OrderableFunc[T], v T) bool {
	if n == nil {
		return false
	}
	switch r := f(v, n.val); {
	case r < 0:
		return n.left.Contains(f, v)
	case r > 0:
		return n.right.Contains(f, v)
	default:
		return true
	}
}
```

对于原生有序类型，直接把实例化后的 `cmp.Compare[int]` 塞给 `NewTree` 就行：

```go
t1 := NewTree(cmp.Compare[int])
t1.Add(10)
t1.Add(30)
t1.Add(15)
fmt.Println(t1.Contains(15), t1.Contains(40)) // true false
```

对于自定义结构体，既可以传一个普通比较函数，也可以给结构体定义一个方法再通过**方法表达式** `Person.Order` 传进去——两种写法签名完全一致：

```go
type Person struct {
	Name string
	Age  int
}

func (p Person) Order(other Person) int {
	if out := cmp.Compare(p.Name, other.Name); out != 0 {
		return out
	}
	return cmp.Compare(p.Age, other.Age)
}

t2 := NewTree(Person.Order)
t2.Add(Person{Name: "Ada", Age: 36})
```

此时如果试图往 `t1` 里 `Add("nope")` 或往 `t2` 里 `Add(10)`，编译器当场就会拒绝，彻底补上了 8.1 节纯接口方案的类型漏洞。

## 8.7 `comparable` 的运行期边界 {#ch8-7}

`comparable` 约束能在编译期把切片、映射、函数（以及含有这些字段的结构体和数组）挡在门外；但在 Go 1.20 之后，为了允许像 `Set[any]`、`Cache[string, io.Reader]` 这样以接口为键的泛型容器通过编译，语言规范允许**普通接口类型**满足 `comparable`。

这也就把 [7.6.2 节](./chapter-07#ch7-6-2)讲过的接口判等风险原封不动带进了泛型里：

```go
type Thinger interface {
	Thing()
}

type ThingerInt int

func (t ThingerInt) Thing() { fmt.Println("ThingInt:", t) }

type ThingerSlice []int

func (t ThingerSlice) Thing() { fmt.Println("ThingSlice:", t) }

func Comparer[T comparable](t1, t2 T) {
	if t1 == t2 {
		fmt.Println("equal!")
	}
}
```

直接拿切片类型 `ThingerSlice` 调 `Comparer`，编译期会老老实实报错：

```go
var a ThingerInt = 20
Comparer(a, a) // equal!

s := ThingerSlice{1, 2, 3}
// Comparer(s, s) // 编译失败：ThingerSlice does not satisfy comparable
```

但只要先把 `ThingerSlice` 装进接口变量 `Thinger` 再传给 `Comparer[Thinger]`，编译期就会放行（因为类型实参是接口 `Thinger`），紧接着在运行期执行 `t1 == t2` 时触发 `panic`：

```go
var i1 Thinger = s
var i2 Thinger = s
Comparer(i1, i2) // 编译通过，运行期 panic: comparing uncomparable type main.ThingerSlice
```

记住这个边界：`comparable` 只保证“静态类型参数允许写 `==`”，一旦类型实参本身是接口（或含接口字段的结构体），运行期安全仍取决于实际塞进去的动态值是否可比较。

## 8.8 语言边界与泛型方法的演进 {#ch8-8}

Go 的泛型设计刻意不做成 C++ 模板那样无所不能的元编程系统，以下几条边界在阅读和设计 API 时需要心里有数：

- **不支持运算符重载与自定义下标语法**：自定义类型不能重载 `+`、`==`、`[]`；想让自定义容器支持 `for range` 遍历，统一提供返回 `iter.Seq` / `iter.Seq2` 的迭代器方法（Go 1.23+，见 [4.4.3 节](./chapter-04#ch4-4-3)）。
- **泛型方法（Go 1.27+）与接口限制**：在 Go 1.18～1.26 中，方法接收者只能使用类型本身已声明的类型参数，方法签名自己不能再加类型参数（会报错 `generic method requires go1.27 or later`）。**自 Go 1.27 起，具体定义类型的方法已经允许声明独立的类型参数**，例如针对 [8.2 节](#ch8-2)最初未收紧比较约束的 `Stack[T any]`，可以直接写出链式转换方法（若接收者采用的是收紧后的 `Stack[T comparable]`，则目标类型参数也须同步写为 `MapTo[E comparable]` 才能满足 `Stack[E]` 的类型约束）：
  ```go
  // 对应 type Stack[T any] struct { vals []T }，Go 1.27+ 合法（go.mod 的 go 版本需 >= 1.27）
  func (s Stack[T]) MapTo[E any](f func(T) E) Stack[E] {
  	out := Stack[E]{vals: make([]E, len(s.vals))}
  	for i, v := range s.vals {
  		out.vals[i] = f(v)
  	}
  	return out
  }
  ```
  但要注意两条限制：**接口中的方法依然不能声明类型参数**（`interface method must have no type parameters`），而且带类型参数的泛型方法也不会拿去匹配普通接口里的具体方法；如果库需要兼容 `go 1.26` 及更早语言版本，仍应提供包级泛型函数 `Map(s, f)`。
- **没有变参类型包、模板特化与编译期元编程**：`...T` 里的所有可变实参仍是同一种 `T`，也不支持针对某个具体类型单独写一份特化重载。

## 8.9 使用惯例与标准库泛型 {#ch8-9}

### 8.9.1 何时用泛型，何时用接口 {#ch8-9-1}

日常写代码不必为了“显得现代”到处加方括号，按下面三条准则区分最省心：

1. **同一容器或算法要原样保留调用方的具体类型**（避免 `any` 装箱与断言、返回与输入同类型的值、直接做运算符计算或比较）：用**泛型**。
2. **只关心一两个行为方法，或需要在同一个切片/映射里混装多种不同的具体实现**（如一组不同的中间件、插件或 `io.Reader`）：继续用**普通接口**。
3. **别为了“消除接口动态派发开销”盲目把 `func read(r io.Reader)` 改成 `func read[R io.Reader](r R)`**：当前官方编译器按底层内存布局（GC Shape）共享生成的机器码——所有指针类型其实共用同一份实例化函数体，并在运行期通过内部字典（Dictionary）查表调用方法；未内联的简单调用场景下，改成类型参数反而可能比直接走接口慢。性能取舍一律以[基准测试](./chapter-15#ch15-6)实测为准。

### 8.9.2 标准库中的泛型 {#ch8-9-2}

随着 Go 1.21～1.26 持续演进，常用泛型容器操作与辅助函数已经成体系地进了标准库，日常直接引用即可：

| 标准库包 | 关键能力与起始版本 |
| --- | --- |
| `"cmp"` | `Ordered` 有序约束、`Compare`、`Less`、`Or`（Go 1.21+；`Or` 自 Go 1.22 起提供首个非零值选择） |
| `"slices"` | `Sort`、`SortFunc`、`BinarySearch`、`Contains`、`Index`、`Insert`、`Delete`、`Clone`、`Clip`、`Equal`（Go 1.21+）；配合迭代器的 `All`、`Values`、`Collect`、`Sorted`（Go 1.23+） |
| `"maps"` | `Clone`、`Copy`、`DeleteFunc`、`Equal`、`EqualFunc`（Go 1.21+）；返回或消费迭代器的 `Keys`、`Values`、`All`、`Collect`、`Insert`（Go 1.23+） |
| `"iter"` | `Seq[V]`、`Seq2[K, V]` 迭代器函数类型与 `Pull`、`Pull2`（Go 1.23+） |
| `"sync"` | `OnceValue`、`OnceValues`（Go 1.21+，并发安全的单次延迟初始化） |
| `"errors"` | `AsType[E](err)`（Go 1.26+，按目标错误类型安全拆包错误树，见 [9.7 节](./chapter-09#ch9-7)） |

此外，自 Go 1.24 起类型别名也正式支持携带类型参数（如 `type Set[T comparable] = map[T]struct{}`），跨包平滑迁移泛型类型时无需再包一层新定义类型。

## 练习 {#ch8-exercises}

以下三题依次检验数值类型集合约束、类型项与方法组合约束以及泛型单链表的实现。代码片段位于包级或 `main` 函数内，`fmt` 对应标准库 `"fmt"`。建议先独立编写，再展开核对参考答案。

### 练习 1：编写通用数值翻倍函数

编写泛型函数 `Double[T Number](v T) T`，支持传入任意内置或自定义的整数、浮点数并返回乘以 `2` 的结果；自行定义 `Number` 约束接口。说明为什么类型项前都应加上 `~`，以及为什么表达式 `v * 2` 中的无类型常量 `2` 能通过编译。

<details>
<summary>查看参考答案</summary>

```go
type Number interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
		~float32 | ~float64
}

func Double[T Number](v T) T {
	return v * 2
}

fmt.Println(Double(10), Double(1.5), Double(uint8(100))) // 20 3 200
```

加上 `~` 后，`type Celsius float64`、`type Count int` 这类以整数或浮点数为底层类型的业务定义类型也能直接调用 `Double`。无类型常量 `2` 对 `Number` 类型集合中的每一种整数和浮点类型都满足可表示性规则，因此通过 [8.5.4 节](#ch8-5-4)的编译期常量检查（注意运行期若传入 `uint8(200)`，结果仍遵循 `uint8` 溢出回绕规则变成 `144`）。

</details>

### 练习 2：设计 `Printable` 组合约束

定义约束接口 `Printable`，要求类型底层必须是 `int` 或 `float64`，且同时实现 `fmt.Stringer`；再分别定义满足它的两个自定义类型，并编写 `Print[T Printable](v T)` 打印其值。

<details>
<summary>查看参考答案</summary>

```go
type Printable interface {
	~int | ~float64
	fmt.Stringer
}

type Age int

func (a Age) String() string { return fmt.Sprintf("age %d", int(a)) }

type Score float64

func (s Score) String() string { return fmt.Sprintf("score %.1f", float64(s)) }

func Print[T Printable](v T) {
	fmt.Println(v)
}

Print(Age(36))     // age 36
Print(Score(92.5)) // score 92.5
```

`Printable` 把联合类型项 `~int | ~float64` 与内嵌接口 `fmt.Stringer` 取了交集。这里两处 `~` 缺一不可：预声明的 `int` 和 `float64` 本身没有 `String()` 方法，只有基于它们声明的定义类型才能挂上 `String()` 来满足整个约束。

</details>

### 练习 3：实现泛型单链表

实现一个零值即可直接使用的泛型单链表 `LinkedList[T]`：

- `Add(v T)`：把元素追加到链表末尾；
- `Insert(v T, pos int)`：在下标 `pos` 处插入元素（`pos <= 0` 插在表头，`pos >= 长度` 追加到表尾）；
- `Index(v T) int`：返回 `v` 首次出现的下标，不存在时返回 `-1`。

说明为什么 `T` 需要声明为 `comparable`。

<details>
<summary>查看参考答案</summary>

```go
type Node[T comparable] struct {
	val  T
	next *Node[T]
}

type LinkedList[T comparable] struct {
	head *Node[T]
	size int
}

func (l *LinkedList[T]) Add(v T) {
	l.Insert(v, l.size)
}

func (l *LinkedList[T]) Insert(v T, pos int) {
	if pos <= 0 || l.head == nil {
		l.head = &Node[T]{val: v, next: l.head}
		l.size++
		return
	}
	if pos > l.size {
		pos = l.size
	}
	current := l.head
	for range pos - 1 {
		current = current.next
	}
	current.next = &Node[T]{val: v, next: current.next}
	l.size++
}

func (l *LinkedList[T]) Index(v T) int {
	i := 0
	for current := l.head; current != nil; current = current.next {
		if current.val == v {
			return i
		}
		i++
	}
	return -1
}
```

验证调用：

```go
var list LinkedList[int]
list.Add(10)
list.Add(30)
list.Insert(20, 1)
fmt.Println(list.Index(20), list.Index(99)) // 1 -1
```

`Index` 需要执行 `current.val == v` 判等，`any` 约束不支持 `==`，所以类型参数必须收紧为 `comparable`。零值 `LinkedList[int]` 的 `head == nil`、`size == 0`，直接调 `Add`、`Insert` 或 `Index` 都不会空指针崩溃。

</details>

## 面试题 {#ch8-interview}

以下四题分别考察 `~` 近似约束、空类型集合约束、`comparable` 的接口擦除盲区以及 Go 1.27 泛型方法与接口的边界。建议先独立判断，再展开核对参考答案。

### 面试题 1：约束里的 `int` 和 `~int` 差在哪里？

```go
type MyInt int

type ExactInt interface{ int }
type ApproxInt interface{ ~int }

func F1[T ExactInt](v T)  {}
func F2[T ApproxInt](v T) {}
```

`F1(MyInt(1))` 和 `F2(MyInt(1))` 各自能否通过编译？

<details>
<summary>查看参考答案</summary>

`F1(MyInt(1))` 编译失败，`F2(MyInt(1))` 编译通过。不带 `~` 的类型项只匹配 `int` 本身，而 `MyInt` 是独立的定义类型；加上 `~int` 后才匹配所有底层类型为 `int` 的类型。

</details>

### 面试题 2：下面这个接口声明本身合法吗？能实例化吗？

```go
type ImpossiblePrintableInt interface {
	int
	String() string
}

type Box[T ImpossiblePrintableInt] struct{ val T }
```

分别判断声明 `Box`、`Box[int]{}` 与 `Box[MyInt]{}`（假设 `MyInt` 已实现 `String() string`）的编译结果。

<details>
<summary>查看参考答案</summary>

声明 `ImpossiblePrintableInt` 和 `Box` 本身**可以通过编译**（语言规范允许存在类型集合为空集的约束接口）；但任何实例化都会编译失败：`Box[int]{}` 因为内置 `int` 没有 `String()` 方法失败，`Box[MyInt]{}` 则因为精确类型项 `int` 不接受定义类型 `MyInt` 失败。把 `int` 改成 `~int` 才有合法实例。

</details>

### 面试题 3：通过了 `comparable` 编译检查的泛型结构体，用 `==` 比较一定不会 `panic` 吗？

```go
type Key[T comparable] struct {
	ID   int
	Meta T
}

k1 := Key[any]{ID: 1, Meta: []int{1, 2}}
k2 := Key[any]{ID: 1, Meta: []int{1, 2}}
fmt.Println(k1 == k2)
```

写出这段代码的编译和运行结果。

<details>
<summary>查看参考答案</summary>

编译通过，运行期在 `k1 == k2` 处触发 **`panic`**（`comparing uncomparable type []int`）。

自 Go 1.20 起，`any` 和普通接口都满足 `comparable` 约束，因此 `Key[any]` 合法且结构体本身可做 `==` 比较。但比较到 `Meta` 字段时，两边接口内部包裹的动态类型都是不可比较的切片 `[]int`，于是在运行期崩溃。

</details>

### 面试题 4：方法能不能声明自己的类型参数？接口里呢？

分别判断下面两段声明在 Go 1.27 下能否通过编译：

```go
type Box[T any] struct{ Val T }

// 声明 A
func (b Box[T]) Convert[U any](f func(T) U) Box[U] {
	return Box[U]{Val: f(b.Val)}
}

// 声明 B
type Transformer[T any] interface {
	Convert[U any](func(T) U) Box[U]
}
```

<details>
<summary>查看参考答案</summary>

在模块语言版本为 **Go 1.27+** 时，**声明 A 可以通过编译**，**声明 B 编译失败**（报错 `interface method must have no type parameters`）。

Go 1.18～1.26 曾一刀切禁止方法声明独立的类型参数（若 `go.mod` 为 `go 1.26` 或更低版本，声明 A 也会报错）；Go 1.27 放开了具体定义类型上的泛型方法，因此声明 A 合法。但接口方法至今不允许声明自己的类型参数，而且具体类型的泛型方法也不能用来满足接口中的非泛型方法。

</details>

## 参考资料

- [Go 语言规范：类型参数声明（Type parameter declarations）](https://go.dev/ref/spec#Type_parameter_declarations)
- [Go 语言规范：方法声明与泛型方法（Method declarations）](https://go.dev/ref/spec#Method_declarations)
- [Go 语言规范：接口类型与类型集合（Interface types）](https://go.dev/ref/spec#Interface_types)
- [Go 语言规范：比较运算与 `comparable`（Comparison operators）](https://go.dev/ref/spec#Comparison_operators)
- [Go 1.18 发布说明：泛型（Generics）](https://go.dev/doc/go1.18#generics)
- [Go 1.20 发布说明：`comparable` 约束放宽](https://go.dev/doc/go1.20#language)
- [Go 1.24 发布说明：泛型类型别名](https://go.dev/doc/go1.24#language)
- [Go 标准库 `cmp`：`Ordered` 约束与比较函数](https://pkg.go.dev/cmp)
- [Go 标准库 `slices`：泛型切片工具](https://pkg.go.dev/slices)
- [Go 标准库 `maps`：泛型映射工具](https://pkg.go.dev/maps)
- [Go 标准库 `iter`：迭代器类型](https://pkg.go.dev/iter)
- [Go 标准库 `sync`：`OnceValue` 与 `OnceValues`](https://pkg.go.dev/sync#OnceValue)
- [Go 官方博客：When To Use Generics](https://go.dev/blog/when-generics)
