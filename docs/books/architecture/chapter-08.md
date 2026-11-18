---
title: 第 8 章 容器隔离原语（cgroups v2）、CRI 运行时与 Kubernetes 调度模型
description: 穿透 Linux Namespaces 与 cgroups v2 内核机制、CRI/containerd 容器运行时、Pod 声明式控制器模型及 Kubernetes 调度框架与 QoS 驱逐。
---

# 第 8 章 容器隔离原语（cgroups v2）、CRI 运行时与 Kubernetes 调度模型

## 本章要点

云原生架构得以将分布式复杂性对业务隐藏，前提是拥有一套标准化、可编程、随时可销毁重建的**不可变基础设施**。许多开发者每天编写 Dockerfile 与 Kubernetes YAML，却误以为“容器是一台轻量级虚拟机”，以致在遇到容器内 `top` 看到宿主机全量内存、Pod 莫名被内核 `OOMKilled` 或高优服务无法抢占 GPU 资源时束手无策。本章整合原书第 11 章、第 14 章与附录 B，全面对齐 **Kubernetes 1.32+ 与 Linux 6.x/7.x 内核标准**：首先穿透 Linux Namespaces、**cgroups v2 统一层级**与淘汰 `dockershim` 后的 **CRI + `containerd`** 调用链；随后剖析 Pod 原子模型、原生 Sidecar 容器与声明式控制回路；最后详解三级 QoS 驱逐与 **`Scheduling Framework` 调度流水线**。

> 核对日期：2026 年 11 月 17 日；核对环境为 Go 1.27.4、Docker 29.10、Linux/AMD64。

## 8.1 Linux 容器内核基石与 CRI 标准运行时 {#ch8-1}

### 8.1.1 容器的本质：Namespaces 视图隔离 + cgroups v2 资源配额 {#ch8-1-1}

不同于通过 Hypervisor 模拟整套硬件并运行独立客户机内核的虚拟机，**容器本质上只是宿主机操作系统上受到视图欺骗与资源受限的普通进程**，由三大 Linux 内核机制联手塑造：

1. **`pivot_root` + OverlayFS 联合挂载**：将容器只读镜像分层（LowerDir）与容器私有可写层（UpperDir）合并呈现为独立的根文件系统视图。
2. **Linux Namespaces（8 类访问视图隔离）**：通过 `clone()` 系统调用标志隔离进程可见范围——包括 `Mount`（挂载点）、`UTS`（主机名）、`IPC`（进程间通信）、`PID`（独立进程号树——注意订正原书将容器初始化进程误写为 `0 号进程` 的笔误：内核调度空闲进程才是 PID 0，**用户态与容器内初始化入口进程恒为 `PID 1`**！）、`Network`（独立网卡/路由/端口栈）、`User`（容器内 root 映射为宿主机非特权普通 UID 防逃逸）、`Cgroup`（隔离 `/proc/self/cgroup` 防止容器窥探宿主机配额）以及 Linux 5.6 新增的 `Time`（注意订正原书误述：**Kubernetes Pod 默认并不创建独立 Time Namespace**，各容器直接共享宿主机内核时钟）。
3. **cgroups v2（Control Groups v2 统一层级与 PSI 压力感知）**：原书写作时容器尚停留在各子系统各自挂载独立目录树的 cgroups v1；如今主流发行版（Ubuntu 22.04+、RHEL 9+）与 **Kubernetes 1.25+ 已全面转正 cgroups v2**（K8s 1.31+ 已推进弃用 v1）：
   - **单一统一树结构（Unified Hierarchy）**：消除了 v1 中一个进程不同线程分属不同子系统控制组导致的协同混乱，特别是打通了 **`memory` 与块设备 `io` 子系统的协同**——彻底解决了 v1 无法限制内核页缓存异步回写（Buffered Writeback）磁盘 I/O 的顽疾！
   - **细粒度内存节流与 PSI**：在硬上限 `memory.max`（触线即 OOM）前新增软节流阈值 **`memory.high`** 平滑回收内存，并内置 **PSI（Pressure Stall Information）** 精确统计进程因等待 CPU、内存或 I/O 而停顿的时间占比。

### 8.1.2 告别 Dockershim：OCI 标准与 kubelet → containerd 调用链 {#ch8-1-2}

早期 Kubernetes 为兼容 Docker Engine 曾在 `kubelet` 内部维护了一层笨重的转译垫片 `dockershim`。**自 Kubernetes 1.24 起已彻底删除 `dockershim`**——原书附录 B 基于 Docker daemon 的部署命令已完全作废，`kubeadm` 现统一对接 `pkgs.k8s.io` 源、`registry.k8s.io` 镜像库与开启 `SystemdCgroup = true` 的 `containerd`。现代生产标准容器启动链路如下：

