---
title: 第 10 章 模块、包和导入
description: 理解仓库、模块与包的层级边界，掌握 go.mod 版本控制、internal 可见性、语义导入版本升级与工作区协作。
---

# 第 10 章 模块、包和导入

## 本章要点

单文件示例代码跑通之后，真正维护工程马上就会遇到代码组织与依赖治理问题：怎么切分包才不会缠成循环依赖？怎么让模块内部共享代码却不对外暴露承诺？第三方库升级破坏兼容时如何平滑过渡？本章从仓库、模块、包三层关系出发，依次梳理 `go.mod` 的语言版本与依赖指令、导出规则与包命名、文档注释、`internal` 目录可见边界、最小版本选择（MVS）与 `/vN` 主版本路径，最后结合 `replace`/`exclude`/`retract` 指令、多模块工作区（`go.work`）以及模块代理与校验和数据库，串起从拆包到发布的完整链路。

> 核对日期：2026 年 11 月 5 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 10.1 仓库、模块和包 {#ch10-1}

Go 组织源码靠三个粒度逐级收敛的概念：

- **仓库（Repository）**：Git 等版本控制系统里的一个代码库；
- **模块（Module）**：由根目录 `go.mod` 界定的版本管理与发布单元，包含一个或多个包；
- **包（Package）**：同一个目录下共同编译的一组 `.go` 源文件，是导入、命名空间与访问控制的最小单位。

虽然一个 Git 仓库里技术上可以放多个 `go.mod`（一仓多模块），但除非有极特殊的独立版本演进需求，平时应坚持**一仓一模块**——多模块同仓会让打标签、跨模块改动和版本推导平白复杂好几倍。

模块靠**模块路径（Module Path）**在全球生态里唯一标识，通常直接取代码托管地址（如 `github.com/jonbodner/proteus`）。像[第 1 章](./chapter-01#ch1-2-1)本地练手用的 `example.com/hello` 只适合不发布的实验代码；一旦准备推上远端供其他项目导入，就必须从一开始使用真实唯一的仓库路径。顺带留意跨语言术语错位：Node.js 或 Python 口中的“包（Package）”大体对应 Go 的**模块**，而 Go 的**包**更接近它们口中的子模块或目录级命名空间。

## 10.2 `go.mod` 的指令 {#ch10-2}

目录下只要有一份合法的 `go.mod`，这棵目录树就成了一个 Go 模块。日常应通过 `go mod init`、`go get`、`go mod tidy` 和 `go mod edit` 维护它，不要当成纯手写文本随便拼接：

```text
module github.com/learning-go-book-2e/money

go 1.27.1

require (
	github.com/learning-go-book-2e/formatter v0.0.0-20220918024742-1835a89362c9
	github.com/shopspring/decimal v1.3.1
)

require (
	github.com/fatih/color v1.13.0 // indirect
	golang.org/x/sys v0.0.0-20210630005230-0f9fa26af87c // indirect
)
```

### 10.2.1 `go` 指令控制语言版本与工具链 {#ch10-2-1}

`module` 声明当前模块的根导入路径；`go` 指令则同时承担两件事（自 Go 1.21 起确立）：一是声明构建本模块所需的**最低 Go 版本**（本地工具链偏旧时会结合 `toolchain` 指令与 `GOTOOLCHAIN` 按需切换，详见 [1.2.1 节](./chapter-01#ch1-2-1)），二是决定编译本模块源码时启用的**语言版本语义**。

“语言版本按模块各自独立生效”是 Go 能在保持兼容的前提下改进老语法瑕疵的关键。典型例子就是 [4.4.5 节](./chapter-04#ch4-4-5)讲过的 Go 1.22 循环变量按轮创建：假设你的主模块写着 `go 1.27.1`，而引用的某个老第三方库写着 `go 1.20`，同一套 Go 1.27 编译器在编主模块时启用每轮新变量语义，编那个第三方库时则照旧保持单变量复用语义——升级你自己的 `go` 版本绝不会把老依赖静默改出新行为。

### 10.2.2 `require` 指令与间接依赖 {#ch10-2-2}

`require` 块列出当前模块要求的依赖模块及**最低版本**（没有版本标签的提交会生成形如 `v0.0.0-时间戳-提交哈希前缀` 的伪版本号）。第一段不带注释的是你源码直接 `import` 的直接依赖；第二段带 `// indirect` 注释的是传递依赖（依赖的依赖），或者刚用 `go get pkg@version` 装进来、还没扫描源码确认引用的包。运行一次 `go mod tidy` 就会自动根据当前源码导入情况增删条目、校准 `// indirect` 标记并同步更新 `go.sum`。

除了这三条核心指令，`go.mod` 还支持控制运行期兼容默认值的 `godebug`（Go 1.23+）、固定开发工具版本的 `tool`（Go 1.24+，见 [11.2 节](./chapter-11#ch11-2)），以及 [10.5 节](#ch10-5)将展开的 `replace`、`exclude` 和 `retract`。

## 10.3 创建包 {#ch10-3}

### 10.3.1 导入与导出 {#ch10-3-1}

Go 不设 `public`、`private` 关键字，可见性完全看**标识符首字母大小写**：首字母为大写字母即对包外**导出（Exported）**，小写字母或 `_` 开头则仅在同一个包内部可见（同包的不同 `.go` 文件之间可直接互访未导出成员，无需 `import`）。一旦把类型、字段、函数或常量做成大写导出，它就成了对外契约的一部分，没有充分理由不要轻易导出内部辅助细节。

### 10.3.2 包声明与导入路径 {#ch10-3-2}

每个 `.go` 文件的非注释首行都必须写 `package 包名`。同一个目录下的全部源码文件必须声明相同的包名（唯一的例外是 [15.1.5 节](./chapter-15#ch15-1-5)的黑盒测试包 `xxx_test`）。

导入模块内其他子包或第三方包时，`import` 双引号里写的是**完整导入路径**（`模块路径 + 子目录相对路径`），而代码里调用时写的限定前缀则是对方源文件第一行声明的**包名**。下面在一个模块里放两个子目录 `math` 和 `do-format` 对比看看：

```go
// math/math.go
package math

func Double(a int) int {
	return a * 2
}
```

```go
// do-format/formatter.go
package format

import "fmt"

func Number(num int) string {
	return fmt.Sprintf("The number is %d", num)
}
```

模块根目录的 `main.go` 导入并调用它们：

```go
package main

import (
	"fmt"

	"github.com/learning-go-book-2e/package_example/do-format"
	"github.com/learning-go-book-2e/package_example/math"
)

func main() {
	num := math.Double(2)
	output := format.Number(num)
	fmt.Println(output) // The number is 4
}
```

注意看 `do-format`：导入路径最后一段虽然叫 `do-format`，代码里调的却是 `format.Number`——**决定默认调用前缀的是对方 `package` 声明的名字，不是目录名**！当然，为了让读者一眼看懂 `import` 列表，平时应尽量让**目录名与包名完全一致**；只有三种情况例外：可执行入口固定写 `package main`、仓库或目录名带了连字符 `-`（Go 标识符不能含连字符），或者主版本升级目录名为 `v2`、`v3`（见 [10.4.3 节](#ch10-4-3)）。另外，模块模式下不支持 `./foo` 这类相对路径导入；且 `import` 作用在[文件块](./chapter-04#ch4-1)而非包块，同包的两个文件若都要用 `"fmt"`，就得各自写 `import "fmt"`。

### 10.3.3 包的命名 {#ch10-3-3}

起包名记住两条最管用的经验：

- **全小写简短名词，坚决不建 `util`、`common`、`misc`、`base` 这类垃圾桶包**：看到 `util.ExtractNames` 谁也不知道它在干嘛；按职责拆成名词包 `names`，里面放动词函数 `names.Extract`、`names.Format`，职责边界一下子就清爽了。
- **导出的名字别把包名再复读一遍**：调用处本来就要写包名前缀，`names.Extract` 干净利落，写成 `names.ExtractNames` 或 `http.HTTPServer` 纯属啰嗦（整个包的核心主类型与包同名是合理惯例，比如 `context.Context`、`bytes.Buffer`）。同时尽量避开跟常用标准库同名的包名（比如上面的演示包起名叫 `math`，在同一个文件里如果还想用标准库 `"math"` 就非得重命名不可）。

### 10.3.4 重命名导入与空白导入 {#ch10-3-4}

当同一个源文件确实需要导入两个包名撞车的包（或者包名被局部变量隐藏又不便改变量名）时，可以在导入路径左边写一个本文件专用的别名。最经典的场景就是同时使用加密随机包 `"crypto/rand"` 和伪随机包 `"math/rand/v2"`（Go 1.22+）——两者的包声明都叫 `rand`：

```go
import (
	crand "crypto/rand"
	"math/rand/v2"
)

func newSeededRand() *rand.Rand {
	var seed [32]byte
	_, _ = crand.Read(seed[:]) // 自 Go 1.24 起 crypto/rand.Read 保证填满切片且永不返回非 nil 错误
	return rand.New(rand.NewChaCha8(seed))
}
```

还有两个特殊前缀符号：

- **空白导入 `_ "pkg"`**：只触发该包的包级变量初始化与 `init` 函数，不在当前文件引入包名（见 [10.3.10 节](#ch10-3-10)）；
- **点导入 `. "pkg"`**：把对方所有导出标识符直接摊平进当前文件作用域，省掉包名前缀，但一眼看不出标识符到底来自哪里，而且对方新增导出符号还可能把你的代码撞挂，日常切勿使用。

### 10.3.5 文档注释与 `go doc` {#ch10-3-5}

Go 直接从源码注释提取 API 文档，不用维护一套花哨的标签语法，核心排版约定就几条：

- 注释必须**紧贴**在 `package` 或导出声明上方，中间**不能隔空行**；每行 `//` 后留一个空格；
- 包注释以 `// Package <包名> ...` 开头（篇幅较长时单独放进同包下的 `doc.go`）；导出函数、类型、常量的注释第一句以该标识符自己的名字开头，方便摘要索引截取；
- 空注释行 `//` 分段；缩进注释行渲染成代码块；`# 标题`（Go 1.19+）生成小节标题；`[Symbol]`、`[pkg.Symbol]` 自动生成包内或跨包 API 跳转链接，`[文本]` 配文末 `[文本]: https://...` 生成外部链接：

```go
// Package convert provides helpers for converting money between currencies.
package convert

// Convert converts from into the target currency identified by to.
//
// Supported currency codes:
//   - USD - US Dollar
//   - EUR - Euro
//
// See [Investopedia] for background on exchange rates.
//
// [Investopedia]: https://www.investopedia.com/terms/e/exchangerate.asp
func Convert(from Money, to string) (Money, error) {
	// ...
}
```

终端里随时可以用 `go doc convert` 或 `go doc convert.Convert` 查阅文档；想在本地浏览器预览和 `pkg.go.dev` 一模一样的网页排版，装一个官方 `pkgsite` 在模块根目录跑起来即可：

```sh
$ go install golang.org/x/pkgsite/cmd/pkgsite@latest
$ pkgsite
```

### 10.3.6 `internal` 包 {#ch10-3-6}

想在自己模块的几个包之间共享一段辅助代码，又不想把它暴露给外部模块当成公开 API 依赖，就把它放进名为 **`internal`** 的目录里。`go` 工具链在编译期强制执行一条目录前缀规则：**`.../a/internal/...` 下的任何包，只允许导入路径以 `.../a` 开头的包（即 `internal` 的直接父目录 `a` 本身，以及 `a` 下面的所有子孙目录）导入**。

拿下面的目录树对照就一目了然：

```text
foo/
  internal/
    secret/
  sibling/
bar/
```

`foo` 和 `foo/sibling` 都落在 `foo` 这棵子树下，可以正常导入 `foo/internal/secret`；而外面的 `bar`（以及模块根包）不在 `foo` 子树内，一旦写 `import ".../foo/internal/secret"`，编译器会直接报错 `use of internal package ... not allowed`。日常写业务服务或库时，拿不准要不要对外公开的代码一律先塞进 `internal/`——日后真需要开放，挪个目录就行；反过来一旦直接暴露出去，再想收回就得升主版本号了。

### 10.3.7 禁止循环依赖 {#ch10-3-7}

Go 编译器严格禁止任何直接或间接的包循环依赖（A 导入 B，B 又导入 A，或 A → B → C → A），一旦出现立刻报错 `import cycle not allowed`。这项铁律是 Go 编译极快、包职责边界不会烂成一锅粥的根本保障。

撞上循环依赖时，顺着三种办法拆：

1. 如果两个包离了彼此谁也活不了，说明当初拆得太碎，直接**合并成一个包**往往最自然；
2. 把两边共同依赖的基础数据结构或小接口下沉到一个更底层的独立包；
3. 利用[第 7 章的消费端隐式接口](./chapter-07#ch7-9-1)解开编译期反向引用，由顶层入口把两边拼起来。

### 10.3.8 组织模块结构 {#ch10-3-8}

Go 官方从不强推什么繁文缛节的“标准目录模板”（尤其别盲目照搬网上那个自封的 `golang-standards/project-layout`），按项目性质由简入繁即可：

- **小工具或单包库**：源码直接平铺在模块根目录，干干净净，连子目录都不用建；
- **应用程序服务**：单一二进制放根目录（多个二进制则放在 `cmd/<程序名>/main.go`），`main` 只负责读配置与组装依赖，其余所有业务包全收进 `internal/` 下，按领域功能（`order`、`billing`、`user`）而不是按技术分层（`controllers`、`models`、`utils`）划分子包；
- **对外发布的库模块**：核心主包直接放在仓库根目录（这样别人 `import "github.com/you/lib"` 最顺手），配套命令行工具放 `cmd/`，不公开的实现细节放 `internal/`。

### 10.3.9 用类型别名平滑重组 API {#ch10-3-9}

库发布之后如果想把某个导出类型挪到子包、或改个更准确的名字，硬删旧名字会直接把下游用户编挂。这时可以用下面三招保持向后兼容：

- **函数**：保留旧函数名，函数体里直接转发调用新函数（并在旧函数注释加上 `// Deprecated: use NewFunc instead.`）；
- **常量**：保留旧常量名，赋相同类型和值；
- **类型**：用[类型别名](./chapter-07#ch7-1-1) `type OldName = newpkg.NewName`（自 Go 1.24 起泛型类型同样支持写 `type OldSet[T comparable] = newpkg.Set[T]`），让新旧两个名字指代完全相同的类型，老调用方和传新类型的代码无缝互通。注意包级 `var` 变量和结构体字段没有别名机制，发布前命名务必想清楚。

### 10.3.10 慎用 `init` {#ch10-3-10}

包里声明的无参无返回值函数 `func init()` 会在该包首次被初始化时由运行时自动调用（按依赖拓扑从底层包往外层包依次执行：在每个包内部，先算完包级变量初值，再执行 `init` 函数，最后才进 `main.main()`；同一个包乃至同一个文件里甚至允许写多个 `init`）。

正因为 `init` 没有入参、不能返回 `error`、只能暗地里改包级全局状态，滥用它会让启动顺序、单测隔离和错误排查变得非常痛苦。在自己写的代码里，只保留两类合理的 `init` 用途：

1. **一次性算出没法用单行表达式写出来的只读查表数据**（比如预编译一组固定正则或 [16.2.2 节](./chapter-16#ch16-2-2)探测 CPU 字节序）；
2. **配合标准库历史约定的插件注册**（典型如 `"database/sql"` 驱动通过空白导入注册自己）：

```go
import (
	"database/sql"

	_ "github.com/jackc/pgx/v5/stdlib"
)
```

千万别在 `init` 里偷偷连数据库、发网络请求、读外部配置文件或起后台常驻 Goroutine——这些有失败风险和生命周期的操作，都应该做成显式的 `NewXxx(...) (*Client, error)` 交给 `main` 调用。

## 10.4 使用第三方模块 {#ch10-4}

### 10.4.1 `go get` 与 `go.sum` {#ch10-4-1}

在源码里写上第三方包的 `import` 路径后，拉取与整理依赖主要靠两条命令：

```sh
$ go get github.com/shopspring/decimal@v1.3.1 # 添加或调整指定模块到目标版本
$ go mod tidy                                 # 扫描源码增删依赖、修正 indirect 并同步 go.sum
```

除了更新 `go.mod`，工具链还会生成并维护 `go.sum`，里面记录了依赖图中每个模块版本的源码包哈希与 `go.mod` 文件哈希，用来防范依赖内容在日后构建时被篡改。**`go.mod` 和 `go.sum` 必须成对提交进版本控制仓库**（不管是应用还是库模块都一样）。本机下载过的模块默认缓存在 `$GOPATH/pkg/mod` 下供所有项目复用，需要彻底清理时运行 `go clean -modcache`。

### 10.4.2 语义化版本与最小版本选择 {#ch10-4-2}

Go 模块严格采用 `v主版本.次版本.补丁版本`（如 `v1.4.2`）的语义化版本（SemVer）：修 Bug 升补丁号，向后兼容加功能升次版本号，不兼容改动升主版本号（`v0.x.y` 视为尚未定型的初始开发阶段，不做兼容保证）。对于带 `-beta.1`、`-rc.1` 后缀的预发布版本（Pre-release），`@latest` 与 `go get -u` 会**优先选择正式发布版**；只有当该模块尚未发布任何未撤回的正式版本时，`@latest` 才会回退选中最高的预发布版，或者当构建依赖图中已有 `go.mod` 显式要求某预发布版时，它也会照常进入最小版本选择计算。

当你的主模块和好几个依赖同时要求同一个底层库 `D` 的不同版本时，Go 不像 npm/Cargo 那样默认抢最新发布的版本，而是采用**最小版本选择（Minimal Version Selection，MVS）**：**在满足所有模块 `require` 最低要求的版本里，挑最小的那个——也就是各方声明的最低版本号当中的最大值**。例如 A 要求 `D v1.1.0`、B 要求 `D v1.2.0`、C 要求 `D v1.2.3`，就算网上昨天刚发了 `D v1.5.0`，构建选出来的依然是确定的 **`v1.2.3`**！这让构建结果不随时间漂移、完全可复现。

日常查看与升降级依赖常用这几条命令：

```sh
$ go list -m -versions github.com/shopspring/decimal # 查看远端全部可用版本标签
$ go get github.com/shopspring/decimal@v1.4.0        # 精确升级或降级到指定版本
$ go get -u=patch github.com/shopspring/decimal      # 只升到当前次版本下的最新补丁版
$ go get -u github.com/shopspring/decimal            # 升到最新次版本/补丁版
$ go mod graph                                       # 打印模块依赖关系图
```

### 10.4.3 主版本升级与 `/vN` 路径 {#ch10-4-3}

一旦模块升到 **`v2` 及更高主版本**（意味着存在破坏性 API 变更），Go 的**语义导入版本控制（Semantic Import Versioning）**立了一条硬规矩：**模块路径和包导入路径末尾必须显式带上 `/v2`、`/v3` 后缀**（`v0` 和 `v1` 不加后缀）。

因为导入路径变了，`.../simpletax` 和 `.../simpletax/v2` 在编译器眼里就是两个完全独立的模块，大型项目可以在同一个进程里让新旧两版并存、按包逐个迁移，不必一次性全仓硬切：

```go
import (
	"github.com/learning-go-book-2e/simpletax"
	simpletaxv2 "github.com/learning-go-book-2e/simpletax/v2"
)
```

作为库维护者发布 `v2` 时，推荐两种官方做法之一：要么在主干（或独立 `v2` 分支）上把根目录 `go.mod` 的 `module` 路径及库内自引用统一改成 `.../repo/v2` 后打 `v2.0.0` 标签；要么保留根目录给 `v1`，新建 `v2/` 子目录放新代码与 `v2/go.mod`（`module .../repo/v2`），再打 `v2.0.0` 标签。

### 10.4.4 `vendor` 目录 {#ch10-4-4}

执行 `go mod vendor` 会把当前模块构建所需的全部第三方包源码拷贝到根目录下的 `vendor/` 文件夹里；存在 `vendor/` 时（在 `go 1.14+` 下），`go build` 和 `go test` 默认直接从 `vendor/` 读取依赖，不再访问网络。代价是代码库体积和 PR Diff 会暴增，且每次改完 `go.mod` 都必须重跑 `go mod vendor` 保持同步。如今除了完全断网隔离的内网构建机外，绝大多数团队更倾向于在 CI 里缓存 `$GOPATH/pkg/mod` 或搭建私有模块代理。

### 10.4.5 `pkg.go.dev` {#ch10-4-5}

引入陌生第三方模块前，先去官方索引站 [pkg.go.dev](https://pkg.go.dev/) 扫一眼它的 API 文档、开源许可证（是否属于 MIT / Apache-2.0 / BSD-3-Clause 等宽松许可证）、依赖树干净程度以及被多少其他开源项目采用（Imported By），能避开不少无人维护或许可证传染的坑。

## 10.5 发布模块与版本治理 {#ch10-5}

发布一个开源 Go 模块不需要去任何中心化网站注册账号上传压缩包：确认根目录放好 `LICENSE`、`go.mod` 和 `go.sum`，跑通测试后，在 Git 上打一个带 `v` 前缀的语义化版本标签（如 `v1.0.0`，注意不要漏掉字母 `v`）推送到公开代码仓库就完成了。

除了日常的 `require`，`go.mod` 还提供了三条版本治理指令（注意 `replace` 和 `exclude` **只在当前模块作为主模块构建时生效**，别人把你的库当依赖拉过去时会自动忽略它们）：

- **`replace`**：把某个模块（或特定版本）替换成另一个模块版本或本地相对路径目录：
  ```text
  replace github.com/jonbodner/proteus => github.com/someone/my_proteus v1.0.0
  replace github.com/jonbodner/proteus => ../proteus
  ```
  指向本地路径的 `replace` 千万别提交进共享分支（队友和 CI 机器上根本没有 `../proteus` 目录）；本地多模块联调请改用下一节的 `go.work`。
- **`exclude`**：拉黑某个已知有问题的依赖特定版本，让 MVS 跳过它继续往更高版本选。
- **`retract`（Go 1.16+）**：模块作者用来**撤回自己以前发砸了的版本**：
  ```text
  retract (
  	v1.5.0 // 包含数据损坏缺陷，请勿使用
  	[v1.7.0, v1.7.2]
  )
  ```
  写好 `retract` 后需要发布一个更高的补丁或次版本标签（如 `v1.7.3`），模块代理抓取到最新版本的 `go.mod` 后，`@latest` 和 `go get -u` 就不会再命中被撤回的版本，已经在用旧版的用户运行 `go list -m -u` 或 `go get` 时也会收到撤回警告（但不会强行打断别人锁死版本的离线构建）。一句话记清方向：**`exclude` 是拒用别人的坏版本，`retract` 是召回自己的坏版本，`replace` 是改道指向替代源**。

## 10.6 工作区 {#ch10-6}

当你一边改底层的 `workspace_lib` 库、一边要在上层的 `workspace_app` 应用里立刻验证效果时，不用再往 `go.mod` 里塞容易误提交的 `replace`，直接在它们的上层目录启用 **Go 工作区（Workspace，Go 1.18+）**：

```sh
$ go work init ./workspace_app
$ go work use ./workspace_lib
```

这会在当前目录生成一份 `go.work` 文件：

```text
go 1.27.1

use (
	./workspace_app
	./workspace_lib
)
```

只要身处该工作区目录树内，`go build`、`go test`、`gopls` 就会自动把两边的模块拼进同一张顶层依赖图，`workspace_app` 导入 `workspace_lib` 时直接读取本地未提交的最新源码。用工作区记住三条规矩：

1. **把 `go.work` 和 `go.work.sum` 加进 `.gitignore`**，不要提交到库或普通单模块仓库里；
2. 提交前跑一遍 `GOWORK=off go test ./...`，确保脱离本地工作区后仅凭 `go.mod` 也能正常构建；
3. 改动定型后按从底向上的顺序发布：先提交 `workspace_lib` 并打新版本标签，再到 `workspace_app` 里 `go get` 新版本号更新 `go.mod`。

## 10.7 模块代理与校验和数据库 {#ch10-7}

直接从全球各地的 Git 仓库拉依赖面临两个痛点：作者一旦删库或强推改写标签，下游构建就会全线瘫痪或产出不一致的二进制。为此 `go` 工具链默认开启了两道基础设施防线：

- **模块代理 `GOPROXY`**（默认 `https://proxy.golang.org,direct`）：首次拉取某模块版本时由代理从源仓库抓取并永久缓存归档快照，后续拉取既快，又不怕原仓库删改历史；
- **校验和数据库 `GOSUMDB`**（默认 `sum.golang.org`）：由透明日志（Merkle Tree）维护全网公开模块每个版本的唯一哈希，本地下载后除了比对项目里的 `go.sum`，对于首次引入的新模块还会向 `GOSUMDB` 核验哈希是否全网一致，不一致当场拒绝安装。

在企业内网拉取公司私有代码库时，切记配置 **`GOPRIVATE`** 环境变量（支持通配符，逗号分隔）：

```sh
$ go env -w GOPRIVATE=*.corp.example.com,github.com/my-org/*
```

命中的模块路径会自动跳过公共代理与公共校验和数据库（避免把内部仓库路径发往外部服务器，同时直接走本机 Git SSH/HTTPS 凭据拉取）；团队规模较大时，也可以在内网部署 Athens、Artifactory 或 Nexus 充当私有 `GOPROXY`。

## 练习 {#ch10-exercises}

以下三题按真实维护顺序串联一个小型计算模块从初始化、补齐标准文档注释到发布 `/v2` 主版本的全过程。建议先独立写出命令与源码，再展开核对参考答案。

### 练习 1：初始化并发布 `v1.0.0` 模块

创建模块 `github.com/yourname/mathutil`，导出函数 `Add(a, b int) int` 返回两数之和；写出从创建目录到推送首个正式版本 `v1.0.0` 的命令序列，并说明为什么不需要向任何中央包管理平台上传产物。

<details>
<summary>查看参考答案</summary>

```sh
$ mkdir mathutil && cd mathutil
$ go mod init github.com/yourname/mathutil
```

新建 `mathutil.go`（同时补好 `LICENSE` 文件）：

```go
package mathutil

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}
```

提交到 `main` 分支、关联远端仓库并推送语义化版本标签：

```sh
$ git init -b main
$ git add .
$ git commit -m "init mathutil module"
$ git remote add origin https://github.com/yourname/mathutil.git
$ git tag v1.0.0
$ git push -u origin main --tags
```

Go 模块路径本身就编码了源码仓库地址：有人执行 `go get github.com/yourname/mathutil@v1.0.0` 时，模块代理（或客户端直连）直接按仓库标签拉取源码快照并在校验和数据库登记哈希，因此往公开 Git 仓库推上合规的 `vX.Y.Z` 标签即完成了发布。

</details>

### 练习 2：补齐标准文档注释并发布补丁版本

为 `mathutil` 包和 `Add` 函数补齐符合 `go doc` 规范的注释：要求包含包级注释、以函数名开头的函数说明，以及一条指向外部参考链接的文档链接语法；说明此时应递增哪一位版本号。

<details>
<summary>查看参考答案</summary>

```go
// Package mathutil provides small helpers for basic arithmetic.
package mathutil

// Add returns the sum of a and b.
//
// See [Addition] for basic properties of integer addition.
//
// [Addition]: https://www.mathsisfun.com/numbers/addition.html
func Add(a, b int) int {
	return a + b
}
```

可用 `go doc .` 与 `go doc Add` 在本地检查渲染结果。只补充文档注释、不新增也不破坏任何 API 行为，按语义化版本规则递增**补丁版本号**，打标签 `v1.0.1`：

```sh
$ git add mathutil.go
$ git commit -m "docs: add package and function doc comments"
$ git tag v1.0.1
$ git push origin main --tags
```

</details>

### 练习 3：将 `Add` 升级为泛型函数并发布 `v2.0.0`

将 `Add` 改为支持任意内置或自定义整数、浮点数的泛型函数，分析为什么把普通函数改为泛型函数应按不兼容主版本处理，并写出发布 `v2.0.0` 所需的 `go.mod` 变更与 Git 命令。

<details>
<summary>查看参考答案</summary>

虽然普通调用点 `Add(1, 2)` 乃至带明确目标类型的赋值 `var f func(int, int) int = Add` 靠类型推断仍能通过编译，但一旦下游代码存在缺少目标函数类型上下文的引用——例如短变量声明 `f := Add`、装箱进空接口 `any(Add)` 或传给 `reflect.ValueOf(Add)`——就会直接报错 `cannot use generic function Add without instantiation`（另外注意标准库 `cmp.Ordered` 还包含 `~string`，若直接用 `cmp.Ordered` 会额外放行字符串拼接；只允许数值时应自定义数值约束）。既然存在合法旧代码无法继续编译的场景，稳妥做法是按不兼容主版本发布 `v2`。

采用最简洁的主干路径升级方案，先将根目录 `go.mod` 中的 `module` 行改为带 `/v2` 后缀：

```text
module github.com/yourname/mathutil/v2

go 1.27.1
```

更新 `mathutil.go`：

```go
// Package mathutil provides generic helpers for basic arithmetic.
package mathutil

// Number matches any integer or floating-point underlying type.
type Number interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 |
		~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
		~float32 | ~float64
}

// Add returns the sum of a and b.
func Add[T Number](a, b T) T {
	return a + b
}
```

提交并打上 `v2.0.0` 标签（若采用 `v2/` 子目录方案，则需在 `v2/` 目录内放置上述源码及含 `module github.com/yourname/mathutil/v2` 的 `v2/go.mod`）：

```sh
$ git add go.mod mathutil.go
$ git commit -m "feat!: generalize Add for all numeric types in v2"
$ git tag v2.0.0
$ git push origin main --tags
```

下游调用方想切到新版时，只需导入 `"github.com/yourname/mathutil/v2"`，且可与旧版 `"github.com/yourname/mathutil"` 在同一项目中并存。

</details>

## 面试题 {#ch10-interview}

以下四题分别考察跨模块 `go` 语言版本隔离、`internal` 目录可见范围、`/vN` 语义导入路径规则以及 `replace`/`exclude`/`retract` 的作用边界。建议先独立作答，再展开核对参考答案。

### 面试题 1：主模块写 `go 1.27`，依赖模块写 `go 1.21`，依赖里的代码按哪个语言版本编译？

<details>
<summary>查看参考答案</summary>

按依赖模块自己的 **`go 1.21`** 语言语义编译（例如它内部的 `for range` 循环仍保持 1.21 的单变量复用行为，也不能使用 1.22+ 的新语法）。`go.mod` 中的 `go` 指令在语言语义层面**按模块独立生效**，主模块调高 `go` 版本只会要求本地工具链不低于 1.27，绝不会强行改写第三方依赖内部的语言版本语义。

</details>

### 面试题 2：哪些包有权限导入 `app/internal/auth`？

假设模块根目录下有 `app/main.go`、`app/internal/auth`、`app/api/v1` 和 `shared/log` 四个目录，分别判断哪些目录里的包能导入 `app/internal/auth`。

<details>
<summary>查看参考答案</summary>

`app/main.go` 和 `app/api/v1` **可以**导入；`shared/log` **不可以**导入（编译报错 `use of internal package ... not allowed`）。

规则只看导入路径前缀：`.../app/internal/...` 下的包，只对 `internal` 直接父目录 `app` 及其所有子孙目录（整棵 `app/` 子树）可见；哪怕 `shared/log` 同在当前模块内，因为它不在 `app/` 子树下，同样无权导入。

</details>

### 面试题 3：为什么模块升到 `v2.0.0` 时连代码里的 `import` 路径都得加 `/v2`？

<details>
<summary>查看参考答案</summary>

Go 规定每个导入路径唯一对应一套向后兼容的包契约；既然升到 `v2` 代表破坏了向后兼容，它按定义就已经不是原来的那个包了。强制加上 `/v2` 后缀（语义导入版本控制）能避免菱形依赖灾难：当主程序依赖库 A（用 `foo` v1）和库 B（用 `foo/v2`）时，两套代码拥有不同的模块路径与包路径，可以同时编译进同一个二进制互不冲突，支持渐进式迁移。

</details>

### 面试题 4：`replace`、`exclude` 和 `retract` 分别由谁写、对谁生效？

<details>
<summary>查看参考答案</summary>

- **`replace`** 与 **`exclude`**：由**下游使用方**写在自己的主模块 `go.mod` 里，**只对当前主模块的构建生效**（别人把你当依赖引用时会自动忽略这两条指令）。`replace` 用于把某依赖重定向到分支版本或其它 fork（本地多模块开发优先用 `go.work` 而非提交本地路径 `replace`）；`exclude` 用于跳过第三方依赖的某个特定坏版本。
- **`retract`**：由**上游模块作者自己**写在新发布版本的 `go.mod` 里，用来向全网声明撤回自己以前发错的旧版本，阻止后续 `@latest` 和 `go get -u` 再选中它们。

</details>

## 参考资料

- [Go 模块参考手册（Go Modules Reference）](https://go.dev/ref/mod)
- [Go 模块文件参考（`go.mod` directives）](https://go.dev/doc/modules/gomod-ref)
- [Go 工具链管理（`toolchain` 与 `GOTOOLCHAIN`）](https://go.dev/doc/toolchain)
- [Go 向后兼容性与 `GODEBUG`](https://go.dev/doc/godebug)
- [最小版本选择（Minimal Version Selection）](https://go.dev/ref/mod#minimal-version-selection)
- [Go 官方博客：Go Modules: v2 and Beyond](https://go.dev/blog/v2-go-modules)
- [Go 官方博客：Publishing Go Modules](https://go.dev/blog/publishing-go-modules)
- [Go 官方博客：Get familiar with workspaces（`go.work`）](https://go.dev/blog/get-familiar-with-workspaces)
- [Go Doc 注释格式规范（Go Doc Comments）](https://go.dev/doc/comment)
- [Go 命令文档：私有模块与 `GOPRIVATE` 配置](https://go.dev/cmd/go/#hdr-Configuration_for_downloading_modules)
- [Go 标准库 `crypto/rand.Read`](https://pkg.go.dev/crypto/rand#Read)
- [Go 标准库 `math/rand/v2`](https://pkg.go.dev/math/rand/v2)
