# 本地视频航拍帧采集插件 · 需求与实施方案 v2.3

本文档是新插件项目的唯一规格，自包含，不依赖任何其他项目的文档。新插件是独立项目、独立仓库。

**本版的核心变化：用户提供的视频视为 100% 可用。** 插件不再判断视频或画面是不是航拍、是否真实、质量如何、有没有水印，也不做素材筛选、4 帧试判、帧质量过滤和抽检。流程只有四步：**按规则抽帧 → 帧去重 → 按对象打标签 → 导出**。v2.1 补充帧去重规则：抽帧后用 64 位 dHash 去掉同一任务内的重复画面，只有去重后的唯一帧才送模型打标。v2.2 去掉每视频帧上限，抽多少帧只由视频时长和用户设置的抽帧间隔决定。v2.3 把默认抽帧间隔改为 2 秒，并补充新电脑部署时的环境检查与 DSH 安装缺失资源规则。

阅读顺序：第 1–14 节是需求（做什么、规则、边界），第 15–17 节是怎么做（工程约束、验收、实施顺序），第 18 节是旧项目里可以借用的代码零件，第 19–20 节是开发启动提示词和完成定义。除第 18 节外，本文档不引用旧项目的任何内容；旧项目的业务规则、提示词和文档都不要带进新项目。

---

## 1. 产品目标

用户已经把视频下载到本地，并且确认这些视频**全部可用**。新插件让用户直接给视频路径，完成：

1. 读视频时长；
2. 按固定规则抽帧；
3. 对抽出的帧做去重，只保留画面不重复的帧；
4. 逐帧调用视觉模型，只判断用户定义的对象是否出现、是否看得清；
5. 给每张去重后的唯一帧的每个对象写标签（合格 / 不确定 / 不合格）；
6. 导出图片和 CSV，直接用于目标检测训练。

它**不是下载器、不是检索器、不是画质筛选器**：不访问任何网站，不搜索，不下载，不判断视频是否航拍、是否真实、质量高低，也不判断水印。素材是否可用由用户负责；插件只去掉画面重复的帧。

### 1.1 术语

| 术语 | 含义 |
|---|---|
| 任务（task） | 一次打标作业：一组对象 + 一批视频 + 抽帧参数；同一时间只允许一个进行中的任务 |
| 素材 / 视频（item） | 用户提交的一个本地视频文件 |
| 帧（frame） | 从视频里按时间点取出的一张图片，是判断和导出的单位 |
| 对象（target） | 用户定义的、希望在画面里识别的东西，例如“挖掘机”“风力发电机” |
| 标签（label） | 某帧对某对象的结论：`QUALIFIED` / `UNSURE` / `NOT_QUALIFIED` |

### 1.2 需求清单（验收口径）

| 编号 | 需求 | 验收标准 | 详见 |
|---|---|---|---|
| R1 | 本地输入 | 单文件或目录；绝对路径；白名单校验；只读打开 | §5 |
| R2 | 文件去重与跳过 | 按内容 SHA-256；同一任务同一文件只留一行；新任务默认跳过此前已抽帧并打标的同一文件（进度显示“已跳过（先前已处理）”）；只有显式 `force` 才重跑 | §5.3、§5.5 |
| R3 | 读时长 | `ffprobe` 读时长；失败记 `ERROR`，不写标签 | §6.1 |
| R4 | 抽帧 | 按用户设置的间隔计算帧数；均匀取时间点；JPEG `-q:v 2` | §6.2–6.4 |
| R5 | 不做画面质量筛选 | 不判断航拍/真实/质量/水印；不试判；只按感知哈希做帧去重，重复帧不送打标 | §3、§6.5–6.6 |
| R6 | 模型打标 | 每张去重后的唯一帧一次调用、同一提示词、只接受规定 JSON；一次调用纳入任务全部对象，每个对象都要有判决；并发路数可配（1–8，默认 2） | §7 |
| R7 | 标签规则 | 无成功模型调用不能 `QUALIFIED`；只有明确 `ABSENT` 才写 `0` | §7.4、§10.2 |
| R8 | 出错与暂停 | 文件错误 / 模型暂停 / 磁盘暂停分开；错误不记成标签 | §8 |
| R9 | 导出 | 新建时间戳目录或 zip：`images/` + `labels.csv` + `sources.csv` + `README.txt` + `stats.json`；对象筛选、按对象分目录、zip 可选；`family_id` = 文件 SHA-256；8:2；可重复导出且不覆盖旧产物 | §10 |
| R10 | 清理 | 过程文件用完即删；**用户原视频从不删除、移动、改名** | §11 |
| R11 | 重做与恢复 | 每步可重做；重启后继续；不重复计数 | §9 |
| R12 | 进度页 | 文件漏斗（含重复跳过数与已跳过数）、处理顺序、错误清单、暂停/继续/取消、添加视频/目录、导出区（对象筛选/zip/分目录）、导出 toast 与打开目录、最近导出记录 | §12.2 |
| R13 | 设置页 | 模型、数据目录与上限、预算、抽帧间隔、判定并发、允许根目录白名单 | §12.1 |
| R14 | agent 工具 | 6 个 `lf_*` 工具，参数和拒绝条件见规格 | §13 |
| R15 | 规模上限 | 7 表 / 6 工具 / 2 页签 / 1 模型 / 1 提示词 / 1 任务 / 2 个子进程 | §3.1 |
| R16 | 安全 | 回环 Host + 同源 Origin + JSON 写接口；密钥与 cookie 不进数据库和日志 | §12.3、§15 |
| R17 | 端到端 | 沙盒实测完整流程；原视频数量和 SHA-256 不变 | §16.2、§20 |

---

## 2. 用户完整使用流程

1. 在新电脑上按 §15.1 检查环境；缺 Node / npm / ffmpeg / ffprobe 时按 §15.2 让 DSH 安装并验证。
2. 在 DSH 里安装并启用插件。
3. 打开“设置”页：选择模型、设置**允许读取的视频根目录**、数据目录上限、抽帧参数。
4. 对话里让 agent 调 `lf_target_add` 建对象（可以一次建多个）。
5. 让 agent 调 `lf_collect_start` 建任务并开始；可以把首批视频路径直接放进 `paths`。
6. 之后随时用 `lf_video_add` 追加视频文件或目录。
7. 插件在后台按状态机抽帧、帧去重、调用模型打标，进度页实时显示处理顺序、漏斗（含重复跳过数与“已跳过（先前已处理）”数）和错误文件。新任务默认跳过此前已完成抽帧和打标的同一文件；只有显式 `force` 才重跑。
8. 让 agent 调 `lf_export` 导出，拿到 `images/` + `labels.csv` + `sources.csv` + `README.txt` + `stats.json`；可按对象筛选、导出 zip 或按对象分目录，进度页也提供同样的导出区、最近导出记录和打开目录按钮。

关掉窗口不会停止任务；要停只能点“暂停”。

---

## 3. 范围与边界

### 3.1 规模上限（硬上限，超出要先停下列理由）

- 7 张数据表；
- 6 个 agent 工具；
- 2 个设置页签（设置、进度）；
- 1 个模型槽；
- 1 种判断提示词；
- 同一时间只跑 1 个任务；同一任务的模型打标并发路数由设置决定（`visionConcurrency`，1–8，默认 2），1 路等同串行；
- 子进程只有 `ffmpeg` 和 `ffprobe` 两个，全部经 DSH 的 `ctx.subprocess` 启动。

