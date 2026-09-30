# TroupeStage —— 导演制 AI 跑团平台 · 总体设计文档

> 版本：v0.5（开工蓝图 · ST 导入导出降级拆出：格式兼容保留，工具按需，见 docs/ST-COMPAT.md）
> 定位：以"世界书"为原点、以"导演-演员"确认制为核心交互的多角色叙事平台。
> 设计蓝本：SillyTavern 的数据格式与世界书算法（格式兼容，代码自研）。

---

## 1. 产品定位与核心交互

### 1.1 一句话定义

用户是导演，AI 角色是演员。导演选定演出团队、布置场景、给出指令；系统基于
**角色卡 + 世界书 + 该角色可见的对话记忆** 组装上下文调用模型生成草稿；
导演确认/修改后草稿落盘为正式剧情，推进故事。

### 1.2 核心循环

```
选团队 → 选场次（或开新场） → 指定在场角色
      → 输入导演指令（或直接以玩家身份发言）
      → 指定发言角色（可多个依次反应）
      → 系统生成草稿 → 导演确认 / 编辑 / 重抽
      → 落盘为正式消息 → 循环
```

### 1.3 与 SillyTavern 的本质差异（本平台的立身之本）

| 能力 | SillyTavern | 本平台 |
|---|---|---|
| 生成智能位置 | 前端浏览器，无 API | 服务端管线，天然 API 化 |
| 消息可见性 | 全群共享一份上下文 | **按角色过滤的不对称上下文（消息级 + 段落级）** |
| 角色私有秘密/记忆 | 无 | 一等公民（只注入本人上下文） |
| 生成确认流 | 生成即上屏 | 草稿→确认→落盘 |
| 世界组织 | 扁平聊天列表 | 世界书→演出团队→场次 三级结构 |
| 多设备 | 单用户轮询 | 响应式 + 草稿状态服务端持久化 |

---

## 2. 领域模型

### 2.1 层级结构

```
世界书 (World)                        ← 一切的原点
 ├── 世界书条目 (LorebookEntry, world 级)
 ├── 角色池 (Character[])
 ├── 导演化身 (Persona[])             ← 玩家人设，{{user}} 的替换来源
 └── 演出团队 (Troupe[])              ← 从角色池选角 + 团队大纲/基调
      ├── 团队成员 (TroupeMember[])
      └── 场次 (Session[])           ← 一幕戏
           ├── 在场名单 (SessionCast，团队成员的子集)
           ├── 消息流 (Message[]，带可见性标签)
           ├── 草稿 (Draft[])
           └── 场次级世界书条目 (session 级)
```

### 2.2 核心实体定义

**World（世界书）**
世界观容器。持有全局 Lorebook 条目、角色池、前提设定（premise）。
同一世界下可建多个演出团队，演绎不同故事线。

**Character（角色）**
归属世界书。载荷为 SillyTavern Character Card V2/V3 兼容 JSON
（description / personality / scenario / first_mes / mes_example …），
另加本平台扩展字段：
- `secrets`：该角色才知道的秘密设定，**只注入本人生成上下文**
- `talkativeness`：自动调度时的发言倾向（0-1）
- 头像图片独立存储，DB 存 URL

**Persona（导演化身）**
归属世界书的轻量玩家人设：`name + description`。导演以 player 身份
发言时的"我"，同时是 ST 宏 `{{user}}` 的替换来源。
每个团队可绑定一个默认化身。

**Troupe（演出团队）**
世界书下的选角结果 + 剧目大纲。字段：
- `outline`：剧目大纲（结构化 JSON：幕次划分、剧情节点）
- `toneDirective`：团队基调指令（"本团走悬疑风"），注入所有生成
- 成员为角色池子集；同一角色可加入多个团队，记忆跨团队默认隔离

**Session（场次）**
一幕戏。字段：
- `scene`：场景设定（地点、时间、氛围、在场道具等）
- `status`：active / archived
- 在场名单（cast）为团队成员子集，可随时上下场

**Message（消息）**
场次内的一条剧情记录，严格按 `seq` 递增排序：
- `senderType`：director（导演旁白/指令）/ character / player（导演以化身发言）
- `visibleTo`：可见角色 ID 数组，默认在场全员（消息级粗筛，见 §2.3）
- `segments`：段落数组，可见性细化到段落级（见下）

