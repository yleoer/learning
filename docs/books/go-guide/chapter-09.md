---
title: 第 9 章 泛型
description: 掌握泛型类型与函数、接口与 ~ 类型集合约束、comparable 运行期边界、Go 1.27 泛型方法及标准库泛型实践。
---

# 第 9 章 泛型

## 本章要点

当容器或算法需要适配多种数据类型、又希望在编译期守住同构类型安全并省去 `any` 装箱断言时，应当使用**泛型**（Generics，Go 1.18+）。本章从泛型栈的零值与防泄漏细节、泛型函数的类型推断边界讲起，系统梳理方法约束、类型集合、`~` 底层类型匹配、`cmp.Ordered` 与常量可表示性规则，最后剖析 `comparable` 遇到接口实参时的运行期陷阱、Go 1.27 新增的具体类型泛型方法边界，以及泛型与接口的工程选型标准。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 9.1 泛型类型与泛型函数 {#ch9-1}

没有类型参数时，通用数据结构若靠接收 `any` 的接口方法比较元素，就无法在编译期阻止调用方往同一容器里混塞不同具体类型。泛型通过在类型或函数声明上引入**类型参数列表** `[T Constraint]`，将同构类型检查前移到编译期。

### 9.1.1 泛型类型与零值处理 {#ch9-1-1}

泛型类型将类型参数写在类型名后的方括号内。下面实现一个支持任意元素类型的后进先出栈 `Stack[T any]`：

```go
type Stack[T any] struct{ vals []T }

func (s *Stack[T]) Push(val T) { s.vals = append(s.vals, val) }

func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.vals) == 0 {
		return zero, false
	}
	idx := len(s.vals) - 1
	top := s.vals[idx]
	s.vals[idx] = zero // 清空弹出槽位，防止指针元素残留引用
	s.vals = s.vals[:idx]
	return top, true
}
```

实例化为 `var s Stack[int]` 后，任何非 `int` 实参都会在编译期报错。编写泛型容器须牢记三条规则：

1. **接收者必须携带类型参数**：写作 `func (s *Stack[T]) Push(...)`，不可省略 `[T]`。
2. **用 `var zero T` 获取通用零值**：当 `T` 为 `int` 或结构体时无法返回 `nil`，声明 `var zero T` 即可按[零值规则](./chapter-02#ch2-1)安全构造任意类型的零值。
3. **缩容前清零底层槽位**：将 `s.vals[idx]` 重置为 `zero` 再截断长度，可避免 `T` 含指针或引用字段时被底层数组持续持有，详见 [3.2.3 节](./chapter-03#ch3-2-3)。

### 9.1.2 泛型函数与类型推断边界 {#ch9-1-2}

泛型函数把类型参数列表放在函数名与普通参数列表之间，调用时编译器通常能直接从实参自动推导类型实参：

```go
func Filter[T any](s []T, keep func(T) bool) (out []T) {
	for _, v := range s {
		if keep(v) {
			out = append(out, v)
		}
	}
	return out
}
fmt.Println(Filter([]int{1, 2, 3, 4}, func(n int) bool { return n%2 == 0 })) // [2 4]（标准库 "fmt"）
```

类型推断存在两处明确边界：

- **仅出现在返回值的类型参数无法从实参推导**：如 `func Convert[T1, T2 ~int | ~int64](in T1) T2`，因 `T2` 不在形参列表中，调用处必须显式写出 `Convert[int, int64](10)`。
- **泛型函数作为函数值传递时的双向推断边界**：若目标签名已固定具体类型，如 `var cmpInt func(int, int) int = cmp.Compare`，编译器可反向推导出 `[int]`——该能力自 Go 1.21 引入并在 Go 1.27 推广至全部涉及函数的赋值上下文；但若内外两侧均为未确定类型的泛型函数，仍须至少在一侧显式指定类型实参，如 `NewTree(cmp.Compare[int])`。

## 9.2 类型约束：接口、类型项与 ~ {#ch9-2}

在 Go 中，所有类型约束的语法载体都是接口。常用约束形态及其能力范围速查如下：

| 约束写法 | 匹配范围与允许的操作 | 能否作为普通变量类型 |
| --- | --- | --- |
| `any` | 任意类型；仅支持传参、赋值、取址与反射，不可做 `==` 或算术运算 | 能（即 `interface{}`） |
| `comparable` | 编译期允许 `==`、`!=` 及作映射键的类型；含普通接口类型（Go 1.20+） | 不能（仅作类型约束） |
| 普通方法接口（如 `fmt.Stringer`） | 方法集满足该接口的所有类型；可调用接口声明的方法 | 能 |
| 自引用泛型接口（如 `Differ[T]`） | 强制方法参数或返回值与实例化类型 `T` 本身严格一致 | 能（如 `Differ[Point]`） |
| 精确类型项（如 `int \| int64`） | 仅精确匹配列出的类型本身；支持集合内共有运算符 | 不能（仅作类型约束） |
| 近似类型项（如 `~int \| ~string`） | 匹配底层类型为指定类型的全部定义类型与原类型 | 不能（仅作类型约束） |
| `cmp.Ordered`（Go 1.21+） | 标准库 `"cmp"` 预置，覆盖全部原生支持 `<`、`<=`、`>`、`>=` 的整数、浮点数与字符串底层类型 | 不能（仅作类型约束） |

### 9.2.1 方法约束与自引用泛型接口 {#ch9-2-1}

普通接口可直接约束类型参数必须具备的方法；接口自身也可声明类型参数。通过在约束中写出自引用形式 `T Differ[T]`，即可在编译期强制要求元素只能与**同一种具体类型 `T`** 计算距离（另用标准库 `"math"`）：

```go
type Differ[T any] interface {
	fmt.Stringer
	Diff(T) float64
}
func Closer[T Differ[T]](target, a, b T) T {
	if target.Diff(a) <= target.Diff(b) {
		return a
	}
	return b
}
type Point struct{ X, Y float64 }
func (p Point) String() string      { return fmt.Sprintf("(%.0f,%.0f)", p.X, p.Y) }
func (p Point) Diff(q Point) float64 { return math.Hypot(p.X-q.X, p.Y-q.Y) }
fmt.Println(Closer(Point{0, 0}, Point{1, 1}, Point{3, 4})) // (1,1)
```

### 9.2.2 类型集合、~ 底层类型匹配与 cmp.Ordered {#ch9-2-2}

为了让泛型函数支持 `+`、`/`、`<` 等运算符，约束接口内部可用竖线 `|` 列出允许的**类型项**（Type Term）构成**类型集合**（Type Set）。不加前缀的类型项只精确匹配该类型本身；加上近似符号 **`~`** 则匹配所有**底层类型**为该类型的定义类型。注意 `~` 右侧自身必须是底层类型，可写 `~int`，不可写 `~Point` 或接口名：

```go
type Integer interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}
```

对于有序大小比较，直接复用标准库 `"cmp"`（Go 1.21+）的 `cmp.Ordered` 约束，配合为浮点 `NaN` 定义了确定全序的 `cmp.Compare(x, y)` 或 `cmp.Less(x, y)` 即可。约束接口还可将类型项与方法签名分列多行取**交集**：

```go
type PrintableInt interface {
	~int
	String() string // 要求底层类型为 int，并且实现了 String() 方法
}
```

此处 `~` 绝不能省：若误写为精确的 `int`，由于预声明 `int` 无法挂载方法，该接口的类型集合将退化为**空集**——接口声明本身虽语法合法，但任何具体类型都无法实例化它。

### 9.2.3 约束中的常量可表示性限制 {#ch9-2-3}

在泛型函数体内将无类型常量转换为类型参数 `T` 或与 `T` 运算时，编译器要求**该常量必须对 `T` 类型集合中的每一个成员类型都满足可表示性**：

```go
func AddHundred[T Integer](v T) T  { return v + 100 }  // 合法：100 在 int8 等全部成员范围内
// func AddThousand[T Integer](v T) T { return v + 1000 } // 编译错误：1000 超出 int8/uint8 范围
```

## 9.3 comparable 边界、泛型方法与工程选型 {#ch9-3}

### 9.3.1 comparable 遇到接口实参的运行期边界 {#ch9-3-1}

`comparable` 约束能在编译期拦截切片、映射和函数等不可比较的具体类型；但自 Go 1.20 起，为了支持 `Set[any]` 等以接口为元素的泛型容器，语言规范允许**普通接口类型**满足 `comparable`。这直接把 [8.3.2 节](./chapter-08#ch8-3-2)的接口判等风险带入了泛型函数——当类型实参被实例化为接口类型且内部装入不可比较动态值时，运行期执行 `==` 会当场 `panic`：

```go
func Same[T comparable](a, b T) bool { return a == b }

// Same([]int{1}, []int{1}) // 编译失败：[]int 不满足 comparable
var x, y any = []int{1}, []int{1}
// Same(x, y)               // 编译通过（T 为 any），运行期触发 panic！
```

### 9.3.2 泛型方法（Go 1.27+）与能力边界 {#ch9-3-2}

Go 刻意克制泛型复杂度，阅读与设计泛型 API 时需把握以下边界：

- **具体类型的泛型方法（Go 1.27+）**：在 Go 1.18～1.26 中方法不能声明独立类型参数；**自 Go 1.27 起**，模块 `go.mod` 指定 `go 1.27` 及以上版本时，具体定义类型的方法已允许声明自己的类型参数：

```go
func (s Stack[T]) MapTo[E any](f func(T) E) Stack[E] {
	out := Stack[E]{vals: make([]E, len(s.vals))}
	for i, v := range s.vals {
		out.vals[i] = f(v)
	}
	return out
}
```

- **接口方法仍禁止带类型参数**：接口内声明 `MapTo[E any](...)` 仍会编译报错 `interface method must have no type parameters`，且具体类型的泛型方法不参与普通接口方法集匹配。
- **其他设计边界**：不支持运算符重载、自定义下标 `[]` 和模板特化；自定义容器接入 `for range` 统一提供返回 `"iter"` 包 `iter.Seq` / `iter.Seq2` 的迭代器方法（Go 1.23+），详见 [4.3.3 节](./chapter-04#ch4-3-3)；泛型类型别名如 `type Set[T comparable] = map[T]struct{}` 自 Go 1.24 起支持。

### 9.3.3 何时用泛型、何时用接口及标准库泛型包 {#ch9-3-3}

工程选型遵循三条准则：

1. **同构容器与保型算法用泛型**：需原样保留调用方具体类型、避免 `any` 类型断言或直接使用运算符时选择泛型。
2. **异构集合与行为解耦用接口**：同一切片需混装多种不同实现，或仅依赖一两个契约方法时继续使用普通小接口。
3. **切勿为“去虚化提速”盲目将接口参数改为泛型约束**：官方编译器按内存形状（GC Shape）共享机器码，指针实参共用函数体并经内部字典查表调用方法；把 `func read(r io.Reader)` 改成 `func read[R io.Reader](r R)` 未内联时反而可能更慢，性能取舍须以[基准测试](./chapter-17#ch17-4-2)为准。

日常开发应优先复用标准库泛型包：

| 标准库包 | 核心泛型能力与起始版本 |
| --- | --- |
| `"cmp"` | `Ordered` 约束、`Compare`、`Less`（Go 1.21+），以及返回首个非零值的 `Or`（Go 1.22+） |
| `"slices"` | `Sort`、`SortFunc`、`BinarySearch`、`Contains`、`Clone`、`Clip`、`Delete`、`Equal`（Go 1.21+）；迭代器衔接 `Collect`、`Sorted`、`Values`（Go 1.23+） |
| `"maps"` | `Clone`、`Copy`、`DeleteFunc`、`Equal`（Go 1.21+）；迭代器衔接 `Keys`、`Values`、`All`、`Collect`（Go 1.23+） |
| `"iter"` | `Seq[V]`、`Seq2[K, V]` 迭代器函数签名与 `Pull`、`Pull2`（Go 1.23+） |
| `"sync"` | `OnceValue`、`OnceValues` 并发安全单次延迟初始化（Go 1.21+） |
| `"errors"` | `AsType[E](err)`（Go 1.26+）：按目标错误类型安全拆包错误树，详见 [10.2.2 节](./chapter-10#ch10-2-2) |

## 练习 {#ch9-exercises}

以下 2 道练习检验 `~` 数值与方法组合约束设计以及泛型二叉搜索树实现。代码位于 `package main`，`fmt`、`cmp` 对应同名标准库包。建议先独立编写，再展开核对参考答案。

### 练习 1：用 `~` 编写数值限幅函数与 `Printable` 组合约束

定义覆盖全部内置及自定义整数、浮点数的约束 `Number`，实现将输入限制在 `[low, high]` 闭区间内的 `Clamp[T Number](v, low, high T) T`；再定义要求底层类型为 `int` 或 `float64` 且实现 `fmt.Stringer` 的组合约束 `Printable`，定义一个满足它的自定义类型并实现 `FormatValue[T Printable](v T) string`。

<details>
<summary>查看参考答案</summary>

```go
type Number interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr | ~float32 | ~float64
}
func Clamp[T Number](v, low, high T) T {
	if v < low {
		return low
	}
	if v > high {
		return high
	}
	return v
}
type Printable interface {
	~int | ~float64
	fmt.Stringer
}
type Celsius float64
func (c Celsius) String() string          { return fmt.Sprintf("%.1fC", float64(c)) }
func FormatValue[T Printable](v T) string { return v.String() }
```

两处约束均须加 `~`：`Clamp` 借此直接支持 `Celsius` 等定义类型；而 `Printable` 若省去 `~`，预声明 `int` 与 `float64` 无法挂载方法，类型集合会退化为空集。

</details>

### 练习 2：结合比较函数与方法表达式实现泛型二叉搜索树

定义泛型比较函数 `OrderFunc[T any] func(a, b T) int`，返回值小于 `0`、大于 `0`、`0` 分别代表小于、大于、等于；实现泛型二叉搜索树 `Tree[T]`、`NewTree[T]`、`Add(v T)` 与 `Contains(v T) bool`，并演示传入 `cmp.Compare[int]` 与结构体方法表达式 `User.Order`。

<details>
<summary>查看参考答案</summary>

```go
type OrderFunc[T any] func(a, b T) int

type node[T any] struct {
	val         T
	left, right *node[T]
}

type Tree[T any] struct {
	cmp  OrderFunc[T]
	root *node[T]
}

func NewTree[T any](cmpFn OrderFunc[T]) *Tree[T] { return &Tree[T]{cmp: cmpFn} }
func (t *Tree[T]) Add(v T)                       { t.root = t.root.add(t.cmp, v) }
func (t *Tree[T]) Contains(v T) bool             { return t.root.contains(t.cmp, v) }

func (n *node[T]) add(cmpFn OrderFunc[T], v T) *node[T] {
	if n == nil {
		return &node[T]{val: v}
	}
	if c := cmpFn(v, n.val); c < 0 {
		n.left = n.left.add(cmpFn, v)
	} else if c > 0 {
		n.right = n.right.add(cmpFn, v)
	}
	return n
}

func (n *node[T]) contains(cmpFn OrderFunc[T], v T) bool {
	if n == nil {
		return false
	}
	c := cmpFn(v, n.val)
	return (c < 0 && n.left.contains(cmpFn, v)) || (c > 0 && n.right.contains(cmpFn, v)) || c == 0
}

type User struct{ Name string }

func (u User) Order(other User) int { return cmp.Compare(u.Name, other.Name) }
```

`NewTree` 与 `cmp.Compare` 两侧均为泛型函数，故需写成 `NewTree(cmp.Compare[int])`；而方法表达式 `User.Order` 的类型已是确定的 `func(User, User) int`，编译器可直接推导出 `Tree[User]`。

</details>

## 面试题 {#ch9-interview}

以下 3 道面试题考查 `~` 与空类型集陷阱、`comparable` 接口擦除盲区以及 Go 1.27 泛型方法与接口的语法边界，代码约定同[练习部分](#ch9-exercises)。建议先独立判断，再展开核对参考答案。

### 面试题 1：约束里的 `int` 与 `~int` 有何区别？下面这段声明能编译和实例化吗？

```go
type MyInt int
func (MyInt) String() string { return "myint" }

type BadConstraint interface {
	int
	String() string
}
type Box[T BadConstraint] struct{ Val T }
```

分别判断声明 `BadConstraint` / `Box`、实例化 `Box[int]{}` 与 `Box[MyInt]{}` 的编译结果。

<details>
<summary>查看参考答案</summary>

**声明 `BadConstraint` 和 `Box` 可通过编译，但 `Box[int]{}` 与 `Box[MyInt]{}` 均编译失败。** 精确类型项 `int` 不匹配定义类型 `MyInt`，而内置 `int` 又不可能拥有 `String()` 方法，导致 `BadConstraint` 的类型集合为空集；将 `int` 改为 `~int` 后 `Box[MyInt]{}` 即可通过编译。

</details>

### 面试题 2：通过了 `comparable` 编译检查的泛型结构体，执行 `==` 一定不会 `panic` 吗？

写出下面代码的编译与运行结果并说明原因。

```go
type Entry[K comparable] struct{ Key K }

a, b := Entry[any]{Key: []string{"a"}}, Entry[any]{Key: []string{"a"}}
fmt.Println(a == b)
```

<details>
<summary>查看参考答案</summary>

**编译通过，运行期触发 `panic`**，报错 `comparing uncomparable type []string`。自 Go 1.20 起普通接口（含 `any`）满足 `comparable`，故 `Entry[any]` 合法；但运行期比较 `Key` 字段时，两侧 `any` 内部的动态值均为不可比较的切片 `[]string`，从而触发运行期崩溃。

</details>

### 面试题 3：具体类型方法与接口方法在声明独立类型参数上有何边界？

判断下面声明 A 与声明 B 在 Go 1.27 模块下各自能否通过编译，并说明版本边界。

```go
type Holder[T any] struct{ Val T }
func (h Holder[T]) Transform[U any](fn func(T) U) Holder[U] { return Holder[U]{Val: fn(h.Val)} } // 声明 A

type Mapper[T any] interface {
	Transform[U any](func(T) U) Holder[U] // 声明 B
}
```

<details>
<summary>查看参考答案</summary>

在 **Go 1.27+** 模块下，**声明 A 编译通过，声明 B 编译失败**并报错 `interface method must have no type parameters`。在 Go 1.18～1.26 中声明 A 也会因不支持泛型方法而报错；Go 1.27 放开了具体定义类型的方法声明独立类型参数，但接口方法至今仍禁止携带类型参数。

</details>

## 参考资料

- [Go 语言规范：类型参数声明与类型推断](https://go.dev/ref/spec#Type_parameter_declarations)
- [Go 语言规范：接口类型集合与 `~` 底层类型项](https://go.dev/ref/spec#Interface_types)
- [Go 语言规范：方法声明与泛型方法](https://go.dev/ref/spec#Method_declarations)
- [Go 1.20 发布说明：`comparable` 约束规则更新](https://go.dev/doc/go1.20#language)
- [Go 标准库 `cmp`、`slices` 与 `maps`](https://pkg.go.dev/slices)
- [Go 官方博客：When To Use Generics](https://go.dev/blog/when-generics)