### 3.2 刻意不做

画面航拍判断、真实拍摄判断、质量评分、水印判断、视频元数据拒绝（时长/分辨率/形状）、4 帧试判、帧质量过滤、被拒素材抽检、人工帧标签抽检、多任务并行、作业队列系统、第二个模型、模型投票、缩略图预筛、场景分段、关键帧检测、图片切块、视频转码、音频处理、OCR、去水印、自动分类训练集、Web 端自建页面、数据库外部服务。

### 3.3 非目标

不做下载、不做检索、不解析网页、不登录任何网站、不判断版权许可、不猜地区、不做模型微调、不替用户判断素材是否可用。

---

## 4. 命名与工程形态

| 项 | 值 |
|---|---|
| 插件 ID | `local-frames` |
| npm 包名 | `dsh-local-frames` |
| HTTP 接口前缀 | `/api/local-frames/*` |
| agent 工具前缀 | `lf_` |
| 数据目录 | 插件配置字段 `dataDir`，普通字符串，默认 `homedir()` 派生（**不写死盘符**） |
| 数据目录内容 | `db.sqlite`、`frames/`、`exports/`、`tmp/` |

技术栈：Node ≥ 22.13、TypeScript strict、ESM、`node:sqlite`。运行在 DSH Host 进程内，使用 DSH 的 `ctx.llm`（模型）、`ctx.subprocess`（子进程）、工具注册、网页服务和设置页框架。

