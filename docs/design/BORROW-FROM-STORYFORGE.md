# 从 StoryForge 借鉴的能力清单

> 调研性质：一次性工程对比笔记（非设计权威文档，不进入 § 引用体系）
> 对比对象：同机 `workspace/storyforge-main`（本地优先 AI 叙事创作系统，React + TS + IndexedDB，约 51 万行，v3.9.1）
> 分层原则：kur-river 的立身之本是"小而克制"（零依赖、内核解耦、刻意不做重试/WS/任务队列），凡与该哲学冲突的重型机制一律归入"不建议搬"。

## 第一层：现在就该抄（便宜、贴合 kur-river 气质）

### 1. Token/成本落库 + 预算上限

- StoryForge 实现：`src/lib/ai/usage-log.ts`（唯一消耗记录点，逐次调用记 token 与 `costUsd`，内置日期版本化的模型价格目录，按 moduleKey 归集展示）+ `src/lib/agent/team-budget.ts`（预算档位，超支抛错）。
- kur-river 现状：usage 仅透传不落库，无成本模块。
- 借鉴形态：`generations`/`drafts` 上落 usage，按场次/角色/团队归集；全局预算闸。跑团是长会话产品，成本不可见迟早出事。

### 2. 有界重试与错误分类

- StoryForge 实现：`src/lib/agent/run/failure-policy.ts`——非重试型 4xx 不重发、重试有界且可见、结果未知不隐藏重发。
- kur-river 现状：刻意不重试、错误处理责任上移（`packages/llm` 注释明示）。
- 借鉴形态：不抄 durable harness，只抄"分类 + 有界 + 可见"三条纪律；记忆摘要已有"失败重试一次/幂等补算"，是现成落点。

### 3. 草稿 stale 检测 / 过期阻断

- StoryForge 实现：候选采纳前的 stale/CAS 校验，过期候选不得 `adopt()`。
- kur-river 现状：草稿生成后若上下文变了（新消息落盘、可见性被改、条目编辑），confirm 事务（`packages/db/src/repos/drafts.ts`）只做锁 + seq，无组装基线失效校验。
- 借鉴形态：confirm 时比对草稿的组装基线（场次 seq / 相关条目修订 hash），过期则拒绝或显式提示重抽。

### 4. 每次生成的"上下文清单"留痕

- StoryForge 实现：每个 durable run 留不可变 Context Manifest（读了哪些源、遗漏了什么、预算用量）。
- kur-river 现状：测试里 mock 录制请求体（`scripts/m2-e2e.mjs`），但生产端草稿只存模型配置快照（`resolved*`），**没存"这次生成实际读了哪些世界书条目/记忆/可见消息"**。
- 借鉴形态：drafts 增加组装清单（触发的 lorebook 条目 ID、注入的记忆 ID、可见消息范围、token 账单）。信息不对称是架构地基，"角色为什么说出不该知道的事"必须可事后排查。

### 5. 缺陷编号回归测试纪律

- StoryForge 实现：`tests/regression/` 739 个 `R-*` 编号测试，每个缺陷沉淀一个永久回归。
- kur-river 现状：里程碑 e2e 驱动，缺"修过的 bug 不再回来"的沉淀层。
- 借鉴形态：纯习惯，成本极低——修 bug 时同步加一个编号回归。

### 6. 分层依赖的机器强制

- StoryForge 实现：`scripts/check-architecture.mjs` 校验 import 边界，CI 门禁。
- kur-river 现状：core/db/web 单向依赖靠自觉；`packages/core` 纯 TS 零依赖是其最有价值的资产。
- 借鉴形态：一条 lint 规则或小脚本守住"core 不得 import db/web/llm"，防内核解耦慢慢腐蚀。

## 第二层：下个阶段值得引入

### 7. 优先级分层上下文裁剪 + 遗漏证据

- StoryForge 实现：`src/lib/registry/assemble-context.ts`——L1/L2/L3 优先级真裁剪、结构化压缩带 anchor 校验、记录被裁掉的来源；固定条数截断只是兜底。
- kur-river 现状：`packages/core/src/context/index.ts` 固定六步组装 + 局部 token 截断。
- 借鉴形态：场次一长"裁谁"就是质量问题；平移分层预算与遗漏记录。

### 8. 角色知识台账

- StoryForge 实现：`src/lib/knowledge-ledger/`——显式追踪"谁知道什么、何时得知"，可被剧情修改。
- kur-river 现状：信息不对称是消息过滤式（看不到 = 不知道），secrets 只覆盖输入侧。
- 互补关系：台账是语义式（看到 ≠ 记住/理解），能让"秘密被泄露"成为一等数据而非只靠可见性快照。

### 9. 破坏性操作前强制备份 + 导出/导入的引用重映射生命周期

- StoryForge 实现：`src/lib/safety/require-backup-before.ts` + `PROJECT_TABLES` 注册表驱动的导出/导入/删除/ID 重映射，带往返测试。
- kur-river 现状：只有 PG 层 dump；ST 导入导出（`docs/design/ST-COMPAT.md`）冻结待启动条件。
- 借鉴形态：ST-COMPAT 解冻时直接抄"注册表驱动生命周期 + 往返测试 + ID 重映射"，省一轮踩坑。

### 10. 世界/场次的封存快照

- StoryForge 实现：S1 WorldRelease——不可变版本 + content hash + 能力画像，上层绑定冻结版本。
- kur-river 现状：世界可变，场次引用"此刻的世界"。
- 借鉴形态：分享剧目（《窄门》种子数据已是雏形）、复现问题场次、未来社区化的前提。只抄"封存 + hash + 绑定"，不抄整个三阶段体系。

## 第三层：等 kur-river 长大再考虑

11. **AI 可写字段注册表 + 唯一采纳入口**（StoryForge `FIELD_REGISTRY` + `adopt()`）：等 AI 自动写结构化字段（改卡/条目/记忆）的场景多起来再上；现在 confirm 单点已够用。
12. **AI 入口注册表 + AST 调用方白名单**（StoryForge `ai-entry-registry.json` + `check-ai-entry-registry.mjs`）：等模型调用方超过一掌之数再上，防"野调用"扩散。
13. **媒资适配层**（StoryForge `src/lib/product-production/media-adapters.ts`：图像/音频 adapter + 成本估算 + 版权标记）：做角色立绘/场景图时再引入。
14. **文档权威白名单机制**（StoryForge `docs/DOCUMENT-AUTHORITY.md`）：当前单篇 DESIGN.md + 代码 `§x.y` 引用在本规模下反而更好；只需现在吸收"一个主题只允许一个现行入口"原则。

## 明确不建议搬的

- **事件溯源 durable Harness**（checkpoint/回放/回执）：与 kur-river"异步任务进程内承载"的既定决策正面冲突，量级差一个数量级。
- **三注册表完整形态**（CONTEXT_SOURCES / FIELD_REGISTRY / PROJECT_TABLES）：13 张表 vs 122 张表，治理成本要与规模匹配。
- **产品目录能力门控、PWA 缓存策略**等 StoryForge 特有产物。

## 一句话总结

最优先抄 **1（成本可见）+ 3（草稿过期阻断）+ 4（生成上下文留痕）**——三者都精准补在 kur-river "信息不对称 + 确认制"地基的观测盲区上，且都能以百行级实现，不违背极简哲学。
