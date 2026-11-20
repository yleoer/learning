---
title: 第 9 章 容器网络（CNI / eBPF）、持久化存储（CSI）与无边车服务网格
description: 深入剖析 Linux 虚拟网络与 Cilium eBPF 加速、Kubernetes CSI 三阶段持久化存储及从 Sidecar 向 Ambient Mesh 无边车服务网格的演进。
---

# 第 9 章 容器网络（CNI / eBPF）、持久化存储（CSI）与无边车服务网格

## 本章要点

单机容器隔离只是云原生的起点；要将数千台物理机编织为一台对应用透明的“数据中心级超级计算机”，还必须打通三大底层基础设施平面：容器跨主机通信平面（CNI）、有状态数据跨节点漂移挂载平面（CSI），以及透明接管七层治理与零信任安全的服务网格平面（Service Mesh）。本章整合原书第 12、13、15 章，全面对齐 **Cilium eBPF、CSI 全外置化与 Istio Ambient Mesh（GA）** 等当代生产标准：首先穿透 `veth`/Bridge/VXLAN 内核路径与 **eBPF Socket 直通加速**；其次梳理 PV/PVC 动态供给、**`ReadWriteOncePod`** 与 CSI 三阶段六操作；最后剖析 Envoy `xDS` 协议及从传统 Sidecar 向无边车架构的范式跃迁。

> 核对日期：2026 年 11 月 20 日；基于 Kubernetes CSI / Gateway API、Cilium、Envoy 与 Istio 官方文档核对（本地参考环境为 Go 1.27.4、Docker 29.10、Linux/AMD64，未在真实多节点 Kubernetes / Istio 集群执行性能压测）。

## 9.1 Linux 虚拟网络、CNI 模式与 Cilium eBPF 加速 {#ch9-1}

### 9.1.1 Netfilter、虚拟网卡原语与 Overlay / Underlay 跨机网络 {#ch9-1-1}

Linux 容器联网依赖内核网络栈钩子（Netfilter 五个挂载点：`PREROUTING`、`INPUT`、`FORWARD`、`OUTPUT`、`POSTROUTING`）以及三类核心虚拟网络设备。注意订正原书将端到端 ACK 重传误归因于二层有线网卡驱动的笔误：重传完全由四层 TCP 协议栈负责；且现代 K8s 1.33+ `kube-proxy` 已正式 GA **`nftables` 模式**替代大规模下 `O(N)` 线性匹配的旧 `iptables`：

- **`veth pair` + `Linux Bridge`**：`veth pair` 如同一根两端跨命名空间直连的虚拟网线，一端插在容器 `Network Namespace` 内充当 `eth0`，另一端插在宿主机二层虚拟网桥 `br0`（如 `cni0`）上；注意单机桥接 NAT 模式下宿主机物理网卡 `eth0` **并不桥接进 `br0`**，外网回包到达物理 `eth0` 后经内核三层 `conntrack` 逆向 DNAT 与路由转发才进入 `br0`（订正原书配图将物理 `eth0` 挂在 `br0` 下方的拓扑偏差）。
- **`VXLAN`（Overlay 隧道模式）vs `BGP`（路由模式）**：遵循 Kubernetes **CNI**（Container Network Interface）插件标准的跨主机组网方案分为三大流派：

| CNI 组网模式 | 代表插件方案 | 跨主机数据包转发机制 | 性能损耗与网络环境要求 |
| --- | --- | --- | --- |
| **Overlay 覆盖隧道** | Flannel `VXLAN`、Cilium `VXLAN/Geneve` | **MAC-in-UDP** 封装（标准端口 `4789`，支持 24-bit 共 1677 万个 VNI；注意 12-bit VLAN 标识缩写为 `VID`、QinQ 标准为 `802.1ad`） | 兼容性最强（跨任意三层机房即插即用）；代价是每包多 **`50 字节` 外层封装头**（MTU 需减 50）及内核封解包 CPU 开销 |
| **三层原生路由** | Calico `BGP`、Cilium `Native Routing`、Flannel `host-gw` | 不封隧道包，直接将对端宿主机配为目标 Pod 子网下一跳（跨子网通过 BGP 同步物理路由器） | **零封装损耗，吞吐逼近物理裸机**；要求底层机房网络放通路由协议或二层直连 |
| **Underlay 硬件直通** | MACVLAN、IPVLAN、SR-IOV | Pod 直接分配底层物理网络真实 IP 与硬件队列 | 延迟最低，但耗尽底层交换机 IP/MAC 表项，弹性受限 |

