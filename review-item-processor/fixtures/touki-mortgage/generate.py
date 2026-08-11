#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登記（抵当権設定）テスト用サンプル書類セットの生成スクリプト。

5 種類の書類 PDF + 整合した 案件情報(caseData) JSON + README を出力する。
全書類は単一の一貫した架空案件（住宅ローン＋土地・建物抵当権設定）を共有し、
17 条の比較ルールがすべて pass になるようデータを合わせている。

実行:
  cd review-item-processor
  uv run --extra evals python fixtures/touki-mortgage/generate.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT_DIR = Path(__file__).resolve().parent

# --- 一貫した架空案件データ（全書類で共有） ------------------------------
BORROWER = "山田 一郎"          # 債務者（借主）
GUARANTOR = "山田 花子"         # 連帯保証人 ＝ 抵当権設定者 ＝ 物件所有者
LENDER = "株式会社サンプル銀行 本店営業部"  # 債権者
LAND_ADDR = "東京都世田谷区桜丘一丁目2番3"
BUILD_ADDR = "東京都世田谷区桜丘一丁目2番3 サンプルハイツ201号床"
CHIMOKU = "宅地"
LAND_AREA = "150.00㎡"
BUILD_AREA = "95.50㎡"
AMOUNT = "金30,000,000円"
AMOUNT_PLAIN = "30,000,000円"
RATE = "年0.475％"
CONTRACT_DATE = "平成31年3月29日"   # ご契約日 ＝ 融資実行予定日 ＝ 乙区原因日付
FILING_DATE = "平成31年4月1日"      # 登記受付年月日
COMPLETE_DATE = "平成31年4月5日"    # 登記完了日
TITLE_DATE = "平成30年6月1日"       # 表題部原因日付（建物新築等）≦ 融資実行予定日
PURPOSE = "抵当権設定"
SEAL_TEXT = "登録識別情報はこの中に記載しています。開封方法は裏面をご覧ください。"
RECEIPT_NO = "平成31年第1234号"

# --- フォント登録 --------------------------------------------------------
FONT_PATH = "C:/Windows/Fonts/msmincho.ttc"
pdfmetrics.registerFont(TTFont("JP", FONT_PATH, subfontIndex=0))

_TITLE = ParagraphStyle("title", fontName="JP", fontSize=18, leading=24, spaceAfter=4)
_SUB = ParagraphStyle(
    "sub", fontName="JP", fontSize=9, textColor=colors.grey, spaceAfter=14
)
_HEAD = ParagraphStyle(
    "head", fontName="JP", fontSize=12, leading=16, spaceBefore=10, spaceAfter=4
)
_NOTE = ParagraphStyle(
    "note", fontName="JP", fontSize=8.5, leading=12, textColor=colors.grey, spaceBefore=8
)


def kv_table(rows: list[tuple[str, str]]) -> Table:
    table = Table(rows, colWidths=[5.0 * 28.35, 11.0 * 28.35])
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "JP"),
                ("FONTSIZE", (0, 0), (-1, -1), 10.5),
                ("LEADING", (0, 0), (-1, -1), 15),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9aa0a6")),
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eef1f4")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def build_pdf(filename: str, title: str, sections: list[tuple[str, list]]) -> None:
    path = OUT_DIR / filename
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        topMargin=2.0 * 28.35,
        leftMargin=2.0 * 28.35,
        rightMargin=2.0 * 28.35,
        bottomMargin=2.0 * 28.35,
        title=title,
    )
    flow = [
        Paragraph(title, _TITLE),
        Paragraph("（テスト用サンプル書類・架空のデータ）", _SUB),
    ]
    for head, rows in sections:
        flow.append(Paragraph(head, _HEAD))
        flow.append(kv_table(rows))
    doc.build(flow)
    print(f"  wrote {filename}")


