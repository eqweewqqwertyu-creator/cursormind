import { desktopCapturer, screen, nativeImage } from 'electron';

export interface ScreenShot {
  /** data URL（data:image/jpeg;base64,...） */
  dataUrl: string;
  /** 截图的像素尺寸（发送给模型时作为坐标系声明） */
  width: number;
  height: number;
  /** 屏幕逻辑尺寸（DIP，用于坐标换算） */
  screenWidth: number;
  screenHeight: number;
}

interface RawGrab {
  image: Electron.NativeImage;
  /** 实际图像像素尺寸（≈DIP 尺寸） */
  width: number;
  height: number;
  /** 屏幕 DIP 尺寸 */
  screenWidth: number;
  screenHeight: number;
}

/**
 * 底层捕获：返回原生 NativeImage（未编码）。
 * 供圈选等需要「在原始位图上裁剪」的调用方使用——避免 dataUrl 路径的
 * 全屏 JPEG 编码 → 解码 → 再编码 双重损耗（约省 100-200ms 且画质无损）。
 */
async function grabRaw(): Promise<RawGrab | null> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  // 按 DIP 尺寸取图（实测 1536×864 下模型估坐标精准；物理像素大图反而劣化估读）
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  if (!sources || sources.length === 0) return null;
  const primary =
    sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!primary) return null;
  const thumb = primary.thumbnail;
  if (thumb.isEmpty()) return null;
  const size = thumb.getSize();
  return {
    image: thumb,
    width: size.width,
    height: size.height,
    screenWidth: width,
    screenHeight: height,
  };
}

/**
 * 截取主屏幕。
 *
 * 性能要点（对标 heyClicky DXGI 常驻通道的等效优化）：
 * - JPEG 编码替代 PNG：1920×1080 的 PNG 编码约 600-900ms，JPEG q82 约 50-150ms；
 *   模型侧图片本就会缩到 ~800×800，JPEG 质量无感知损失。
 * - 缩略图按物理屏尺寸取，避免二次缩放。
 * - 启动时调一次 warmupCapture() 预热 GPU 捕获通道，首次提问不再承担初始化开销。
 * - 多屏时按 display_id 找主屏。
 */
const JPEG_QUALITY = 92;

export async function captureScreen(): Promise<ScreenShot | null> {
  try {
    const raw = await grabRaw();
    if (!raw) return null;
    const jpeg = raw.image.toJPEG(JPEG_QUALITY);
    return {
      dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      width: raw.width,
      height: raw.height,
      screenWidth: raw.screenWidth,
      screenHeight: raw.screenHeight,
    };
  } catch {
    return null;
  }
}

/**
 * 圈选区域截图：全屏原生位图 → 按 DIP rect 裁剪 → 裁剪图 JPEG 编码。
 * 与截图像素坐标同尺度（thumbnail 按 DIP 尺寸取图），小区域自动放大提升可读性。
 */
export async function captureRegionImage(rect: { x: number; y: number; width: number; height: number }): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const raw = await grabRaw();
    if (!raw) return null;
    const pad = 8;
    let x = Math.max(0, Math.floor(rect.x - pad));
    let y = Math.max(0, Math.floor(rect.y - pad));
    let w = Math.min(raw.width - x, Math.ceil(rect.width + pad * 2));
    let h = Math.min(raw.height - y, Math.ceil(rect.height + pad * 2));
    if (w < 4 || h < 4) return null;
    let img: Electron.NativeImage = raw.image.crop({ x, y, width: w, height: h });
    if (img.isEmpty()) return null;
    // 小区域放大提升模型可读性（vision 模型对小图分辨力有限）
    const maxSide = Math.max(w, h);
    if (maxSide < 280) {
      const k = Math.min(3, Math.ceil(280 / maxSide));
      img = img.resize({ width: w * k, height: h * k });
    }
    const outSize = img.getSize();
    const jpeg = img.toJPEG(JPEG_QUALITY);
    return {
      dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      width: outSize.width,
      height: outSize.height,
    };
  } catch {
    return null;
  }
}

/** 预热捕获通道（启动时调用；结果丢弃，只为把 GPU/编码路径热起来） */
export async function warmupCapture(): Promise<void> {
  try {
    await grabRaw();
  } catch { /* 预热失败不影响正式截图 */ }
}
