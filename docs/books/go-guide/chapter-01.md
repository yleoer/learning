---
title: 第 1 章 设置 Go 环境
description: 安装 Go 工具链、初始化模块，厘清编译、格式化与静态检查的边界，并理解兼容性与升级规则。
---

# 第 1 章 设置 Go 环境

## 本章要点

搭建 Go 环境不只是让 `go` 命令跑起来，更关键的是建立一套从模块初始化、代码格式化、静态检查到构建交付的可复现工作流，并弄清哪些问题由编译器拦截、哪些交给 `gofmt` 与 `go vet`、哪些仍需测试覆盖。与此同时，理解 `go.mod` 的版本控制语义、Go 1 兼容性承诺与静态编译产物的部署特性，也是后续维护工程与升级工具链的基础。

> 核对日期：2026 年 10 月 15 日；核对环境为 Go 1.27.1、Windows/AMD64。

## 1.1 安装 Go 工具 {#ch1-1}

Go 官方发行包内置编译器、链接器、标准库及统一的 `go` 命令行工具。日常开发与生产构建应优先使用受支持的稳定版本：Go 官方维护策略仅对最近两个主版本（Major Release）提供关键缺陷修复与安全补丁。

### 1.1.1 按操作系统安装 {#ch1-1-1}

从 [Go 官方下载页](https://go.dev/dl/)选择与操作系统及 CPU 架构匹配的安装包：

| 平台 | 推荐安装方式 | 默认位置 |
| --- | --- | --- |
| Windows | 运行官方 `.msi`，完成后重启终端 | `C:\Program Files\Go` |
| macOS | 运行官方 `.pkg` | `/usr/local/go` |
| Linux | 解压官方 `.tar.gz`，先删旧目录再解压 | `/usr/local/go` |

Homebrew、Chocolatey 等第三方包管理器同样可以安装 Go，但可用版本与升级时机受限于各自的软件源；需要精确锁定工具链版本时，最好直接基于官方归档安装并在 CI 中固定版本号。

以 Linux/AMD64 稳定版为例，下载、校验并解压安装：

```sh
$ curl -LO https://go.dev/dl/go1.27.1.linux-amd64.tar.gz
$ echo "63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445  go1.27.1.linux-amd64.tar.gz" | sha256sum -c -
go1.27.1.linux-amd64.tar.gz: OK
$ sudo rm -rf /usr/local/go
$ sudo tar -C /usr/local -xzf go1.27.1.linux-amd64.tar.gz
```

校验值应从官方下载页对应文件的 **SHA256 Checksum** 栏获取（上例校验值仅对应 `go1.27.1.linux-amd64.tar.gz`），务必在 `sudo` 解压前完成完整性校验。升级或重装时，必须先删除旧的 `/usr/local/go` 目录再解压，切勿直接覆盖既有目录，否则残留的旧版本文件可能导致工具链异常。ARM64 主机应改用文件名带 `linux-arm64` 的归档与对应校验值。

在 macOS 与 Linux 环境中，需将 Go 工具链目录及 `go install` 的输出目录前置加入 `PATH`（前置写法可避免被系统预装的旧版 Go 遮蔽）。`zsh` 可写入 `~/.zshrc`，`bash` 通常写入 `~/.profile` 或 `~/.bashrc`：

```sh
export PATH="/usr/local/go/bin:$PATH"
export PATH="$(go env GOPATH)/bin:$PATH"
```

修改后重启终端或重新加载配置文件即可生效。上述配置对应未显式设置 `GOBIN` 的默认情况；若设置了 `GOBIN` 环境变量，则应将 `GOBIN` 指向的目录加入 `PATH`。Windows 环境由 `.msi` 安装程序自动配置系统 `PATH`，需要时可在系统环境变量中核对路径并补充工具输出目录。

现代 Go 模块（Module）项目可以放在任意目录下，不必放入 `GOPATH`。如今 `GOPATH` 主要用于存放模块依赖缓存（`$GOPATH/pkg/mod`）和 `go install` 生成的可执行工具（`$GOPATH/bin`）；常规开发也无需手动设置 `GOROOT`。

### 1.1.2 验证与排错 {#ch1-1-2}

```sh
$ go version
go version go1.27.1 linux/amd64
$ go env GOOS GOARCH GOROOT GOPATH
linux
amd64
/usr/local/go
/root/go
```

上例为 Linux/AMD64 环境的典型输出，具体目录随系统用户与安装方式变化。`go version` 显示当前工具链版本与宿主平台；`go env` 的四行输出依次对应目标操作系统（`GOOS`）、目标架构（`GOARCH`）、Go 安装根目录（`GOROOT`）和工作区目录（`GOPATH`）。注意 `GOROOT` 与 `GOPATH` 都不是项目目录，且交叉编译时 `GOOS`、`GOARCH` 可以与宿主系统不同。

若 `go version` 报错或版本与预期不符，可按以下顺序排查：

1. 在 macOS/Linux 下运行 `command -v go`，或在 Windows 下运行 `where.exe go`，确认可执行文件是否存在，以及是否命中了其他安装副本。PowerShell 中也可使用 `Get-Command go -All`（注意 PowerShell 中的 `where` 是 `Where-Object` 的内置别名，不是 `where.exe`）。
2. 确认终端已重启，或已重新加载 Shell 配置文件使 `PATH` 生效。
3. 通过 `uname -s`、`uname -m` 等命令核对宿主操作系统与 CPU 架构是否与安装包一致。
4. 若机器上并存多个 Go 版本，用 `type -a go`（`bash`）、`whence -a go`（`zsh`）或 `where.exe go`（Windows）查看全部候选路径的先后顺序，调整 `PATH` 优先级。

### 1.1.3 Go 命令概览 {#ch1-1-3}

日常开发高频操作都统一收敛在 `go` 命令下：

| 命令 | 用途 |
| --- | --- |
| `go version` | 查看当前工具链版本，或读取已编译二进制内嵌的构建版本 |
| `go build` | 编译目标包及其依赖项 |
| `go run` | 编译并直接运行程序 |
| `go fmt` | 按 Go 官方规范格式化源码 |
| `go vet` | 静态检查可通过编译但存在常见缺陷模式的构造 |
| `go test` | 编译并运行单元测试与基准测试 |
| `go mod` | 管理模块定义与依赖关系 |
| `go help <command>` | 在本地查看指定子命令或主题的参考说明 |

Go 默认将程序编译为原生可执行文件，目标机器无需安装 Go 工具链即可运行。不过“单文件二进制”并不意味着在任何条件下都零外部依赖：若启用 `cgo`（未设置 `CGO_ENABLED=0`）而在 Linux 等平台上动态链接系统 `libc`、发起 TLS 请求时依赖宿主系统根证书（如 `/etc/ssl/certs`），或加载时区信息却未导入标准库 `"time/tzdata"`（Go 1.15+）也未挂载系统时区库，运行期仍会依赖宿主环境资源。

## 1.2 第一个 Go 程序 {#ch1-2}

### 1.2.1 创建模块 {#ch1-2-1}

在任意工作目录下新建项目目录并初始化模块：

```sh
$ mkdir hello
$ cd hello
$ go mod init example.com/hello
go: creating new go.mod: module example.com/hello
```

`go mod init` 会在当前目录生成 `go.mod` 文件。模块路径（Module Path）与版本号共同标识一个模块，同时也是模块内所有包的导入路径前缀。本地练习可使用保留域名 `example.com`；准备协作或发布的仓库则应从一开始使用真实代码托管路径，例如 `github.com/you/hello`。

在 Go 1.27.1 下生成的 `go.mod` 如下（版本号随本地工具链变化）：

```text
module example.com/hello

go 1.27.1
```

`go` 指令既控制编译器对该模块启用的语言版本语义，也自 Go 1.21 起作为构建该模块所需的最低 Go 版本约束（并支持 `1.X.Y` 补丁级版本号）。当本地工具链低于模块要求的版本时，Go 1.21 引入的 `toolchain` 指令与 `GOTOOLCHAIN` 机制可按需自动下载并切换对应版本的工具链；在离线环境或需要严格固定镜像版本的 CI 中，可设置 `GOTOOLCHAIN=local` 禁止自动下载，强制使用本地已有工具链。日常增删依赖应通过 `go get`、`go mod tidy` 与 `go mod edit` 完成，避免把 `go.mod` 当成普通手写配置随意涂改。

### 1.2.2 编写、构建与运行 {#ch1-2-2}

新建源码文件 `hello.go`（此处刻意用空格缩进，留待下一小节演示格式化）：

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, world!")
}
```

这段最小程序包含四个核心要素：

- `package main`：声明当前文件属于可执行程序的入口包（非 `main` 包仅编译为库，不生成可执行文件）；
- `import "fmt"`：导入标准库格式化输入输出包 `"fmt"`；
- `func main()`：`main` 包的入口函数，在所有包级变量初始化与 `init` 函数执行完毕后由运行时调用；
- `fmt.Println`：调用 `fmt` 包导出的函数，向标准输出打印文本并换行。

编译并运行生成的可执行文件：

```sh
$ go build
$ ./hello
Hello, world!
```

Windows 平台默认生成 `hello.exe`。编译单个 `main` 包时，默认可执行文件名取自模块或包导入路径的最后一个非主版本号段（本例从 `example.com/hello` 得到 `hello`），与外层文件夹叫什么名字无关。需要固定输出路径或文件名时，使用 `-o` 显式指定：

```sh
$ go build -o bin/hello .
$ ./bin/hello
Hello, world!
```

本地快速验证也可直接运行 `go run .`：它会在临时目录完成编译并立即启动进程，不在当前目录留下二进制文件；正式构建与部署则应使用 `go build`。

在 Windows PowerShell 中，运行当前目录或子目录下的程序需带上路径前缀，显式指定 `-o` 时建议写明 `.exe` 后缀：

```powershell
go build -o bin/hello.exe .
.\bin\hello.exe
```

同时要注意 `go run` 的目标粒度：`go run .` 以整个包为单位编译，会自动纳入当前目录下所有满足构建约束（Build Constraints）的同包源文件；`go run hello.go` 则只把命令行点名的文件传给编译器。一旦同包代码拆成多个 `.go` 文件，就应统一使用 `go run .`。

### 1.2.3 使用 `go fmt` 统一格式 {#ch1-2-3}

上一小节的 `hello.go` 使用了空格缩进。Go 把代码风格直接内置到工具链中，无需再靠人工维护缩进与对齐规范：

```sh
$ go fmt ./...
hello.go
```

在模块根目录下，`./...` 会递归匹配当前模块的所有包。`go fmt` 会将源文件就地改写为标准格式（例如统一用制表符 Tab 缩进、对齐声明），并打印被修改的文件路径。日常开发建议在编辑器中开启“保存时自动格式化”，提交前再用 `go fmt ./...` 兜底。

统一格式除了省去风格争论，也能减少代码生成和重构带来的无关 Diff。接手旧项目需要批量格式化时，最好把纯格式改动单独提交，避免真实逻辑变更淹没在大片缩进差异里。

#### 为什么左花括号不能另起一行

Go 词法分析器在扫描源码时遵循确定性的分号自动插入规则：当一行的最后一个词法单元（Token）是标识符、基础字面量，或 `break`、`continue`、`fallthrough`、`return`、`++`、`--`、`)`、`]`、`}` 之一时，词法分析器会自动在该行末尾补入分号 `;`。因此下面的写法无法通过编译：

```go
func main()
{
	fmt.Println("Hello, world!")
}
```

`func main()` 末尾的 `)` 触发了自动插分号，使函数签名在换行处提前结束，下一行的 `{` 随之变成语法错误。`gofmt` 必须先把源码解析为合法的抽象语法树（AST）才能重排格式，因此无法代修这类语法错误。

### 1.2.4 使用 `go vet` 找出可疑代码 {#ch1-2-4}

把输出语句临时改成如下写法：

```go
fmt.Printf("Hello, %s!\n")
```

这行代码语法合法、类型也匹配 `Printf` 的可变参数签名，因此 `go build` 能顺利通过，但运行时却缺少与 `%s` 对应的实参。运行 `go vet` 可以提前揪出这类问题：

```sh
$ go vet ./...
# example.com/hello
./hello.go:6:2: fmt.Printf format %s reads arg #1, but call has 0 args
```

补齐实参即可修复：

```go
fmt.Printf("Hello, %s!\n", "world")
```

`go vet` 只针对一组高置信度的常见缺陷模式做静态检查，既不是完备的形式化证明，也不能替代单元测试、代码审查或 `staticcheck`、`golangci-lint` 等扩展检查工具。顺带一提，`go test` 在执行测试前会自动跑一小部分高优先级 `vet` 分析器（包含 `Printf` 格式检查），但显式运行 `go vet ./...` 覆盖的检查项更完整。本地提交前通常按以下顺序串联自检：

```sh
$ go fmt ./...
$ go vet ./...
$ go test ./...
$ go build ./...
```

## 1.3 开发工具 {#ch1-3}

虽然纯文本编辑器配合命令行就能写 Go，但接入具备语义理解能力的开发环境后，自动补全、跳转定义、重命名重构、单测运行和断点调试都会顺手很多。VS Code 等轻量编辑器通过官方语言服务器 `gopls` 获得 Go 语义分析能力，GoLand 则内置独立的索引与重构引擎。无论平时习惯哪款工具，项目构建流程都不应绑定特定 IDE 配置，而应保证在纯命令行与 CI 下独立可复现。

### 1.3.1 Visual Studio Code {#ch1-3-1}

VS Code 免费且跨平台。先安装官方 Go 工具链，再安装 Go 扩展（扩展 ID：`golang.go`），按提示补齐语言服务器 `gopls` 与调试器 Delve（`dlv`）即可。常用配置是开启保存时自动格式化（Format On Save）与自动整理导入路径（Organize Imports）。

### 1.3.2 GoLand {#ch1-3-2}

GoLand 是 JetBrains 面向 Go 的商业 IDE，开箱集成重构、调试、测试运行器与覆盖率视图，只需在项目设置中指定本地 Go SDK 路径即可使用；编辑器与插件生态的更多选择可参考 [Go 官方编辑器与 IDE 指南](https://go.dev/doc/editors)。

### 1.3.3 The Go Playground {#ch1-3-3}

[The Go Playground](https://go.dev/play/) 适合在免安装环境下快速验证语法、格式化或分享简短的自包含代码片段。由于运行在受限沙箱中，外部网络访问、CPU 时间、内存上限、虚拟文件系统和系统时钟均受限或采用固定模拟值，不能代替本地环境验证真实 I/O 与并发时序。

注意不要把密码、访问令牌、私钥、业务敏感数据或未公开代码贴进 Playground：点击分享即会把代码上传到公共服务器，任何拿到链接的人都能读取，且它也不提供私有持久化存储。

## 1.4 用 Makefile 固化流程 {#ch1-4}

把格式化、静态检查与编译步骤写进仓库脚本，可以避免每次手敲命令遗漏检查，也让本地操作与 CI 保持一致。在模块根目录新建 `Makefile`：

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

各部分作用如下：

- `.DEFAULT_GOAL := build`：直接执行 `make` 时默认运行 `build` 目标；
- 依赖链：`build: vet` 与 `vet: fmt` 串起 `fmt → vet → build` 的执行顺序，前一步返回非零退出码时立即中止后续步骤；
- `.PHONY`：将目标声明为伪目标，避免目录中恰好存在同名文件（如名为 `build` 的目录或文件）时跳过命令；
- 缩进规则：目标下方的命令行必须以 **Tab（制表符）** 开头，误用空格会导致 `make` 报错；
- 读写差异：`make fmt` 会直接改写工作区文件；后续引入测试后，可把 `go test ./...` 一并挂进 `build` 的前置依赖。

如果 CI 需要“只检查不改写”的格式校验，不能直接用 `go fmt ./...`，而应改用 `gofmt -l .`（注意 `gofmt` 接收文件或目录路径，不支持 `./...` 包通配符）：它会列出格式不合规的文件名，但自身退出码仍为 `0`，脚本需判断输出非空后主动返回非零状态码。

Windows 默认不带 `make`，可通过包管理器安装，或改写为 PowerShell 脚本；在 PowerShell 中顺序调用多条外部命令时，每步之后都要检查 `$LASTEXITCODE`，否则前序检查失败后脚本仍会继续执行 `go build`。构建产物的清理方式留作[本章练习](#ch1-exercises)。

## 1.5 理解 Go 兼容性承诺 {#ch1-5}

[Go 1 兼容性承诺](https://go.dev/doc/go1compat)的核心含义是：遵循 Go 1 语言规范编写且当前能正常编译运行的源码，在后续 Go 1.x 版本中通常无需修改即可继续编译并保持原有语义；标准库会持续扩充新 API，但除极少数例外不会破坏已有公开接口。

实际维护项目时，需要清楚这项承诺的边界：

- **只承诺源码级兼容**：不同版本的 Go 工具链之间不保证预编译目标文件或二进制产物的兼容性，升级工具链后必须从源码重新编译。
- **安全与缺陷修复豁免**：修复安全漏洞、消除规范歧义、修正标准库 Bug，或代码原本依赖未定义行为（例如 `map` 遍历顺序）时，升级后行为可能改变。
- **不在承诺范围内的能力**：`unsafe` 包、特定操作系统的底层细节、运行时调度与性能特征，以及实验性特性均不受兼容性承诺保护。
- **命令行输出格式可变**：`go` 工具的提示文本、缓存目录结构等非公开细节可能随版本调整，依赖解析终端文本的脚本在升级时需要复核。
- **第三方模块各自演进**：该承诺只约束 Go 语言与官方标准库，外部依赖遵循各自的语义化版本（SemVer）约束。

借助 `go.mod` 中的 `go` 指令，升级本地编译器与升级模块语言版本可以分步推进：先用新工具链按旧 `go` 版本编译回归，确认无误后再择机调高 `go.mod` 中的 `go` 版本号并单独验证新语义。

## 1.6 保持更新 {#ch1-6}

Go 通常按每半年一个主版本的节奏发布（每年 2 月与 8 月），并同时维护最近两个主版本的补丁序列（Minor/Patch Release；截至本章核对日期为 Go 1.27 与 Go 1.26）。补丁版常包含编译器修复、运行时改进与安全补丁，开发环境与构建镜像应及时跟进当前序列的最新补丁版。

常规工具链升级可按以下步骤核对：

1. 阅读[官方发布记录](https://go.dev/doc/devel/release)及目标版本的 Release Notes，确认语言、标准库与运行时变更点。
2. 在旧工具链下跑通全量测试并留存基准结果，便于升级后对照。
3. 按[官方安装指南](https://go.dev/doc/install)替换工具链（Linux 下记得先删旧目录再解压）。
4. 核对 `go version`，依次执行 `go fmt ./...`、`go vet ./...`、`go test ./...` 和完整构建。
5. 同步更新 CI 镜像、构建脚本（含 `GOTOOLCHAIN` 设置），并确认 `gopls`、`golangci-lint`、代码生成器及 Delve 等周边工具兼容新版本。
6. 单独评估是否上调 `go.mod` 的 `go` 版本指令，并针对激活的新语言或默认 `GODEBUG` 行为做专项验证。

还要牢记静态编译带来的运维边界：线上正在运行的 Go 二进制在构建时就已经把当时的标准库与运行时打包进去了，仅升级服务器或开发机上的 Go 工具链并不会影响已部署进程。每当标准库或运行时披露安全漏洞，都必须用新工具链重新编译二进制并重新发布替换。需要在本机并存测试多个版本时，可结合 `GOTOOLCHAIN` 环境变量或参考官方[多版本管理指南](https://go.dev/doc/manage-install)。

## 练习 {#ch1-exercises}

以下两题分别检验构建脚本编排与编译、静态检查、测试三者的职责边界。练习 2 的代码片段位于 `main` 函数内，且已导入标准库 `"fmt"`。建议先独立作答，再展开核对参考答案。

### 练习 1：为 Hello 项目固化工具链

为仅含 `hello.go` 的模块编写 `Makefile`，提供 `fmt`、`vet`、`build` 和 `clean` 四个目标。要求默认执行 `build` 并将可执行文件输出至 `bin/hello`，同时说明为何 `clean` 目标既要调用 `go clean` 又要显式清理自定义产物路径。

<details>
<summary>查看参考答案</summary>

```make
.DEFAULT_GOAL := build

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

**解析**：`go fmt` 统一源码格式，`go vet` 检查常见可疑构造，`go build -o` 将产物写入指定路径（`bin` 目录不存在时会自动创建）。`go clean ./...` 只会清理模块构建缓存及默认命名的构建产物，并不知道 `-o bin/hello` 自定义输出到了哪里，因此 `clean` 目标还必须显式删除 `bin/hello`（以及 Windows 下可能生成的 `bin/hello.exe`）。

上例的 `rm -f` 适用于 Unix Shell；在原生 Windows PowerShell 中，对应的构建与清理写法如下：

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

针对以下三个代码场景，分别判断 `go build`、`go vet` 的检查结果与程序运行输出，并说明拦截对应问题所需的手段。

```go
// 场景 A
fmt.Printf("Hello, %s!\n", "world")

// 场景 B
fmt.Printf("Hello, %s!\n")

// 场景 C：业务需求规定输出 "Hello, world!"
fmt.Printf("Hello, %s!\n", "wrong name")
```

<details>
<summary>查看参考答案</summary>

| 场景 | `go build` | `go vet` | 运行时输出 | 拦截手段 |
| --- | --- | --- | --- | --- |
| A | 通过 | 通过 | `Hello, world!` | 无需修复 |
| B | 通过 | 报错（格式化占位符与实参数量不匹配） | `Hello, %!s(MISSING)!` | 静态分析（`go vet`） |
| C | 通过 | 通过 | `Hello, wrong name!` | 单元测试（断言输出）与代码审查 |

**解析**：编译器负责词法、语法与类型安全检查；`go vet` 能识别特定模式的可疑调用（如格式化字符串与参数个数失配），但不理解业务需求。编译与静态检查全绿只说明代码在语言与常见模式层面合法，业务行为是否正确仍必须靠自动化测试与代码审查把关。

</details>

## 面试题 {#ch1-interview}

以下三题围绕包级构建粒度、词法分号插入规则与静态产物的运维边界展开。建议先独立作答，再展开核对参考答案。

### 面试题 1：按包运行和按文件运行有什么区别？

模块根目录下有同属 `main` 包的 `hello.go` 与 `message.go`，其中 `hello.go` 调用了定义在 `message.go` 中的 `message()` 函数。分别执行 `go run .` 与 `go run hello.go` 会发生什么？

<details>
<summary>查看参考答案</summary>

- `go run .` 以当前目录所在的整个包为单位编译，会自动纳入同包下的 `hello.go` 与 `message.go`，可正常解析 `message()` 并输出结果。
- `go run hello.go` 只把显式指定的 `hello.go` 传给编译器，缺少 `message.go` 中的定义，编译阶段即报错 `undefined: message`。

</details>

### 面试题 2：为什么 `gofmt` 不能修复另起一行的函数左花括号？

<details>
<summary>查看参考答案</summary>

不能修复，且源码无法通过编译。根据 Go 词法分析器的分号自动插入规则，函数签名末尾的右括号 `)` 会在行尾自动触发插入分号 `;`，导致函数声明在换行处截断，下一行的左花括号 `{` 构成语法错误。`gofmt` 只能在源码成功解析为合法抽象语法树（AST）后重排格式，无法代替编译器修复语法错误。

</details>

### 面试题 3：源码或工具链更新后，已部署的 Go 二进制会自动更新吗？

<details>
<summary>查看参考答案</summary>

不会。Go 编译器会将业务代码、第三方依赖、标准库和运行时一并静态编译进可执行文件。无论是修改了业务源码，还是为了修复标准库或运行时安全漏洞而升级了 Go 工具链，都必须使用新工具链重新编译生成二进制文件，并重新部署替换线上进程后才会生效。

</details>

## 参考资料

- [Go 官方下载与安装指南](https://go.dev/doc/install)
- [Go 官方下载页](https://go.dev/dl/)
- [Go 多版本工具链安装与管理](https://go.dev/doc/manage-install)
- [Go 模块文件参考（`go.mod`）](https://go.dev/doc/modules/gomod-ref)
- [Go 工具链管理（`toolchain` 与 `GOTOOLCHAIN`）](https://go.dev/doc/toolchain)
- [Go 命令参考文档](https://go.dev/cmd/go/)
- [Go 语言规范：分号自动插入规则](https://go.dev/ref/spec#Semicolons)
- [Go 编辑器插件与 IDE 指南](https://go.dev/doc/editors)
- [Go 1 兼容性承诺](https://go.dev/doc/go1compat)
- [Go 版本发布策略与历史记录](https://go.dev/doc/devel/release)