def gen_teitou() -> None:
    """抵当権設定契約証書（表面＋裏面）。"""
    omote = [
        ("債権者", LENDER),
        ("債務者", BORROWER),
        ("抵当権設定者氏名", GUARANTOR),
        ("ご契約日", CONTRACT_DATE),
        ("債権額（極度額）", AMOUNT),
        ("利率", RATE),
    ]
    ura = [
        ("物件の表示（土地）", f"{LAND_ADDR}／地目：{CHIMOKU}／地積：{LAND_AREA}"),
        ("物件の表示（建物）", f"{BUILD_ADDR}／床面積：{BUILD_AREA}"),
    ]
    build_pdf(
        "01_teitou_settei_keiyaku_shousho.pdf",
        "抵当権設定契約証書",
        [("【表面】", omote), ("【裏面】物件の表示", ura)],
    )


def gen_kanryou() -> None:
    """登記完了証。"""
    rows = [
        ("登記の目的", PURPOSE),
        ("受付番号", RECEIPT_NO),
        ("受付年月日", FILING_DATE),
        ("登記完了年月日", COMPLETE_DATE),
        ("登記権利者（債権者）", LENDER),
        ("登記義務者（抵当権設定者）", GUARANTOR),
        ("不動産（土地）", f"{LAND_ADDR}／{LAND_AREA}"),
        ("不動産（建物）", f"{BUILD_ADDR}／{BUILD_AREA}"),
        ("債権額", AMOUNT),
    ]
    build_pdf("02_touki_kanryou_shou.pdf", "登記完了証", [("登記完了のお知らせ", rows)])


def gen_shikibetsu() -> None:
    """登記情報識別通知。"""
    rows = [
        ("登記の目的", PURPOSE),
        ("登記年月日", FILING_DATE),
        ("登記原因", f"{CONTRACT_DATE} 金銭消費貸借"),
        ("権利者（債権者）", LENDER),
        ("義務者（抵当権設定者）", GUARANTOR),
        ("不動産（土地）", f"{LAND_ADDR}／地目：{CHIMOKU}／地積：{LAND_AREA}"),
        ("不動産（建物）", f"{BUILD_ADDR}／床面積：{BUILD_AREA}"),
        ("目隠しシール", SEAL_TEXT),
    ]
    build_pdf(
        "03_touki_jouhou_shikibetsu_tsuchi.pdf",
        "登記情報識別通知",
        [("不動産登記情報", rows)],
    )


def gen_tatemono() -> None:
    """建物登記簿謄本（表題部＋甲区＋乙区）。"""
    hyodai = [
        ("所在・番地", LAND_ADDR),
        ("建物の名称・区画", "サンプルハイツ 201号床"),
        ("床面積", BUILD_AREA),
        ("原因及びその日付", f"新築　{TITLE_DATE}"),
    ]
    kōku = [
        ("登記順位1", f"所有権保存　{TITLE_DATE}　権利者：{GUARANTOR}"),
    ]
    oku = [
        (
            "登記順位1",
            "抵当権設定／原因："
            f"{CONTRACT_DATE} 金銭消費貸借／受付：{FILING_DATE}／"
            f"権利者（債権者）：{LENDER}／債務者：{BORROWER}／債権額：{AMOUNT}",
        )
    ]
    build_pdf(
        "04_tatemono_touki_touhon.pdf",
        "登記簿謄本（建物）",
        [("【表題部】", hyodai), ("【甲区】所有権", kōku), ("【乙区】所有権以外の権利", oku)],
    )


def gen_honchi() -> None:
    """本地登記簿謄本（土地／表題部＋甲区＋乙区）。"""
    hyodai = [
        ("所在・番地", LAND_ADDR),
        ("地目", CHIMOKU),
        ("地積", LAND_AREA),
        ("原因及びその日付", f"所有権移転　{TITLE_DATE}"),
    ]
    kōku = [
        ("登記順位1", f"所有権保存　{TITLE_DATE}　権利者：{GUARANTOR}"),
    ]
    oku = [
        (
            "登記順位1",
            "抵当権設定／原因："
            f"{CONTRACT_DATE} 金銭消費貸借／受付：{FILING_DATE}／"
            f"権利者（債権者）：{LENDER}／債務者：{BORROWER}／債権額：{AMOUNT}",
        )
    ]
    build_pdf(
        "05_honchi_touki_touhon.pdf",
        "登記簿謄本（土地／本地）",
        [("【表題部】", hyodai), ("【甲区】所有権", kōku), ("【乙区】所有権以外の権利", oku)],
    )


