---
title: 第 7 章 自定义类型、方法与组合
description: 掌握定义类型与类型别名的差异、值与指针接收者选择标准，以及结构体内嵌组合与类继承的本质边界。
---

# 第 7 章 自定义类型、方法与组合

## 本章要点

Go 没有类继承体系，而是通过**定义类型与方法**为数据结构绑定领域行为，再借助**结构体内嵌**实现扁平化的字段与方法复用。本章先对比定义类型与类型别名在类型转换和方法归属上的边界，接着梳理值接收者与指针接收者的选择标准、`nil` 指针接收者递归及方法值与方法表达式，最后拆解结构体内嵌的提升机制与“内嵌不是继承”的三条核心红线。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Linux/AMD64。

## 7.1 定义类型与类型别名 {#ch7-1}

除了用 `struct` 组织字段，Go 允许基于任意内置类型或复合类型声明全新的**定义类型**（Defined Type），也可使用带等号的语法声明**类型别名**（Type Alias，Go 1.9+）：

```go
type Score int          // 定义类型：独立于 int 的新类型
type HighScore Score    // 定义类型：基于 Score 再创建新类型，不继承 Score 的方法
type ScoreAlias = Score // 类型别名：与 Score 完全是同一个类型

func (s Score) Valid() bool { return s >= 0 }
```

