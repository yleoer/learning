---
title: 第 1 章 设置你的 Go 环境
description: 安装 Go、创建第一个模块，并用格式化、静态检查、编辑器与 Makefile 建立可重复的开发流程。
---

# 第 1 章 设置你的 Go 环境

## 本章要点

本章沿用原书“安装工具 → 创建模块 → 编写程序 → 检查与构建”的主线。完成后，你应能独立运行一个 Go 程序，区分格式化、静态检查和编译的职责，并把这些步骤写成可重复执行的流程。

> 核对日期：2026 年 9 月 15 日；核对环境为 Go 1.27.1、Windows/AMD64。

下面标为 `sh` 的命令使用 Unix shell 语法，`$` 是提示符，无需输入；Windows PowerShell 的差异会单独说明。

## 1.1 安装 Go 工具 {#ch1-1}

Go 发布包包含编译器、链接器、标准库和统一的 `go` 命令。生产环境优先使用受支持的稳定版本；Go 官方只为最新两个主要版本发布关键问题与安全修复。

### 1.1.1 按操作系统安装

先从 [Go 官方下载页](https://go.dev/dl/)选择与操作系统、CPU 架构匹配的安装包：

| 平台 | 推荐安装方式 | 默认位置 |
| --- | --- | --- |
| Windows | 运行官方 `.msi`，完成后重开终端 | `Program Files` 下的 Go 目录 |
| macOS | 运行官方 `.pkg` | `/usr/local/go` |
| Linux | 解压官方 `.tar.gz`，不要覆盖旧的 Go 目录 | `/usr/local/go` |

Homebrew、Chocolatey 等包管理器也能安装 Go，但可用版本和升级行为由相应仓库决定。团队需要精确控制版本时，应把安装来源和版本写进开发文档或 CI 配置。

Linux 以当前稳定版、AMD64 为例：

```sh
$ curl -LO https://go.dev/dl/go1.27.1.linux-amd64.tar.gz
$ echo "63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445  go1.27.1.linux-amd64.tar.gz" | sha256sum -c -
go1.27.1.linux-amd64.tar.gz: OK
$ sudo rm -rf /usr/local/go
$ sudo tar -C /usr/local -xzf go1.27.1.linux-amd64.tar.gz
```

校验值应从下载页对应文件的 **SHA256 Checksum** 获取；上面的值只适用于这个版本和架构。应在使用 `sudo` 解压前完成校验，避免安装下载不完整或被替换的归档。

删除目标必须是旧安装目录 `/usr/local/go`；不要把新归档直接解压到旧目录中，否则残留文件可能造成损坏的安装。ARM64 机器应下载文件名含 `linux-arm64` 的归档并使用其对应校验值。

在 macOS/Linux 上，把 Go 和通过 `go install` 安装的工具加入 `PATH`。使用 zsh 时可写入 `~/.zshrc`，bash 通常写入 `~/.profile` 或 `~/.bashrc`：

```sh
export PATH="$PATH:/usr/local/go/bin"
export PATH="$PATH:$(go env GOPATH)/bin"
```

重开终端，或加载对应配置文件使修改生效。上面的工具目录适用于未设置 `GOBIN` 的常见配置；如果设置了 `GOBIN`，应将该目录加入 `PATH`。Windows 可在系统环境变量设置中检查安装程序加入的 Go 路径，并按需添加工具目录。

现代模块项目可以放在任意目录，不需要把源代码放进 `GOPATH`。`GOPATH` 仍用于默认的模块缓存和工具安装目录；通常不需要手工设置 `GOROOT`。

### 1.1.2 验证与排错

```sh
$ go version
go version go1.27.1 linux/amd64

$ go env GOOS GOARCH GOROOT GOPATH
linux
amd64
/usr/local/go
/root/go
```

这里展示的是一台 Linux/AMD64 机器的示例输出，路径因用户和安装方式而异。`go version` 显示工具链版本及其平台；后四行依次是构建目标操作系统、目标架构、Go 安装根目录和 `GOPATH`，并非项目的当前目录。`GOOS`、`GOARCH` 可因交叉编译配置而与本机不同。若 `go version` 失败，可按顺序检查：

1. 使用 macOS/Linux 的 `command -v go` 或 Windows 的 `where.exe go`，确认命令是否存在、是否误用了另一份安装。PowerShell 也可使用 `Get-Command go -All`；不要把别名 `where` 当成 `where.exe`。
2. 确认终端已经重启或重新加载了 `PATH`。
3. 确认下载包的操作系统和架构与 `uname -s`、`uname -m` 等系统信息相符。
4. 若电脑上有多份 Go，使用 bash 的 `type -a go`、zsh 的 `whence -a go` 或 Windows 的 `where.exe go` 查看全部匹配项及其顺序，再调整 `PATH`。

### 1.1.3 一条命令背后的工具集

常用能力都从 `go` 命令进入：

| 命令 | 用途 |
| --- | --- |
| `go version` | 查看工具链版本，或检查二进制的构建版本 |
| `go build` | 编译包及其依赖 |
| `go run` | 编译并立即运行程序 |
| `go fmt` | 按 Go 标准格式整理源码 |
| `go vet` | 检查可编译但很可能有问题的代码 |
| `go test` | 编译并运行测试 |
| `go mod` | 管理模块及其依赖 |
| `go help <command>` | 在本地查看命令的当前说明 |

Go 程序通常编译为原生可执行文件，运行目标机器不必另装 Go 工具链。但“单个二进制”不等于在任何环境都绝对没有外部依赖：启用 cgo、动态链接、读取证书或时区数据时，程序仍可能依赖操作系统资源。

## 1.2 你的第一个 Go 程序 {#ch1-2}

### 1.2.1 创建模块

项目不必位于特殊工作区。选择任意开发目录，创建模块：

```sh
$ mkdir hello
$ cd hello
$ go mod init example.com/hello
go: creating new go.mod: module example.com/hello
```

`go mod init` 在模块根目录创建 `go.mod`。模块路径与版本一起唯一标识模块，也是模块内包的导入路径前缀。示例可使用保留的 `example.com` 域名；准备发布的项目最好从一开始就使用真实仓库路径，例如 `github.com/you/hello`。

新工具链生成的文件大致如下，具体 `go` 版本取决于执行命令的工具链：

```text
module example.com/hello

go 1.27.1
```

这里的 `go` 指令不只是注释。自 Go 1.21 起，它声明构建该模块所需的最低 Go 版本，并影响可用语言语义和工具链选择。依赖应主要通过 `go get`、`go mod tidy` 和 `go mod edit` 管理；理解含义后可以编辑 `go.mod`，但不要把它当作一份随意维护的依赖清单。

### 1.2.2 编写、构建与运行

创建 `hello.go`：

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, world!")
}
```

这段程序有四个关键部分：

- `package main` 表示这是可执行程序的一部分；
- `import "fmt"` 导入整个 `fmt` 包；
- `func main()` 是 `main` 包的入口函数，在包初始化完成后执行；
- `fmt.Println` 调用包内导出的函数并输出一行文本。

先构建，再运行生成的文件：

```sh
$ go build
$ ./hello
Hello, world!
```

在 Windows 上生成的是 `hello.exe`。构建单个 `main` 包时，默认输出名取自包导入路径最后一个非主版本元素；本例的 `example.com/hello` 因而得到 `hello`，与模块根目录实际叫什么无关。需要稳定名称或指定目录时显式使用 `-o`：

```sh
$ go build -o bin/hello .
$ ./bin/hello
Hello, world!
```

学习和快速验证时也可运行 `go run .`。它会构建临时二进制并执行，却不会在当前目录留下可分发文件；正式发布仍应使用 `go build`。

在 PowerShell 中，运行默认产物使用 `.\hello.exe`。显式指定输出文件时，也建议写上扩展名：

```powershell
go build -o bin/hello.exe .
.\bin\hello.exe
```

`go run .` 按包构建，包含当前目录符合构建条件的 Go 文件；`go run hello.go` 只使用显式列出的文件。程序拆成多个文件后，通常应使用前者。

### 1.2.3 用 `go fmt` 统一格式

示例故意用空格缩进，但 Go 不要求开发者手工维护某种个人风格。运行：

```sh
$ go fmt ./...
hello.go
```

在本例的模块根目录中，`./...` 匹配当前目录及其子目录中的包。命令会把这些包的 Go 源文件改成标准格式，例如用制表符缩进，并只列出发生改动的文件。编辑器应配置为保存时格式化，提交前仍建议运行一次 `go fmt ./...`。

统一格式不仅减少风格争论，也让自动重构、代码生成和审查更可靠。若格式化涉及大量旧代码，最好把纯格式改动与逻辑改动分开提交，避免真正的行为变化淹没在 diff 中。

#### 为什么左花括号不能另起一行

Go 的词法分析器会自动插入分号。若一行的最后一个词法单元是标识符、基础字面量、`break`、`continue`、`fallthrough`、`return`、`++`、`--`、`)`、`]` 或 `}`，行末会自动插入分号。因此下面的写法不合法：

```go
func main()
{
    fmt.Println("Hello, world!")
}
```

`func main()` 行末的 `)` 会触发分号插入，相当于在函数签名和函数体之间放了一个分号。`gofmt` 只能格式化语法正确的程序，不能修复这个语法错误。

### 1.2.4 用 `go vet` 找出可疑代码

把输出临时改为：

```go
fmt.Printf("Hello, %s!\n")
```

它在语法和类型上可以通过编译，运行时却缺少 `%s` 对应的参数。执行：

```sh
$ go vet ./...
# example.com/hello
./hello.go:6:2: fmt.Printf format %s reads arg #1, but call has 0 args
```

修正为：

```go
fmt.Printf("Hello, %s!\n", "world")
```

`go vet` 只报告一组高可信度的可疑结构，不是完整证明，也不能代替测试、代码审查或更全面的静态分析。最低限度的本地检查可以是：

```sh
$ go fmt ./...
$ go vet ./...
$ go test ./...
$ go build ./...
```

## 1.3 选择你的工具 {#ch1-3}

只用文本编辑器和命令行就能开发 Go；处理较大项目时，自动格式化、补全、跳转、重构、测试和调试能提高效率。VS Code 等编辑器可通过官方语言服务器 `gopls` 获得 Go 语义分析能力；GoLand 则提供自己的集成支持。无论选择哪种工具，项目都应能在命令行中构建。

### 1.3.1 Visual Studio Code

VS Code 免费且跨平台。从 VS Code 扩展市场安装 **Go** 扩展（标识符 `golang.go`），并按提示安装 `gopls` 和 Delve 等工具。`gopls` 提供补全、诊断和导航，Delve 用于调试；Go 工具链仍需先行安装。建议启用保存时格式化和保存时整理导入。

### 1.3.2 GoLand

GoLand 是 JetBrains 面向 Go 的 IDE，集成重构、调试、测试和覆盖率工具，无需另外安装 Go 语言插件；仍需配置 Go SDK。许可政策可能变化，以 [JetBrains 官网](https://www.jetbrains.com/go/)为准。可根据项目需要和使用习惯选择编辑器，不必为学习本指南更换已经熟悉的工具。

### 1.3.3 The Go Playground

[The Go Playground](https://go.dev/play/) 适合运行、格式化和分享短小且自包含的示例，不需要创建本地项目。它运行在受限沙箱中，网络、执行时间、资源、文件系统和时间行为都可能受限制，因此不能替代本地环境。

不要把密码、令牌、私钥、个人信息或公司代码粘贴进去。分享链接意味着内容会被上传并可由持有链接的人访问，Playground 也不应当作代码仓库。

## 1.4 用 Makefile 固化流程 {#ch1-4}

把常用命令写进仓库，能让开发者和 CI 执行同一套流程。先按原书创建一个简单的 `Makefile`，放在模块根目录：

```make
.DEFAULT_GOAL := build

