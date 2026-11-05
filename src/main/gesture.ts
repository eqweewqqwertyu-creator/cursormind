/**
 * 鼠标画圈手势判定（纯函数，零 Electron 依赖——可用 node 直接单测）。
 *
 * 「真圈」与普通拖动的区分（四重条件，缺一不可）：
 *   1. 时长窗口 150ms~4000ms：太短是抖动，太长不是一次手势
 *   2. 路径足够长（≥280px）且包围盒 ≥50×50：圈要有实际大小
 *   3. 闭合：起终点距离 ≤ 路径总长 25%（拖文件到远处不闭合）
 *   4. 累计转角 |Σθ| ≥ 270°（相对质心）：直线往返的正负转角相互抵消，
 *      只有真正绕一圈才会累计出 ~360°——这是区分「划一大圈」和
 *      「划选文字/拖动往返」的决定性指标
 *
 * 只观察不拦截：判定发生在鼠标抬起之后，画圈拖动的副作用（如桌面图标
 * 被拖动）属于用户自己的操作，灵标不干扰（v1 已知限制，见讨论记录）。
 */

export interface TrailPoint {
  x: number;
  y: number;
  /** 相对时间戳（ms，同一时基即可，钩子里用系统 time 字段） */
  t: number;
}

export interface TrailBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CircleVerdict {
  closed: boolean;
  /** 判定失败原因（日志/调试用） */
  reason?: string;
  /** 累计转角（度，带方向） */
  totalAngleDeg?: number;
  /** 路径总长 px */
  pathLength?: number;
}

const MIN_POINTS = 16;        // 采样点下限（3px 间距采样下约 50px 路径）
const MIN_PATH_LEN = 280;     // 路径总长下限 px
const MIN_BOX = 50;           // 包围盒最小边 px
const CLOSE_RATIO = 0.25;     // 起终点距离 / 路径总长 的闭合阈值
const MIN_ANGLE_DEG = 270;    // 累计转角下限（一整圈约 360°）
const DUR_MIN = 150;          // 时长下限 ms
const DUR_MAX = 4000;         // 时长上限 ms

/** 轨迹包围盒 */
export function trailBox(pts: TrailPoint[]): TrailBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 路径总长 */
export function trailLength(pts: TrailPoint[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

/** 归一化角度到 (-π, π] */
function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

function clampNum(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 按弧长均匀重采样（方向检测的抗噪预处理：粗尺度上噪声被平均掉） */
function resampleByDistance(pts: TrailPoint[], step: number): TrailPoint[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const out: TrailPoint[] = [pts[0]];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    let d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    while (acc + d >= step) {
      const r = (step - acc) / d;
      const nx = prev.x + (cur.x - prev.x) * r;
      const ny = prev.y + (cur.y - prev.y) * r;
      out.push({ x: nx, y: ny, t: cur.t });
      prev = { x: nx, y: ny, t: cur.t };
      d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  if (out.length < 2) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * 判定轨迹是否为「画圈」手势。
 * @param pts 已按 3px 间距采样的轨迹（物理或 DIP 坐标均可，阈值按 DIP 校准）
 */
export function isCircleGesture(pts: TrailPoint[]): CircleVerdict {
  if (pts.length < MIN_POINTS) return { closed: false, reason: '点数不足' };

  const duration = pts[pts.length - 1].t - pts[0].t;
  if (duration < DUR_MIN) return { closed: false, reason: '时长过短(' + duration + 'ms)' };
  if (duration > DUR_MAX) return { closed: false, reason: '时长过长(' + duration + 'ms)' };

  const pathLength = trailLength(pts);
  if (pathLength < MIN_PATH_LEN) {
    return { closed: false, reason: '路径太短', pathLength };
  }

  const box = trailBox(pts);
  if (box.width < MIN_BOX || box.height < MIN_BOX) {
    return { closed: false, reason: '包围盒太小(' + Math.round(box.width) + 'x' + Math.round(box.height) + ')' };
  }

  // 闭合判定：起终点距离相对路径总长
  const startEnd = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
  if (startEnd > pathLength * CLOSE_RATIO) {
    return { closed: false, reason: '不闭合', pathLength };
  }

  // 防护 A：路径方向突变计数（矩形框选/折线多边形）。
  // 关键：不能在原始 3px 采样上检测——那个尺度上真人手抖的方向噪声就有
  // 30°+，会把平滑圈误判成折线。先按弧长重采样成粗轨迹（自适应步长），
  // 再检测方向突变；并补检首尾衔接角（矩形第 4 个角恰在闭合处）。
  const coarse = resampleByDistance(pts, clampNum(pathLength / 40, 18, 40));
  const DIR_CHANGE_RAD = 0.7; // 单步方向变化 >40° 记一次突变（矩形角 90° 稳拒，手绘噪声稳过）
  let dirChanges = 0;
  let prevDir: number | null = null;
  for (let i = 1; i < coarse.length; i++) {
    const dir = Math.atan2(coarse[i].y - coarse[i - 1].y, coarse[i].x - coarse[i - 1].x);
    if (prevDir !== null) {
      const dd = normAngle(dir - prevDir);
      if (Math.abs(dd) > DIR_CHANGE_RAD) dirChanges++;
    }
    prevDir = dir;
  }
  // 首尾衔接角：最后一步方向 vs 第一步方向（闭合轨迹的第 n 个拐角）
  if (coarse.length >= 3) {
    const firstDir = Math.atan2(coarse[1].y - coarse[0].y, coarse[1].x - coarse[0].x);
    const lastDir = Math.atan2(
      coarse[coarse.length - 1].y - coarse[coarse.length - 2].y,
      coarse[coarse.length - 1].x - coarse[coarse.length - 2].x
    );
    if (Math.abs(normAngle(firstDir - lastDir)) > DIR_CHANGE_RAD) dirChanges++;
  }
  if (dirChanges >= 4) {
    return { closed: false, reason: '折线多边形(' + dirChanges + '次方向突变)', pathLength };
  }

  // 防护 B + 累计转角：轨迹各点相对质心的极角变化总和。
  // 坑：直线往返会两次穿过质心，极角各跳变 180°（假转角），不加防护会被
  // 误判成圈。防护：单步跳变 >90° 视为穿质心，不计入平滑累计。
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length;
  cy /= pts.length;
  let total = 0;
  let prev = Math.atan2(pts[0].y - cy, pts[0].x - cx);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - cy, pts[i].x - cx);
    const d = normAngle(a - prev);
    if (Math.abs(d) <= Math.PI / 2) {
      total += d;
    }
    prev = a;
  }
  const totalDeg = (total * 180) / Math.PI;
  if (Math.abs(totalDeg) < MIN_ANGLE_DEG) {
    return { closed: false, reason: '转角不足(' + Math.round(totalDeg) + '°)', pathLength, totalAngleDeg: totalDeg };
  }

  return { closed: true, totalAngleDeg: totalDeg, pathLength };
}

/**
 * 轨迹压缩：等距重采样到 max 点以内（给渲染层画笔迹用，避免 IPC 大数组）。
 * 保留首尾点；max<=0 或点数已少时原样返回。
 */
export function simplifyTrail(pts: TrailPoint[], max: number): Array<{ x: number; y: number }> {
  if (max <= 0 || pts.length <= max) return pts.map((p) => ({ x: p.x, y: p.y }));
  const step = (pts.length - 1) / (max - 1);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < max; i++) {
    const p = pts[Math.round(i * step)];
    out.push({ x: p.x, y: p.y });
  }
  return out;
}
