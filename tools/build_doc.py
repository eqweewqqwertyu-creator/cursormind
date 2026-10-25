# -*- coding: utf-8 -*-
"""生成《光标精灵 · 项目概述 v1.4》Word 文档（含架构图）。"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROOT = r"C:\Users\eqwee\Desktop\鼠标伴侣"
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

# ---------------- 配色 ----------------
INK = RGBColor(0x1A, 0x1A, 0x1A)
NAVY = RGBColor(0x1F, 0x2A, 0x66)
BLUE = RGBColor(0x2A, 0x3B, 0x8F)
ORANGE = RGBColor(0xF9, 0x73, 0x16)
GRAY = RGBColor(0x59, 0x59, 0x59)
LGRAY = RGBColor(0x8C, 0x8C, 0x8C)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

HEX_BLUE = "2A3B8F"
HEX_ORANGE = "F97316"
HEX_ZEBRA = "F4F6FD"
HEX_CODE_BG = "F6F8FA"
HEX_NOTE = "FFF7ED"
HEX_NOTE_OK = "EEF6FF"

HEAD_FONT = "微软雅黑"
BODY_FONT = "宋体"
MONO_FONT = "Consolas"


# ---------------- 架构图 ----------------
def build_diagram(path):
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei"]
    plt.rcParams["axes.unicode_minus"] = False
    fig, ax = plt.subplots(figsize=(9.8, 5.5), dpi=220)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    def box(x, y, w, h, title, sub, fc, ec, ts=11.5, ss=8.8, dashed=False):
        ax.add_patch(FancyBboxPatch(
            (x, y), w, h, boxstyle="round,pad=0.5,rounding_size=1.8",
            linewidth=1.5, facecolor=fc, edgecolor=ec, zorder=2,
            linestyle=(0, (4, 3)) if dashed else "solid"))
        ax.text(x + w / 2, y + h * 0.665, title, ha="center", va="center",
                fontsize=ts, color="#1A1A1A", fontweight="bold", zorder=3)
        ax.text(x + w / 2, y + h * 0.285, sub, ha="center", va="center",
                fontsize=ss, color="#404040", zorder=3, linespacing=1.55)

    def arrow(p1, p2, two_way=False):
        ax.add_patch(FancyArrowPatch(
            p1, p2, arrowstyle="<|-|>" if two_way else "-|>",
            mutation_scale=15, linewidth=1.4, color="#2A3B8F",
            shrinkA=0, shrinkB=0, zorder=1))

    box(5, 79, 90, 15, "覆盖层（Electron 透明置顶 · 点击穿透 · 不抢焦点）",
        "假箭头精灵（飞行 / 眨眼）· 高亮圈 · 气泡 · 圈选框 · 提问面板", "#EAF0FF", "#2A3B8F")
    box(5, 55, 90, 16, "主进程（大脑）  deepseek-flash",
        "热键 → 截屏 / 裁剪 → 意图理解 → 知识库检索 → 引导状态机\n→ 下发指引 → 等待确认 → 下一步",
        "#FFF1E8", "#F97316")
    box(5, 28, 27, 17, "Chrome 适配器", "CDP 读 DOM 矩形\nURL · 元素树 · 事件", "#E8F7F0", "#0E9F6E")
    box(36.5, 28, 27, 17, "Blender 适配器", "addon 上报 region 矩形\n版本 · 模式 · 操作事件", "#E8F7F0", "#0E9F6E")
    box(68, 28, 27, 17, "视觉（仅做语义）", "裁剪图 → 这是什么 / 状态变没变\n≈0.0008 元 / 张", "#F3F0FF", "#6B46C1")
    box(5, 7, 90, 11, "", "截图 diff（本地像素比对，免费）· 适配器上报事件（用户点了什么）",
        "#FAFAFA", "#B0B0B0", ss=8.8, dashed=True)

    arrow((50, 78.4), (50, 71.6))
    ax.text(51.6, 75.2, "IPC：指令下发 / 事件回传", fontsize=8, color="#2A3B8F", va="center")
    arrow((18.5, 54.4), (18.5, 45.6), two_way=True)
    arrow((50, 54.4), (50, 45.6), two_way=True)
    arrow((81.5, 54.4), (81.5, 45.6), two_way=True)

    fig.savefig(path, bbox_inches="tight", pad_inches=0.18, facecolor="white")
    plt.close(fig)


# ---------------- Word 基础工具 ----------------
def run_font(run, name=BODY_FONT, size=10.5, bold=False, color=INK, mono=False):
    fname = MONO_FONT if mono else name
    run.font.name = fname
    run._element.get_or_add_rPr()
    rfonts = run._element.rPr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        run._element.rPr.append(rfonts)
    rfonts.set(qn("w:ascii"), fname)
    rfonts.set(qn("w:hAnsi"), fname)
    rfonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = color


def shade(el_pr, hex_color):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    el_pr.append(shd)


def cell_shade(cell, hex_color):
    shade(cell._tc.get_or_add_tcPr(), hex_color)


def para_border(par, edge="bottom", color=HEX_ORANGE, size=12, space=2):
    pPr = par._p.get_or_add_pPr()
    pbdr = pPr.find(qn("w:pBdr"))
    if pbdr is None:
        pbdr = OxmlElement("w:pBdr")
        pPr.append(pbdr)
    el = OxmlElement("w:" + edge)
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), color)
    pbdr.append(el)


def table_borders(table, color="D6DCF0", size=4):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    tblPr.append(borders)


def cell_margins(table, top=70, bottom=70, left=100, right=100):
    tblPr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for edge, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblPr.append(mar)


def row_cant_split(row):
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:cantSplit")
    trPr.append(el)


def row_header(row):
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    trPr.append(el)

def add_field(par, instr):
    run = par.add_run()
    f1 = OxmlElement("w:fldChar"); f1.set(qn("w:fldCharType"), "begin")
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr
    f2 = OxmlElement("w:fldChar"); f2.set(qn("w:fldCharType"), "separate")
    t = OxmlElement("w:t"); t.text = "1"
    f3 = OxmlElement("w:fldChar"); f3.set(qn("w:fldCharType"), "end")
    for el in (f1, it, f2, t, f3):
        run._r.append(el)


# ---------------- 文档级构件 ----------------
def h1(doc, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(18)
    pf.space_after = Pt(9)
    pf.keep_with_next = True
    run_font(p.add_run(text), HEAD_FONT, 16, True, NAVY)
    para_border(p, "bottom", HEX_ORANGE, 12, 4)
    return p


def h2(doc, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(12)
    pf.space_after = Pt(5)
    pf.keep_with_next = True
    run_font(p.add_run(text), HEAD_FONT, 12, True, BLUE)
    return p


def h3(doc, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(8)
    pf.space_after = Pt(3)
    pf.keep_with_next = True
    run_font(p.add_run(text), HEAD_FONT, 10.5, True, RGBColor(0x33, 0x33, 0x33))
    return p


def para(doc, text, size=10.5, color=INK, bold=False, first_indent=0, space_after=4,
         align=WD_ALIGN_PARAGRAPH.JUSTIFY, line=1.45, keep_next=False):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(space_after)
    pf.line_spacing = line
    pf.alignment = align
    pf.keep_with_next = keep_next
    if first_indent:
        pf.first_line_indent = Cm(first_indent)
    run_font(p.add_run(text), BODY_FONT, size, bold, color)
    return p


def rich(doc, segments, size=10.5, line=1.45, space_after=4, indent=0.0,
         align=WD_ALIGN_PARAGRAPH.JUSTIFY):
    """segments: list of (text, bold, color)"""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_after = Pt(space_after)
    pf.line_spacing = line
    pf.alignment = align
    if indent:
        pf.left_indent = Cm(indent)
    for seg in segments:
        text = seg[0]
        b = seg[1] if len(seg) > 1 else False
        c = seg[2] if len(seg) > 2 else INK
        run_font(p.add_run(text), BODY_FONT, size, b, c)
    return p


def bullet(doc, text, size=10.5, mark="•", space_after=2):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.62)
    pf.first_line_indent = Cm(-0.62)
    pf.space_after = Pt(space_after)
    pf.line_spacing = 1.4
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run_font(p.add_run(mark + " "), HEAD_FONT, size, False, ORANGE)
    run_font(p.add_run(text), BODY_FONT, size, False, INK)
    return p


def numbered(doc, idx, text, size=10.5, space_after=2):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.85)
    pf.first_line_indent = Cm(-0.85)
    pf.space_after = Pt(space_after)
    pf.line_spacing = 1.4
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run_font(p.add_run("%d  " % idx), HEAD_FONT, size, True, BLUE)
    run_font(p.add_run(text), BODY_FONT, size, False, INK)
    return p


def code_block(doc, lines, size=8.6):
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    cell_shade(cell, HEX_CODE_BG)
    table_borders(tbl, "E3E6EA", 4)
    cell_margins(tbl, 120, 120, 160, 120)
    cell.text = ""
    first = True
    for ln in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        pf = p.paragraph_format
        pf.space_after = Pt(0)
        pf.space_before = Pt(0)
        pf.line_spacing = 1.15
        run_font(p.add_run(ln if ln else " "), BODY_FONT, size, False,
                 RGBColor(0x24, 0x29, 0x2E), mono=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def callout(doc, title, body, fill=HEX_NOTE, edge=HEX_ORANGE):
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    cell_shade(cell, fill)
    table_borders(tbl, edge, 4)
    cell_margins(tbl, 110, 110, 150, 150)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.line_spacing = 1.35
    run_font(p.add_run(title), HEAD_FONT, 9.8, True, ORANGE)
    p2 = cell.add_paragraph()
    p2.paragraph_format.space_after = Pt(0)
    p2.paragraph_format.line_spacing = 1.4
    p2.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run_font(p2.add_run(body), BODY_FONT, 9.6, False, RGBColor(0x33, 0x33, 0x33))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def add_table(doc, headers, rows, widths, font=9, header=True, zebra=True,
              first_col_bold=False, align_right_cols=()):
    cols = len(widths)
    tbl = doc.add_table(rows=0, cols=cols)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False
    table_borders(tbl)
    cell_margins(tbl, 70, 70, 100, 100)

    def fill_row(values, is_header, idx):
        row = tbl.add_row()
        row_cant_split(row)
        if is_header:
            row_header(row)
        for j, val in enumerate(values):
            cell = row.cells[j]
            cell.width = Cm(widths[j])
            cell.text = ""
            p = cell.paragraphs[0]
            pf = p.paragraph_format
            pf.space_after = Pt(0)
            pf.space_before = Pt(0)
            pf.line_spacing = 1.28
            pf.alignment = (WD_ALIGN_PARAGRAPH.CENTER if (is_header or j in align_right_cols)
                            else WD_ALIGN_PARAGRAPH.LEFT)
            if is_header:
                cell_shade(cell, HEX_BLUE)
                run_font(p.add_run(str(val)), HEAD_FONT, font, True, WHITE)
            else:
                if zebra and idx % 2 == 1:
                    cell_shade(cell, HEX_ZEBRA)
                bold = first_col_bold and j == 0
                color = BLUE if bold else INK
                text = str(val)
                chunks = text.split("\n")
                for k, ch in enumerate(chunks):
                    if k:
                        p.add_run().add_break()
                    run_font(p.add_run(ch), HEAD_FONT if bold else BODY_FONT,
                             font, bold, color)

    if header:
        fill_row(headers, True, 0)
        start = 0
    else:
        start = 0
    for i, r in enumerate(rows):
        fill_row(r, False, start + i)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return tbl


# ---------------- 构文档 ----------------
def build():
    arch = os.path.join(ASSETS, "arch.png")
    build_diagram(arch)

    doc = Document()

    # 默认样式
    style = doc.styles["Normal"]
    style.font.name = BODY_FONT
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)

    sec = doc.sections[0]
    sec.page_width = Cm(21)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.1)
    sec.bottom_margin = Cm(1.8)
    sec.left_margin = Cm(2.4)
    sec.right_margin = Cm(2.2)
    sec.different_first_page_header_footer = True

    # 页眉
    hp = sec.header.paragraphs[0]
    hp.paragraph_format.tab_stops.add_tab_stop(Cm(16.2), WD_TAB_ALIGNMENT.RIGHT)
    run_font(hp.add_run("光标精灵 · 项目概述"), HEAD_FONT, 8, False, LGRAY)
    run_font(hp.add_run("\tv1.4"), HEAD_FONT, 8, False, LGRAY)
    para_border(hp, "bottom", "D6DCF0", 6, 2)

    # 页脚
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run_font(fp.add_run("—  "), HEAD_FONT, 8.5, False, LGRAY)
    add_field(fp, "PAGE")
    run_font(fp.add_run("  —"), HEAD_FONT, 8.5, False, LGRAY)

    # ===== 封面 =====
    for _ in range(2):
        doc.add_paragraph()

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    run_font(p.add_run("项 目 立 项 文 档"), HEAD_FONT, 10, False, LGRAY)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    run_font(p.add_run("光标精灵"), HEAD_FONT, 40, True, NAVY)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    run_font(p.add_run("项目概述"), HEAD_FONT, 20, True, RGBColor(0x44, 0x4C, 0x7A))

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(22)
    run_font(p.add_run("v1.4  ·  2026-10-24"), HEAD_FONT, 10.5, False, GRAY)
    para_border(p, "bottom", HEX_ORANGE, 14, 8)

    # 定位语
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    cell_shade(cell, HEX_NOTE)
    table_borders(tbl, HEX_ORANGE, 4)
    cell_margins(tbl, 180, 180, 200, 200)
    cell.text = ""
    p0 = cell.paragraphs[0]
    p0.paragraph_format.space_after = Pt(0)
    p0.paragraph_format.line_spacing = 1.55
    p0.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run_font(p0.add_run("一个能召唤的鼠标箭头精灵：问「环切在哪」，它像鼠标一样飞过去圈住那个按钮，"
                        "弹一句话告诉你，然后等你点完再指下一步。"), HEAD_FONT, 11.5, False,
             RGBColor(0x33, 0x33, 0x33))
    p1 = cell.add_paragraph()
    p1.paragraph_format.space_before = Pt(6)
    p1.paragraph_format.space_after = Pt(0)
    p1.paragraph_format.line_spacing = 1.4
    run_font(p1.add_run("不是「帮我把活干完」，而是「教会我下次自己干」。"), HEAD_FONT, 10, True, ORANGE)

    doc.add_paragraph().paragraph_format.space_after = Pt(6)

    add_table(doc, None, [
        ("项目名称", "光标精灵（工程代号 cursor-elf）"),
        ("文档版本", "v1.4"),
        ("当前阶段", "需求已锁定，M0 概念验证待开工"),
        ("技术基座", "Electron + Canvas 2D（流程参考 MudrikNow，MIT）"),
        ("首个 Demo", "Chrome 适配器 1 天 + Blender 适配器 2 天"),
        ("模型方案", "deepseek-flash（文本 + 图像理解，≈0.0008 元/张图）"),
        ("演示环境", "Windows 10/11 · 1920×1080 · 缩放 100%"),
    ], widths=[4.0, 12.4], font=9.5, header=False, zebra=False,
        first_col_bold=True, align_right_cols=())

    doc.add_page_break()

    # ===== 目录 =====
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(12)
    run_font(p.add_run("目  录"), HEAD_FONT, 18, True, NAVY)
    para_border(p, "bottom", HEX_ORANGE, 12, 6)

    toc = [
        ("1", "项目定位"), ("2", "核心体验"), ("3", "交互细节"), ("4", "范围与选型"),
        ("5", "架构"), ("6", "借鉴清单"), ("7", "关键技术点"), ("8", "风险与对策"),
        ("9", "三天计划"), ("10", "成本预估"), ("11", "待定事项与变更记录"),
    ]
    for num, title in toc:
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(0.4)
        pf.space_after = Pt(7)
        pf.line_spacing = 1.3
        run_font(p.add_run(num + "  "), HEAD_FONT, 11.5, True, ORANGE)
        run_font(p.add_run(title), HEAD_FONT, 11.5, False, RGBColor(0x22, 0x22, 0x22))

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    run_font(p.add_run("阅读提示"), HEAD_FONT, 9.5, True, LGRAY)
    rich(doc, [("若只想看结论：看 §1 定位、§4 选型、§9 三天计划。"
                "若准备开工：看 §5 架构与 §7 关键技术点。", False, GRAY)], size=9.5)

    doc.add_page_break()

    # ===== 1 项目定位 =====
    h1(doc, "1  项目定位")

    h2(doc, "1.1  一句话")
    para(doc, "一个能召唤的鼠标箭头精灵。唤它出来，问「环切在哪」，它像鼠标一样飞过去圈住那个按钮，"
              "弹一句话告诉你，然后等你点完再指下一步。它不是替用户操作电脑的 agent，"
              "而是一个把「功能藏在第三层菜单里」这件事变简单的教学型助手。")

    h2(doc, "1.2  给谁用")
    bullet(doc, "Blender 新手：想用某个功能但记不住菜单位置（「环切在哪」「材质面板在哪」）。")
    bullet(doc, "三维软件学习者：需要的是「这次教我在哪」，不是「这次帮我做完」。")
    bullet(doc, "所有被复杂 Web 后台折磨过的人：网页里的设置项同样藏得深。")
    para(doc, "核心价值主张只有一句：教，不做。这决定了后续所有功能取舍——凡是「替用户点」的能力，
         "v1 一律不做。")

    h2(doc, "1.3  边界（v1 明确不做）")
    add_table(doc, ["不做什么", "原因"], [
        ("computer-use 自动化（替用户点击）", "产品定位会从「教学」变成「代做」，用户学不会，且稳定性风险高。"),
        ("通用桌面适配", "每个软件都要单独写感知层，短期做不出好体验；v1 只做 Chrome 与 Blender。"),
        ("语音输入（识别）", "链路长、调优成本高；v1 先做打字与圈选，接口预留。"),
        ("用视觉模型算坐标", "视觉负责「看懂」，坐标必须由适配器给，这是精度底线。"),
    ], widths=[5.6, 10.8], font=9)
    doc.save(os.path.join(ROOT, "_tmp_part1.docx"))
    return doc


if __name__ == "__main__":
    print("scaffold ok")