```text
kubelet ──(CRI v1 gRPC)──► containerd (守护进程) ──► 拉起每个容器专属的 containerd-shim-runc-v2 垫片进程
                                                            │
                                                            ├── 调用 OCI 运行时 runc（或 crun / Kata / gVisor runsc）创建隔离环境
                                                            └── 【关键细节】runc 初始化完容器进程后立即退出！由 shim 垫片常驻充当容器父进程！
```

注意订正原书配图将 `runc` 画为常驻中间层的误导：**`runc` 只是一个瞬时命令行创建工具**，拉起业务进程后即刻退出；真正驻留负责接管容器标准输入输出（stdio）、向 `containerd` 汇报退出码并实现 **`containerd` 重启升级不杀业务容器**的功臣是轻量的 **`containerd-shim`**！且通过 Kubernetes **`RuntimeClass`**，同一集群可无缝混跑默认极速 `runc` 容器与面向不可信代码的 **Kata Containers（轻量微虚拟机）/ gVisor** 安全沙箱。

## 8.2 Pod 模型、声明式控制回路与应用封装 {#ch8-2}

### 8.2.1 Pod 超亲密协作、Pause 根容器与原生 Sidecar 容器 {#ch8-2-1}

为什么 Kubernetes 的最小调度单元是 **Pod（豌豆荚）** 而不是单个容器？因为真实工程中存在日志采集器、服务网格代理等必须与主业务进程同机共生、共享本地回环网络的辅助进程——若塞进同一个容器会违背“单容器单进程”打包解耦原则，若拆成两个独立调度单元又面临跨主机协同调度（Coscheduling）死锁难题。

Pod 通过首先启动一个仅占几十 KB 的极简 **`Pause`（Infra）根容器** 来锚定共享边界：
- **默认共享**：Pod 内所有业务与辅助容器全部加入 `Pause` 容器创建的同一个 **`Network`、`IPC` 与 `UTS` Namespace**——因此同一 Pod 内的多个容器共享**完全相同的 IP 地址与端口空间**，直接通过 `localhost` 零开销通信！
- **默认隔离**：各容器的 **`Mount` 文件系统与 `PID` 视图默认彼此隔离**（需共享临时目录时挂载同一个 `emptyDir` Volume；需共享进程树时显式开启 `shareProcessNamespace: true`）。

> [!TIP]
> **Kubernetes 1.28+ / 1.33 GA 里程碑：原生 Sidecar 容器（`initContainers` + `restartPolicy: Always`）**：过去把网格代理或日志代理放在普通 `containers` 列表中存在两大痛点——① 业务容器启动比边车还快时，首波请求因网络未就绪直接报错；② 跑批处理 `Job` 主任务早已成功退出，但常驻边车不退出导致 `Job` 永远无法进入 `Completed` 态！现代 K8s 只需将边车定义在 `initContainers` 中并设置 **`restartPolicy: Always`**，内核级保证“**边车必定先于业务容器就绪启动，且当所有普通业务容器正常结束时自动优雅终止边车**”！

### 8.2.2 声明式控制器模式与高层封装生态 {#ch8-2-2}

Kubernetes 架构的灵魂是**声明式 API + 调谐控制循环**（Reconciliation Control Loop）。用户向集群状态网关与 etcd 唯一读写前端 `kube-apiserver` 提交期望状态 `Spec`——注意订正原书将其误称为“指标监视器”的表述，CPU/内存实时监控指标实由 `kubelet` 内置 `cAdvisor` 经 **`Metrics Server`** 聚合暴露；随后 `kube-controller-manager` 中的控制器持续执行“观测当前状态 `Status` -> 比对差异 `Diff` -> 驱动状态收敛”：

- 无状态负载由 `HPA（弹性扩缩）-> Deployment（滚动替换版本）-> ReplicaSet（维持副本数自愈）` 托管；
- 有状态集群（如数据库、消息队列）使用 **`StatefulSet`**（注意必须声明 `apiVersion: apps/v1` 与必填 `selector`，订正原书早已移除的 `apps/v1beta1` 失效 YAML）提供稳定的序号域名（`pod-0`、`pod-1`）、确定性启停顺序与独占持久化卷模板，更复杂的备份切主运维知识则通过 **`CRD + Operator`** 编码为自定义控制器；
- 安全准入层面，早年复杂的 `PodSecurityPolicy (PSP)` 已于 K8s 1.25 彻底移除，现代统一采用内置 **`Pod Security Admission (PSA)`** 与基于 CEL 表达式的原生 **`ValidatingAdmissionPolicy`**（K8s 1.30 GA）做无 Webhook 极速策略拦截。