### 9.1.2 Cilium + eBPF 如何重塑云原生网络数据面 {#ch9-1-2}

传统 `iptables` + `veth` 路径下，每个数据包在容器与宿主机之间都要完整穿越两次内核 TCP/IP 协议栈与成千上万条 Netfilter 链式规则。以 CNCF 毕业项目 **Cilium** 为代表的现代 **eBPF（Extended Berkeley Packet Filter）** 网络底座，通过在内核关键挂载点注入经安全验证的 JIT 字节码实现了降维打击：

```text
[传统 iptables + veth 路径]  应用 Socket ──► 容器 TCP/IP 栈 ──► veth 软中断 ──► 宿主机 Netfilter/iptables O(N) 遍历 ──► 物理网卡
[现代 Cilium eBPF 路径]      应用 connect() 系统调用 ──► cgroup/connect4 eBPF 直接 O(1) 查哈希表将 ClusterIP 替换为目标 Pod IP！
                             同机或边车通信直接经 sockops / sk_msg 在 Socket 缓冲区之间零协议栈直通拷贝！
```

它不仅能**100% 彻底移除并替代 `kube-proxy`**，还原生提供基于服务身份（而非脆弱 IP）的 L3～L7 `NetworkPolicy` 以及零代码侵入的 **Hubble** 全局网络流可观测性。

## 9.2 Kubernetes 持久化存储（PV / PVC / CSI） {#ch9-2}

### 9.2.1 PV / PVC / StorageClass 动态供给与访问模式（RWOP） {#ch9-2-1}

容器自身的 OverlayFS 可写层随 Pod 重建即清空。Kubernetes 通过将“存储供给方式（运维关心的 **`StorageClass`** 与 **`PersistentVolume` PV**）”和“存储消费申请（开发关心的 **`PersistentVolumeClaim` PVC**）”解耦，实现了有状态负载跨节点重建挂载。

选型底层存储介质与声明访问模式时，必须遵循严格的物理语义边界（**订正原书图 13-10 将 AWS EBS 误标为文件系统接口、将 EFS 误标为对象存储的严重图表错误，以及建议数据库放弃块存储改用 NFS/EFS 的选型误导**）：

1. **三类存储介质铁律**：
   - **块存储**（如云盘 AWS EBS、Ceph RBD）：裸块设备低延迟高 IOPS，**MySQL、PostgreSQL、etcd、Kafka 等 I/O 与文件锁敏感型核心有状态集群必须采用 `StatefulSet + 块存储（配合延迟绑定 WaitForFirstConsumer）`**！
   - **文件存储**（如 NFS、AWS EFS、CephFS）：支持目录树与多节点并发读写共享（`ReadWriteMany`），适合共享静态媒资或日志归档，但元数据锁延迟高，严禁跑高并发关系数据库。
   - **对象存储**（如 S3、MinIO）：扁平 Bucket + HTTP REST 接口，海量廉价高吞吐，应由应用代码通过 S3 SDK 直接读写而非强行 Fuse 挂载成磁盘。
2. **四种标准访问模式（补齐 K8s 1.29 GA 的 `RWOP`）**：
   - `ReadWriteOnce (RWO)`：仅限**单个宿主机节点**读写挂载——注意盲区：若同一台宿主机上意外调度了两个 Pod 引用同一个 `RWO` PVC，两者仍能同时挂载写坏块设备！
   - **`ReadWriteOncePod (RWOP)`（K8s 1.29 GA）**：真正严格的**全集群唯一单 Pod 排他读写挂载**，为单主有状态中间件补齐最后一块安全拼图；
   - `ReadOnlyMany (ROX)` 与 `ReadWriteMany (RWX)`：多节点只读 / 多节点并发读写。

### 9.2.2 全外置 CSI 三阶段六操作控制闭环 {#ch9-2-2}

Kubernetes 现已将所有早期的树内（In-Tree）云存储驱动与冻结的 `FlexVolume` 全部清理出核心代码库，**CSI**（Container Storage Interface）成为唯一标准架构。一块云盘从创建到挂入容器目录，严格历经三大控制器接力完成的**三阶段六操作**：