**导演指令不落盘（明确决策）**：`draft.directive` 是幕后调度元数据，
只存于草稿、用于当次组装（§5.2 ⑥），确认后不成为消息。导演要以
剧情身份发言（旁白/推进），一律走 POST messages 显式落盘
（sender_type=director）——历史里出现的每一条内容都是刻意落盘的。

**直接落盘路径的同等约定**：导演/玩家 POST messages 直接发言时，
同样在落盘前完成宏替换（"库里不存裸宏"是全局不变量，不只覆盖
草稿确认与开场草稿两条路径）；segments 默认构造为单个 public 段落，
UI 可改为 director 旁注等其他可见性。

LLM 的自然输出是散文风混合体——动作描写、内心独白、台词交织在同一条
回复里，整条消息一个可见性粒度不够用。因此 content 建模为段落数组：

```ts
segments: [
  { kind: 'speech' | 'action' | 'thought', text: string,
    visibility: 'public' | 'self_director' | 'director' }
]
```

- `public`：在场全员可见（台词、公开动作的默认值）
- `self_director`：仅本人 + 导演可见（内心独白的默认值，
  保证角色记得自己想过什么）
- `director`：仅导演可见（隐蔽动作、幕后信息）

上下文组装按"读者角色"过滤段落而非整条消息；`visibleTo` 数组退化为
"段落过滤后是否还有剩余内容"的消息级快速索引。

**可见性快照语义（明确决策）**：`visibleTo` 在消息创建时按当时在场
名单快照。中途上场的角色看不到上场前的剧情——这是刻意的信息不对称，
不是失忆 bug。导演面板提供"补发可见性"操作，可将历史消息批量授权给
新上场角色。

**Draft（草稿）**
确认制的载体，完整状态机（含生成中与失败态）：

```
queued → generating → ready → confirmed / discarded
              └────→ failed（保留 error 信息，可重试）
```

确认时在事务内转化为 Message（取下一个 seq；ready 态下导演可先编辑
段落内容与可见性再确认）。草稿额外记录
`resolvedConnectionId / model / params`——本次生成实际使用的模型配置
快照，支撑重抽 A/B 对比与问题追溯。草稿服务端持久化，
支持移动端断连后恢复——生成请求与结果收取解耦。

**Memory（记忆摘要）**
每场归档产出一条 `(character_id, troupe_id, session_id)` 记录（追加式），
把该角色在场可见的段落压缩成长期记忆。生成时按
`(character_id, troupe_id)` 取该角色在本团队的全部摘要，按场次时间
顺序拼接、在记忆预算内**从旧到新截断（最近场次优先保留）**。
摘要条数超过阈值（如 10 场）时触发"摘要的摘要"：较旧记录滚动合并为
一条 epoch 摘要。**epoch 只是读取优化，不删原始单场摘要**——原始
记录保留，epoch 可随时由它们重建。已归档场次的任何消息变更
（PATCH 编辑、/truncate 截断重演，§7.1）触发同一条规则：该场次的
记忆记录作废并按变更后内容重算，若该场已并入 epoch 则连带重建
epoch——角色不能"记得被剪掉的剧情"。跨团队记忆默认隔离，
共享机制列入 M5+。

**LorebookEntry（世界书条目）**
三级 scope，通过 `ownerType + ownerId` 表达：
- `world`：对全世界所有团队/场次生效
- `character`：分 `public / private` 两档——public（外貌、身份等公开
  设定）在该角色**在场**时对所有发言者的扫描生效；private 仅注入
  本人生成上下文（与 secrets 同级隔离）
- `session`：单场专属，场次归档时批量置 `enabled=false` 失效

触发模型兼容 ST：关键词数组 + 扫描深度 + 优先级 + 插入位置
（before/after character def）+ token 预算。

### 2.3 信息不对称的实现原理（两级过滤）

**第一级：消息级粗筛（SQL）**

```sql
SELECT * FROM messages
WHERE session_id = :sid
  AND visible_to @> ARRAY[:character_id]   -- Postgres 数组包含
ORDER BY seq DESC LIMIT N;
```

