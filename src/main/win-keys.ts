/**
 * Win32 按键模拟（koffi 纯 JS FFI，零编译原生依赖）。
 * 只做一件事：模拟 Ctrl+C / Ctrl+X / Ctrl+V 组合键。
 * 注意：koffi 类型名是全局注册表，必须用 CM_ 前缀避免与其他模块/热重载冲突。
 */
import koffi from 'koffi';

// ---- 类型先注册（func 签名解析时注册表里必须已有类型名）----
const KEYBDINPUT = koffi.struct('CM_KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});
const CM_INPUT = koffi.struct('CM_INPUT', {
  type: 'uint32_t',
  ki: KEYBDINPUT,
});
const INPUT_SIZE = koffi.sizeof(CM_INPUT);

const user32 = koffi.load('user32.dll');
const SendInput = user32.func('uint32_t SendInput(uint32_t n, CM_INPUT *inputs, int32_t cb)');
const GetKeyState = user32.func('int16_t GetKeyState(int32_t)');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int32_t)');

/** ~ 键（VK_OEM_3，Esc 下方）是否物理按住：短/长按判定用异步键态 */
export function isTildeDown(): boolean {
  return (GetAsyncKeyState(0xc0) & 0x8000) !== 0;
}

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const VK_CONTROL = 0x11;
const VK_C = 0x43;
const VK_X = 0x58;
const VK_V = 0x56;

/** Ctrl 是否真实按住（用户手按着时不模拟，避免冲突） */
export function isCtrlDown(): boolean {
  return (GetKeyState(VK_CONTROL) & 0x8000) !== 0;
}

function input(vk: number, up: boolean) {
  return {
    type: INPUT_KEYBOARD,
    ki: {
      wVk: vk,
      wScan: 0,
      dwFlags: up ? KEYEVENTF_KEYUP : 0,
      time: 0,
      dwExtraInfo: 0,
    },
  };
}

/** 模拟 Ctrl+<key>（如 Ctrl+C）；返回 SendInput 注入的事件数 */
export function sendCtrlCombo(vk: number): number {
  const events = [input(VK_CONTROL, false), input(vk, false), input(vk, true), input(VK_CONTROL, true)];
  return SendInput(4, events, INPUT_SIZE);
}

export const VK = { C: VK_C, X: VK_X, V: VK_V };
