import type { Feature } from '../shared/types';

// 知识库：M0 只承诺 5~10 个高频功能。
// Chrome 条目先做，Blender 条目阶段 2 用。
export const features: Feature[] = [
  {
    id: 'github_settings',
    names: ['设置', 'settings', '仓库设置', '改可见性', '可见性', '改名'],
    app: 'chrome',
    bubble: '先点这儿',
    locate: {
      kind: 'selector',
      // data-tab-item 是 GitHub 仓库 tab 的稳定属性，优先用它，避免误匹配营销页链接
      selector: '[data-tab-item="settings"], #settings-tab',
    },
  },
  {
    id: 'github_new_repo',
    names: ['新建仓库', 'new repository', '建仓库', 'create repo'],
    app: 'chrome',
    bubble: '点这个新建仓库',
    locate: { kind: 'selector', selector: 'a[href="/new"]' },
  },
  {
    id: 'github_issues',
    names: ['issues', '议题', 'issue'],
    app: 'chrome',
    bubble: '在这看 issues',
    locate: { kind: 'selector', selector: '[data-tab-item="issues"], #issues-tab' },
  },
  {
    id: 'blender_loop_cut',
    names: ['环切', 'loop cut', '加一圈边', '圈边'],
    app: 'blender',
    requires_mode: 'EDIT',
    shortcut: 'Ctrl+R',
    search_keyword: 'Loop Cut',
    bubble: '先 Tab 进编辑模式，再 Ctrl+R',
    prereq: ['enter_edit_mode'],
  },
  {
    id: 'blender_bevel',
    names: ['倒角', 'bevel', '切角'],
    app: 'blender',
    requires_mode: 'EDIT',
    shortcut: 'Ctrl+B',
    search_keyword: 'Bevel',
    bubble: '编辑模式下 Ctrl+B，再滚轮调段数',
  },
  {
    id: 'blender_material',
    names: ['材质', 'material', '材质面板'],
    app: 'blender',
    bubble: '看右侧属性面板的材质标签',
    locate: { kind: 'region_offset', region: 'PROPERTIES', offset: { x: 0, y: 0 } },
  },
];