**第二级：段落级过滤（core/visibility，纯逻辑）**

对每条消息按"读者角色"渲染 segments：
- 他人的消息 → 仅保留 `public` 段落
- 本人的消息 → 保留 `public` + `self_director` 段落
  （角色记得自己的心声，不会自我失忆）
- 导演视图 → 全部段落

秘密设定、其他角色的内心独白、别场次的记忆，天然不在其中。
注意：secrets 的隔离只覆盖**输入侧**——角色可能在叙述中把秘密"演
出来"。输出侧靠段落默认可见性 + 导演确认时的定密把关兜底（§5.7）。
这是本架构的地基，不是后期补丁。

---

## 3. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Next.js 15（App Router）+ TypeScript | 全栈一体，Server Components + Route Handlers |
| 样式 | Tailwind CSS v4 + shadcn/ui（Base UI 基元） | 语义 token（--background/--card/--primary…）驱动；题材皮肤 = `app/skins/*.css` 按 `[data-skin]` 覆盖变量，troupe.skin 挂皮肤、scene.skin 单场覆盖；氛围动画 = `components/ambient/` canvas 粒子，scene.ambience 驱动 |
| 数据库 | PostgreSQL + JSONB | 关系主干（消息流/可见性/层级）+ 文档载荷（卡/条目） |
| ORM | Drizzle（或 Prisma，二选一） | 见 §6.3 讨论 |
| 包管理 | pnpm workspaces | monorepo，核心引擎独立成包 |
| LLM 接入 | 自研 Provider Adapter，首发 OpenAI 兼容协议 | 覆盖 OpenAI/DeepSeek/各类本地推理 |
| 移动端 | 响应式 + PWA manifest | 不做原生 App |
| 文件存储 | 本地磁盘起步，接口抽象后可换 S3 | 角色卡 PNG/头像 |
| 部署形态 | 长驻 Node 进程（自部署） | 异步生成/摘要任务跑在进程内，不依赖 serverless |
| 认证 | 单用户密码门（basic auth 级） | 自部署也不裸奔，保护 API key 与剧情数据 |

明确不引入：向量数据库（MVP 用关键词触发即可，后续可加 embedding 召回）、
WebSocket（生成走"提交→轮询/SSE 重连"，与草稿持久化模型契合）、
外部任务队列（异步生成与摘要任务以进程内事件订阅者承载，
前提是长驻 Node 进程部署）。

---

## 4. Harness 工程架构（迭代友好性设计）

### 4.1 总原则：核心引擎与框架解耦

生成管线、世界书引擎、可见性过滤是**纯 TypeScript 领域逻辑**，
不依赖 Next.js、不依赖 HTTP、不依赖数据库实现。
这样：可单元测试、可换框架、可出 CLI、未来功能（骰子/语音/立绘）
都挂在稳定的内核边界上。

### 4.2 仓库结构（pnpm monorepo）

```
troupe-stage/
├── apps/
│   └── web/                    # Next.js 应用（薄壳）
│       ├── app/                # App Router 路由
│       ├── components/         # UI 组件
│       └── server/             # Route Handlers / Server Actions
├── packages/
│   ├── core/                   # ★ 领域内核（纯 TS，零框架依赖）
│   │   ├── lorebook/           # 世界书引擎：匹配、排序、预算、注入
│   │   ├── context/            # ContextAssembler：生成上下文组装
│   │   ├── visibility/         # 可见性过滤规则
│   │   ├── scheduling/         # 发言调度（导演点名/依次反应/自动）
│   │   ├── memory/             # 记忆摘要策略
│   │   ├── card/               # Character Card V2/V3 解析与规范化
│   │   └── events/             # 领域事件总线
│   ├── llm/                    # LLM Provider 适配层
│   │   ├── adapter.ts          # ProviderAdapter 接口（见下）
│   │   ├── registry.ts         # providerType → Adapter 注册表
│   │   ├── openai-compatible/  # 首发实现（覆盖 OpenAI/DeepSeek/
│   │   │                       #   OpenRouter/LM Studio/各类本地推理）
│   │   └── token-counter.ts    # token 计数抽象（可插拔）
```