无类型常量只要落在可表示范围内即可直接赋给兼容的定义类型，详见 [2.3.1 节](./chapter-02#ch2-3-1)；结合整型定义类型与 `iota` 还可表达进程内部枚举，见 [2.3.2 节](./chapter-02#ch2-3-2)。而不同定义类型的变量之间传递必须显式转换，如 `HighScore(score)`。两类声明的核心差异如下：

| 对比维度 | 定义类型 `type A B` | 类型别名 `type A = B` |
| --- | --- | --- |
| 类型身份 | 创造与 `B` 截然不同的新类型 | 仅为 `B` 增加同义词，编译期与 `B` 完全等价 |
| 变量直接互赋 | 禁止，底层类型相同时须显式写 `A(b)` | 允许直接混用与互赋，无需转换 |
| 挂载新方法 | 可在定义所在包为 `A` 声明专属方法 | 等同于直接给原类型 `B` 加方法，须受同包规则约束 |
| 原类型 `B` 的方法 | **一律不继承** `B` 已声明的方法 | 完全共享 `B` 的全部方法集 |
| 典型用途 | 隔离 `UserID`、`Score` 等领域概念并绑定行为 | 跨包重构平滑迁移 API，见 [11.1.3 节](./chapter-11#ch11-1-3) |

## 7.2 方法声明与接收者选择 {#ch7-2}

方法通过在 `func` 与方法名之间添加**接收者**（Receiver）绑定到具体类型，受三条硬性语法约束：**同包限制**要求方法必须与接收者类型声明在同一包内，不能跨包为内置或标准库类型加方法；**基类型限制**要求 `T` 或 `*T` 的基类型 `T` 不能是指针或接口；此外同一类型下**无方法重载**。接收者参数名惯例取类型名首字母小写（如 `Counter` 取 `c`），不用 `this` 或 `self`；读取方法直接命名为 `Total()`，不加 `Get` 前缀。

### 7.2.1 值接收者与指针接收者 {#ch7-2-1}

接收者本质上是方法的第一个参数，同样遵循按值传递。选择值接收者 `T` 还是指针接收者 `*T` 按以下四条标准判断：

- **需要修改接收者状态，或内部含有 `sync.Mutex` 等不可复制字段**：必须使用 `*T`，锁拷贝禁令见 [6.3.1 节](./chapter-06#ch6-3-1)；
- **需要把 `nil` 指针当作合法输入状态处理**：必须使用 `*T`；
- **结构体体积较大，或该类型已有其他方法采用指针接收者**：通常统一使用 `*T`，保持方法集一致；
- **体积小、具备天然不可变语义且全部方法只读**：如标准库 `"time"` 的 `time.Time`，适合使用值接收者 `T`。

```go
type Counter struct{ total int }

func (c *Counter) Increment() { c.total++ }
func (c Counter) Total() int  { return c.total }
```

直接通过变量调用方法时，编译器提供双向语法糖：对**可寻址**的值变量调指针方法自动改写为 `(&c).Increment()`；对指针变量调值方法自动改写为 `(*pc).Total()`。注意两道边界：一是结构体字面量 `Counter{}.Increment()` 与映射下标 `m["k"].Increment()` 均不可寻址，调用指针方法会编译报错；二是语法糖不改变类型的方法集，接口赋值规则见 [8.1.2 节](./chapter-08#ch8-1-2)。

### 7.2.2 nil 指针接收者与方法值、方法表达式 {#ch7-2-2}

指针变量为 `nil` 时，调用其**指针接收者**方法不会立即崩溃，而是将 `nil` 原样传入方法体；通过 `nil` 指针调用**值接收者**方法则会因隐式解引用而直接 `panic`。利用该特性可写出紧凑的递归链表，但注意首次插入时接收者 `l` 只是指针值副本，新表头地址必须由返回值传回：

```go
type IntList struct {
	val  int
	next *IntList
}

func (l *IntList) Prepend(v int) *IntList { return &IntList{val: v, next: l} }
func (l *IntList) Sum() int {
	if l == nil {
		return 0
	}
	return l.val + l.next.Sum()
}

var head *IntList
fmt.Println(head.Prepend(20).Prepend(10).Sum()) // 30（标准库 "fmt"）
```

方法还可转化为普通函数值：**方法值**（`instance.Method`）绑定具体实例并省去接收者形参，值接收者方法在求值当刻就会浅复制并封存当时的实例副本；**方法表达式**如 `Type.Method` 或 `(*Type).Method` 则将接收者提升为显式的第一个形参：

```go
type Adder struct{ base int }

func (a Adder) AddTo(v int) int { return a.base + v }

adder := Adder{base: 10}
fnVal, fnExpr := adder.AddTo, Adder.AddTo
adder.base = 99
fmt.Println(fnVal(5), fnExpr(adder, 5)) // 15 104
```

## 7.3 结构体内嵌与组合边界 {#ch7-3}

### 7.3.1 字段与方法提升 {#ch7-3-1}

在结构体声明中只写类型名、省略字段名，即构成**内嵌字段**（Embedded Field）。被内嵌类型的字段与方法会被提升（Promote）到外层结构体，可直接通过外层实例点号访问：

```go
type Employee struct{ Name, ID string }

func (e Employee) Label() string { return e.Name + "#" + e.ID }

type Manager struct {
	Employee
	Department string
}

m1 := Manager{Employee: Employee{Name: "Ada", ID: "01"}, Department: "Core"}
m2 := Manager{Name: "Bob", ID: "02", Department: "Infra"} // Go 1.27+：可直接填写非指针内嵌的提升字段名
fmt.Println(m1.ID, m2.Label())                            // 01 Bob#02
```

在 Go 1.26 及更早语言版本中，复合字面量必须按层级写出 `Employee: Employee{...}`；自 **Go 1.27** 起，带键结构体字面量支持直接填写沿非指针内嵌路径提升的字段名，前提是不在同一字面量中同时显式指定外层 `Employee` 字段。若外层定义了同名字段或方法，外层成员会遮蔽内层成员，可通过 `m1.Employee.Name` 显式访问内层。

### 7.3.2 内嵌不是继承：无动态重写与导出契约风险 {#ch7-3-2}

结构体内嵌只是编译期生成字段与方法转发的组合语法糖，与面向对象子类型继承存在三条本质区别：

1. **无子类型互赋**：`Manager` 不能当作 `Employee` 传参或赋值，必须显式取字段 `m1.Employee`。
2. **无虚方法重写与动态派发**：调用提升方法进入内嵌类型后，接收者静态类型固定为内嵌类型本身，内部自调用永远静态绑定内层方法，绝不会跳到外层同名方法；需运行期替换行为时应持有接口或函数字段：

```go
type Base struct{}
func (Base) Role() string       { return "base" }
func (b Base) Describe() string { return "role:" + b.Role() }
type Admin struct{ Base }
func (Admin) Role() string      { return "admin" }
fmt.Println(Admin{}.Role(), Admin{}.Describe()) // 输出 "admin role:base"，而非 "role:admin"
```

3. **警惕导出结构体的公开契约泄漏**：匿名内嵌会将被内嵌类型未被遮蔽且无歧义的导出字段与方法提升到外层公开 API，并可能令外层类型意外满足相关接口，同时令 `"encoding/json"` 默认把内嵌字段拍平到顶层对象中，见 [16.1.1 节](./chapter-16#ch16-1-1)。不过提升受三条规则约束：外层声明的同名字段或方法会**遮蔽（Shadowing）**内层成员；同一最浅深度若有多个内嵌类型包含同名成员，会产生**同层歧义而不自动提升**；方法最终是否进入外层方法集并决定接口实现，还取决于内嵌形式（值内嵌或指针内嵌）以及外层的值/指针方法集规则，详见 [8.1.2 节](./chapter-08#ch8-1-2)。典型反例是在导出结构体里内嵌 `sync.Mutex`——尽管外层值类型不含 `*sync.Mutex` 的指针方法，但外层指针 `*T` 及可寻址值均会直接暴露出 `Lock()` / `Unlock()` 方法；互斥锁应始终声明为未导出的具名字段 `mu sync.Mutex`。

## 练习 {#ch7-exercises}

以下 2 道练习检验 `nil` 指针接收者树结构递归实现与自定义结构体方法设计。代码位于 `package main`，`fmt`、`slices`、`cmp` 对应同名标准库包。建议先独立编写，再展开核对参考答案。

### 练习 1：实现支持 `nil` 接收者的有序整数二叉树

定义整数二叉搜索树节点 `IntTree`，实现 `Insert(val int) *IntTree` 与 `Contains(val int) bool` 两个指针接收者方法，使未初始化的 `var root *IntTree` 可直接调用 `root = root.Insert(5)` 插入数据并调用 `root.Contains(5)` 查找，全程不触发 `panic`；说明为什么 `Insert` 必须返回 `*IntTree`。

<details>
<summary>查看参考答案</summary>

```go
type IntTree struct {
	val         int
	left, right *IntTree
}

func (t *IntTree) Insert(val int) *IntTree {
	if t == nil {
		return &IntTree{val: val}
	}
	if val < t.val {
		t.left = t.left.Insert(val)
	} else if val > t.val {
		t.right = t.right.Insert(val)
	}
	return t
}

func (t *IntTree) Contains(val int) bool {
	if t == nil {
		return false
	}
	return val == t.val || (val < t.val && t.left.Contains(val)) || (val > t.val && t.right.Contains(val))
}
```

接收者 `t` 是按值传递的指针副本。空树或空叶子分支首次创建节点时，若在方法内只写 `t = &IntTree{val: val}`，仅修改了局部副本，调用方的 `root` 或父节点的左右指针仍是 `nil`，因此必须将新节点地址通过返回值传回并重新赋值。

</details>

### 练习 2：定义联赛结构体与积分排名方法

定义包含 `Name string`、`Players []string` 字段的 `Team` 结构体，以及包含 `Teams []Team`、`Wins map[string]int` 字段的 `League` 结构体。为 `League` 实现：`MatchResult(first string, firstScore int, second string, secondScore int) error` 记录胜方胜场加 `1`，平局不计分，队名未知时返回错误；`Ranking() []string` 按胜场数**降序**返回队名切片，胜场相同时按字典序**升序**排列。

<details>
<summary>查看参考答案</summary>

```go
type Team struct {
	Name    string
	Players []string
}

type League struct {
	Teams []Team
	Wins  map[string]int
}

func (l *League) MatchResult(first string, firstScore int, second string, secondScore int) error {
	has := func(name string) bool {
		return slices.ContainsFunc(l.Teams, func(t Team) bool { return t.Name == name })
	}
	if !has(first) || !has(second) {
		return fmt.Errorf("unknown team: %q vs %q", first, second)
	}
	if l.Wins == nil {
		l.Wins = make(map[string]int, len(l.Teams))
	}
	if firstScore > secondScore {
		l.Wins[first]++
	} else if secondScore > firstScore {
		l.Wins[second]++
	}
	return nil
}

func (l *League) Ranking() []string {
	if l == nil {
		return nil
	}
	names := make([]string, 0, len(l.Teams))
	for _, t := range l.Teams {
		names = append(names, t.Name)
	}
	slices.SortFunc(names, func(a, b string) int {
		if d := cmp.Compare(l.Wins[b], l.Wins[a]); d != 0 {
			return d
		}
		return cmp.Compare(a, b)
	})
	return names
}
```

两个方法统一使用指针接收者 `*League`：零值 `League` 的 `Wins` 为 `nil` 映射，`MatchResult` 写入前必须初始化并写回字段 `l.Wins`，而 `Ranking` 读取 `nil` 映射会安全返回零值 `0`，同时首行 `l == nil` 保证了空指针接收者调用不崩溃。

</details>

## 面试题 {#ch7-interview}

以下 3 道面试题考查定义类型与类型别名边界、不可寻址值的方法调用限制以及结构体内嵌的静态绑定行为，代码约定同[练习部分](#ch7-exercises)。建议先独立作答，再展开核对参考答案。

### 面试题 1：定义类型与类型别名 `=` 在方法归属和互赋上有何区别？

判断下面两处赋值与两处 `Valid()` 调用能否通过编译，并说明原因。

```go
type Score int
func (s Score) Valid() bool { return s >= 0 }
type HighScore Score
type AliasScore = Score

var s Score = 10
var a HighScore = s
var b AliasScore = s
_, _ = a.Valid(), b.Valid()
```

<details>
<summary>查看参考答案</summary>

**`var a HighScore = s` 和 `a.Valid()` 编译失败；`var b AliasScore = s` 和 `b.Valid()` 编译通过。** `type HighScore Score` 声明了独立的新定义类型，赋值须显式写 `HighScore(s)`，且**不会继承** `Score` 上的 `Valid()` 方法；`type AliasScore = Score` 是类型别名，与 `Score` 完全等价并共享全部方法集。

</details>

### 面试题 2：为什么 `map[string]Counter` 的元素不能直接调用指针接收者方法？

判断下面最后两行能否通过编译，并给出修复方案。

```go
type Counter struct{ n int }
func (c *Counter) Inc() { c.n++ }

m := map[string]Counter{"hits": {}}
m["hits"].Inc()
Counter{}.Inc()
```

<details>
<summary>查看参考答案</summary>

**最后两行均编译失败**，报错 `cannot call pointer method Inc on Counter`。自动补 `&` 的语法糖仅适用于可寻址值；字面量 `Counter{}` 是临时右值，映射下标 `m["hits"]` 因扩容可能搬迁底层桶而禁止取址。修复方式：先拷出局部变量修改后再写回映射 `c := m["hits"]; c.Inc(); m["hits"] = c`，或直接声明为 `map[string]*Counter`。

</details>

### 面试题 3：内嵌结构体与外层有同名方法时，内部互调会跳到外层方法吗？

写出下面代码的输出结果并说明原因。

```go
type Worker struct{}
func (Worker) Name() string  { return "worker" }
func (w Worker) Run() string { return "run:" + w.Name() }

type CustomWorker struct{ Worker }
func (CustomWorker) Name() string { return "custom" }

fmt.Println(CustomWorker{}.Name(), CustomWorker{}.Run())
```

<details>
<summary>查看参考答案</summary>

输出 `custom run:worker`。结构体内嵌不是类继承，不存在虚方法动态重写：直接调 `CustomWorker{}.Name()` 时外层方法遮蔽内层返回 `"custom"`；而 `Run()` 转发进入 `Worker.Run` 后，接收者 `w` 的静态类型为 `Worker`，内部 `w.Name()` 在编译期已静态绑定到 `Worker.Name()`。

</details>

## 参考资料

- [Go 语言规范：类型声明与类型别名](https://go.dev/ref/spec#Type_declarations)
- [Go 语言规范：方法声明与选择器提升规则](https://go.dev/ref/spec#Method_declarations)
- [Go 语言规范：结构体复合字面量](https://go.dev/ref/spec#Composite_literals)
- [Effective Go：方法与内嵌组合](https://go.dev/doc/effective_go#embedding)