```text
1. Provision / Delete (创建与销毁物理云盘)
   PV Controller 监测到新 PVC ──► External Provisioner 边车 ──(gRPC)──► 厂商 CSI Controller 创建云盘并生成 PV 对象
          │
          ▼ (Pod 调度绑定至目标 Node X)
2. Attach / Detach (将云盘远程挂载至宿主机 Node X 成为 /dev/vdb)
   AD Controller ──► External Attacher 边车 ──(gRPC ControllerPublishVolume)──► 云平台 API 将块设备挂上目标宿主机
          │
          ▼
3. Mount / Unmount (在宿主机格式化文件系统并 bind mount 进容器指定目录)
   Node X 上的 kubelet Volume Manager ──(本机 UNIX Socket gRPC)──► 节点级 CSI Node DaemonSet 完成挂载与扩容
```

## 9.3 服务网格（Service Mesh）：从 Sidecar 到 Ambient Mesh {#ch9-3}

### 9.3.1 控制面回归单体 istiod 与数据面 Envoy xDS 协议族 {#ch9-3-1}

服务网格通过分离**数据平面**（负责实际转发包的高性能代理 **Envoy**）与**控制平面**（负责将声明式治理规则编译下发的 **`istiod`**），向分布式系统发起了不侵入业务代码的“透明通信涅槃”。

在架构演进上，Istio 自身经历了一次极具启发意义的“**控制面从微服务回归模块化单体**”：早期 Istio `< 1.5` 曾教条拆分为 `Pilot`、`Mixer`（每笔请求都要跨网调 Mixer 检查遥测策略，沦为致命延迟瓶颈！）、`Citadel`、`Galley` 四个组件；**Istio 1.5+ 果断将控制面合并收敛为单一进程 `istiod`**——注意订正原书第 15 章将 Envoy Prometheus 指标端口 `15090` 与 Agent 健康聚合端口 `15020` 误称为 Mixer/Gateway 端口的偏差，并通过标准化的 **xDS 动态发现 gRPC 协议族**驱动数据面实时热更新：

| xDS 核心子协议 | 全称与对应抽象层级 | 解决的动态治理问题 |
| --- | --- | --- |
| **`LDS`** | Listener Discovery Service（监听器发现） | 动态指示 Envoy 监听哪些端口及挂载哪条 L4/L7 过滤器链 |
| **`RDS`** | Route Discovery Service（路由配置发现） | 动态下发 HTTP 域名、URI 前缀、Header 灰度权重分流与重试规则 |
| **`CDS`** | Cluster Discovery Service（上游集群发现） | 动态定义后端逻辑服务簇、负载均衡算法、连接池上限与断路器阈值 |
| **`EDS`** | Endpoint Discovery Service（端点实例发现） | 对接 K8s `EndpointSlice` 实时推送健康 Pod IP 列表，免去轮询 DNS |
| **`SDS`** | Secret Discovery Service（密钥证书发现） | **零信任核心**：纯内存安全推送并自动轮换 SPIFFE mTLS 私钥与证书 |

同时，在北向配置 API 标准上，原书介绍的 **SMI（Service Mesh Interface）已被 CNCF 正式归档淘汰**；取而代之的是全面 GA 的 **`Kubernetes Gateway API`（GAMMA 倡议）**——用同一套标准 `HTTPRoute` / `GRPCRoute` 同时统一了南北向入口网关与东西向服务网格路由！

### 9.3.2 消除“边车税”：Istio Ambient Mesh 无边车两层革命 {#ch9-3-2}

传统 Sidecar 模式通过准入 Webhook 为**每一个业务 Pod 都塞进一个 `istio-proxy`（Envoy）容器**，并用 `iptables` 将出入流量劫持到 `15006` / `15001` 端口。在大规模生产落地中，这种模式暴露出沉重的 **“三大边车税”**：
1. **高昂内存底噪**：5000 个 Pod 就要常驻 5000 个 Envoy 进程（即便空闲也额外吃掉数百 GB 内存）；
2. **双跳七层解析延迟**：每一次东西向调用都要在源端 Envoy 和目的端 Envoy 做两次完整的 HTTP/2 七层解析与内核协议栈往返；
3. **生命周期强耦合**：升级 Envoy 安全补丁必须滚动重启全公司所有业务 Pod！