```ts
interface ProviderAdapter {
  readonly type: string;
  listModels(conn: LlmConnection): Promise<string[]>;   // 拉取可用模型列表
  generate(req: {
    connection: LlmConnection; model: string;
    messages: ChatMessage[]; params: GenerationParams;
    onToken?: (delta: string) => void;                  // 流式回调
  }): Promise<{ text: string; usage?: TokenUsage }>;
}
```

新增厂商 = 在 `packages/llm/` 加一个目录实现此接口并注册，
core 与 web 层零改动。Claude/Gemini 原生协议列入 M5+ 按需添加，
消息格式转换可参考 ST 的 `src/prompt-converters.js`。

```
│   └── db/                     # Drizzle schema + client + migrations
├── docs/
└── pnpm-workspace.yaml
```

### 4.3 模块依赖方向（单向，禁止反向）

```
apps/web ──► packages/core ──► packages/llm
    │              │
    └────► packages/db ◄───────┘（core 定义仓储接口，db 实现）
```

`core` 通过**仓储接口**（Repository pattern）访问数据，
`db` 包实现这些接口。core 的单测用内存仓储，不起数据库。

### 4.4 扩展点（为后续迭代预埋）

1. **ProviderAdapter 接口**：新增 LLM 厂商 = 新增一个适配器目录。
2. **领域事件总线**：`draft.created` / `message.confirmed` /
   `session.archived` / `memory.summarized` 等事件，
   后续功能（自动摘要、骰子判定、TTS、通知推送）以订阅者身份挂接，
   不改内核。
3. **生成拦截器**（参考 ST 的 generation interceptors）：
   管线中预留 `beforeAssemble` / `afterAssemble` / `afterGenerate` 钩子，
   正则处理、内容过滤、数值系统（HP/骰子）后续以插件形式插入。
4. **Feature flags**：配置驱动的功能开关，半成品功能可合并不发布。

---

## 5. 生成管线详细设计（核心中的核心）

### 5.1 输入

```ts
interface GenerationRequest {
  sessionId: string;
  speakerCharacterId: string;      // 谁发言
  directive?: string;              // 导演指令（可空：角色自发反应）
  triggerMessageId?: string;       // 由哪条消息触发
  connectionId?: string;           // 单次覆盖（§5.5 优先级链最高层）
  model?: string;
  presetId?: string;
}
```

### 5.2 ContextAssembler 组装步骤（伪代码）

```ts
async function assemble(req: GenerationRequest): Promise<ChatMessage[]> {
  const char    = await characters.get(req.speakerCharacterId);
  const session = await sessions.getWithTroupeAndWorld(req.sessionId);
  const budget  = allocateBudget(session.settings.maxContext);
  // 例：system 区 30% / 历史区 50% / 输出保留 20%

  // ① 基调与世界观层
  const systemParts = [
    session.troupe.toneDirective,
    session.world.premise,
    session.scene.description,
  ];

  // ② 世界书扫描（三级 scope 合并）
  //    扫描源：最近 scanDepth 条可见消息 + 本角色卡文本 + 导演指令
  const visibleRecent = await messages.visibleTo(char.id, session.id,
                                                 { limit: SCAN_SOURCE_DEPTH });
  const entries = lorebook.scan({
    sources: [...visibleRecent.map(m => m.publicText), char.cardText, req.directive],
    scopes:  ['world', 'session:' + session.id,
              'character:' + char.id,                    // 本人：public + private
              ...castPublicScopes(session.cast, char.id)], // 其他在场角色：仅 public
    budget:  budget.lorebook,
  });
  // 按优先级排序、去重、token 预算截断；按 entry.position 分 before/after 两组

  // ③ 角色卡层（仅本角色的卡 + 本角色的 secrets）
  const charDef = renderCharacterCard(char, { includeSecrets: true });

  // ④ 长期记忆层（本角色 × 本团队的摘要）
  const memory = await memories.get(char.id, session.troupe.id);

  // ⑤ 对话历史层（消息级粗筛 + 段落级过滤，token 预算内尽量多带）
  //    每条消息按读者 = char 渲染 segments（§2.3 第二级过滤）；
  //    at_depth 类世界书条目在此层按深度插桩注入
  const history = await messages.visibleTo(char.id, session.id,
                                           { tokenBudget: budget.history });

  // ⑥ 导演指令作为最后一条 user 消息；输出契约注入 system（§5.7）。
  //    宏替换（{{char}}→发言角色名，{{user}}→当前化身名；M1 支持这两个，
  //    其余 ST 宏按需扩展）只作用于本次新组装的 system 层与 directive：
  //    历史消息在确认落盘时已完成替换（§5.2.2 开场草稿同理），库里不存
  //    裸宏——否则 {{char}} 会在他人发言时被错绑到当前发言角色
  return [
    { role: 'system', content: substituteMacros(join(systemParts, entries.before)) },
    { role: 'system', content: substituteMacros(join(charDef, entries.after, memory,
                                                     outputContract)) },
    ...history.map(toChatMessage),        // 多角色 role 映射见 §5.2.1
    req.directive && { role: 'user',
                       content: substituteMacros(wrapDirective(req.directive)) },
  ].filter(Boolean);
}
```