.PHONY: fmt vet build

fmt:
	go fmt ./...

vet: fmt
	go vet ./...

build: vet
	go build .
```

规则含义如下：

- 直接运行 `make` 会选择默认的 `build`；
- `build: vet` 和 `vet: fmt` 建立 `fmt → vet → build` 的执行顺序，前一步失败时后续步骤停止；
- `.PHONY` 表明这些名称是动作，不是同名文件；
- 配方行必须用 **Tab** 开头，不能用普通空格；
- `make fmt` 会自动改写源码，`make vet` 会先格式化，再检查；
- 后续加入测试时，可以把 `go test ./...` 纳入构建前的检查流程。

这份 Makefile 会修改格式不规范的源码。CI 若要求只检查而不修改，可以用 `gofmt -l` 列出需要格式化的文件，并由脚本在输出非空或命令失败时返回非零状态；仅执行 `gofmt -l` 不会因存在格式差异自动失败。

Windows 默认不附带 `make`，可以安装兼容工具，也可以依次执行上述 Go 命令。使用 PowerShell 编写脚本时，应在每一步检查 `$LASTEXITCODE`，防止前一步失败后仍继续构建。清理目标留作[本章练习](#ch1-exercises)。

## 1.5 理解 Go 兼容性承诺 {#ch1-5}

Go 1 兼容性承诺的核心是：按 Go 1 规范编写、今天能够正确编译运行的源码，应当在后续 Go 1 版本中继续正确编译运行。标准库 API 可以扩展，但通常不会以破坏既有 Go 1 源码的方式变化。

这个承诺有清晰边界：

- 保证的是**源代码兼容性**，不是不同工具链版本间的二进制包兼容性；升级后应重新编译源码。
- 安全问题、规范错误、修复了的实现缺陷以及未规定行为可能导致程序变化。
- `unsafe`、操作系统接口、程序性能和开发中的未发布特性不在同等保证范围内。
- `go` 命令及其他工具仍会演进，依赖其输出文本、内部目录或非公开细节的脚本可能失效。
- 外部包有各自的版本与兼容策略，Go 1 承诺不会替第三方模块保证 API 稳定。

现代 Go 还允许模块声明自己的语言版本。`go.mod` 的 `go` 指令决定该模块采用的最低版本和相关语言语义；这使新工具链能够继续构建旧模块，同时让新模块选择修正后的行为。升级工具链不等于必须立刻提高模块的 `go` 指令，应分别测试这两个变化。

## 1.6 保持更新 {#ch1-6}

Go 通常每年发布两个主要版本，并为当前两个主要版本按需发布补丁。截至本章核对日期，受支持的版本系列为 Go 1.27 和 Go 1.26。补丁可能包含编译器、运行时、标准库和安全修复，开发机与 CI 应及时更新到所用系列的受支持补丁版。

更新建议采用以下流程：

1. 阅读[发布记录](https://go.dev/doc/devel/release)和对应版本说明。
2. 用项目当前工具链执行完整测试并记录基线。
3. 按[官方安装说明](https://go.dev/doc/install)替换工具链；Linux 不要把新归档覆盖解压到旧 Go 目录。
4. 验证 `go version`，再运行 `go fmt ./...`、`go vet ./...`、`go test ./...` 和项目构建。
5. 在 CI 和开发文档中同步版本，检查静态分析器、生成器与调试器是否兼容。
6. 最后再决定是否提高 `go.mod` 中的 `go` 版本，并单独审查由此启用的语义变化。

已部署的 Go 二进制不会因为开发机更换工具链而自动改变；需要获得新工具链或标准库中的修复时，必须重新构建并部署。需要并行测试旧版本时，可参考官方的[多版本安装方法](https://go.dev/doc/manage-install)。

## 练习 {#ch1-exercises}

两题分别检查工具链任务设计和静态检查的能力边界。先独立完成，再展开参考答案。Go 代码片段位于 `main` 函数内，`fmt` 对应标准库导入路径 `"fmt"`；同题的独立场景分别分析，命令均以模块根目录为当前目录。

### 练习 1：为 Hello 项目固化工具链

为一个只有 `hello.go` 的模块设计 Makefile，提供 `fmt`、`vet`、`build` 和 `clean` 四个目标。`build` 应将程序写入 `bin/hello`，并说明 `clean` 为什么需要同时处理 Go 生成的默认产物和显式输出文件。答案不要求实际执行命令。

<details>
<summary>查看参考答案</summary>

```make
.PHONY: fmt vet build clean