为此，**Istio Ambient Mesh（已在 Istio 1.24+ 正式 GA）** 将零信任四层基础能力与按需七层治理彻底解耦，开创了**无边车（Sidecarless）两层数据面架构**：

```text
[业务 Pod 内零注入任何 Sidecar 容器！应用升级与网格升级 100% 解耦！]

源业务 Pod ──► [本节点共享 L4 安全隧道：ztunnel (Rust 编写极省内存 DaemonSet)]
                    │  通过 HBONE (HTTP/2 CONNECT 加密隧道) 零配置实现全集群强制双向 mTLS、SPIFFE 认证与四层遥测！
                    ├──► (若目标服务仅需加密与 L4 访问控制，90% 场景直接一跳送到对端节点 ztunnel -> 目标业务 Pod！)
                    └──► (仅当目标命名空间确需灰度分流/重试/熔断等复杂七层治理时，才按需经过独立的 L7 Waypoint Proxy 集群！)
```

配合节点内透明流量重定向与共享的 Rust `ztunnel` 代理，Ambient Mesh 把原本随 Pod 数量线性增长的固定边车底噪转化为按节点共享的四层开销与按需部署的七层 `Waypoint` 开销，标志着服务网格步入轻量透明演进阶段。不过需要强调：**切换至 Ambient 模式后的真实 CPU 与内存净收益并非固定的普适百分比，而高度取决于单节点 Pod 密度、节点共享 `ztunnel` 承载的并发连接与吞吐负载、按需部署的 `Waypoint Proxy` 副本数及七层规则复杂度**，上线前应参照 Istio 官方性能基准测试方法，在目标拓扑与真实流量模型下合并计量 `ztunnel`、`Waypoint` 与控制面的总资源占用和尾延迟后再做容量决策。

## 练习 {#ch9-exercises}

以下 2 道练习分别检验 Kubernetes CNI 与 CSI 生产架构选型排障，以及传统 Sidecar 网格向 Ambient Mesh 演进的资源收益核算。建议先独立作答，再展开核对参考答案。

### 练习 1：为混合负载 Kubernetes 集群选型 CNI 网络与有状态 CSI 存储方案

某金融科技公司在自建同机房 BGP 三层网络（共 300 台物理节点）上建设核心 Kubernetes 生产集群，运行两类关键工作负载：① 每秒数十万次内部调用的低延迟风控微服务群（要求开启精细 L4/L7 网络隔离策略，且消除 `kube-proxy` 大规模规则同步抖动）；② 基于 `StatefulSet` 部署的高并发账务 PostgreSQL 主从集群（严禁同一块底层 Ceph RBD 云盘在节点闪断脑裂期间被新旧两个 Pod 同时挂载写坏文件系统）。请给出完整的 CNI 插件工作模式与 PVC/StorageClass 关键配置选型。

<details>
<summary>查看参考答案</summary>

1. **网络平面（CNI）选型——`Cilium（BGP 原生路由模式 + Kube-Proxy Replacement）`**：
   - 自建机房支持 BGP，直接启用 **Cilium Native Routing + BGP** 免去 VXLAN `50 字节` 隧道封解包损耗，获得裸机级吞吐与延迟；
   - 开启 **`kubeProxyReplacement: true`**，彻底卸载节点 `kube-proxy`，利用 Socket 层 `cgroup/connect` eBPF 在系统调用入口 `O(1)` 完成 Service 负载均衡转发，并原生支撑基于身份的 L3/L4/L7 `CiliumNetworkPolicy` 与 Hubble 流监控。
2. **存储平面（CSI）选型——`Ceph RBD CSI 块存储 + ReadWriteOncePod + WaitForFirstConsumer`**：
   - 数据库严禁使用 CephFS/NFS 文件存储，必须选用低延迟块设备 **`ceph-rbd` CSI StorageClass**，配置 `volumeBindingMode: WaitForFirstConsumer` 确保云盘与 Pod 协同拓扑调度；
   - 在 `StatefulSet` 的 `volumeClaimTemplates` 中显式声明 **`accessModes: ["ReadWriteOncePod"]`（`RWOP`）**——由控制面与 CSI 联合保证全集群任何时刻最多只有唯一 1 个 Pod 能挂载该块卷，彻底防范同机双 Pod 重叠挂载写坏数据库页。

</details>