#### 5.2.1 多角色历史的 role 映射

OpenAI 协议只有 system/user/assistant 三种 role，多角色历史按
"以发言者为第一人称"映射（与 ST 群聊策略一致）：

- 发言角色自己的历史消息 → `assistant`
- 其他角色 / 导演旁白 / 玩家化身的消息 → `user`，
  内容加名字前缀（`Alice: ...` / `旁白: ...`）
- 段落渲染在映射前完成：他人消息只带 public 段落文本

#### 5.2.2 开场处理

场次创建时，若首个上场角色的卡带 `first_mes`（及 V2 的
alternate_greetings，供导演挑选），经宏替换后作为该角色的开场草稿
进入确认流；导演也可跳过，改用旁白开场。

### 5.3 世界书引擎算法（移植自 ST `checkWorldInfo()` 的设计）

```
输入：扫描源文本集合、条目集合、预算
1. 关键词匹配：每条目检查 keys（支持正则），命中则激活；
   带 secondaryKeys 的条目需主副同时命中（ST 的 AND 逻辑）
2. 递归扫描：被激活条目的 content 加入扫描源，重复匹配
   （上限 scanDepth，防死循环）
3. 排序：insertionOrder 降序（数值小者优先进入预算）
4. 预算截断：累计 token ≤ lorebookBudget，超出丢弃低优先条目
5. 输出：按 position（before_char / after_char / at_depth）分组
```

MVP 实现关键词匹配 + 预算截断 + 位置注入；递归扫描、概率触发、
timed effects（sticky/cooldown）列入后续迭代。

### 5.4 发言调度（scheduling）

- **导演点名**（默认）：UI 点选角色 → 生成。最符合拍戏直觉。
- **依次反应**：导演发一条消息后，在场角色按列表顺序推进，
  **严格串行**：A 生成 → 导演确认（A 落盘）→ B 才开始生成——
  后续角色的上下文必须包含前面角色已确认的反应，禁止对同一条
  导演消息批量并行预生成。GalGame 式推进。单批设排队计划上限
  （默认 = 在场角色数，可在场次设置中收紧），限制的是队列长度
  而非并行数——一次导演操作不会触发超额付费调用。
- **自动接龙**（后续迭代）：参考 ST NATURAL 策略按提及打分，
  连续 N 轮无需导演干预。

### 5.5 模型路由与多 API 切换

**目标：一条生成请求进来，系统能解析出"用哪个连接、哪个模型、哪套参数"，并允许在多个层级上覆盖。**

```ts
interface LlmConnection {           // 一条命名连接 = 一个可用 API 来源
  id: string;
  name: string;                     // "我的 DeepSeek" / "本地 LM Studio"
  providerType: 'openai-compatible' | 'claude' | 'gemini' | ...;  // 决定用哪个 Adapter
  baseUrl: string;
  apiKey: string;                   // 服务端保管，前端永不回传明文
  defaultModel?: string;
  enabled: boolean;
}

interface GenerationPreset {        // 命名采样参数预设
  id: string;
  name: string;                     // "稳定叙事" / "高发散创作"
  params: { temperature?, topP?, maxTokens?, frequencyPenalty?, presencePenalty?, ... };
}
```

