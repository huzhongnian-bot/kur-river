// 剧目大纲思维导图（mind-elixir）：拖拽 / 缩放 / 收起 / 双击编辑 / 右键增删。
// outline JSONB（{summary, relationshipMeter?, acts:[{key,title,beats[]}]}）与
// mind-elixir nodeData 双向转换；纯文本大纲按"空行分段 + 幕标题识别"降级解析，
// 保存时统一写成结构化 JSON。编辑结果通过 onChange 回传 JSON 字符串（复用既有保存链路）。
'use client';

import { useEffect, useRef } from 'react';
import type { MindElixirInstance, NodeObj } from 'mind-elixir';
import 'mind-elixir/style.css';

export interface OutlineAct {
  key?: string;
  title?: string;
  beats?: string[];
}

export interface OutlineDoc {
  summary?: string;
  relationshipMeter?: string;
  acts?: OutlineAct[];
}

/** 幕标题识别：第X幕/章/回/部、【…】、markdown 标题 */
const ACT_HEADING = /^(第\S{1,4}[幕章回部]|【[^】]+】|#{1,3}\s)/;
const SUMMARY_PREFIX = '总览：';
const METER_PREFIX = '关系计量：';

/** 纯文本大纲降级解析：空行分段；幕标题开新幕，其余归入当前幕的 beats，开头无标题部分作 summary */
function fromText(text: string): OutlineDoc | null {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return null;
  const doc: OutlineDoc = {};
  const acts: OutlineAct[] = [];
  const summaryParts: string[] = [];
  let current: OutlineAct | null = null;
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ACT_HEADING.test(lines[0])) {
      current = { title: lines[0], beats: lines.slice(1) };
      acts.push(current);
    } else if (current) {
      current.beats!.push(...lines);
    } else {
      summaryParts.push(block);
    }
  }
  if (acts.length > 0) doc.acts = acts;
  if (summaryParts.length > 0) doc.summary = summaryParts.join('\n\n');
  return doc;
}

/** outline 可能是对象、JSON 字符串或纯文本；完全为空时返回 null */
export function parseOutline(outline: unknown): OutlineDoc | null {
  let v = outline;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    const text = v;
    try {
      v = JSON.parse(text);
    } catch {
      return fromText(text);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const doc = v as OutlineDoc;
  if (!Array.isArray(doc.acts) && !doc.summary) return null;
  return doc;
}

// ---- outline ↔ mind-elixir nodeData ----

function outlineToNodeData(doc: OutlineDoc | null): NodeObj {
  const children: NodeObj[] = [];
  if (doc?.summary) {
    children.push({ id: 'meta-summary', topic: SUMMARY_PREFIX + doc.summary });
  }
  if (doc?.relationshipMeter) {
    children.push({ id: 'meta-meter', topic: METER_PREFIX + doc.relationshipMeter });
  }
  for (const [i, act] of (doc?.acts ?? []).entries()) {
    children.push({
      id: `act-${i}`,
      topic: act.title ?? act.key ?? `第 ${i + 1} 幕`,
      children: (act.beats ?? []).map((b, j) => ({ id: `act-${i}-beat-${j}`, topic: b })),
    });
  }
  return { id: 'root', topic: '剧目大纲', root: true, children } as NodeObj;
}

function nodeDataToOutline(root: NodeObj): OutlineDoc {
  const doc: OutlineDoc = { acts: [] };
  for (const child of root.children ?? []) {
    if (child.topic.startsWith(SUMMARY_PREFIX)) {
      doc.summary = child.topic.slice(SUMMARY_PREFIX.length);
    } else if (child.topic.startsWith(METER_PREFIX)) {
      doc.relationshipMeter = child.topic.slice(METER_PREFIX.length);
    } else {
      doc.acts!.push({
        title: child.topic,
        beats: (child.children ?? []).map((b) => b.topic),
      });
    }
  }
  if (!doc.summary) delete doc.summary;
  if (!doc.relationshipMeter) delete doc.relationshipMeter;
  return doc;
}

/** 只在这些操作后回写（beginEdit / reshapeNode 等不改数据的不触发） */
const DATA_OPS = new Set([
  'addChild',
  'insertSibling',
  'insertParent',
  'removeNodes',
  'finishEdit',
  'moveNodeIn',
  'moveNodeAfter',
  'moveNodeBefore',
  'copyNode',
]);

export function OutlineMap({
  outline,
  onChange,
}: {
  outline: unknown;
  /** 导图内容变化时回传 outline JSON 字符串（用于复用保存链路） */
  onChange?: (json: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // onChange 每次渲染都变，用 ref 防止 effect 重跑重建导图
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let disposed = false;
    let mind: MindElixirInstance | null = null;
    (async () => {
      const [{ default: MindElixir }, { zh_CN }] = await Promise.all([
        import('mind-elixir'),
        import('mind-elixir/i18n'),
      ]);
      if (disposed || !containerRef.current) return;
      mind = new MindElixir({
        el: containerRef.current,
        direction: 1, // 右侧树
        editable: true,
        contextMenu: { locale: zh_CN },
        toolBar: true,
        keypress: true,
        allowUndo: true,
      });
      mind.init({ nodeData: outlineToNodeData(parseOutline(outline)) });
      // 初始视野适配：内容常宽于容器，缩放到全图可见
      requestAnimationFrame(() => mind?.scaleFit());
      mind.bus.addListener('operation', (op) => {
        if (!DATA_OPS.has(op.name) || !mind) return;
        onChangeRef.current?.(
          JSON.stringify(nodeDataToOutline(mind.getData().nodeData), null, 2),
        );
      });
    })();
    return () => {
      disposed = true;
      mind?.destroy();
    };
    // 只在挂载时初始化一次；outline 最新值通过 JSON 视图切换时的重挂载生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div
        ref={containerRef}
        className="h-[520px] w-full overflow-hidden rounded-lg border border-border bg-card"
      />
      <p className="mt-1 text-xs text-muted-foreground">
        拖拽移动节点 · 双击编辑文字 · 右键增删 · 滚轮缩放 · 点节点圆点收起子树；改动点"保存"生效
      </p>
    </div>
  );
}
