// 手写请求校验（不引 zod）：全部返回类型化值或抛 400。
import { badRequest } from './http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** 路径参数里的 id 统一过这道，避免非法 UUID 打到 pg 层变成 500 */
export function pathUuid(value: string, name = 'id'): string {
  if (!isUuid(value)) throw badRequest(`路径参数 ${name} 不是合法 UUID：${value}`);
  return value;
}

export function reqString(body: Record<string, unknown>, key: string, maxLen = 10_000): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw badRequest(`字段 ${key} 必填且必须是非空字符串`);
  }
  if (v.length > maxLen) throw badRequest(`字段 ${key} 超长（>${maxLen} 字符）`);
  return v;
}

/** 可选字符串：undefined 不带该字段；null/'' 归一为 null（用于可空列的清空） */
export function optString(
  body: Record<string, unknown>,
  key: string,
  maxLen = 100_000,
): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`字段 ${key} 必须是字符串`);
  if (v.length > maxLen) throw badRequest(`字段 ${key} 超长（>${maxLen} 字符）`);
  return v;
}

export function reqUuid(body: Record<string, unknown>, key: string): string {
  const v = reqString(body, key, 64);
  if (!isUuid(v)) throw badRequest(`字段 ${key} 不是合法 UUID：${v}`);
  return v;
}

export function optUuid(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const v = optString(body, key, 64);
  if (v === undefined || v === null) return v;
  if (!isUuid(v)) throw badRequest(`字段 ${key} 不是合法 UUID：${v}`);
  return v;
}

export function optNumber(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || Number.isNaN(v)) throw badRequest(`字段 ${key} 必须是数字`);
  if (opts.int && !Number.isInteger(v)) throw badRequest(`字段 ${key} 必须是整数`);
  if (opts.min !== undefined && v < opts.min) throw badRequest(`字段 ${key} 不能小于 ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw badRequest(`字段 ${key} 不能大于 ${opts.max}`);
  return v;
}

export function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`字段 ${key} 必须是布尔值`);
  return v;
}

/** 逗号分隔字符串或字符串数组 → string[]；undefined 表示未提供 */
export function optStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw badRequest(`字段 ${key} 必须是字符串数组或逗号分隔字符串`);
}

/** JSONB 载荷（premise/outline/scene/secrets 等）：对象/数组/字符串原样透传 */
export function optJson(body: Record<string, unknown>, key: string): unknown {
  return body[key];
}

export function optEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw badRequest(`字段 ${key} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return v as T;
}