**模型选择的覆盖优先级（从低到高）：**

```
全局默认连接+模型  <  团队绑定  <  角色绑定  <  单次生成指定
```

- 全局默认：settings 里选一条连接 + 一个模型 + 一套预设
- 团队绑定：团队可指定"本团用 Claude"（比如悬疑团用长上下文模型）
- 角色绑定：可让特定角色走不同模型（旁白用小模型省钱、主角用大模型保质）
- 单次生成：演出界面生成按钮旁可临时换模型/调参数，不改任何绑定

**运行时解析：**

```ts
function resolveModel(req: GenerationRequest): ResolvedLlm {
  const char   = ...; const troupe = ...; const global = settings.default;
  const connId = req.connectionId ?? char.llmConnectionId
              ?? troupe.llmConnectionId ?? global.connectionId;
  const model  = req.model ?? char.model ?? troupe.model
              ?? connections.get(connId).defaultModel;
  const preset = presets.get(req.presetId ?? troupe.presetId ?? global.presetId);
  return { adapter: adapters.for(connections.get(connId).providerType),
           connection: connections.get(connId), model, params: preset.params };
}
```

**切换体验**：连接和预设都是命名实体、随时热切换，改动即生效、无需重启；
演出界面的"临时换模型"只影响当次草稿，方便导演 A/B 对比不同模型的演绎风格。

### 5.6 草稿确认流

```
POST /api/sessions/:id/drafts
  → 创建 draft(queued) → 进程内异步生成（generating）
  → 流式写回 draft.content（按 ~500ms 间隔批量 flush，避免 token 级写库）
  → 完成后 afterGenerate 解析成段落（§5.7）置 ready / 出错置 failed（记录 error，可重试）
GET  /api/drafts/:id        （轮询/SSE 取结果，移动端断连可恢复）
POST /api/drafts/:id/confirm   → 事务内转为 message，发 message.confirmed 事件
POST /api/drafts/:id/regenerate → 新 draft 替换旧的（沿用或改写模型配置快照）
PATCH /api/drafts/:id       （导演编辑草稿段落内容/可见性后再确认）
```

**seq 分配的并发正确性**：confirm 在单事务内以
`SELECT ... FOR UPDATE`（锁场次行）或 pg advisory lock 串行化取
`max(seq)+1`，`UNIQUE(session_id, seq)` 仅作最后防线。
"依次反应"多草稿排队确认依赖此保证。

**运行前提**：异步生成与摘要任务均以进程内任务承载，
部署目标为长驻 Node 进程（§3），不上 serverless、不引入外部队列。

### 5.7 输出契约与解析（散文风治理）

LLM 角色输出天然是散文混合体（动作 + 心声 + 台词交织），
管线在输出侧做三件事：

**① 输出契约（注入 system prompt）**：约定社区通用格式——
台词用引号、动作用 `*...*`、内心独白用 `(...)`；
只演自己的角色，不替他人写台词与主观动作。

**② afterGenerate 解析拦截器**（§4.4 预留钩子的首个内建实现）：
- 按契约切分 segments，打默认可见性
  （speech/action → public，thought → self_director）
- 越权发言裁剪：检测到为其他在场角色代写台词/主观动作时，
  从该位置截断（同 ST 群聊处理）
- 解析失败整条降级为单个 `self_director` 段落（fail-closed：宁可让
  导演在定密台手动下放可见性，也不默认把未识别内容放进全员上下文），
  不追求 100% 解析率

**③ 导演定密（确认流 UI）**：草稿按段落展示，每段带可见性开关，
导演微调后落盘。secrets 在输出侧的泄漏由此兜底（§2.3）。

---

## 6. 数据层设计

### 6.1 Schema（PostgreSQL + JSONB，Drizzle 表达）

