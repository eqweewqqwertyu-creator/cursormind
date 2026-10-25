import type { Rect } from '../shared/types';

/**
 * POINT 协议（借鉴 Clicky，MIT）：
 * 模型在回答末尾追加 [POINT:x,y:label] 标签，客户端解析后驱动精灵粗指路。
 * 只在无 CDP（纯视觉模式）时使用；有 CDP 时走像素级 DOM 矩形。
 */

export interface PointingParseResult {
  /** 剥离标签后的文本（用于回复条显示） */
  spokenText: string;
  /** 截图像素坐标；none / 无标签时为 null */
  coordinate: { x: number; y: number } | null;
  /** 元素短标签（如 "搜索框"）；none 时为 'none' */
  elementLabel: string | null;
}

// 只匹配末尾的标签；label 不含 ] : 空白；容忍 x , y 两侧空白
const POINT_PATTERN = /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?)\]\s*$/;

/** 解析回答末尾的 POINT 标签（Clicky 原版语义：尽力而为，无标签不报错） */
export function parsePointing(text: string): PointingParseResult {
  const t = (text || '').trim();
  const m = t.match(POINT_PATTERN);
  if (!m) {
    return { spokenText: t, coordinate: null, elementLabel: null };
  }
  const spokenText = t.slice(0, m.index).trim();
  if (m[1] === undefined || m[2] === undefined) {
    // [POINT:none]
    return { spokenText, coordinate: null, elementLabel: 'none' };
  }
  return {
    spokenText,
    coordinate: { x: parseInt(m[1], 10), y: parseInt(m[2], 10) },
    elementLabel: m[3] || null,
  };
}

/**
 * 截图像素坐标 → 屏幕 DIP 坐标。
 * screenshot 是 desktopCapturer 的缩略图，尺寸可能与屏幕物理/逻辑像素不同，
 * 按比例换算（Clicky 的坐标系自描述思路：坐标随图走，客户端负责换算）。
 */
export function mapImageToScreen(
  p: { x: number; y: number },
  imageSize: { width: number; height: number },
  screen: { width: number; height: number }
): { x: number; y: number } {
  const sx = Math.max(0, Math.min(p.x, imageSize.width));
  const sy = Math.max(0, Math.min(p.y, imageSize.height));
  return {
    x: Math.round((sx / imageSize.width) * screen.width),
    y: Math.round((sy / imageSize.height) * screen.height),
  };
}

/** 由坐标生成一个粗指路用的小矩形（精灵落点，不画大高亮框） */
export function pointToRect(p: { x: number; y: number }, size = 56): Rect {
  return { x: p.x - size / 2, y: p.y - size / 2, width: size, height: size };
}