def gen_casedata() -> None:
    """17 ルールの「書類 vs 案件情報」比較が整合する caseData JSON。"""
    case_data = {
        "案件情報": {
            "顧客氏名": BORROWER.replace(" ", ""),  # 山田一郎（正規化で契約証書の「山田 一郎」と一致）
            "借入情報": {
                "融資実行予定日": "2019年03月29日",
                "総借入希望額": AMOUNT_PLAIN,
                "加減算後‗適用金利": "0.475%",
            },
            "連帯保証人": [GUARANTOR.replace(" ", "")],   # 山田花子
            "担保提供者": [],
            "物件情報": {
                "登記簿住所": LAND_ADDR,
                "マンション名": "サンプルハイツ",
                "号棟": "201号",
                "部屋番号": "201",
                "土地面積": "150.00",
                "延床面積": "95.50",
            },
        }
    }
    path = OUT_DIR / "case_data.json"
    path.write_text(
        json.dumps(case_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  wrote case_data.json")


def gen_readme() -> None:
    rows = [
        ("債務者（借主）", BORROWER),
        ("連帯保証人／抵当権設定者／物件所有者", GUARANTOR),
        ("債権者（金融機関）", LENDER),
        ("土地", f"{LAND_ADDR}／地目：{CHIMOKU}／地積：{LAND_AREA}"),
        ("建物", f"{BUILD_ADDR}／床面積：{BUILD_AREA}"),
        ("借入金額（債権額）", AMOUNT),
        ("適用金利", RATE),
        ("ご契約日＝融資実行予定日＝乙区原因日付", CONTRACT_DATE),
        ("登記受付年月日", FILING_DATE),
        ("表題部原因日付（≦融資実行予定日）", TITLE_DATE),
        ("登記の目的", PURPOSE),
    ]
    mapping = [
        ("01_teitou_settei_keiyaku_shousho.pdf", "抵当権設定契約証書"),
        ("02_touki_kanryou_shou.pdf", "登記完了証"),
        ("03_touki_jouhou_shikibetsu_tsuchi.pdf", "登記情報識別通知"),
        ("04_tatemono_touki_touhon.pdf", "建物登記簿謄本"),
        ("05_honchi_touki_touhon.pdf", "本地登記簿謄本"),
        ("case_data.json", "案件情報（システム抽出データとして入力）"),
    ]
    doc = SimpleDocTemplate(
        str(OUT_DIR / "00_README.pdf"),
        pagesize=A4,
        topMargin=2.0 * 28.35,
        leftMargin=2.0 * 28.35,
        rightMargin=2.0 * 28.35,
        bottomMargin=2.0 * 28.35,
        title="README",
    )
    flow = [
        Paragraph("登記（抵当権設定）テスト用サンプル書類セット", _TITLE),
        Paragraph("住宅ローン＋土地・建物 抵当権設定の一貫した架空案件。", _SUB),
        Paragraph("案件データ", _HEAD),
        kv_table(rows),
        Paragraph("ファイルと文書タイプの対応（アップロード時にマッピング）", _HEAD),
        kv_table(mapping),
        Paragraph(
            "※ 全データは架空。17 条の比較ルールがすべて pass になるよう整合済み。"
            "正規化（氏名の空白除去、金額カンマ、和暦↔西暦）を介して一致する。",
            _NOTE,
        ),
    ]
    doc.build(flow)
    print("  wrote 00_README.pdf")


def main() -> None:
    print(f"Generating into {OUT_DIR}")
    gen_teitou()
    gen_kanryou()
    gen_shikibetsu()
    gen_tatemono()
    gen_honchi()
    gen_casedata()
    gen_readme()
    print("done.")


if __name__ == "__main__":
    main()