```sql
worlds         (id, user_id, title, premise JSONB, created_at)
                                   -- user_id：单用户 MVP 恒为默认用户，多用户化预留
characters     (id, world_id, name, avatar_url,
                card JSONB,        -- V2/V3 spec 原文
                secrets JSONB,     -- 私有设定，仅注入本人上下文
                talkativeness real DEFAULT 0.5, created_at)
personas       (id, world_id, name, description text, created_at)
                                   -- 导演化身，{{user}} 宏替换来源
troupes        (id, world_id, name, outline JSONB, tone_directive text,
                default_persona_id uuid, created_at)
troupe_members (troupe_id, character_id, added_at, PRIMARY KEY(troupe_id, character_id))
sessions       (id, troupe_id, title, scene JSONB, status text,
                settings JSONB,    -- maxContext / 依次反应批上限等场次级配置（§5.2、§5.4）
                created_at)
session_cast   (session_id, character_id, PRIMARY KEY(session_id, character_id))
messages       (id, session_id, seq int, sender_type text, sender_id uuid,
                                   -- player 消息的 sender_id = persona id
                content JSONB,     -- 段落数组 [{kind,text,visibility}]（§2.2）
                visible_to uuid[], -- 消息级粗筛快照（§2.3）
                created_at, UNIQUE(session_id, seq))
drafts         (id, session_id, character_id, directive text,
                trigger_message_id uuid,
                content JSONB,     -- 与 message 同构的段落数组
                status text,       -- queued/generating/ready/failed/confirmed/discarded
                error text,
                resolved_connection_id uuid, resolved_model text,
                resolved_params JSONB,   -- 本次生成的模型配置快照（§2.2）
                created_at, updated_at)
lorebook_entries (id, owner_type text, owner_id uuid,
                  visibility text, -- character 级条目：public 在场全员生效 /
                                   --   private 仅注入本人（§2.2）
                  keys text[], secondary_keys text[],
                  content text, position text,
                  depth int,       -- position=at_depth 时的插入深度（§5.2 ⑤）
                  insertion_order int, scan_depth int, token_budget int,
                  enabled bool)
                                   -- session 级条目在场次归档时批量置 enabled=false
memories       (id, character_id, troupe_id, session_id,
                summary text, created_at)
                                   -- 每场一条追加；聚合与滚动合并见 §2.2 Memory
llm_connections (id, name, provider_type text, base_url text,
                 api_key text,        -- 服务端保管；自部署 MVP 明文，
                                      -- 多用户化时换加密存储
                 default_model text, enabled bool, created_at)
generation_presets (id, name, params JSONB)   -- 采样参数预设
settings       (id, user_id, default_connection_id, default_preset_id,
                default_model text)  -- user_id 同 worlds，单用户恒为默认
```

模型绑定的覆盖字段（§5.5 优先级链）：`troupes.llm_connection_id / model / preset_id`、
`characters.llm_connection_id / model`，均可空，空则向上回退。

索引要点：
- `messages(session_id, seq)` 复合索引（分页主路径）
- `messages.visible_to` GIN 索引（可见性过滤）
- `lorebook_entries(owner_type, owner_id)`（scope 查询）

### 6.2 为什么是 Postgres 而不是 MongoDB

文档形数据（卡、条目、premise、outline、scene）全部 JSONB 承接，
灵活性与文档库持平；而高频路径（消息流排序分页、可见性数组过滤、
draft→message 事务转换、层级关联查询）全是关系型主场。
Next.js 生态（Neon/Supabase/Vercel Postgres）也以 Postgres 为主流。

### 6.3 ORM 选择

- **Drizzle**：SQL 亲和、轻量、数组/JSONB 操作符表达直接，推荐。
- **Prisma**：生态更大，但 `visible_to uuid[]` 的数组包含查询要写 raw SQL。
倾向 Drizzle，开工时最终确认。

### 6.4 文件存储

头像、立绘等图片本体存文件系统/对象存储，DB 只存 URL。
ST 卡 PNG 内嵌 JSON 的导入导出已降级为按需扩展，
拆分至 [ST-COMPAT.md](ST-COMPAT.md)，不在本蓝图路线内。

---

## 7. API 与页面结构

### 7.1 Route Handlers（apps/web）

