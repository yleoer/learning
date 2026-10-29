---
name: 技术学习笔记
description: 个人技术书架：安静、温暖、清晰，组件轻巧而明确，优先易用。
colors:
  primary: "#b45335"
  clay: "#d97757"
  primary-hover: "#ae5133"
  primary-active: "#9d482d"
  primary-dark-hover: "#e18968"
  primary-dark-active: "#bd6244"
  primary-dark-text: "#25130d"
  link: "#184f95"
  link-hover: "#123d75"
  link-dark: "#6da7ec"
  link-dark-hover: "#91bdf0"
  code: "#8e2626"
  code-dark: "#f4abab"
  page: "#f9f9f7"
  surface: "#fcfcfb"
  raised: "#ffffff"
  muted: "#f3f3f0"
  muted-strong: "#f0efec"
  border: "#e2e1dc"
  border-strong: "#cbc9c2"
  text: "#131313"
  text-secondary: "#52514e"
  text-muted: "#686661"
  soft: "rgba(19, 19, 19, 0.05)"
  page-dark: "#20201f"
  surface-dark: "#151515"
  raised-dark: "#1a1a19"
  muted-dark: "#292928"
  muted-strong-dark: "#31312f"
  border-dark: "#383835"
  border-strong-dark: "#4a4945"
  text-dark: "#f9f9f7"
  text-secondary-dark: "#c3c2b7"
  text-muted-dark: "#97958d"
  soft-dark: "rgba(249, 249, 247, 0.07)"
  selection: "#efd7ce"
  selection-dark: "#59392f"
