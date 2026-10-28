/**
 * 托盘图标：纯代码绘制 + 零依赖 PNG 编码（无外部图片资源）。
 * 视觉语言与界面一致——纯白液态玻璃球 + 橙色强调：
 *   idle：白玻璃球 + 橙色瞳点（"灵"的点睛）
 *   busy：球外圈橙色进度弧，4 帧旋转（暗示正在跑）
 * 在 128px 高清画布上绘制，再盒滤波降采样到目标尺寸（抗锯齿）。
 */
import * as zlib from 'zlib';

const HI = 128; // 高清画布边长

// ---------- PNG 编码（8bit RGBA） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------

interface P { x: number; y: number }

const ORANGE = { r: 255, g: 138, b: 60 }; // #FF8A3C 强调橙

/** source-over 混合一个像素（浮点画布，非预乘） */
function blend(buf: Float32Array, x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const i = (y * HI + x) * 4;
  const da = buf[i + 3];
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  buf[i] = (r * a + buf[i] * da * (1 - a)) / outA;
  buf[i + 1] = (g * a + buf[i + 1] * da * (1 - a)) / outA;
  buf[i + 2] = (b * a + buf[i + 2] * da * (1 - a)) / outA;
  buf[i + 3] = outA;
}

function blendDot(buf: Float32Array, cx: number, cy: number, rad: number, c: { r: number; g: number; b: number }, alpha: number): void {
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(HI - 1, Math.ceil(cy + rad)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(HI - 1, Math.ceil(cx + rad)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= rad) blend(buf, x, y, c.r, c.g, c.b, alpha);
    }
  }
}

/** 在高清画布上画一帧 */
function drawHi(kind: 'idle' | number): Float32Array {
  const buf = new Float32Array(HI * HI * 4);
  const c = HI / 2;
  const R = HI * 0.34; // 玻璃球半径

  // 球体：边缘微蓝白 → 左上高光纯白，外圈一道半透明深色描边（浅色任务栏保底可见）
  for (let y = 0; y < HI; y++) {
    for (let x = 0; x < HI; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (d > R) continue;
      const hl = Math.max(0, 1 - Math.hypot(x + 0.5 - (c - R * 0.35), y + 0.5 - (c - R * 0.42)) / (R * 1.25));
      const lerp = (a: number, b: number): number => a + (b - a) * hl;
      let r = lerp(212, 255);
      let g = lerp(226, 255);
      let b = lerp(243, 255);
      if (d >= R - 1.8) {
        // 描边：越靠外越实
        const e = (d - (R - 1.8)) / 1.8; // 0..1
        r = r + (98 - r) * e * 0.55;
        g = g + (116 - g) * e * 0.55;
        b = b + (146 - b) * e * 0.55;
      }
      blend(buf, x, y, r, g, b, 1);
    }
  }

  if (kind === 'idle') {
    // 瞳点：中心偏右下的橙色小点
    blendDot(buf, c + R * 0.16, c + R * 0.2, HI * 0.05, ORANGE, 0.95);
  } else {
    // 进度弧：120° 橙弧贴球外圈旋转（kind = 起始角度）
    const rr = HI * 0.42;
    const w2 = HI * 0.04;
    const start = (Number(kind) * Math.PI) / 2;
    const sweep = (120 * Math.PI) / 180;
    const arc = (ang: number): boolean => {
      let a = ang - start;
      while (a < 0) a += Math.PI * 2;
      return a <= sweep;
    };
    const capA: P = { x: c + rr * Math.cos(start), y: c + rr * Math.sin(start) };
    const capB: P = { x: c + rr * Math.cos(start + sweep), y: c + rr * Math.sin(start + sweep) };
    for (let y = 0; y < HI; y++) {
      for (let x = 0; x < HI; x++) {
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - rr) <= w2 && arc(Math.atan2(dy, dx))) {
          blend(buf, x, y, ORANGE.r, ORANGE.g, ORANGE.b, 0.95);
        }
      }
    }
    // 弧端圆帽
    blendDot(buf, capA.x, capA.y, w2, ORANGE, 0.95);
    blendDot(buf, capB.x, capB.y, w2, ORANGE, 0.95);
  }
  return buf;
}

/** 盒滤波降采样（预乘 alpha 平均，避免透明边缘泛白） */
function downscale(hi: Float32Array, size: number): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const f = HI / size;
  for (let ty = 0; ty < size; ty++) {
    const y0 = ty * f;
    const y1 = y0 + f;
    for (let tx = 0; tx < size; tx++) {
      const x0 = tx * f;
      const x1 = x0 + f;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = Math.floor(y0); y < Math.min(HI, Math.ceil(y1)); y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.min(HI, Math.ceil(x1)); x++) {
          const wx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * HI + x) * 4;
          const al = hi[i + 3];
          r += hi[i] * al * w;
          g += hi[i + 1] * al * w;
          b += hi[i + 2] * al * w;
          a += al * w;
        }
      }
      const o = (ty * size + tx) * 4;
      const area = f * f;
      const av = Math.min(1, a / area);
      if (a > 0) {
        out[o] = Math.max(0, Math.min(255, Math.round(r / a)));
        out[o + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
        out[o + 2] = Math.max(0, Math.min(255, Math.round(b / a)));
      }
      out[o + 3] = Math.round(av * 255);
    }
  }
  return out;
}

export type FrameKind = 'idle' | 0 | 1 | 2 | 3;

/** 渲染一帧并输出 PNG（size 为目标像素边长） */
export function renderFramePng(kind: FrameKind, size: number): Buffer {
  const hi = drawHi(kind === 'idle' ? 'idle' : Number(kind));
  return encodePng(size, size, downscale(hi, size));
}