## 8.3 资源配额、三级 QoS 驱逐与调度器框架 {#ch8-3}

### 8.3.1 可压缩 / 不可压缩资源、QoS 等级与节点压力驱逐 {#ch8-3-1}

Kubernetes 将计算资源严格区分为两类物理特性截然不同的维度，并拆分为**调度账本依据 `requests`** 与 **cgroups 硬上限 `limits`**（K8s 1.33+ 已支持 `InPlacePodVerticalScaling` 在线热修改 Pod CPU/内存配额而免重建 Pod！）：

- **可压缩资源（CPU，单位 `1000m = 1 Core`）**：超限时仅通过 cgroups CFS 配额节流（Throttling）使进程变慢，**绝不会杀死进程**。
- **不可压缩资源（Memory，单位二进制 `Mi` / `Gi`）**：容器内存一旦触碰 `limits` 立即被内核 **`OOMKilled`（退出码 `137`）**！

当宿主机整体可用物理内存跌破 `kubelet` 硬驱逐红线（如默认 `memory.available < 100Mi` 或磁盘 `nodefs.available < 10%`）时，系统严格按 Pod 配置自动推导出的**三级服务质量**（QoS Class）由低到高依次牺牲驱逐：

| QoS 等级 | 自动判定充要条件 | 节点内存紧缺时的生存优先级与生产适用对象 |
| --- | --- | --- |
| **`Guaranteed`**（最高保障） | Pod 内**每一个容器**都同时显式设置了 CPU 和 Memory，且 **`requests` 严格等于 `limits`** | **最后才被杀**（`oom_score_adj = -997`）；**核心交易服务、有状态中间件必选**！ |
| **`Burstable`**（弹性突发） | 不满足 `Guaranteed`，但至少有一个容器设置了 CPU 或 Memory 的 `requests` 或 `limits` | 居中（按实际内存使用超出 `requests` 的比例排序驱逐）；适合普通无状态 Web 服务 |
| **`BestEffort`**（尽力而为） | Pod 内所有容器**未设置任何** CPU 和 Memory 的 `requests` 与 `limits` | **第 1 批立即强杀牺牲**（`oom_score_adj = 1000`）；仅限随时可重跑的离线低优任务 |

### 8.3.2 kube-scheduler 双循环与统一调度框架（Scheduling Framework） {#ch8-3-2}

`kube-scheduler` 采用源自 Google Omega 论文的**无锁内存缓存双循环架构**：后台 Informer 循环监听 `apiserver` 事件维护全内存 `Scheduler Cache`；主调度循环每次从优先级队列弹出一个待调度 Pod，现已彻底废除早期的 `Predicates / Priorities` 硬编码逻辑，100% 运行在插件化的 **`Scheduling Framework` 流水线**之上：

```text
待调度 Pod ──► [同步调度周期 Scheduling Cycle（串行全内存计算，零远程 I/O）]
                 1. PreFilter -> 2. Filter（过滤剔除资源不够、端口冲突、不满足节点亲和性或污点 Taint 的节点）
                                      │ 若全部节点被筛光 (0 可用节点)
                                      ▼
                 3. PostFilter（触发抢占 Preemption：模拟驱逐某节点上 PriorityClass 更低的 Pod 腾出空间）
                                      │ 存在候选节点
                                      ▼
                 4. PreScore -> 5. Score（各插件在 0～100 区间打分并按权重汇总，选出最高分节点）-> 6. Reserve（内存预占防并发冲突）
                                      │
                                      ▼
              [异步绑定周期 Binding Cycle（并发执行）]
                 7. Permit（准入等待，支撑 AI 多卡成组原子调度 Gang Scheduling）-> 8. PreBind（如挂载卷）-> 9. Bind（写回 apiserver）
```

针对现代 AI 大模型多 GPU 训练负载，传统仅支持整数计数的 `Device Plugin`（如 `nvidia.com/gpu: 4`）无法表达 NVLink 拓扑亲和、单卡切分与多容器共享——**Kubernetes 1.34 已正式 GA 动态资源分配 `DRA`（Dynamic Resource Allocation，基于类似 PVC 的 `ResourceClaim` 与 `DeviceClass`）**，配合 **Kueue / Volcano** 实现多 Pod 成组协同调度（修正原书“有了 Pod 就不再需要协同调度”的早期局限判断）。