`package.json` 的关键字段：`main: lib/src/index.js`、`types: lib/src/index.d.ts`、`exports["."]` 指向 lib、`exports["./client"]: ./client.js`、`files: [lib, client.js, cordis.patch.yml, SKILL.md]`、`engines.node: >=22.13`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client: { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-settings"] }`；运行依赖为空，peerDependencies 为 `@deepseek-ai/cordis ~4.0.5` 与 `@deepseek-ai/schemastery >=3.18.5 <4.0.0`。

---

## 5. 输入：本地视频

### 5.1 入口

- agent 工具 `lf_collect_start`（首批视频路径）和 `lf_video_add`（追加）；
- “进度”页签上的“添加视频/目录”输入框。

这些入口走**同一套校验和导入函数**，不允许各写一套。

### 5.2 参数

- `path`：绝对路径，可以是单个文件，也可以是一个目录。
- `recursive`：目录是否递归扫描，默认 `true`。
- `force`：布尔值，默认 `false`。只有显式传 `true` 才重新抽帧并调用模型；对单个文件和整个目录都生效。进度页对应“强制重跑（忽略先前已处理跳过）”勾选项。

### 5.3 路径校验（每条都要有单测）

1. 必须是绝对路径。相对路径、包含 `..` 穿越、空串 → 拒绝。
2. 解析符号链接后的真实路径必须落在设置页配置的**允许根目录白名单**内。白名单默认为空，此时拒绝一切；用户必须先配置。
3. 必须存在、是普通文件、大小 > 0。
4. 扩展名必须在视频白名单：`.mp4 .mov .mkv .webm .avi .m4v`。
5. 用文件内容的 SHA-256 去重与跳过：**同一个任务内**，同一文件重复提交、或同一文件从不同路径提交，只保留一行记录，不重复计数；已在该任务处理过的再提交直接报“已存在”。不同任务默认跳过此前已完成抽帧并打标的同一文件（见 §5.5）：新任务只插入一条 `SKIPPED` 记录，不抽帧、不调模型，进度显示“已跳过（先前已处理）”；只有显式 `force` 才重新处理。
6. **只读**打开。不复制、不硬链接、不移动、不删除、不改名用户原文件。整条流程结束后原文件必须仍在原位置、内容哈希不变。
7. 目录扫描按路径字典序处理，保证两次提交顺序一致；扫描时跳过隐藏目录和符号链接目录。批量路径按提交顺序处理，进度页按同样的顺序给出序号。

### 5.4 可选 CSV 元数据

用户可以给视频配一个 CSV（与视频同目录，或放数据目录），用于记录来源信息。列：

`file`（或 `path`）、`url`、`author`、`license`、`region`、`region_evidence`、`family`

规则：

- 全部字段都按原文照实记录，没有就留空；
- `family` 可选：同一来源的多个文件可以填同一个值，导出时同一 `family` 的帧不会跨 train/val；留空时用文件 SHA-256 做家族；
- `region` 只有同时给出 `region_evidence` 时才允许填 `CN` / `SEA` / `OTHER`，否则一律 `UNKNOWN`；
- 不允许从画面推断地区；
- CSV 编码按 UTF-8，带 BOM 也可；解析失败的文件跳过并在进度页列出。

### 5.5 跨任务跳过与强制重跑

- 识别键是文件内容 SHA-256，与导出 `family_id` 的兜底规则一致（没有 CSV `family` 时 `family_id` 就是文件 SHA-256）。
- “此前已处理”指此前任意任务里同一 SHA-256 的素材已到 `DONE`（完成抽帧与打标；状态机只在没有可处理的待判帧时才置 `DONE`）。`ERROR` 或在处理中的素材不算，仍按新素材导入。
- 新任务导入时默认跳过：只插入一条 `state = SKIPPED` 的素材记录，不探测、不抽帧、不调模型、不写标签；进度页在漏斗和“处理顺序”里显示“已跳过（先前已处理）”。
- 跳过只作用于本次导入：不修改先前任务的帧、标签、调用记录或导出结果，也不会删除任何原视频。
- 强制重跑必须显式触发：`lf_collect_start` / `lf_video_add` 的 `force: true`，或进度页导入框的“强制重跑（忽略先前已处理跳过）”勾选；对单个文件和整个目录都生效。
- `force: true` 时，如果同一文件已存在于当前任务（包括 `SKIPPED`），先删除该素材在本任务中的 `frames` / `labels` / `calls` 记录和插件自己写出的帧文件，再把素材重置为 `NEW`，重新抽帧并调模型。用户原视频仍只读，不移动、不改名、不删除。
- 未显式 `force` 的任何导入都不能绕过跳过规则；进度页不提供隐式“全部重跑”按钮。

---

## 6. 抽帧

### 6.1 探测

用 `ffprobe` 读时长：

```
ffprobe -v error -show_entries format=duration -of json <file>
```

读不出来记 `PROBE_FAILED`，按**出错**处理（第 8 节）。不做分辨率、时长上下限、宽高比筛选。

### 6.2 帧数

设置页参数：

- `frameIntervalSeconds`：抽帧间隔，默认 2 秒，范围 1–3600。

单个视频的帧数：

```
count = max(1, floor(duration / frameIntervalSeconds))
```

即默认 2 秒一帧；短视频至少 1 帧。**不设每视频帧上限**，抽多少帧完全由视频时长和用户设置的间隔决定。间隔越小，帧数、模型调用和磁盘占用越多；例如 1 小时视频按 2 秒抽会得到 1800 帧，长视频建议把间隔调大，或确认模型预算足够。

### 6.3 时间点

均匀分布：

```
t_i = duration × (i + 0.5) / count，i = 0 … count-1
```

### 6.4 取帧命令

```
ffmpeg -hide_banner -loglevel error -ss <秒> -i <本地路径> -frames:v 1 -pix_fmt yuvj420p -q:v 2 -update 1 -y <目标文件>
```

- 单帧超过 60 秒算该帧 `FAILED`，继续取下一帧；
- 同一个视频累计 3 帧 `FAILED`，该视频记 `ERROR`，不再继续取；
- 帧文件放在 `tmp/` 或 `frames/`，路径由实现决定，但导出前不能删。

### 6.5 不做画面质量筛选

成功取出的每一帧先做帧去重（§6.6），去重后的唯一帧才送模型打标。**不判断**：

- 画面是不是航拍；
- 是不是真实拍摄；
- 清晰度、曝光、裁切；
- 水印。

用户已经保证视频可用；插件不替用户做质量判断，也不因为“看起来不好”丢弃帧。唯一会丢弃的是画面内容重复的帧。

### 6.6 帧去重（在模型打标之前）

1. 对每一张成功取出的帧，用 `ffmpeg` 解码成灰度缩略图（长边 1024），按 9×8 网格计算 **64 位 dHash**，存成 16 位十六进制字符串。
2. 与**同一任务内已经保留的所有帧**逐一比较汉明距离（跨视频比较，不只是同一个视频）。
3. 距离 **≤ 16**（`DHASH_DISTANCE_MAX = 16`）判定为重复：
   - 后出现的帧记 `DUPLICATE`，`duplicate_of` 写保留帧的 `frame_id`；
   - 立即删除该帧文件；
   - **不调用模型、不写标签、不导出**。
4. 距离 > 16 的帧保留，进入模型打标队列。
5. 处理顺序固定：先按视频提交顺序，再按同一个视频内的 `t_ms` 升序。重复时**保留先出现的那一帧**，保证重跑结果一致。
6. 每个任务只和本任务已保留的帧比较；不同任务之间不互相做帧去重。跨任务按文件 SHA-256 跳过（§5.5）发生在抽帧之前，不改变本节的帧去重规则；强制重跑的任务也只和它自己新保留的帧比较。
7. 去重只比较画面内容，不判断质量：一张模糊但画面独特的帧仍会保留并送打标。
8. 灰度解码失败：该帧记 `FAILED`，不调用模型；按第 8 节处理。
9. 去重自动完成，不暂停等人工确认；进度页显示重复跳过数。

阈值 16 先固定，不放到设置页；如果实测发现误删或漏删，再单独调整。

---

## 7. 模型打标（唯一模型步骤）

### 7.1 模型选择

用户在设置页从 `ctx.llm` 支持的、能接收图片的模型里选一个。插件不假设速度、额度或图片上限；接入方式和费用由用户在 DSH 里负责。

### 7.2 输出格式

每个通过帧去重的唯一帧一次调用，同一个提示词，只接受下面这个 JSON。同一任务的多帧按设置并发调用（1–8 路，默认 2；1 路等同串行），每帧的提示词和对象表完全相同。

```json
{
  "objects": [
    {
      "name": "对象名（必须与输入对象表里的 name 完全一致）",
      "verdict": "PRESENT | ABSENT | UNSURE",
      "visibility": "CLEAR | SMALL | TINY | OCCLUDED",
      "confidence": 0.0,
      "reason": "一句话理由"
    }
  ]
}
```

不再输出 `view`、`real`、`quality`、`watermark`。

### 7.3 判断定义（写进提示词，逐字不要改写）

- `PRESENT`：画面里能确认这个对象存在。
- `ABSENT`：画面里明确没有这个对象。只有确实看清整幅画面、能确认没有时才选 `ABSENT`；看不清、被挡住、太小、拿不准，选 `UNSURE`。
- `UNSURE`：看不清、被遮挡、太小、角度不对，无法确认有没有。
- `visibility`：
  - `CLEAR`：物体完整、清楚，占画面足够大，可以直接用于检测训练；
  - `SMALL`：物体较小，但轮廓完整、能确认；
  - `TINY`：物体小于画面约 1%，细节看不清；
  - `OCCLUDED`：大部分被其他物体或画面边缘挡住，无法确认。
- `confidence`：0 到 1 之间的小数，表示模型对 `verdict` 的把握。
- `reason`：一句话，不要写与判断无关的内容。

### 7.4 标签结论

| 模型输出 | 标签 |
|---|---|
| `PRESENT` 且 `visibility` 为 `CLEAR` 或 `SMALL` | `QUALIFIED` |
| `PRESENT` 且 `visibility` 为 `TINY` 或 `OCCLUDED` | `NOT_QUALIFIED` |
| `UNSURE` | `UNSURE` |
| `ABSENT` | `NOT_QUALIFIED` |

**对象表**：每次调用放入本次任务选中的全部对象，不设对象数量上限；一张帧的模型输出必须为每个对象给出判决。输出 JSON 缺少任一对象、对象名重复或含多余对象名都算无效，不能写库；不允许分批补判或把未判对象当成“没有”。

### 7.5 调用失败与重试

- 以调用的**结束状态**为准：中途收到部分文本、最后报错，也算失败。
- 每次模型调用带 120 秒超时；超时通过 `AbortSignal` 中止该次调用，并按可重试失败处理。
- 超时、空响应、限流、服务端错误、网络错误：自动重试。同一帧的模型调用**总尝试次数最多 5 次**（含首次，即首次 + 至多 4 次重试）；重试间隔优先用模型建议的等待时间，没有就依次 1 秒、5 秒、10 秒、30 秒。
- 5 次尝试用尽仍失败：按第 8 节的任务级错误处理（连续调用失败计数与暂停），不再继续重试这一帧。
- 插件启动后第一次调用报“缺凭据”：等 3 秒重试一次。
- 凭据无效或额度用尽：不重试，按第 8 节暂停。
- 输出 JSON 不合法、缺字段、对象名对不上：重试最多 2 次，且这些尝试计入同一帧的 5 次总上限；仍不合法，该帧记 `FAILED`，不猜、不再重判。
- **没有成功的模型调用，标签不能是 `QUALIFIED`。**

### 7.6 模型输入图片的尺寸处理

1. DSH 附件硬上限：20 MiB、边长 8192、6400 万像素；超了先缩到以内再存附件；
2. 再用 `ctx.llm.imageRequestTarget` 与 `readImageRequest` 缩到所选模型能接收的尺寸（例如 DeepSeek 长边最多 4096、单次约 2 MiB），按返回的实际尺寸发送；
3. 若返回 `withinMaxBytes: false`，目标边长减半再取一次；仍超就记 `FAILED`。

暂不做切块。

---

## 8. 出错处理

本版本没有“内容拒绝”这一类；只有**文件错误**和**暂停**。错误不写标签，也不导出。

| 情况 | 处理 |
|---|---|
| 文件不存在、无权限、读不出、`ffprobe` 失败、`ffmpeg` 取帧失败 | 该素材记 `ERROR` + `error_code`，保留原文件，等用户处理；可重试 |
| 帧灰度解码失败（dHash 计算） | 该帧记 `FAILED`，不调用模型，继续下一帧 |
| 模型凭据无效、重试后仍缺凭据、额度用尽 | 任务立即暂停，显示原因，等用户在 DSH 模型页处理 |
| 模型连续 3 次调用失败，或网络不通 | 任务暂停并显示原因，每 10 分钟自动重试 |
| 连续 5 帧模型输出 `FAILED` | 任务暂停，提示“模型输出格式不对”，等用户换模型或调整提示词 |
| 数据目录超过设置上限 | 任务暂停，出缺口报告 |
| 磁盘剩余 < 10 GB | 任务暂停，出缺口报告 |
| 模型调用预算用尽（默认每任务 3000 次，可改） | 任务暂停，出缺口报告 |

---

## 9. 数量、结束与重做

- 任务开始后处理所有已提交的视频，不做“达标提前结束”。
- 任务结束条件：所有视频都进入终态（`DONE`、`ERROR` 或 `SKIPPED`），或用户取消。剩余仅为已记录的 `ERROR` 且没有自动重试时，任务直接结束，不无限等待；只剩 `SKIPPED` 时也直接结束。
- `ERROR` 只在用户点“继续”时重试；任务不会自动重试 `ERROR` 素材。模型连续调用失败属于任务暂停（§8），与素材 `ERROR` 分开。
- 结束时报告：每个对象 `QUALIFIED` / `UNSURE` / `NOT_QUALIFIED` 数量、文件漏斗（含重复跳过数与已跳过数）、`ERROR` 文件清单、模型调用次数。
- 重试：只重做出错的文件，已完成的跳过，不重复计数。强制重跑必须显式 `force`（§5.5），并会先清掉该素材在当前任务的帧/标签/调用记录后重做。
- 每一步都可以重做；重启后自动继续。

---

## 10. 导出

每次导出都在设置的导出目录下新建产物，导出后不再修改、也不覆盖旧导出：默认是文件夹 `<导出目录>/<时间>/`，选择 zip 时是 `<导出目录>/<时间>.zip`；同一秒内重复导出用 `-2`、`-3` 后缀区分。导出目录是设置页里的绝对路径（§12.1）；未设置时使用默认目录 `dataDir/exports`。已完成任务可以反复导出，只复用数据库中已有的帧与标签，绝不重新抽帧、绝不调用模型。

### 10.1 目录结构

```
<导出目录>/2026-01-01_120000/
├── images/          原始分辨率帧（硬链接，不占额外空间；按对象分目录时见 §10.7）
├── labels.csv
├── sources.csv
├── README.txt
└── stats.json       统计报表（§10.9）
```

选择 zip 时产物是 `<导出目录>/2026-01-01_120000.zip`，zip 根目录同样包含 `images/`、`labels.csv`、`sources.csv`、`README.txt`、`stats.json`。

`<导出目录>` 默认为 `dataDir/exports`。导出只读取用户原视频，不删除、不移动、不改写原文件。

图片文件名：`<原文件主名>-<frame_id>.jpg`；字符只保留字母、数字、`-`、`_`，重名加序号。`labels.csv` 和 `sources.csv` 的 `file_name` 必须指向实际图片（未分目录时为图片文件名，分目录时为相对路径，见 §10.7）。

### 10.2 labels.csv

列：`file_name`, `split`, `family_id`, 然后每个对象一列。按对象筛选导出时只保留本次所选对象的列（§10.6）。

单元格取值：

- `1`：`QUALIFIED`；
- `0`：仅当模型明确回答 `ABSENT`；
- 空：`UNSURE`、`TINY`、`OCCLUDED`，或未判。

### 10.3 sources.csv

列：`file_name`, `local_path`, `file_sha256`, `t_ms`, `family_id`, `url`, `author`, `license_raw`, `region`, `region_evidence`。

- `file_name` 与 `labels.csv` 相同；按对象分目录时是相对导出根目录的路径；
- `local_path` 是原文件绝对路径，`file_sha256` 是原文件哈希；
- `url` / `author` / `license_raw`（来自 CSV 的 `license`）/ `region` / `region_evidence` 只在用户 CSV 如实给出时才有值，否则留空；`region` 默认 `UNKNOWN`；
- 不写渠道、不编造 URL、标题、作者、时间。

### 10.4 README.txt

写：每个对象的帧数、文件分布、地区占比、缺口、所用模型、抽帧参数、帧去重参数（dHash 64 位、汉明距离≤16）和重复跳过数；并注明“素材为用户预先下载的本地文件，用户确认可用”“license_raw 照实记录”“region 为 UNKNOWN 表示没有元数据证据”。

### 10.5 导出范围与划分

- 只导出至少有一个对象 `QUALIFIED` 的帧；全为 `ABSENT` / `UNSURE` / 不合格的帧不导出，导出前删除；`DUPLICATE` 重复帧永不导出；
- `family_id` = 用户 CSV 的 `family`（如果给了），否则原文件 SHA-256；
- 按 `family_id` 的哈希固定分配 train/val，默认 8:2；同一家族不拆开；多次导出结果一致；
- 绝不能用“渠道 + 作者”之类的字段做家族键——本地文件没有这些信息，而且同一视频的帧必须留在同一边。

实现参考：`parseInt(sha256(family).slice(0, 2), 16) < 205 ? 'train' : 'val'`。

### 10.6 对象筛选

- `lf_export` 的 `targetIds` 与进度页导出区的对象勾选都可指定一个或多个对象；不传、不勾选表示任务全部对象，输出与旧版全量导出保持一致。
- 只导出至少一个所选对象为 `QUALIFIED` 的帧；未选对象的标签不写入。
- `labels.csv` 只保留所选对象的列，列顺序按本次选择顺序。
- 所选对象必须属于该任务，否则导出失败并提示“对象不在该任务中”。
- 导出只读取已有的帧与标签：不新增帧记录、不调用模型，因此同一任务可以换对象反复导出。

### 10.7 按对象分目录

- `byObject=true` 时图片写入 `images/<对象目录>/`。对象目录由对象名做文件名安全处理：NFKC 后只保留文字、数字、`-`、`_`，其他字符替换为 `-`，去掉首尾 `-`；空名用 `object`，重名加 `-2` 后缀。
- 一帧对多个选中对象都是 `QUALIFIED` 时，在每个命中的对象目录各放一份（同磁盘硬链接）。
- `labels.csv` 每帧只有一行；`file_name` 是按本次对象选择顺序第一个命中的对象目录下的相对路径（如 `object-a/clip-frame-id.jpg`）。其他目录中的副本同名，仅目录不同。
- 未命中任何选中对象的帧不导出。不开 `byObject` 时保持旧布局 `images/<图片文件名>`。

### 10.8 zip 导出

- `zip=true` 时只生成 `<导出目录>/<时间>.zip`，不写同名目录；zip 根目录为 `images/`、`labels.csv`、`sources.csv`、`README.txt`、`stats.json`。
- zip 以“不存在才创建”的方式写入；同名已存在时用 `-2`、`-3` 后缀，绝不覆盖旧导出。

### 10.9 统计报表 stats.json

- 任务与导出信息：`task_id`、`task_status`、`exported_at`（UTC）、`mode`（`full` / `selected`）、`zip`、`by_object`；
- `selected_targets[]`：`target_id`、`name`、`directory`（未分目录为 `null`）、`qualified_frames`（本次导出中该对象 `QUALIFIED` 的帧数）；
- 数量：`images`（导出帧数）、`image_copies`（实际图片副本数，分目录时可能大于帧数）、`train`、`val`；
- 任务统计：`extracted_frames`（总抽帧数）、`judged_frames`（已打标帧数）、`duplicates_skipped`（去重跳过数）、`model_calls`、`model_calls_ok`、`items`。
- `README.txt` 写明 stats.json 的位置与统计口径。

### 10.10 最近导出记录与页面反馈

- 每次成功导出都把记录写入现有 `settings` JSON 的 `recentExports`（不新增表）：`exported_at`、`task_id`、`target_ids`、`target_names`、`images`、`train`、`val`、`directory`、`zip`；最多保留 10 条，最新在前。旧设置缺少该字段时按空列表解析。
- 进度页导出成功后显示显眼 toast：帧数与产物路径；提供「打开目录」按钮（`POST /api/local-frames/export/open`，只允许打开导出目录内的产物；zip 打开其父目录）和「复制路径」；打开失败时提示原因，并保留可复制的路径。
- 进度页「最近导出」列表显示时间、对象、数量、路径。

---

## 11. 存储与清理

原则：**过程文件用完即删；帧文件只在可导出时保留；用户原视频永远不动。**

| 文件 | 何时删除 |
|---|---|
| 重复帧（`DUPLICATE`） | 判重后立即删 |
| 判断后没有任何对象 `QUALIFIED` 的帧 | 立即删 |
| 判断失败（`FAILED`）的帧 | 立即删 |
| 合格帧 | 保留，是交付物 |
| 导出目录 | 同磁盘硬链接；跨盘时复制；旧导出由用户自己删 |
| `tmp/` | 插件启动时清空 |
| **用户原视频** | **从不删除、不移动、不改名** |

数据表不超过 7 张，时间一律 UTC，复杂结构用 JSON 字段。库结构变化用单一建表脚本加版本号；不兼容时先备份再提示重建。

### 11.1 数据表

| 表 | 主要字段 |
|---|---|
| `settings` | key, value_json（模型、磁盘上限、预算、抽帧间隔、导出目录、最近导入路径、允许根目录、最近导出记录 `recentExports`；**不含密钥**） |
| `targets` | target_id, name, aliases_json, definition, archived |
| `tasks` | task_id, spec_json（对象、抽帧参数、预算）, progress_json, status |
| `items` | item_id, task_id, local_path, file_sha256, file_bytes, title（=文件名）, author, license_raw, region, region_evidence, probe_json, state（NEW/PROBED/FRAMED/DONE/ERROR/SKIPPED）, error_code, attempts |
| `frames` | frame_id, item_id, t_ms, path（删除后为空）, width, height, dhash（16 位十六进制）, duplicate_of（重复帧指向保留帧）, judge_json, state（PENDING/JUDGED/FAILED/DUPLICATE）, error |
| `labels` | frame_id, target_id, verdict, visibility, confidence, reason, outcome（QUALIFIED/UNSURE/NOT_QUALIFIED）, call_id |
| `calls` | call_id, frame_id, model, ms, tokens, ok, error |

---

## 12. 设置页（2 个页签）

### 12.1 设置

- 模型下拉（来自 `ctx.llm`）；
- 数据目录（来自插件配置字段 `dataDir`，页面只读展示）与磁盘上限；
- 导出目录（绝对路径，默认 `dataDir/exports`；留空表示使用默认目录；保存后重新打开仍显示当前值）；
- 每任务模型调用预算（默认 3000）；
- 抽帧间隔（秒，默认 2，范围 1–3600）；
- 判定并发（`visionConcurrency`，整数 1–8，默认 2；1 路等同串行；保存后对后续模型调用生效）；
- **允许读取的视频根目录白名单**（可增删；为空时拒绝一切导入）。路径输入框和「保存」一起提交，首次添加即写入 `settings` 并立刻显示在列表中；设置尚未载入时不得静默丢弃，非绝对路径等校验失败要在页面上说明原因；
- 环境检查区：Node / npm / ffmpeg / ffprobe / DSH / Git 版本，`OK` / `MISSING` / `TOO_OLD` 状态，缺失项的安装提示和“重新检查”按钮（见 §15.1）；
- 保存立即生效。

### 12.2 进度

- 对象列表（可归档）；
- 任务进度与状态；
- 处理顺序：按导入顺序列出全部视频的序号、文件名和状态（`DONE` / `ERROR` / `SKIPPED` 等）；`SKIPPED` 明确显示“已跳过（先前已处理）”；目录内按路径字典序，批量路径按提交顺序；
- 文件漏斗：导入数、探测成功数、抽帧数、**重复跳过数**、**已跳过（先前已处理）数**、打标数、可导出帧数、`ERROR` 文件数；
- `ERROR` 文件清单（路径 + 原因）；
- 数据目录占用；
- 暂停 / 继续 / 取消；
- 导出区：对象多选（不选为全部）、可选 zip 与 `images/<对象>/` 分目录；导出到设置页配置的导出目录，每次新建目录或 zip；
- 导出成功后显示 toast（帧数与路径），提供「打开目录」「复制路径」，打开失败有提示；
- 「最近导出」列表显示时间、对象、数量、路径；
- 本地路径导入框（最近一次提交的绝对路径写入 `settings`，重新打开插件时回填并可见），带“递归”和“强制重跑（忽略先前已处理跳过）”选项；不勾选强制时，先前已处理的视频只跳过、不重做。

写明“关窗口不会停止采集，要停请点暂停”。

### 12.3 接口

- 路径 `/api/local-frames/*`；
- 页面用相对路径 `fetch`，图片用同源 `<img>`；
- 自己检查 `Host` 必须回环、`Origin` 有就必须同源；
- 写接口只收 JSON；
- 不自建独立 HTML 页面，使用 DSH 网页服务。

---

## 13. agent 工具（6 个，`lf_` 前缀）

| 工具 | 参数 | 说明 |
|---|---|---|
| `lf_status` | 无 | 只读：设置（不含密钥）、对象列表、任务进度、处理顺序、文件漏斗（含重复跳过数与已跳过数）、数据目录占用、环境检查（Node/npm/ffmpeg/ffprobe/DSH/Git 版本与缺失项） |
| `lf_target_add` | name, aliases, definition | 新建对象；`aliases` 是按语言的别名；同名未归档对象拒绝 |
| `lf_collect_start` | targetIds?, paths?, force? | 建任务并开始；`targetIds` 省略表示全部未归档对象；`paths` 可同时提交首批视频；`force=true` 才重跑此前已处理的文件；`paths` 为空且任务还没有视频时拒绝；已有进行中/暂停任务、缺模型、缺对象定义、白名单为空、磁盘不够则拒绝并列出缺项 |
| `lf_video_add` | path, recursive?, force? | 提交本地视频文件或目录；按第 5 节校验；默认跳过此前已处理的视频，`force=true` 才重跑；没有进行中或暂停的任务时拒绝并提示先建任务；任务已结束也不能加 |
| `lf_collect_control` | taskId, action（pause/resume/cancel） | 暂停、继续（含重试 `ERROR` 文件）、取消 |
| `lf_export` | taskId?, targetIds?, zip?, byObject? | 导出；省略 `taskId` 表示当前任务或最近一个已完成任务；`targetIds` 省略或为空表示任务全部对象（全量导出兼容），传入时只导出所选对象；`zip=true` 生成 zip；`byObject=true` 按对象分目录；只复用已有帧与标签，不抽帧、不调用模型 |

额外配一份简短的 `SKILL.md`，说明调用顺序：

`lf_status → lf_target_add → lf_collect_start（可用 paths 传首批视频）→ lf_video_add（追加）→ lf_status 汇报 → lf_export`

工具返回值统一为 `{ status: 'OK' | 'ERROR', message: string, data: object }`；失败用 `status='ERROR'` 返回，不抛异常。agent 只能看到渲染文本，所以 `data` 要有有界 JSON 投影（最多 6000 字符），并让 `lf_target_add → lf_collect_start → lf_video_add` 能靠返回的 id 串联。

没有：抽检写入、设置与密钥写入、自由检索词、删除工具。

---

## 14. 防错规则（11 条）

1. 没有成功的模型调用，标签不能 `QUALIFIED`。
2. 只有模型明确回答 `ABSENT` 才导出为 `0`，其他一律留空。
3. 模型输出是不可信数据，校验失败按失败处理，不猜。
4. 出错（文件读不出、模型失败、磁盘满）不记成标签，也不导出。
5. 地区必须有元数据证据（用户 CSV 的 `region_evidence`），只凭画面一律 `UNKNOWN`。
6. 不编造 URL、标题、来源、作者、许可、时间、成功状态；本地路径与哈希照实记录。
7. **绝不删除、移动、改写用户原视频**；路径必须校验，防目录穿越。
8. 不判断素材是否航拍、是否真实、质量高低、有没有水印——用户已保证可用，插件不加二次判断；只按 §6.6 做帧去重。
9. 重复帧不调用模型、不写标签、不导出。
10. 不改对象定义凑数；缺口如实报告。
11. 每一步可重做；重启后继续；重做不重复计数。

---

## 15. 工程约束

- Node ≥ 22.13，TypeScript strict，ESM。
- 用 DSH 给的能力：模型 `ctx.llm`、子进程 `ctx.subprocess`、工具注册、网页服务、设置页框架。
- **不直接 `child_process.spawn`**；**不自建 `Agent`、不改全局 dispatcher、不用 `worker_threads`**——会丢掉 DSH 装好的代理。
- 子进程只有 `ffmpeg`、`ffprobe`，全部经 `ctx.subprocess`。
- 不引入 `yt-dlp`、不引入服务端 HTTP 客户端、不引入付费 API、GPU、Docker、任何新依赖（页面自身的同源 `fetch` 与 `<img>` 不算）。
- 设置存插件自己的表，不用 DSH 插件配置的 `.volatile()` 字段；`dataDir` 用普通字符串字段。
- 改行为就加测试；工具测试覆盖成功、校验失败、状态不允许、重复调用。
- 密钥与 cookie 不进 SQLite、日志、导出、git、对话；插件不读浏览器或 DSH 的 cookie 数据库。
- 开发测试用沙盒 profile（npm 版 `dsh --profile <名称>`）和临时数据目录；不装到 DSH 桌面 profile，除非用户同意。
- 不 push、不发 Release，除非用户明确要求。
- `ffmpeg` / `ffprobe` 必须在 PATH 上；插件只检测并显示版本，不自动下载。新电脑缺失时由 DSH 按 §15.2 安装。
- DSH 版本约束：`>=0.2.1-rc.2 <0.3.0`（预览版接口可能变化，新电脑上重新核实）。

### 15.1 新电脑部署：环境检查

插件启动时和 `lf_status` 调用时都执行同一套检查，结果显示在设置页的“环境”区域，并由 `lf_status` 的 `environment` 字段返回。状态分 `OK` / `MISSING` / `TOO_OLD`。

| 资源 | 要求 | 检查命令 | 不满足时 |
|---|---|---|---|
| Node.js | ≥ 22.13 | `node --version` | 插件加载失败并提示升级；不能开始任务 |
| npm | 随 Node 安装，可执行 | `npm --version` | 开发/构建插件时无法执行 npm 命令，提示重装 Node |
| ffmpeg | 可执行，建议 6.0 以上 | `ffmpeg -version` | 任务开始前拒绝，提示按 §15.2 安装 |
| ffprobe | 与 ffmpeg 同一发行版、版本一致 | `ffprobe -version` | 同上 |
| DSH | `>=0.2.1-rc.2 <0.3.0` | `dsh --version` | 提示先升级 DSH，插件不加载 |
| Git | 可执行（开发/克隆需要） | `git --version` | 只在开发时提示，不影响运行 |
| 数据目录 | 可写，剩余 ≥ 10 GB | 写临时文件 + 磁盘余量检查 | 任务暂停，出缺口报告 |

检查结果必须有“重新检查”按钮；环境变化后不用重启 DSH 就能刷新。缺 `ffmpeg` / `ffprobe` 时插件本身不崩溃，只拒绝新任务并显示缺失项和安装命令。

### 15.2 由 DSH 安装缺失资源

新电脑上，用户可以对 DSH 说“按规格 §15.2 检查并安装环境”。DSH 按下面顺序执行：

1. 先跑 §15.1 的检查命令，列出缺失项、当前版本和准备执行的安装命令。
2. **把命令和影响告诉用户，得到确认后再执行**；不要静默安装，不要从来源不明的网站下载二进制，不要修改与这些工具无关的系统配置。
3. 用系统包管理器安装；安装完成后重新打开终端（或重启 DSH），再跑一遍 §15.1。
4. 全部 `OK` 后，再在插件目录执行 `npm install`、`npm run typecheck`、`npm test`、`npm run build`。

Windows（PowerShell，包管理器命令需要管理员权限）：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
winget install --id Git.Git -e
```

没有 `winget` 时可用 `choco install nodejs-lts ffmpeg git -y`（需要先装 Chocolatey）。

macOS：

```bash
brew install node@22 ffmpeg git
# 如果 node 仍指向旧版本
brew link --overwrite node@22
```

Linux（Debian/Ubuntu）：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg git
# Node 22 用 NodeSource 或 nvm 安装，安装后确认 node --version >= 22.13
```

安装后的验收命令：

```bash
node --version
npm --version
ffmpeg -version
ffprobe -version
git --version
```

必须全部返回成功；`ffmpeg -version` 与 `ffprobe -version` 的第一行版本号要一致。DSH 本体版本不够时，让用户按 DSH 官方方式升级，不要用插件脚本静默改 DSH 安装。

---

## 16. 验收标准

### 16.1 单元测试必含

- 路径校验：相对路径、`..` 穿越、白名单外、符号链接逃逸、不存在、目录、错误扩展名、空文件、重复文件、同一文件多路径，各自的正确结果。
- 原视频在完整流程后仍存在，且 SHA-256 未变。
- `ffprobe` 失败、`ffmpeg` 取帧失败记 `ERROR`，不写标签。
- 帧数公式：默认 2 秒间隔；短视频 1 帧；不设每视频上限；时间点公式。
- 帧去重：同一张图两次抽到只留先出现的一帧；近似图（轻微压缩/缩放）汉明距离 ≤16 判重；不同画面不误判；跨视频比较；`duplicate_of` 指向正确；重复帧文件被删且模型调用次数不增加；重跑结果一致。
- 模型：JSON 不合法重试后 `FAILED`；凭据无效与额度用尽直接暂停；部分文本后报错算失败；`TINY` 不算合格；未判对象不写 `ABSENT`；任务对象超过 8 个时一次调用全部判定；超时自动重试且单帧总尝试次数不超过 5 次；判定并发路数生效（1 路串行，多路同时在途调用数不超过设置值）；超图片限制时缩小；`DUPLICATE` 帧不调用模型。
- 状态推进：中途中止后重做一步不重复计数；启动时清空 `tmp/`；不可导出帧被删除。
- 多视频顺序：目录按路径字典序、批量路径按提交顺序导入；进度顺序号稳定；同一顺序重启后不变。
- 跨任务跳过：同一 SHA-256 在第二个任务默认只插入 `SKIPPED`，不新增帧、不调用模型；进度漏斗和顺序列表显示“已跳过（先前已处理）”。
- 强制重跑：只有显式 `force` 才删除当前任务的旧帧/标签/调用后重新抽帧并打标；原视频 SHA-256 不变。
- 任务结束：整夹全部完成后为 `DONE`；只剩 `ERROR` 或只剩 `SKIPPED` 时也立即结束，不无限等待。
- 兼容：旧数据库（schema 1）和缺字段的旧设置/旧 `progress_json` 能正常打开并应用跳过规则。
- 导出：至少一对象合格才导出；`family_id` 按文件哈希、两次导出划分一致、同一文件不跨 train/val；`sources.csv` 不出现编造字段。
- 对象筛选：只选一个对象时 `images/` 只含该对象合格帧、`labels.csv` 只有该对象列；不选时输出与旧全量导出一致。
- 重复导出：换对象再导出不新增帧/标签/模型调用，新目录或 zip 不覆盖旧产物。
- 导出扩展：zip 内含 `images/<对象>/` 与 `stats.json`；最近导出记录持久化，旧设置缺字段可读。
- 导出交互：成功 toast 显示路径与帧数；打开目录失败有提示，可复制路径。
- 工具：6 个工具的成功、校验失败、状态不允许、重复调用；接口拒绝非回环 `Host` 和跨源 `Origin`。
- 环境检查：Node 版本过低、`ffmpeg` / `ffprobe` 缺失、DSH 版本不满足时状态和提示正确；缺工具时插件不崩溃，只拒绝新任务。
- 代码、默认配置、提示词、测试里搜不到测试对象名。

### 16.2 沙盒实测

3 个测试对象、若干本地视频（含一个短视频、一个无法读取的假文件、一个由同一素材重复编码出的近似视频），完整走一次抽帧、帧去重、打标、导出；打开图片和 CSV 核对重复帧没有出现、模型调用数少于抽帧数；杀掉 Host 重启后继续；确认原视频一个没少。

---

## 17. 怎么干：实施顺序

### 阶段 0：新电脑环境准备

- 按 §15.1 检查 Node / npm / ffmpeg / ffprobe / DSH / Git / 数据目录；
- 缺什么按 §15.2 让 DSH 安装并验证；
- 只有全部 `OK` 才进入阶段 1；缺 `ffmpeg` / `ffprobe` 时不要先写抽帧代码。

### 阶段 1：骨架（可运行的空插件）

- `package.json`、`tsconfig*.json`、`vitest.config.ts`、`.gitignore`；
- `db.ts` 7 张表与版本升级；
- `settings.ts` 默认设置；
- `http.ts` 回环/同源/JSON 校验；
- `tool.ts` 6 个工具注册（先返回占位数据，`lf_video_add` 的路径校验先完成）；
- `versions.ts` 环境检查（§15.1），`lf_status` 返回 `environment`；
- `client.js` 2 个页签空壳；
- `cordis.patch.yml`、`SKILL.md`。

验收：`npm run typecheck`、`npm test`、`npm run build` 通过；沙盒加载插件，2 个页签能打开，`lf_status` 能返回。

### 阶段 2：抽帧与状态机

- 本地扫描、CSV 解析、`ffprobe`、`ffmpeg` 取帧；
- 帧数/时间点公式、dHash 帧去重（同任务跨视频、≤16、保留先出现帧）、状态推进、重启恢复、清理规则；
- “原视频哈希不变”测试。

验收：不接模型也能把视频跑成“待打标帧”，数据库状态正确；原文件完整。

### 阶段 3：模型打标与导出

- 按第 7 节逐字写提示词；
- 输出解析与校验、重试、暂停逻辑、图片缩放；
- 导出 `images/` 硬链接、`labels.csv`、`sources.csv`、`README.txt`；
- 沙盒实测完整抽帧 + 打标 + 导出，核对 CSV 与图片。

验收：16.2 全部通过。

每个阶段结束都实跑 `npm run typecheck`、`npm test`、`npm run build`，并如实分 BUILT / TESTED / CONNECTED / NOT_RUN / BLOCKED 汇报。

---

## 18. 可以参考旧项目的地方

旧项目仓库：**https://github.com/shady2713/aerialframes**

> 说明：这个地址从公开网络访问返回 404，可能是私有仓库；在有权限的账号下应该可以访问。以下路径按旧项目仓库的 `plugin/` 子目录组织；如果仓库根目录本身就是插件目录（没有 `plugin/` 这一层），把表格里的 `plugin/` 前缀去掉即可。如果没有访问权限，可以让 owner 加权限，或从旧项目导出需要的文件。

旧项目是一个“从互联网采集航拍帧”的 DSH 插件（TypeScript，结构相近），**只能参考代码零件和工程结构，不能参考它的业务规则和文档**。新插件与它的核心区别：素材来源是本地路径、用户保证可用，不检索、不下载、不联网、不筛素材、不试判、不做帧质量过滤、不抽检；只保留一道“送模型前按 dHash 去重”。

如果只想搬最小的复用包：`subprocess.ts`、`http.ts`、`scheduler.ts`、`disk.ts`、`versions.ts`、`types.ts` 六个文件，加 `inbox.ts` 里的“目录扫描 + CSV 解析 + `ffprobe` + 本地取帧”片段，以及 `frameQuality.ts` 里的 dHash/汉明距离片段。其余按下面两节改造或不要带。

### 18.1 直接复用（逻辑与网络无关）

| 旧项目文件 | 内容 | 用法 |
|---|---|---|
| `plugin/src/subprocess.ts` | 经 `ctx.subprocess` 启动子进程的封装 | 直接搬 |
| `plugin/src/http.ts` | 回环 Host、同源 Origin、方法/JSON 校验、响应封装 | 直接搬 |
| `plugin/src/scheduler.ts` | 5 秒轮询调度器 | 直接搬 |
| `plugin/src/disk.ts` | 磁盘余量检查（`DEFAULT_MIN_FREE_DISK_GB=10`） | 直接搬 |
| `plugin/src/versions.ts` | `ffmpeg`/`ffprobe`/DSH 版本探测 | 搬，删 `yt-dlp` 检测 |
| `plugin/src/types.ts` | 枚举类型 | 搬（删 `ChannelId`，补本规格的状态） |
| `plugin/src/frameQuality.ts` | 64 位 dHash（9×8 灰度网格）、`phashDistance` 汉明距离、ffmpeg 灰度解码 | 只搬哈希与灰度解码部分；不要搬清晰度、亮度、裁切判废阈值 |

### 18.2 需要改造后复用

| 旧项目文件 | 改造点 |
|---|---|
| `plugin/src/inbox.ts` | **最贴近新插件的零件**：本地递归扫描、CSV 解析、`ffprobe` 读时长、`ffmpeg` 本地取帧、硬链接。必须删掉“处理完把原文件移到 `inbox/done/`”的代码，并改为唯一的素材入口；删掉图片导入和试判相关逻辑 |
| `plugin/src/db.ts` | SQLite 建表、WAL、版本升级、8 张表骨架可复用；按新表结构改成 7 张表 |
| `plugin/src/judge.ts` | LLM 调用、超时/重试、图片缩放逻辑可复用；**提示词和输出 schema 必须按本文档第 7 节重写**，删掉 `view`/`real`/`quality`/`watermark` 和帧可用判断 |
| `plugin/src/collector.ts` | 状态机、本地取帧方法可复用；旧项目的 phash 去重队列可参考；删掉试判、正式帧区分、元数据筛、下载、远程取帧、翻页、渠道冷却、User-Agent |
| `plugin/src/export.ts` | 导出流程可复用；`family_id` 改成文件 SHA-256，`sources.csv` 改成 `local_path`/`file_sha256`，删除 `watermark` 列和 channel 文件名 |
| `plugin/src/tool.ts` | 6 个工具改名 `lf_*`；`af_lead_add` 换成 `lf_video_add`；`lf_collect_start` 加 `paths`、删 `targetFrames` |
| `plugin/src/index.ts` | 改 ID、包名、接口前缀；删渠道注册、链接服务；`InboxService` 改成唯一素材入口 |
| `plugin/src/config.ts` | 默认 `dataDir` 在 Windows 写死 `E:\aerial-frames-data`，改成 `homedir()` 派生或设置页配置 |
| `plugin/src/routes.ts` | 保留 status/settings/targets/tasks/scheduler/models/export；删 review 和网络连通测试；`/inbox/import` 换成 `/videos/add` |
| `plugin/client.js` | 保留进度页骨架；设置页删渠道、登录、连通测试，加白名单与抽帧参数；删抽检页 |

### 18.3 不要带进新项目

`plugin/src/channels/` 全部（bilibili、internetarchive、nasa、pexels、pixabay、flickr、link 等）、`plugin/src/credentials.ts`、`plugin/src/linkService.ts`、`plugin/src/hostPacer.ts`、`plugin/src/commons.ts`、`plugin/src/words.ts`（检索词生成）、`plugin/src/downloadProgress.ts`、`plugin/src/metadata.ts`（本版本不做元数据筛）、`plugin/src/review.ts`（本版本不做抽检），以及一切 `yt-dlp`、cookie、User-Agent、渠道冷却、页面抓取代码。`frameQuality.ts` 只保留 dHash/汉明距离/灰度解码（见 18.1），不要带清晰度、亮度、裁切判废部分。

### 18.4 已知坑（照抄前必读）

1. **原文件会被移动**：旧项目 `plugin/src/inbox.ts` 处理完会 `renameSync` 把用户原文件移到 `inbox/done/`。新插件**绝对不能**这么做，必须删掉这段。
2. **旧项目的试判和帧质量门禁不要带回来**：旧 `collector.ts` 有 4 帧试判、元数据拒绝、正式取帧前筛素材；本版本用户已保证视频可用，这些逻辑全部删掉。但旧项目用来做 phash 去重的 dHash 算法可以留下，按 §6.6 接在“抽帧后、送模型前”。注意旧项目在同一批里去重时会用“更清晰”的帧替换前一帧；本版本不做质量判断，统一保留先出现帧，不要照抄这个替换分支。
3. **提示词与规格不一致**：旧项目代码里的判读定义包含航拍/真实/质量/水印，新插件的模型只判断对象，必须按第 7 节重写；不要照抄旧提示词。
4. **默认数据目录写死 E 盘**：旧项目 Windows 分支硬编码 `E:\aerial-frames-data`。新电脑不一定有 E 盘。
5. **导出家族键不适用**：旧项目用“渠道 + 作者”做 `family_id`。本地视频没有这些字段；不改会导致同一视频的帧跨 train/val。必须改成文件 SHA-256。
6. **旧项目的文档和 AGENTS.md 已过时**：不要把旧项目的 `docs/`、`AGENTS.md`、`DEV_PROMPT.md` 当规则带进新项目；它们只描述互联网采集版。
7. **旧项目本地 `plugin/` 是独立 git 仓库**：如果把旧目录整体复制成新仓库，注意不要带上 `plugin/.git`，否则会变成 gitlink 或丢失文件。
8. **DSH 预览版接口**：`ctx.llm.imageRequestTarget`、`readImageRequest`、`ctx.inject`、`ctx.subprocess`、`webServer.register` 的签名在新电脑上按实际 DSH 版本核实。

### 18.5 建议的参考方式

1. 先把本文档第 1–17 节当唯一规格实现；旧项目只在需要写某个具体函数时打开对应文件看实现。
2. 每搬一个文件，先读完整、理解依赖，再复制并补测试；不要整目录复制。
3. 旧项目测试可以挑对应的搬，但断言要按新需求改（尤其“原视频不变”“导出用文件哈希”“不试判”“帧去重后模型调用数减少”）。

---

## 19. 开发启动提示词（可直接粘贴）

```
工作目录：<新项目目录>。

请先读 docs/LOCAL_VIDEO_PLUGIN_SPEC.md（唯一权威规格，自包含）。这是新插件，
只做“用户给本地视频路径 → 按规则抽帧 → 帧去重 → 逐帧按对象打标签 → 导出图片+CSV”。
新电脑先按规格 §15.1 检查环境；缺 Node/npm/ffmpeg/ffprobe 时按 §15.2 让 DSH 安装并验证后再开始。
用户保证视频 100% 可用，所以不做航拍/真实/质量/水印判断，不做试判，不做帧质量过滤，不做抽检；
但必须在送模型前做帧去重（64 位 dHash，同任务跨视频比较，汉明距离≤16，保留先出现帧）。

按规格第 3 节控制规模（7 表/6 工具/2 页签/1 模型/1 提示词，子进程只有 ffmpeg、
ffprobe），按第 16 节的验收标准和第 17 节的阶段 0–3 实现：
0) 新电脑环境准备；1) 骨架与 6 工具；2) 抽帧与状态机；3) 模型打标与导出。
每个阶段实跑 npm run typecheck、npm test、npm run build，并分
BUILT / TESTED / CONNECTED / NOT_RUN / BLOCKED 汇报。

旧项目 https://github.com/shady2713/aerialframes 只作代码零件参考，
参考清单见规格第 18 节；不要照抄它的业务规则、提示词和文档。
特别注意：绝不删除/移动/改写用户原视频；模型只判断对象；导出 family_id 用文件 SHA-256。
```

---

## 20. 完成定义（Definition of Done）

- [ ] 插件能在沙盒 profile 加载，2 个页签可用；
- [ ] 6 个 `lf_*` 工具可用，参数与错误符合第 13 节；
- [ ] 本地视频从路径到导出全流程跑通，原视频哈希不变；
- [ ] 抽帧数量、时间点、JPEG 质量符合第 6 节；
- [ ] 帧去重按第 6.6 节执行（dHash、≤16、同任务跨视频、保留先出现帧），重复帧不调用模型、不导出；
- [ ] 模型提示词与第 7 节逐字一致，只输出对象判断；
- [ ] 不做任何航拍/真实/质量/水印判断，不试判，不做画面质量筛选；只丢弃重复帧；
- [ ] 导出目录结构、CSV 列、train/val 划分、对象筛选、按对象分目录、zip、stats.json 与最近导出记录符合第 10 节；
- [ ] `npm run typecheck` / `npm test` / `npm run build` 全绿；
- [ ] 沙盒实测通过第 16.2 节；
- [ ] 新电脑按 §15.1 / §15.2 检查并补齐环境后能加载；缺 Node / ffmpeg / ffprobe 时给出明确安装提示；
- [ ] 代码、默认配置、提示词、测试里没有写死任何测试对象名或项目名。