typography:
  display: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "56px", fontWeight: 600, lineHeight: "64px", letterSpacing: "0" }
  headline: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "28px", fontWeight: 600, lineHeight: "1.25", letterSpacing: "0" }
  title: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "22px", fontWeight: 600, lineHeight: "1.25", letterSpacing: "0" }
  subheading: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "18px", fontWeight: 600, lineHeight: "1.3", letterSpacing: "0" }
  body: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "16px", fontWeight: 400, lineHeight: "1.5", letterSpacing: "0" }
  label: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: "14px", fontWeight: 500, lineHeight: "20px", letterSpacing: "0" }
  caption: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: "14px", fontWeight: 400, lineHeight: "20px", letterSpacing: "0" }
  button: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: "14px", fontWeight: 600, lineHeight: "38px", letterSpacing: "0" }
  mono: { fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', Consolas, monospace", fontSize: "14px", fontWeight: 400, lineHeight: "1.625" }
  table-cell: { fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif", fontSize: "14px", fontWeight: 400, lineHeight: "1.4" }
rounded:
  field: "4px"
  small: "6px"
  container: "8px"
  button-medium: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  field: "12px"
  prose-inset: "14px"
  md: "16px"
  card: "24px"
  section: "32px"
  wide: "48px"
  page: "64px"
components:
  button-primary: { backgroundColor: "{colors.primary}", textColor: "{colors.raised}", typography: "{typography.button}", rounded: "{rounded.button-medium}", padding: "0 20px", height: "40px" }
  button-primary-hover: { backgroundColor: "{colors.primary-hover}", textColor: "{colors.raised}" }
  button-primary-active: { backgroundColor: "{colors.primary-active}", textColor: "{colors.raised}" }
  button-primary-dark: { backgroundColor: "{colors.clay}", textColor: "{colors.primary-dark-text}" }
  button-primary-dark-hover: { backgroundColor: "{colors.primary-dark-hover}", textColor: "{colors.primary-dark-text}" }
  button-primary-dark-active: { backgroundColor: "{colors.primary-dark-active}", textColor: "{colors.raised}" }
  button-secondary: { backgroundColor: "{colors.raised}", textColor: "{colors.text}", typography: "{typography.button}", rounded: "{rounded.button-medium}", padding: "0 20px", height: "40px" }
  feature-card: { backgroundColor: "{colors.raised}", textColor: "{colors.text}", rounded: "{rounded.container}", padding: "{spacing.card}" }
  search-field: { backgroundColor: "{colors.muted}", textColor: "{colors.text}", rounded: "{rounded.field}" }
  nav-active: { backgroundColor: "{colors.muted-strong}", textColor: "{colors.text}", typography: "{typography.label}", rounded: "{rounded.small}", padding: "4px 8px" }
  answer-details: { backgroundColor: "{colors.muted}", textColor: "{colors.text}", rounded: "{rounded.container}", padding: "0 14px" }
  code-block: { backgroundColor: "{colors.muted}", textColor: "{colors.text}", typography: "{typography.mono}", rounded: "{rounded.container}", padding: "{spacing.prose-inset}" }
  topic-status: { textColor: "{colors.text-secondary}", typography: "{typography.caption}", padding: "24px 0" }
  chapter-outline: { textColor: "{colors.text-secondary}", fontSize: "13px", lineHeight: "1.5" }
---

# Design System: 技术学习笔记

## Overview

**Creative North Star: "个人技术书架"**

把界面看作一处可以长期积累、分类和回看技术知识的个人书架。整体气质为安静、温暖、清晰：浅色采用接近纸张的暖白底色，深色采用带暖调的炭灰；正文与导航保持明确分工，装饰退居内容之后。名称与气质由用户确认，用来描述并延续现有系统。

组件轻巧而明确，优先易用。圆角、细边框、底色变化和文字层级构成主要视觉语言；正文容器保持平面，菜单与搜索弹层通过阴影形成临时层次。中英文技术内容共用无衬线排版，命令与代码以等宽字体区分。

记录依据为 `docs/.vitepress/theme/custom.css`、`docs/.vitepress/config.mts`、当前安装的 VitePress 1.6.4 默认主题，以及 2026 年 10 月 29 日的浏览器核对。已查看首页、章节页、搜索和答案折叠，采样尺寸为桌面（1280 × 720）及手机（390 × 844），并核对桌面深色阅读与搜索效果。分层目录与专题状态调整另核对了 768px、1024px、1440px 和 1920px 视口。这里只记录现有视觉规则；产品背景见 `PRODUCT.md`，章节写作规范见 `AGENTS.md`。

**Key Characteristics:**

- 暖白与炭灰成对构成阅读底色。
- 陶土橙承担身份与主操作，墨蓝承担链接与定位。
- 无衬线中文正文与等宽代码形成清晰分工。
- 内容平面，弹层浮起。
- 组件轻巧而明确，优先易用。

## Colors

陶土橙、墨蓝与暖白构成主要颜色关系，暗色主题通过对应的文字、背景和边框角色切换。前置元信息中的颜色值是规范数据；正文用 token 名说明用途，页面实现继续使用现有 CSS 变量。

### Primary

- **陶土橙**：`primary` 用于浅色首页标题、主按钮及强调文字；`clay` 用于标识和暗色主题中的对应强调。主按钮按 `primary-hover`、`primary-active` 及对应暗色 token 表达状态。
- **按钮文字**：浅色主按钮使用 `raised`；暗色常态与悬停使用 `primary-dark-text`，按下时使用 `raised`，与当前主题变量一致。

### Secondary

- **墨蓝**：`link` 与 `link-hover` 用于正文链接；暗色对应 `link-dark` 与 `link-dark-hover`。目录定位标记、搜索焦点和搜索结果选中边框沿用链接色。
- **代码红**：`code` 与 `code-dark` 用于行内代码。代码块的语法高亮由 VitePress/Shiki 提供，不以单一代码红替代全部语法颜色。

### Neutral

| 角色 | 浅色 token | 暗色 token | 用途 |
| --- | --- | --- | --- |
| 页面 | `page` | `page-dark` | 正文与页面底色 |
| 侧栏 | `surface` | `surface-dark` | 章节导航底色 |
| 独立容器 | `raised` | `raised-dark` | 首页卡片、分页与弹层 |
| 柔和底色 | `muted` | `muted-dark` | 代码块、折叠答案、搜索输入背景 |
| 选中底色 | `muted-strong` | `muted-strong-dark` | 章节导航选中状态 |
| 分隔线 | `border` | `border-dark` | 卡片、表格、代码块和折叠区域边界 |
| 较强边界 | `border-strong` | `border-strong-dark` | 引用块、部分控件及悬停边界 |
| 主文字 | `text` | `text-dark` | 正文与标题 |
| 次文字 | `text-secondary` | `text-secondary-dark` | 说明、导航和引用 |
| 弱文字 | `text-muted` | `text-muted-dark` | 元信息、语言标签等辅助文字 |
| 轻度覆盖 | `soft` | `soft-dark` | 表格行悬停、行内代码等覆盖底色 |
| 文本选区 | `selection` | `selection-dark` | 文字选中背景 |

辅助文字也按普通文字保持至少 4.5:1 的对比度。浅色 `text-muted` 在页面、独立容器、柔和及选中底色上约为 4.99–5.74:1，覆盖代码语言标签和上下章提示等小字号文字。

现有提示块另有绿、蓝、紫、黄、红的语义配置；当前取样页面没有使用这些提示块，因此不把整套未取样配置扩展为新的品牌色阶。需要使用时，核对对应主题变量与实际组件。

**The Color Roles Rule.** 陶土橙强调身份与主操作，墨蓝表达链接和定位，代码红区分行内代码；新增同类元素继续沿用这些角色。

## Typography

**Display Font / Body Font:** Noto Sans SC，依次回退到 PingFang SC、Microsoft YaHei 与系统无衬线。界面文字另含操作系统字体回退，完整栈见前置元信息。

**Label/Mono Font:** 界面标签沿用中文无衬线；代码使用 JetBrains Mono，回退到 Cascadia Mono、Cascadia Code、Consolas 和系统等宽字体。字体样式表由站点配置中的外部链接加载，不能假定所有环境都已成功加载首选字体。

### Hierarchy

| 层级 | token 或实现规则 | 使用方式 |
| --- | --- | --- |
| 首页标题 | `display` | 大屏使用该角色；中屏为（48px / 56px），小屏为（32px / 40px） |
| 章节标题 | `headline` | 小于 768px 时为（26px / 1.25） |
| 二级正文标题 | `title` | 小于 768px 时为（20.8px / 1.25） |
| 三级正文标题 | `subheading` | 以字重和节前留白建立层级 |
| 正文 | `body` | 段落上下间距为（0.75em），列表沿用正文行高 |
| 标签与摘要 | `label` | 侧栏、折叠摘要、说明性文字；右侧目录使用（13px） |
| 中号按钮 | `button` | 使用浏览器采样得到的字重，组件样式优先于全局按钮字重声明 |
| 代码块 | `mono` | 行内代码按父字号的（0.9em）缩放 |
| 表格单元格 | `table-cell` | 表头字重为（500）；表格容器声明的（15px）没有覆盖默认单元格字号 |

首页导语在小屏、中屏、大屏分别为（18px）、（20px）、（24px），行高均为（1.5）。标题没有额外字距；正文的数字使用 lining 与 tabular 排版。现有字号是分层设置，不是一套统一等比比例尺。

**The Reading Type Rule.** 正文与标题保持同一中文无衬线体系；代码用等宽字体区分，不将正文整体换成等宽字体。

## Layout

桌面章节页采用左侧章节导航、中央正文、右侧目录的空间结构。导航栏高度为（64px）；桌面左侧栏宽为（288px），右侧目录区域上限为（256px）。正文恢复原有（1200px）的宽度上限，不额外限制带目录的整体内容区。实际正文宽度取决于视口、侧栏与内部留白；1280px 视口下约为（598px），1920px 下为（1200px），不能把上限当作固定正文宽度。

首页主要内容上限为（1152px）。当前三张功能卡片在小屏纵向排列，在不小于 768px 时按三列排列；卡片内部留白沿用 `spacing.card`，列间视觉间隔为（16px）。这描述已有首页网格，不要求后续所有页面都使用三列。

专题内容状态位于首页主操作与功能卡片之间，与首页内容对齐。可阅读专题显示实际章节数量与最新章节链接；尚无章节的专题集中标为待整理，并说明入口用于查看规划。状态区域以横向细分隔线组织，960px 起分两列，小屏纵向排列；内容由构建期读取专题文件生成，不维护手写进度。

### Responsive behavior

| 边界 | 当前行为 |
| --- | --- |
| 小于 640px | 首页使用小屏标题与较窄边距 |
| 不小于 640px | 首页标题放大，首页左右留白增大；分页可并排 |
| 小于 768px | 搜索入口简化；章节标题缩小，表格可横向滚动；搜索弹层占满视口 |
| 不小于 768px | 首页当前三卡片进入三列，搜索显示文字与快捷键 |
| 不小于 960px | 章节侧栏固定显示，首页使用大屏标题 |
| 不小于 1280px | 顶部完整导航与章节右侧分层目录显示；小于此宽度时站点导航收进菜单，移动目录只展示二级标题 |
| 不小于 1440px | 默认主题调整大屏容器与侧栏位置计算，继续受项目的全视口布局变量约束 |

手机章节页实际留白为（32px 24px 96px），桌面章节外层为（48px 32px 0）；桌面正文内部另有底部留白。全局 CSS 虽声明了其他移动端留白，但默认组件的作用域选择器优先级更高，应以实际层叠结果为准。

间距由小范围控件留白、正文相对字号的段间距和大范围页面留白共同构成；前置元信息仅整理重复使用的间距值。表格与代码的横向滚动用于保留内容完整性，不通过缩小全部正文字号容纳长内容。

## Elevation & Depth

**内容平面，弹层浮起。** 正文、功能卡片、代码块、表格与分页不使用投影，层次通过底色和边框建立。菜单与搜索弹层使用既有低强度阴影；导航栏有半透明背景与背景模糊（12px），搜索遮罩使用背景模糊（2px）。暗色页面的独立容器可以比页面更暗，不把“抬高必然更亮”写成规则。

### Shadow Vocabulary

- **Flat**：`--vp-shadow-1` 与 `--vp-shadow-2` 均为 `none`。
- **Popup**：`--vp-shadow-3` 为 `0 8px 30px rgba(19, 19, 19, 0.1)`，用于菜单与搜索弹层。
- **Reserved**：`--vp-shadow-4` 与 `--vp-shadow-5` 已有定义，但本次未在可见组件上观察到使用，不作为日常容器默认值。

**The Flat Content Rule.** 内容容器用边框与底色区分；阴影保留给现有弹层语义。

## Shapes

容器使用柔和而克制的圆角。卡片、代码块、表格、折叠答案、分页和搜索弹层采用 `rounded.container`；侧栏文字背景及代码复制按钮采用 `rounded.small`；搜索栏及搜索结果采用 `rounded.field`。正文引用块保持直角，以左侧竖线区分。

中号主按钮与备用按钮采用 `rounded.button-medium` 的胶囊轮廓。全局 CSS 中的按钮圆角声明没有覆盖默认主题的尺寸类，不能据此将按钮记为容器圆角。行内代码采用相对字号圆角（0.4em）；表格、代码等细边框在浏览器中可能因像素对齐而显示为（1px），保留源码中的细边框定义。

## Components

### Buttons

轻巧而明确，用颜色和文字表达操作。

- 中号按钮的圆角、字号、留白和高度见 `button-primary`。实际字重为（600），常态行高加上下边框形成组件高度。
- 主按钮使用陶土橙的完整浅色／暗色状态组合，悬停与按下只改变颜色和边框，不位移或放大。
- 状态过渡为（250ms）；按下时为（100ms）。全局键盘焦点使用链接色轮廓（2px），向外偏移（2px）；默认组件若有自身焦点规则，应核对实际覆盖。
- `button-secondary` 是现有备用样式：独立容器底色、主文字与细边框，悬停转柔和底色；当前首页没有使用它。

### Cards / Containers

功能卡片使用独立容器底色、细边框与统一容器圆角，无投影。内部留白见 `feature-card`；图标占据柔和底色的小区域（48px × 48px），图标区域圆角为 `rounded.small`。标题与说明分层，说明字号为（14px）、字重为（500）。悬停改变边界和底色，过渡为（120ms ease）；当前功能卡片本身不是导航链接。

首页专题状态使用 `topic-status`：沿用页面底色，以细分隔线、标题和文字层级区分可阅读与待整理内容。章节数量和最新链接随构建更新；待整理入口保持可点击，并在入口前说明尚无章节。

### Inputs / Fields

当前输入组件是本地全文搜索，不补写未实现的业务表单状态。

- 外层搜索栏使用细边框与 `rounded.field`；输入区域使用柔和底色，桌面输入内边距为（6px 12px），外框横向留白为（12px）。焦点在搜索栏上呈链接色边界。
- 搜索弹层桌面宽度为 `min(100vw - 60px, 900px)`，内边距为（12px），顶部外边距为（64px）；手机占满视口，项目样式仍使弹层保留容器圆角。
- 搜索结果实际使用（2px）边框和 `rounded.field`。选中结果使用链接色边界，悬停使用较强中性边界与柔和底色；作用域样式使结果圆角没有采用全局声明的容器圆角。
- 桌面显示键盘提示，支持键盘导航；移动端采用适合触控的搜索入口与关闭操作。

### Navigation

顶部站点名为（15px / 600），菜单为（14px / 500）。章节侧栏使用次文字，当前章节以主文字、较强柔和底色和小圆角区分；悬停使用轻度覆盖底色。

右侧 `chapter-outline` 默认显示二级标题，当前节自动展开三级标题，也可用独立按钮展开或收起一组。练习和面试题始终保留入口，具体题名随分组展开，长标题自然换行。当前节使用柔和底色和链接色，当前项同时用字重及 `aria-current` 标明；按钮具备展开状态和所控制列表的可访问关系。目录文字为（13px / 1.5），展开按钮为（32px × 32px），键盘焦点使用链接色内描边。

小屏将章节侧栏收进抽屉，页内目录由移动导航入口展开，仅显示二级标题；选择小节后自动关闭。目录链接保留自然换行，优先让读者快速定位正文、练习、面试题与参考资料。

分页使用细边框与独立容器底色，无投影；悬停改变边界和底色。描述为弱文字，目标标题使用链接色，内部留白为（11px 16px 13px）。

### Reading primitives

- **代码块**：容器圆角、柔和底色与细边框；内部留白和文字角色见 `code-block`。保留语言标签、复制入口和语法高亮。复制入口使用小圆角，不把整块代码变成按钮。
- **行内代码**：代码红、轻度覆盖底色、细边框与相对字号，保持随文字换行的能力。
- **表格**：容器圆角、细分隔线与柔和表头，单元格留白为（7px 12px）。普通行不做斑马纹，悬停有轻度底色；手机保留横向滚动。
- **引用**：透明底色、直角、次文字与左侧竖线（4px）；正文核对环境等信息可使用此形态。
- **正文链接**：墨蓝文字、细下划线与适量下划线偏移（3px），悬停加深颜色并使下划线更明确。

### Answer disclosures

折叠答案沿用 `answer-details`。摘要是可操作的整行文字，内部留白为（11px 14px），使用原生展开标记；默认收起，展开后摘要下方出现细分隔线，内容结尾留白为（14px）。示例与实现都保留语义化的 `details` / `summary` 结构，题目与待分析代码置于容器之外。

### Motion and focus

现有动效用于颜色、背景、边框和抽屉状态变化，不为内容增加入场演出。侧栏文字与功能卡片主要采用（120ms ease），按钮采用默认主题过渡；其他导航过渡由默认主题提供。系统偏好减少动态效果时，全局取消平滑滚动，将过渡与动画时间降至（0.01ms），动画只运行一次。组件预览同步提供键盘焦点和减少动态效果样式。

## Do's and Don'ts

### Do:

- **Do** 同时沿用浅色与暗色的语义颜色角色，并使用现有 CSS 变量连接组件样式。
- **Do** 保留正文、标题、标签和代码之间的字体与字号分工。
- **Do** 为卡片、表格和代码保留平面层次，为菜单和搜索保留弹层层次。
- **Do** 保留按钮胶囊、容器圆角与搜索栏小圆角之间的已有区别。
- **Do** 在桌面和手机核对实际层叠结果，尤其注意默认主题的作用域样式。
- **Do** 为键盘操作保留可见焦点，并遵循系统减少动态效果的偏好。

### Don't:

- **Don't** 用统一圆角替代按钮、搜索结果和内容容器各自的轮廓。
- **Don't** 为普通内容卡片、表格和代码块添加投影或悬停位移。
- **Don't** 用品牌强调色替代正文链接、行内代码和语法高亮各自的语义角色。
- **Don't** 把容器宽度上限、全局声明或某次字体加载结果当作所有设备的实际渲染值。
- **Don't** 将当前首页的三列卡片布局推广成所有页面必须遵循的结构。

设计面板的补充数据位于 `.impeccable/design.json`：它提供组件的独立 HTML/CSS、阴影、动效、断点与描述性元数据。色带由现有颜色推导用于预览，不代表站点已有额外色阶；颜色、字体、圆角和间距的规范值仍由本文件前置元信息承载。