### 练习 2：评估 2000 Pod 集群从传统 Sidecar 迁移至 Ambient Mesh 的结构变化与路由升级

某企业集群运行着 200 个微服务共 **2000 个业务 Pod**（分布在 **40 台** 64 核工作节点上），此前全部注入了传统 Envoy Sidecar（平均每个 Envoy 容器常驻内存 `120 MiB`）。日常 85% 的内部服务仅需满足合规要求的“双向 mTLS 加密与服务间调用白名单鉴权”，仅有 15%（约 30 个核心服务）需要七层按 Header 金丝雀灰度与重试治理。同时团队此前基于已归档的 SMI 规范编写流量切分配置。请回答：
1. 传统 Sidecar 模式的边车静态内存基准开销是多少？迁移至 **Istio Ambient Mesh** 后，代理进程部署结构、升级耦合度以及资源评估方法会发生哪些关键变化？
2. 淘汰 SMI 后，南北向入口与东西向金丝雀灰度应统一迁移至什么官方标准 API？

<details>
<summary>查看参考答案</summary>

1. **代理结构变化、升级解耦与基于实测的资源评估**：
   - **传统 Sidecar 模式基线**：需伴随业务 Pod 运行 **2000 个** Envoy 实例，仅静态边车常驻内存基线即消耗 `2000 × 120 MiB ≈ 234.4 GiB`（尚未计入高并发下连接池与配置快照增长）；且升级 Envoy 安全补丁时必须将 2000 个业务 Pod 挨个滚动销毁重建。
   - **Ambient Mesh 架构变化与零重启升级**：2000 个业务 Pod 内部**零边车容器**——40 台节点上仅部署 **40 个**节点级共享的 Rust **`ztunnel`** DaemonSet 承接全集群 100% 服务的 mTLS 与四层 `AuthorizationPolicy`；仅对那 15% 需要七层治理的服务按命名空间或服务维度独立部署并按实际七层流量弹性扩缩 **`Waypoint Proxy`**。代理数量从“随 Pod 数量线性膨胀”转为“随节点数与七层流量按需伸缩”，且升级 `ztunnel` 或 `Waypoint` 与业务 Pod 生命周期彻底解耦，**无需重启业务 Pod**。
   - **真实收益须结合流量基准实测**：切忌套用无条件的固定节省百分比拍脑袋估算；落地前应参照 **Istio 官方性能基准方法（Performance and Scalability）**，在代表性并发连接数、QPS 与负载体量下，合并观测 40 个 `ztunnel` 实例的运行期 CPU/内存、按需 `Waypoint Proxy` 副本数及其七层规则（Header 路由、重试、遥测）开销，以及多一跳 `Waypoint` 对七层服务 P99 延迟的影响，综合核定真实资源净收益。
2. **统一路由标准 API**：
   - 全面迁移至正式 GA 的 **`Kubernetes Gateway API`**——通过 `HTTPRoute` / `GRPCRoute` 的 `parentRefs` 区分场景：指向边缘 `Gateway` 即配置南北向入口路由，指向内部 `Service` 即按 GAMMA 规范配置东西向网格按权重/Header 金丝雀分流。

</details>

## 面试题 {#ch9-interview}

以下 3 道面试题聚焦容器跨主机网络原理、CSI 存储挂载链路与服务网格演进。建议先独立作答，再展开核对参考答案。

### 面试题 1：两个分布在不同物理宿主机上的 Pod 通信时，Overlay（如 VXLAN）和 Underlay / BGP 路由模式在数据包走向上有什么本质区别？该如何选型？

<details>
<summary>查看参考答案</summary>

1. **数据包走向本质区别**：
   - **Overlay（VXLAN 隧道）**：源 Pod 发出的原始二层帧到达宿主机 `vxlan0`（VTEP）设备后，内核在外面**套上一层新的 UDP 头 + 宿主机外层 IP 头 + 外层 MAC 头（共多出 50 字节）**，底层物理交换机只看到两台宿主机 IP 之间的普通 UDP 包；到达目标宿主机后由对端 VTEP 拆掉外层壳再送进目标 Pod。
   - **BGP 三层路由模式**：**不加任何外层隧道封装**！每个节点分配独立的 Pod 网段（如节点 A 为 `10.244.1.0/24`、节点 B 为 `10.244.2.0/24`），通过 BGP 协议将“去往 `10.244.2.0/24` 的下一跳是节点 B 物理 IP”直接同步进宿主机与机房物理交换机路由表，原始 IP 包像普通物理机一样线速直达。
