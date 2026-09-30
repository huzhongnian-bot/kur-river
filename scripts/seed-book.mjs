// 种子脚本：把 docs/books/<book>/seed/ 下的世界书设定灌进本地 kur-river 实例。
//
// 用法：
//   node scripts/seed-book.mjs [seedDir]          # 默认 docs/books/narrow-gate/seed
// 环境变量：
//   BASE_URL      默认 http://localhost:3000
//   APP_PASSWORD  若服务端设了密码门则必须提供（Basic 凭证，用户名任意）
//
// 目录结构（全部可选，存在才处理）：
//   world.json            { title, premise }
//   characters/*.json     { name, card, secrets, talkativeness, avatarUrl }
//   personas/*.json       { name, description }
//   lorebook.json         [ { label?, ownerCharacter?, visibility, keys, secondaryKeys,
//                             content, position, depth, insertionOrder, scanDepth,
//                             tokenBudget, enabled } ]
//   troupe.json           { name, outline?, toneDirective?, defaultPersona?, members? }
//   ownerCharacter / defaultPersona / members 按名称解析为本世界对象；
//   label 仅作可读注释，不会写入。
//
// 幂等：世界按 title 复用；角色/化身按 name 跳过；条目按 owner+content 全等跳过。
// 重复运行不会产生重复数据（已存在条目不会被更新——要改内容请先删掉旧条目）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedDir = path.resolve(
  process.argv[2] ?? path.join(rootDir, 'docs', 'books', 'narrow-gate', 'seed'),
);
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const AUTH = process.env.APP_PASSWORD
  ? `Basic ${Buffer.from(`director:${process.env.APP_PASSWORD}`).toString('base64')}`
  : null;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function api(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(AUTH ? { authorization: AUTH } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const hint =
      res.status === 401 && !AUTH
        ? '（服务端开了密码门，请设 APP_PASSWORD 环境变量）'
        : '';
    throw new Error(`${method} ${url} → ${res.status}: ${text} ${hint}`);
  }
  return data;
}

const skip = (what) => console.log(`  - 跳过（已存在）：${what}`);
const made = (what) => console.log(`  + 创建：${what}`);

