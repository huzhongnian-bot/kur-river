# ST 兼容与导入导出（按需扩展）

> 状态：**冻结，不在 M0–M4 路线内**。启动条件见 §4。
> 本文档从 DESIGN.md v0.5 拆出：格式兼容保留在内核（卡片载荷即
> V2/V3 spec），这里只承载"导入导出工具"这一可延后部分。

## 1. 定位与边界

本平台原生按 ST Character Card V2/V3 与世界书触发模型建模
（DESIGN.md §2.2、§5.3），因此"兼容"分两层：

- **格式兼容（已内置，不在本文档范围）**：`characters.card` 就是
  V2/V3 JSON；世界书字段（keys / secondary_keys / scan_depth /
  insertion_order / position / token_budget）是 ST 触发模型的超集。
  原生建卡/建条目 UI 产出的即为该格式，无需任何转换。
- **导入导出工具（本文档，按需）**：解析 ST 生态的既有产物——
  卡 PNG、lorebook JSON、chat JSONL——映射进本平台，以及反向导出。

## 2. 建设范围（启动时按此执行）

新增 `packages/st-compat/`（纯格式转换层，不动 core）：

- 卡 PNG 导入：解析 tEXt chunk 内嵌 JSON
  （参考 ST `character-card-parser.js`），图片本体存文件存储，
  卡 JSON 落 `characters.card`
- 卡 PNG/JSON 导出：反向合成
- lorebook JSON 导入导出
- chat JSONL 导入：每条历史消息包装为单 public 段落、
  visible_to 取导入时在场全员
- API：`/api/worlds/:id/characters/import|export`、lorebook 同级

轻量兜底（可先行，成本极低）：建卡/建条目 UI 提供"粘贴 JSON"入口，
覆盖社区卡以纯 JSON 形式分发的场景，不需要 PNG 解析。

## 3. 启动前必须补齐的设计：字段映射与降级表

ST 条目字段多于本平台支持面，导入策略需逐字段定义。下表为骨架，
启动时对照 ST 源码补全并定稿：

| ST 字段 | 本平台映射 | 策略（待定稿） |
|---|---|---|
| keys / secondary_keys | keys / secondary_keys | 直映 |
| constant（常驻条目） | 无对应 | 降级为普通关键词条目或忽略 |
| selectiveLogic（NOT ANY 等） | 仅主副同时命中（AND） | 降级/忽略 |
| probability / useProbability | 无（概率触发属 M5+） | 忽略，保原文 |
| caseSensitive / matchWholeWords | 无 | 忽略，保原文 |
| group / groupWeight | 无 | 忽略，保原文 |
| preventRecursion / excludeRecursion | 无（递归扫描属 M5+） | 忽略，保原文 |
| vectorized（embedding 触发） | 无（向量召回属 M5+） | 忽略，保原文 |
| V3 卡内嵌 lorebook（char book） | character scope 条目 | 拆分导入 |
| alternate_greetings | 卡 JSON 原样保留（§5.2.2 开场消费） | 直映 |

**raw_source 决策（启动时顺手加列）**：`characters` /
`lorebook_entries` 各加一列 `raw_source JSONB` 存导入原文。
暂不支持的字段未来支持时可重新水合，避免降级造成不可逆丢失。

## 4. 启动条件

满足任一即启动，在此之前原生 CRUD（+ 粘贴 JSON 兜底）足够：

1. 需要从 ST 迁移既有角色/世界书；
2. 需要批量搬运社区卡（chub 等）；
3. 需要与 ST 用户交换内容。