```
/api/worlds                        CRUD
/api/worlds/:id/characters         CRUD（ST 导入导出已降级拆出，见 docs/ST-COMPAT.md）
/api/worlds/:id/personas           导演化身 CRUD
/api/worlds/:id/lorebook           条目 CRUD
/api/troupes                       CRUD + /members
/api/troupes/:id/sessions          CRUD + /cast
/api/sessions/:id/messages         GET（分页）+ POST（导演/玩家直接发言；
                                     落盘前宏替换、默认单 public 段落，§2.2）
                                   + PATCH /:mid（编辑已落盘消息，M3）
                                   + /truncate（截断到某 seq 重演，M3）
                                     两者对已归档场次生效时均触发该场
                                     记忆作废重算与 epoch 重建（§2.2）
                                   + /grant-visibility（补发可见性给新上场角色）
/api/sessions/:id/drafts           生成草稿（§5.6）
/api/sessions/:id/archive          归档：发 session.archived 事件触发记忆摘要，
                                   session 级世界书条目批量置 enabled=false（§2.2）
/api/providers/connections         LLM 连接 CRUD + /models（拉取模型列表）
/api/providers/presets             采样参数预设 CRUD
/api/settings                      全局默认连接/模型/预设读写（§5.5）
```

密钥存服务端（参考 ST secrets 模式），前端永不持有。

### 7.2 页面

```
/worlds                    世界书列表
/worlds/:id                世界书详情（条目管理 / 角色池 / 团队列表）
/troupes/:id               团队详情（大纲 / 成员 / 场次列表）
/sessions/:id              ★ 演出界面（核心战场）
/settings/providers        LLM 连接与预设管理（多连接并存、热切换），
                           兼作全局默认连接/模型/预设的设置入口（/api/settings）
```

**演出界面布局**：
- PC：三栏——左侧在场角色列表（上下场开关、点名发言按钮），
  中间剧情流 + 草稿确认卡（按段落展示、每段带可见性开关的
  "定密台"，§5.7），右侧导演面板（指令输入、场景设定、世界书速查、
  补发可见性）。
- 移动：单栏剧情流为主，底部输入栏 + 抽屉式角色/导演面板。
  重编辑（世界书条目、角色卡）主要面向 PC 端优化，移动端只做轻量调整。

---

## 8. 迭代路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 骨架 | monorepo + Next.js + DB schema（含段落式消息结构）+ 密码门 + 部署跑通 | hello world 全链路 |
| M1 单角色 MVP | 世界书/角色/化身 CRUD、单团队单场次、OpenAI 兼容生成、draft 完整状态机、{{char}}/{{user}} 宏、first_mes 开场（段落可先全 public） | 能完整演一场单人戏 |
| M2 多角色 | 团队选角、在场名单、两级可见性过滤、secrets、输出契约解析 + 越权裁剪、段落定密 UI、补发可见性、依次反应调度 | 信息不对称可演示 |
| M3 记忆与修订 | 场次归档摘要、跨场次记忆注入与滚动合并、消息编辑/截断重演 | 角色记得上一场的事；剧情可回滚 |
| M4 体验 | 移动端打磨、PWA | 手机可导戏 |
| M5+ 扩展 | 自动接龙调度、递归世界书、向量召回、骰子/数值系统、TTS、立绘、ST 导入导出（docs/ST-COMPAT.md） | 按需 |

每个里程碑结束保持可部署状态；M5+ 全部通过 §4.4 的扩展点接入，不动内核。

---

## 9. 测试策略

- `packages/core`：纯逻辑，单元测试全覆盖
  （世界书匹配矩阵、段落级可见性过滤矩阵、预算截断边界、
  输出契约解析器：切分/越权裁剪/降级、role 映射、宏替换）。
- `packages/llm`：adapter 契约测试（mock fetch）。
- API 层：集成测试（testcontainers Postgres 或 Neon 分支），
  重点覆盖 confirm 并发取 seq 的串行化正确性。
- 演出界面：Playwright 冒烟（导演指令→草稿→确认→消息上屏）。

---

## 10. 开放问题（开工前确认）

1. ORM 最终选 Drizzle。
2. 单用户自部署起步（带单用户密码门，§3）。
3. token 计数：js-tokenizers（对非 OpenAI 系模型为近似值，
   预算截断预留 ~10% buffer）。
4. 项目正式命名：kur-river。
5. 部署形态：长驻 Node 进程，异步任务进程内承载，
   不上 serverless / 外部队列（§5.6）。
