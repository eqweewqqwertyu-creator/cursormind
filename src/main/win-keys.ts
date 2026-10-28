/**
 * Win32 按键模拟（koffi 纯 JS FFI，零编译原生依赖）。
 * 模拟编辑类按键：Ctrl+C/X/V/A/Z/Y 组合键与 Delete 单键。
 *
 * 为什么用 keybd_event 而不是 SendInput：
 *   SendInput 需要手写 INPUT 结构，而 INPUT 的 union 必须按最大的 MOUSEINPUT(32B) 对齐，
 *   即 x64 下 sizeof(INPUT)=40。之前 struct 只定义 KEYBDINPUT，sizeof 被算成 32，
 *   cbSize 传错导致 SendInput 每次失败（返回 0）——这就是历史「注入无效」悬案的根因。
 *   keybd_event 是 4 个标量参数、无结构体，由系统内部正确处理 INPUT，绕开这个坑。
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const keybd_event = user32.func(
  'void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
);
const GetKeyState = user32.func('int16_t GetKeyState(int32_t)');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int32_t)');

/** ~ 键（VK_OEM_3，Esc 下方）是否物理按住：短/长按判定用异步键态 */
export function isTildeDown(): boolean {
  return (GetAsyncKeyState(0xc0) & 0x8000) !== 0;
}

const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_C = 0x43;
const VK_X = 0x58;
const VK_V = 0x56;
const VK_A = 0x41;
const VK_Z = 0x5A;
const VK_Y = 0x59;
const VK_DELETE = 0x2E;

/** Ctrl 是否真实按住（用户手按着时不模拟，避免冲突） */
export function isCtrlDown(): boolean {
  return (GetKeyState(VK_CONTROL) & 0x8000) !== 0;
}

/** 模拟 Ctrl+<key>（如 Ctrl+C）：按下 Ctrl → 按下 key → 抬起 key → 抬起 Ctrl */
export function sendCtrlCombo(vk: number): void {
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(vk, 0, 0, 0);
  keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
}

/** 模拟无修饰单键（如 Delete）：按下 → 抬起 */
export function sendKey(vk: number): void {
  keybd_event(vk, 0, 0, 0);
  keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
}

export const VK = { C: VK_C, X: VK_X, V: VK_V, A: VK_A, Z: VK_Z, Y: VK_Y, DEL: VK_DELETE };
