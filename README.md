# kur-river

导演制 AI 跑团平台。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 开发环境上手（M0）

前置：Node.js ≥ 22、pnpm（`npm i -g pnpm`）。不需要 Docker / 本地 Postgres。

```bash
pnpm install        # 安装依赖（内嵌 Postgres 二进制随依赖安装）

# 终端 1：启动开发数据库（内嵌 Postgres，端口 54329，数据在 .pgdata/，
# 首次运行会初始化数据目录；自动把 DATABASE_URL 写入根目录 .env）
pnpm db:dev

# 终端 2：应用数据库迁移，启动 web
pnpm db:migrate     # 生成迁移用 pnpm db:generate（改 schema 后）
pnpm dev            # http://localhost:3000

# 可选：开启密码门（不设置则本地放行）
APP_PASSWORD=你的密码 pnpm dev
```

其他命令：

```bash
pnpm build          # 全部包类型检查 + Next.js 构建
pnpm test           # 单元测试（packages/core 冒烟）
```

## M1 端到端验证

`scripts/e2e-m1.mjs`（node 原生、零依赖）覆盖完整导演流程：mock OpenAI
服务（127.0.0.1:4100，SSE 流式）→ 构建并在 3100 端口起 `next start` →
Basic Auth 下走通 建世界 → 角色（含 first_mes）→ 化身 → 连接/预设/全局默认
→ 团队+成员 → 场次+上场 → ready 开场草稿 → confirm(seq 1) → 生成草稿
（流式内容断言与 mock 全文一致）→ confirm(seq 2) → 导演消息(seq 3)。

```bash
# 前置：开发数据库在跑（pnpm db:dev 或等价 Postgres，DATABASE_URL 见根 .env.local）
node scripts/e2e-m1.mjs
```

注意：脚本会临时占用 3100 与 4100 端口，结束时自动清理。

## M2 端到端验证

`scripts/e2e-m2.mjs`（node 原生、零依赖，起停模式同 M1）覆盖多角色不对称
信息流：mock OpenAI **记录每次生成请求的 body**，按调用顺序消费带契约标记
（*动作*「台词」（心声））的脚本化回复。断言矩阵：

1. 契约解析：草稿段落切分与默认可见性（speech/action→public、thought→self_director）
2. 信息不对称：他人生成 body 不含心声/secrets、含 public 文本；本人含自己的心声与 secrets
3. castPublicScopes：他人可见 character 级 public 条目、不可见 private 条目
4. 越权裁剪：代写他角色台词 → `outputTruncated` 且段落在该行前截断
5. fail-closed：无契约标记文本 → 单 self_director 段
6. 定密：PATCH segments 把心声段改 public → 确认后他人上下文可见该段
7. 补发可见性：晚加入角色看不到加入前消息 → grant-visibility 后可见
8. 依次反应（§5.4 严格串行）：A 落盘后才生成 B，B 的上下文含 A 刚确认的消息；
   活跃批次重复发起 409；cancel 清批次保留当前草稿

```bash
# 前置：开发数据库在跑（pnpm db:dev 或等价 Postgres）
# 注意：DATABASE_URL 默认读根 .env.local——若它指向生产库，请显式覆盖，例如：
DATABASE_URL=postgresql://postgres:postgres@localhost:54329/kur_river \
  APP_PASSWORD=任意自洽密码 node scripts/e2e-m2.mjs
```

访问 http://localhost:3000 应看到「kur-river M0 全链路 OK」+ 数据库时间与各表计数。

## 仓库结构

- `apps/web` — Next.js 15 应用（薄壳），含单用户密码门（`middleware.ts`）
- `packages/core` — 领域内核（纯 TS，零运行时依赖）
- `packages/llm` — LLM Provider 适配层
- `packages/db` — Drizzle schema + client + migrations
- `scripts/dev-db.mjs` — 开发用内嵌 Postgres 启动脚本