2. **选型准则**：在底层物理网络不可控的公有云跨子网环境或快速搭建测试集群时，选 **Overlay（VXLAN/Geneve）** 零网络改造开箱即用；在对延迟与带宽极度敏感的自建机房（或云厂商原生 VPC ENI 直通网络），优先选 **BGP 路由或 eBPF 原生路由模式**。

</details>

### 面试题 2：在 Kubernetes 中挂了云盘（CSI 块存储）的有状态 Pod 所在宿主机突然断电宕机，为什么新 Pod 在另一台机器重建时经常卡在 `ContainerCreating`（`Multi-Attach error`）好几分钟？

<details>
<summary>查看参考答案</summary>

这是块设备数据安全保护与三阶段解绑超时共同作用的结果：

1. **单写排他保护（防脑裂写坏磁盘）**：云盘块设备为 `RWO` / `RWOP` 模式，云厂商底层存储与 K8s `VolumeAttachment` 绝不允许同一块盘在尚未从旧宿主机 `Detach` 解绑前就 `Attach` 挂到新宿主机上，否则如果旧机器只是网络假死仍在刷脏页，双机同写会瞬间损毁文件系统超级块！
2. **卡顿链路**：旧宿主机断电失联后，`kubelet` 无法主动上报卸载完成；控制面需先等待节点心跳超时判定 `NotReady`（默认 `40s`），再等待驱逐容忍时间及 `AD Controller` 强制调用 `ControllerUnpublishVolume` 超时兜底（默认可达 `6 分钟`）确认旧挂载解除后，新节点才能完成 `Attach -> Mount` 启动容器。生产若需缩短恢复时间，须结合硬件带外电源隔离（STONITH / 云 API 确认关机）与 **Non-Graceful Node Shutdown** 污点机制安全加速解绑。

</details>

### 面试题 3：服务网格（Service Mesh）的传统 Sidecar 模式是怎么无侵入劫持业务 Pod 流量的？为什么现在又演进出了 Istio Ambient Mesh？

<details>
<summary>查看参考答案</summary>

1. **传统 Sidecar 流量劫持原理**：Pod 创建时由 `MutatingAdmissionWebhook` 自动注入 Envoy 边车与初始化网络规则（通过 Istio CNI 或 `init` 容器配置 Netfilter/`iptables` 或 eBPF）：将进入 Pod 的所有流量重定向到 Envoy 入站端口 `15006`，将业务进程发出的所有流量重定向到 Envoy 出站端口 `15001`，同时**通过匹配 Envoy 进程专属的 `UID 1337` 放行 Envoy 自己发出的真实网络包**，从而避免无限死循环劫持。
2. **演进出 Ambient Mesh 的原因**：每 Pod 一边车在大规模集群中带来了沉重的**内存底噪、双跳七层解析延迟以及升级边车必须重启业务 Pod 的运维耦合**；Ambient Mesh 将四层安全下沉为每台宿主机共享的 Rust `ztunnel`，将七层复杂路由抽离为按需部署的独立 `Waypoint Proxy`，在保持对业务零代码侵入的同时显著缓解了随 Pod 数量线性膨胀的边车底噪与升级耦合（实际资源收益视节点 Pod 密度、七层流量占比与 `Waypoint` 规模实测而定）。

</details>

## 参考资料

- [Cilium Official Documentation：eBPF Datapath & Kube-Proxy Replacement](https://docs.cilium.io/en/stable/network/ebpf/)
- [Kubernetes CSI Developer Documentation：CSI Architecture & Volume Lifecycle](https://kubernetes-csi.github.io/docs/)
- [Envoy Proxy Documentation：xDS REST and gRPC Protocol Specification](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol)
- [Istio Official Documentation：Ambient Mode Architecture（`ztunnel` & Waypoint Proxies）](https://istio.io/latest/docs/ambient/architecture/)
- [Istio Official Documentation：Performance and Scalability Benchmarking](https://istio.io/latest/docs/ops/deployment/performance-and-scalability/)
- [Kubernetes Gateway API Specification：Mesh Traffic Management（GAMMA）](https://gateway-api.sigs.k8s.io/mesh/)