## 练习 {#ch8-exercises}

以下 2 道练习分别检验容器内存视图与 QoS 驱逐事故排查，以及面向高可用数据库与批处理混部的调度亲和/抢占设计。建议先独立作答，再展开核对参考答案。

### 练习 1：诊断两组线上 Pod 频繁退出码 137（OOMKilled）与被驱逐（Evicted）的根因

某 Kubernetes 集群（节点物理内存 `64 GiB`）出现两起容器异常重启：
1. **故障 A**：某 Java 服务 Pod 配置了 `requests.memory: 2Gi`、`limits.memory: 4Gi`，启动脚本使用老旧写法根据宿主机 `/proc/meminfo` 计算堆大小（或未限制堆外直接内存），运行半小时后无任何应用报错日志便瞬间重启，`kubectl describe pod` 显示 `State: Terminated, Reason: OOMKilled, Exit Code: 137`。
2. **故障 B**：某核心计费网关 Pod 配置了 `requests: {cpu: "2", memory: "4Gi"}`、`limits: {cpu: "4", memory: "4Gi"}`，运维满以为它内存设了 `requests == limits` 就是最高等级 `Guaranteed`；结果同节点批处理任务内存暴涨触发节点压力时，该核心网关竟然先于另一个小服务被 `kubelet` 驱逐（`Status: Evicted`）！

请分别指出故障 A 和故障 B 的底层原因并给出精确修复方案。

<details>
<summary>查看参考答案</summary>

1. **故障 A 根因与修复**：
   - **根因**：早期容器未隔离 `/proc/meminfo` 时程序误读宿主机 `64 GiB` 物理内存将 JVM 堆开得过大，或 JVM 虽配了 `-Xmx4g` 但忽略了 Metaspace、线程栈、Netty Direct Memory 与 glibc Arena 等堆外内存——只要容器内所有进程总物理内存触碰 cgroups v2 的 `memory.max = 4GiB` 硬红线，Linux 内核 OOM Killer 就会直接发 `SIGKILL (9)` 强杀进程（`128 + 9 = 137`，进程根本来不及写任何遗言日志！）。
   - **修复**：升级至容器感知完备的现代 JDK 21+，使用 `-XX:MaxRAMPercentage=70.0` 预留 30% 余量给堆外内存与页面缓存，避免把堆顶满容器 `limits`。
2. **故障 B 根因与修复（极高频 QoS 判定踩坑点！）**：
   - **根因**：成为 **`Guaranteed`** 的严格条件是 **Pod 内所有容器（含边车！）的 CPU 和 Memory 两项资源的 `requests` 都必须严格等于各自的 `limits`**！该计费网关虽然 `memory` 相等（`4Gi == 4Gi`），但 **CPU 配置成了 `requests: 2` != `limits: 4`**——导致整个 Pod 降级沦为了 **`Burstable`**，丧失了最高免死金牌！
   - **修复**：将业务容器及 Pod 内所有边车容器的 CPU 与 Memory 均对齐设为相等（如 `requests: {cpu: "4", memory: "4Gi"}`、`limits: {cpu: "4", memory: "4Gi"}`），并为其绑定高优先级的 `PriorityClass`。

</details>

### 练习 2：为同集群混部“在线交易核心服务”与“夜间空闲算力离线训练任务”设计调度与保障策略

为提升服务器资源利用率，平台计划在同一套 Kubernetes 集群混部两类负载：① 白天高峰不能有任何闪失的在线交易微服务（需跨 3 个可用区均衡打散防单机房掉电）；② 利用夜间碎片算力运行的离线批量特征计算任务（允许随时中断重跑）。请结合本章机制写出四项关键配置设计。

<details>
<summary>查看参考答案</summary>

1. **严格分级 QoS**：在线交易服务全部配置 `requests == limits` 锁定为 **`Guaranteed`**（必要时开启 kubelet `static` CPU Manager 绑占独占物理核）；离线任务设为低 `requests` 的 **`Burstable`** 或 **`BestEffort`**。
2. **高低优先级抢占（PriorityClass + Preemption）**：为在线交易绑定 `priority: 100000` 的 `high-online` 类，为离线任务绑定 `priority: -100`（且可设 `preemptionPolicy: Never` 禁止离线任务互相抢占震荡）的 `low-batch` 类——一旦白天在线流量激增触发 HPA 扩容，调度器在 `PostFilter` 阶段会毫秒级自动抢占驱逐离线任务腾出节点资源。
3. **跨可用区拓扑均匀打散（`topologySpreadConstraints`）**：在在线交易 Deployment 中配置 `topologyKey: topology.kubernetes.io/zone`、`maxSkew: 1`，强制调度器在 `Filter/Score` 阶段将副本均匀铺在 3 个 AZ。
4. **原生 Sidecar 与配额围栏**：离线任务日志/监控辅助容器统一使用 `initContainers` + `restartPolicy: Always` 原生边车确保任务跑完即刻释放 Pod，并用 `ResourceQuota` 封顶离线命名空间总上限。