async function main() {
  if (!fs.existsSync(path.join(seedDir, 'world.json'))) {
    throw new Error(`未找到 world.json：${seedDir}`);
  }
  try {
    await api('GET', '/api/health');
  } catch (err) {
    throw new Error(`连不上 ${BASE_URL}（先 pnpm dev 启动服务）：${err.message}`);
  }
  console.log(`[seed] 目标 ${BASE_URL}，目录 ${seedDir}`);

  // ---- 世界 ---------------------------------------------------------------
  const worldDef = readJson(path.join(seedDir, 'world.json'));
  const worlds = await api('GET', '/api/worlds');
  let world = worlds.find((w) => w.title === worldDef.title);
  if (world) {
    skip(`世界书「${world.title}」(${world.id})`);
  } else {
    world = await api('POST', '/api/worlds', {
      title: worldDef.title,
      premise: worldDef.premise,
    });
    made(`世界书「${world.title}」(${world.id})`);
  }

  // ---- 角色 ---------------------------------------------------------------
  const charsDir = path.join(seedDir, 'characters');
  const existing = await api('GET', `/api/worlds/${world.id}/characters`);
  const byName = new Map(existing.map((c) => [c.name, c]));
  if (fs.existsSync(charsDir)) {
    for (const file of fs.readdirSync(charsDir).filter((f) => f.endsWith('.json'))) {
      const def = readJson(path.join(charsDir, file));
      if (byName.has(def.name)) {
        skip(`角色 ${def.name}`);
        continue;
      }
      const c = await api('POST', `/api/worlds/${world.id}/characters`, {
        name: def.name,
        avatarUrl: def.avatarUrl,
        card: def.card,
        secrets: def.secrets,
        talkativeness: def.talkativeness,
      });
      byName.set(c.name, c);
      made(`角色 ${c.name} (${c.id})`);
    }
  }

  // ---- 化身 ---------------------------------------------------------------
  const personasDir = path.join(seedDir, 'personas');
  const existingPersonas = await api('GET', `/api/worlds/${world.id}/personas`);
  const personaByName = new Map(existingPersonas.map((p) => [p.name, p]));
  if (fs.existsSync(personasDir)) {
    for (const file of fs.readdirSync(personasDir).filter((f) => f.endsWith('.json'))) {
      const def = readJson(path.join(personasDir, file));
      if (personaByName.has(def.name)) {
        skip(`化身 ${def.name}`);
        continue;
      }
      const p = await api('POST', `/api/worlds/${world.id}/personas`, {
        name: def.name,
        description: def.description,
      });
      personaByName.set(p.name, p);
      made(`化身 ${p.name} (${p.id})`);
    }
  }

  // ---- 世界书条目 -----------------------------------------------------------
  const lorePath = path.join(seedDir, 'lorebook.json');
  if (fs.existsSync(lorePath)) {
    const entries = readJson(lorePath);
    const existingEntries = await api('GET', `/api/worlds/${world.id}/lorebook`);
    const has = (ownerType, ownerId, content) =>
      existingEntries.some(
        (e) => e.ownerType === ownerType && e.ownerId === ownerId && e.content === content,
      );
    for (const def of entries) {
      let ownerType = 'world';
      let ownerId;
      if (def.ownerCharacter) {
        const c = byName.get(def.ownerCharacter);
        if (!c) {
          throw new Error(
            `条目「${def.label ?? def.keys[0]}」引用不存在的角色：${def.ownerCharacter}`,
          );
        }
        ownerType = 'character';
        ownerId = c.id;
      }
      const label = def.label ?? def.keys?.[0] ?? def.content.slice(0, 12);
      if (has(ownerType, ownerId ?? world.id, def.content)) {
        skip(`条目「${label}」`);
        continue;
      }
      await api('POST', `/api/worlds/${world.id}/lorebook`, {
        ownerType,
        ownerId,
        visibility: def.visibility,
        keys: def.keys,
        secondaryKeys: def.secondaryKeys,
        content: def.content,
        position: def.position,
        depth: def.depth,
        insertionOrder: def.insertionOrder,
        scanDepth: def.scanDepth,
        tokenBudget: def.tokenBudget,
        enabled: def.enabled,
      });
      made(`条目「${label}」(${ownerType}${def.ownerCharacter ? `:${def.ownerCharacter}` : ''} / ${def.visibility ?? 'public'})`);
    }
  }

  // ---- 演出团队 -------------------------------------------------------------
  const troupePath = path.join(seedDir, 'troupe.json');
  if (fs.existsSync(troupePath)) {
    const def = readJson(troupePath);
    const troupes = await api('GET', `/api/troupes?worldId=${world.id}`);
    let troupe = troupes.find((t) => t.name === def.name);
    if (troupe) {
      skip(`团队「${troupe.name}」(${troupe.id})`);
    } else {
      let defaultPersonaId;
      if (def.defaultPersona) {
        const p = personaByName.get(def.defaultPersona);
        if (!p) throw new Error(`团队「${def.name}」引用不存在的化身：${def.defaultPersona}`);
        defaultPersonaId = p.id;
      }
      troupe = await api('POST', '/api/troupes', {
        worldId: world.id,
        name: def.name,
        outline: def.outline,
        toneDirective: def.toneDirective,
        defaultPersonaId,
      });
      made(`团队「${troupe.name}」(${troupe.id})`);
    }
    const members = await api('GET', `/api/troupes/${troupe.id}/members`);
    const memberIds = new Set(members.map((m) => m.characterId ?? m.character_id ?? m.id));
    for (const name of def.members ?? []) {
      const c = byName.get(name);
      if (!c) throw new Error(`团队「${def.name}」引用不存在的角色：${name}`);
      if (memberIds.has(c.id)) {
        skip(`成员 ${name}`);
        continue;
      }
      await api('POST', `/api/troupes/${troupe.id}/members`, { characterId: c.id });
      made(`成员 ${name}`);
    }
  }

  console.log('\n[seed] 完成。');
}

main().catch((err) => {
  console.error(`\n[seed] ✗ ${err.message}`);
  process.exitCode = 1;
});
