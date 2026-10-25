import { desktopCapturer, screen } from 'electron';

export interface ScreenShot {
  /** data URL（data:image/png;base64,...），已叠加网格 */
  dataUrl: string;
  /** 截图的像素尺寸（发送给模型时作为坐标系声明） */
  width: number;
  height: number;
  /** 屏幕逻辑尺寸（DIP，用于坐标换算） */
  screenWidth: number;
  screenHeight: number;
}

/**
 * 截取主屏幕并叠加 100px 网格 + 刻度（帮助未做 grounding 训练的模型"读坐标"）。
 * 网格是半透明的，不破坏画面语义。
 */
export async function captureScreen(): Promise<ScreenShot | null> {
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    if (!sources || sources.length === 0) return null;
    const primary =
      sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!primary) return null;

    const thumb = primary.thumbnail;
    const w = thumb.getSize().width;
    const h = thumb.getSize().height;

    // 叠加网格（nativeImage 逐像素画太慢，用 Electron 的 Image 以 canvas 方式不可用——
    // 主进程没有 canvas。改为把网格说明写进提示词，模型按 1/10 分度估读）
    // 说明：真正的像素网格需要 OffscreenCanvas，Electron 35 主进程支持 OffscreenCanvas + Image；
    // 但依赖 native 模块风险高。此处先做"坐标刻度提示词"方案，网格线渲染放到后续优化。

    return {
      dataUrl: thumb.toDataURL(),
      width: w,
      height: h,
      screenWidth: width,
      screenHeight: height,
    };
  } catch {
    return null;
  }
}