fmt:
	go fmt ./...

vet: fmt
	go vet ./...

build: vet
	go build -o bin/hello .

clean:
	go clean ./...
	rm -f bin/hello bin/hello.exe
```

`go fmt` 统一源码格式，`go vet` 检查一部分可疑用法，`go build -o` 生成指定路径的产物，并自动创建缺失的 `bin` 目录。`go clean ./...` 不会删除 `-o` 指定的产物，所以清理目标要显式删除它。

上面的清理配方使用 Unix shell 的 `rm`。在 Windows 上将输出路径改为 `bin/hello.exe`；使用原生 PowerShell 时，构建与清理命令为：

```powershell
go build -o bin/hello.exe .
go clean ./...
foreach ($buildOutput in '.\bin\hello', '.\bin\hello.exe') {
	if (Test-Path -LiteralPath $buildOutput) {
		Remove-Item -LiteralPath $buildOutput
	}
}
```

</details>

### 练习 2：判断工具能发现哪类错误

对下面三个场景分别判断 `go build`、`go vet` 和运行程序的结果，并说明还需要哪一种检查才能发现问题。

```go
// A
fmt.Printf("Hello, %s!\n", "world")

// B
fmt.Printf("Hello, %s!\n")

// C：需求是向 world 问好
fmt.Printf("Hello, %s!\n", "wrong name")
```

<details>
<summary>查看参考答案</summary>

| 场景 | `go build` | `go vet` | 运行结果 | 还需检查 |
| --- | --- | --- | --- | --- |
| A | 通过 | 通过 | `Hello, world!` | 无 |
| B | 通过 | 报告格式参数可疑 | `Hello, %!s(MISSING)!` | 修复代码 |
| C | 通过 | 通过 | `Hello, wrong name!` | 对照需求、测试或代码审查 |

编译器主要检查语法和类型；`go vet` 能发现部分格式化调用问题，但不能从代码本身推断业务需求。构建成功不等于行为满足需求。

</details>

## 面试题 {#ch1-interview}

三题检查源码选择、格式化边界和构建产物更新。先独立回答，再展开参考答案；命令的目录约定沿用[练习部分](#ch1-exercises)。

### 面试题 1：按包运行和按文件运行有什么区别？

目录中有 `hello.go` 和 `message.go`，两者属于同一个 `main` 包；`hello.go` 调用了 `message()`。`go run .` 与 `go run hello.go` 分别会发生什么？

<details>
<summary>查看参考答案</summary>

`go run .` 按当前包选择源文件，因此可以找到 `message()`；`go run hello.go` 只编译命令行列出的文件，会因找不到 `message` 在编译期失败。

</details>

### 面试题 2：为什么 `gofmt` 不能修复另起一行的函数左花括号？

<details>
<summary>查看参考答案</summary>

Go 的分号插入规则会在上一行结尾形成分号，函数声明因此不符合语法。`gofmt` 只能格式化已经能解析的语法树，遇到语法错误无法代替编译器修复代码。

</details>

### 面试题 3：源码修改后，已部署的 Go 二进制会自动更新吗？

<details>
<summary>查看参考答案</summary>

不会。二进制包含构建时的源码和依赖；源码、工具链或标准库变化都需要重新构建并重新部署，旧进程和旧文件不会自动改变。

</details>

## 参考资料

- [Go 官方下载与安装](https://go.dev/doc/install)
- [Go 下载页](https://go.dev/dl/)
- [Go 模块文件参考](https://go.dev/doc/modules/gomod-ref)
- [Go 命令文档](https://go.dev/cmd/go/)
- [编辑器插件与 IDE](https://go.dev/doc/editors)
- [Go 1 兼容性承诺](https://go.dev/doc/go1compat)
- [Go 发布策略与历史](https://go.dev/doc/devel/release)
