# 给云电脑 DSH 的开发提示词

把下面整段内容粘贴到云电脑上的 DSH 对话框。`<项目目录>` 换成该电脑上仓库克隆后的实际路径。

```text
工作目录：<项目目录>。

这是一个新的 DSH 插件项目，代码还没有开始写。唯一权威规格是
docs/LOCAL_VIDEO_PLUGIN_SPEC.md；请先完整读完这份规格，再开始任何实现。
不要凭记忆、不要按其他项目的习惯补规则；规格没有写的，先停下来问我。

项目只做这一条流程：用户给本地视频路径 → 按规格抽帧 → 帧去重 → 逐帧按
用户定义的对象调用视觉模型打标签 → 导出图片和 CSV。用户保证输入视频 100%
可用，所以不做航拍判断、真实拍摄判断、质量判断、水印判断，不做素材筛选，
不做 4 帧试判，不做帧质量过滤，不做人工抽检。唯一要在送模型前做的过滤是
帧去重：64 位 dHash、同一任务内跨视频比较、汉明距离 ≤16、保留先出现帧，
重复帧记 DUPLICATE，不调用模型、不写标签、不导出。

开工顺序：

0. 环境准备：按规格 §15.1 检查 Node ≥22.13、npm、ffmpeg、ffprobe、DSH
   版本、Git、数据目录可写和剩余空间。缺什么按 §15.2 先列缺失项和安装
   命令，得到我的确认后再用系统包管理器安装，装完重新打开终端/DSH 复验。
   全部 OK 再进入阶段 1。
1. 阶段 1：骨架。package.json、tsconfig、vitest、.gitignore、7 张表的
   db.ts、settings.ts、http.ts、6 个 lf_ 工具占位、versions.ts 环境检查、
   client.js 两个页签空壳、cordis.patch.yml、SKILL.md。
2. 阶段 2：抽帧与状态机。本地扫描、CSV、ffprobe、ffmpeg 取帧、帧数/
   时间点公式、dHash 去重、状态推进、重启恢复、清理规则。
3. 阶段 3：模型打标与导出。按规格第 7 节逐字写提示词，解析和校验模型
   JSON，处理重试与暂停，导出 images/、labels.csv、sources.csv、README.txt。

硬性约束（规格 §3.1）：7 张表、6 个 agent 工具、2 个设置页签、1 个模型槽、
1 种判断提示词、同一时间只跑 1 个任务、子进程只有 ffmpeg 和 ffprobe，且
都经 DSH 的 ctx.subprocess 启动。不要加规格之外的后台机制、抽象层或依赖。

绝不能做的事：
- 绝不删除、移动、改名或改写用户的原视频；只读打开。旧项目的 inbox.ts
  有一段把原文件 renameSync 到 inbox/done/ 的代码，不要照抄。
- 不编造 URL、标题、作者、许可、地区或成功状态；本地视频没有这些字段就
  照实留空或写本地路径和文件哈希。
- 模型输出是不可信数据，必须校验通过才入库；没有成功的模型调用，标签
  不能是 QUALIFIED。
- 只有模型明确回答 ABSENT 才写 0；UNSURE、TINY、OCCLUDED 都不算没有。
- 密钥和 cookie 不进 SQLite、日志、导出或 git。
- 导出 family_id 用文件 SHA-256（CSV 提供 family 列时优先用 family），
  同一视频的帧不能跨 train/val。

旧项目 https://github.com/shady2713/aerialframes 只作代码零件参考，清单见
规格第 18 节。如果没有访问权限，不要等它，按规格自己实现；不要照抄它的
业务规则、提示词、docs 或 AGENTS.md。

每个阶段结束都要实跑并如实汇报：
npm run typecheck
npm test
npm run build

汇报分五段：BUILT（做了什么）、TESTED（实际跑了什么、结果）、CONNECTED
（在沙盒 profile 里实际加载/调用过什么）、NOT_RUN（没跑的和原因）、
BLOCKED（卡住的和需要我决定的事）。不要把 NOT_RUN 写成通过，不要用合成
夹具冒充真实视频验收。

先不要改 git 历史、不要 push；每阶段完成后等我确认再进入下一阶段。
现在从阶段 0 开始：先读规格，输出一份你打算怎么做的简短计划，然后检查环境。
```