</details>

## 面试题 {#ch8-interview}

以下 3 道面试题聚焦容器与虚拟机隔离边界、`dockershim` 移除真相与 Pod `Pause` 容器机制。建议先独立作答，再展开核对参考答案。

### 面试题 1：既然有了 Docker 容器，为什么多租户公有云跑不可信第三方代码时不能直接裸跑普通 `runc` 容器，而要用 Kata Containers 或 gVisor？

<details>
<summary>查看参考答案</summary>

因为普通 `runc` 容器**与宿主机及同机所有其他容器共享同一个 Linux 操作系统内核**！

`Namespaces` 与 `cgroups` 只是在内核系统调用入口加了视图过滤与配额账本，容器进程每一次读写文件、收发网络包都直接调用宿主机内核的 300 多个系统调用——一旦宿主机 Linux 内核曝出提权漏洞（如经典的 Dirty Pipe / Dirty COW），恶意容器即可直接击穿 Namespace 实现**容器逃逸**控制整台物理机！

- **gVisor（`runsc`）**：在用户态用 Go 实现了一层软内核 `Sentry` 拦截模拟绝大部分系统调用，把容器进程与宿主机真内核隔开；
- **Kata Containers / Firecracker**：为每个 Pod 启动一个毫秒级超轻量独立微虚拟机（拥有独立 Guest 内核），在完全兼容 OCI 镜像与 K8s CRI 编排体验的同时，提供硬件虚拟化级别的强安全边界。

</details>

### 面试题 2：Kubernetes 1.24 宣布“移除 Dockershim”当时引发很多恐慌，这是否意味着 Docker 构建出来的镜像在 K8s 里不能跑了？

<details>
<summary>查看参考答案</summary>

**完全不是！Docker 构建的镜像 100% 照常运行，受影响的仅仅是宿主机节点底层的运行时调用链瘦身。**

1. **镜像格式早已被 OCI 标准化**：`docker build` 产出的镜像遵循开放的 **OCI Image Spec** 标准，任何符合标准的运行时（`containerd`、`CRI-O`）都能原生拉取和解压运行。
2. **为什么删掉 `dockershim`**：Docker Engine 本身内部也是调用拆出去的 `containerd -> runc` 来真正跑容器的；旧链路 `kubelet -> dockershim -> Docker Engine -> containerd -> runc` 多绕了两层无谓的进程转发与损耗。移除 `dockershim` 后，`kubelet` 直接通过标准 CRI gRPC 连 `containerd`，链路更短、内存更省、故障率更低。

</details>

### 面试题 3：每个 Kubernetes Pod 里为什么都会多出一个什么业务都不干的 `Pause`（`registry.k8s.io/pause`）容器？如果把它杀掉会发生什么？

<details>
<summary>查看参考答案</summary>

1. **`Pause` 容器的两大核心职责**：
   - **充当 Pod 共享 Namespace 的锚点宿主**：Pod 内的主业务容器可能会因为报错重启重建（一旦容器销毁其自身创建的 Namespace 就会消失）；由永不干重活、极度稳定的 `Pause` 容器率先创建并一直持有 `Network`、`IPC`、`UTS` 命名空间，哪怕业务容器崩溃重启十次，Pod 的 IP 地址与本地网络栈依然稳如泰山！
   - **在开启共享 PID 命名空间时充当 `PID 1` 收割僵尸进程**：负责调用 `wait()` 回收容器内孤儿进程留下的僵尸进程表项。
2. **杀掉 `Pause` 的后果**：`kubelet` 检测到 Sandbox 沙箱根容器死亡，意味着整个 Pod 的网络命名空间已销毁，会立即销毁并重建该 Pod 内的所有业务容器。

</details>

## 参考资料

- [Linux Kernel Documentation：Control Group v2（cgroups v2 Unified Hierarchy）](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Kubernetes Official Documentation：Container Runtime Interface（CRI）& Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Kubernetes Official Documentation：Pod Quality of Service（QoS）Classes & Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Kubernetes Official Documentation：Scheduling Framework & Dynamic Resource Allocation（DRA）](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
