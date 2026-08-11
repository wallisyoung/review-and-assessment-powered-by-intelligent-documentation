#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登記（抵当権設定）テスト用サンプル書類セットの生成スクリプト。

実在の登記事項証明書／登記識別情報通知／契約証書の様式（表題部・甲区・乙区の
多段組、不動産番号・12桁符号・目隠しシール等）を参考にした見やすい PDF を生成。
全書類は単一の一貫した架空案件（住宅ローン＋土地・建物抵当権設定）を共有し、
17 条の比較ルールがすべて pass になるようデータを合わせている。

実行:
  cd review-item-processor
  uv run --extra evals python fixtures/touki-mortgage/generate.py
"""

from __future__ import annotations

import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle

OUT_DIR = Path(__file__).resolve().parent

# --- 一貫した架空案件データ（全書類で共有） ------------------------------
BORROWER = "山田 一郎"
GUARANTOR = "山田 花子"            # 連帯保証人 ＝ 抵当権設定者 ＝ 物件所有者
LENDER = "株式会社サンプル銀行 本店営業部"
LAND_ADDR = "東京都世田谷区桜丘一丁目2番3"
LAND_CHIBAN = "2番3"
BUILD_ADDR = "東京都世田谷区桜丘一丁目2番3"
BUILD_KAOKU = "2番地の3"
CHIMOKU = "宅地"
LAND_AREA = "150.00平方メートル"
BUILD_AREA = "95.50平方メートル"
AMOUNT = "金30,000,000円"
AMOUNT_PLAIN = "30,000,000円"
RATE = "年0.475％"
CONTRACT_DATE = "平成31年3月29日"   # ご契約日 ＝ 融資実行予定日 ＝ 乙区原因日付
FILING_DATE = "平成31年4月1日"
COMPLETE_DATE = "平成31年4月5日"
TITLE_DATE = "平成30年6月1日"       # 表題部原因日付（≦ 融資実行予定日）
PURPOSE = "抵当権設定"
SEAL_TEXT = "登録識別情報はこの中に記載しています。開封方法は裏面をご覧ください。"
RECEIPT_NO = "平成31年第1234号"
FUDOUSAN_LAND = "130000000012345"   # 架空の不動産番号（土地）
FUDOUSAN_BUILD = "130000000012346"  # 架空の不動産番号（建物）
ID_CODE = "A1B2-C3D4-E5F6"          # 12桁の登記識別情報（目隠しシールで隠れる）

# --- フォント登録 --------------------------------------------------------
pdfmetrics.registerFont(
    TTFont("JP", "C:/Windows/Fonts/msmincho.ttc", subfontIndex=0)
)

_TITLE = ParagraphStyle("title", fontName="JP", fontSize=18, leading=24, spaceAfter=4)
_SUB = ParagraphStyle(
    "sub", fontName="JP", fontSize=9, textColor=colors.grey, spaceAfter=14
)
_HEAD = ParagraphStyle(
    "head", fontName="JP", fontSize=12, leading=16, spaceBefore=10, spaceAfter=4
)
_SMALL = ParagraphStyle(
    "small", fontName="JP", fontSize=8.5, leading=12, textColor=colors.grey
)
_CELL = ParagraphStyle("cell", fontName="JP", fontSize=9.5, leading=13)

C = 28.35  # cm → pt


def P(text: str) -> Paragraph:
    """表セル内で折り返し可能な段落。"""
    return Paragraph(text, _CELL)


def kv_table(rows: list[tuple[str, str]]) -> Table:
    table = Table(rows, colWidths=[5.0 * C, 11.0 * C])
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


def section_table(
    header: list[str], rows: list[list], col_widths: list[float]
) -> Table:
    """登記簿謄本の権利部（甲区／乙区）風の多段組テーブル。"""
    data = [header] + [[P(c) for c in r] for r in rows]
    table = Table(data, colWidths=[w * C for w in col_widths], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), "JP"),
                ("FONTSIZE", (0, 0), (-1, 0), 9.5),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e7eaee")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9aa0a6")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def build_pdf(filename: str, title: str, blocks: list[tuple[str, object]]) -> None:
    path = OUT_DIR / filename
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        topMargin=2.0 * C,
        leftMargin=2.0 * C,
        rightMargin=2.0 * C,
        bottomMargin=2.0 * C,
        title=title,
    )
    flow = [
        Paragraph(title, _TITLE),
        Paragraph("（テスト用サンプル書類・架空のデータ）", _SUB),
    ]
    for head, f in blocks:
        flow.append(Paragraph(head, _HEAD))
        flow.append(f)
    doc.build(flow)
    print(f"  wrote {filename}")


# --- 各書類の生成 --------------------------------------------------------
def gen_teitou() -> None:
    """抵当権設定契約証書（契約書形式：当事者／極度額／物件表示）。"""
    parties = [
        ("債権者（抵当権者）", f"{LENDER}\n　代表者　取締役　大村　太郎"),
        ("債務者", BORROWER),
        ("抵当権設定者", GUARANTOR),
    ]
    terms = [
        ("極度額", AMOUNT),
        ("債権の範囲", "金銭消費貸借契約"),
        ("利率", RATE),
        ("契約年月日", CONTRACT_DATE),
    ]
    obj = [
        ("目的物（土地）", f"不動産番号：{FUDOUSAN_LAND}／{LAND_ADDR}／地目：{CHIMOKU}／地積：{LAND_AREA}"),
        ("目的物（建物）", f"不動産番号：{FUDOUSAN_BUILD}／{BUILD_ADDR} サンプルハイツ201号床／種類：居宅／床面積：{BUILD_AREA}"),
    ]
    build_pdf(
        "01_teitou_settei_keiyaku_shousho.pdf",
        "抵当権設定契約証書",
        [("【当事者】", kv_table(parties)), ("【契約条項】", kv_table(terms)), ("【物件の表示】", kv_table(obj))],
    )


def gen_kanryou() -> None:
    """登記完了証（登記完了通知形式）。"""
    rows = [
        ("登記の目的", PURPOSE),
        ("受付番号", RECEIPT_NO),
        ("受付年月日", FILING_DATE),
        ("登記完了年月日", COMPLETE_DATE),
        ("登記権利者（債権者）", LENDER),
        ("登記義務者（抵当権設定者）", GUARANTOR),
        ("不動産番号（土地）", FUDOUSAN_LAND),
        ("不動産番号（建物）", FUDOUSAN_BUILD),
        ("債権額", AMOUNT),
    ]
    build_pdf("02_touki_kanryou_shou.pdf", "登記完了証", [("登記完了のお知らせ", kv_table(rows))])


def gen_shikibetsu() -> None:
    """登記識別情報通知（法務局様式：不動産番号／12桁符号／目隠しシール）。"""
    rows = [
        ("不動産番号", FUDOUSAN_BUILD),
        ("所在／地番", f"{BUILD_ADDR} サンプルハイツ201号床"),
        ("登記の目的", PURPOSE),
        ("登記名義人（権利者）", LENDER),
        ("義務者（抵当権設定者）", GUARANTOR),
        ("登記識別情報", "■■■■　■■■■　■■■■　（12桁の符号・目隠しシールで覆われています）"),
        ("目隠しシール", SEAL_TEXT),
        ("QRコード", "（二次元コード）"),
    ]
    build_pdf(
        "03_touki_jouhou_shikibetsu_tsuchi.pdf",
        "登記識別情報通知",
        [("不動産登記・登記識別情報通知", kv_table(rows))],
    )


def _meisai_header() -> list[str]:
    return ["順位", "登記の目的", "登記原因（年月日）", "受付年月日", "権利者・義務者・その他事項"]


def gen_tatemono() -> None:
    """建物登記簿謄本（表題部＋権利部 甲区／乙区）。"""
    # 表題部
    hyodai = [
        ("不動産番号", FUDOUSAN_BUILD),
        ("所在", BUILD_ADDR),
        ("家屋番号", f"{LAND_ADDR} {BUILD_KAOKU}"),
        ("種類・構造", "居宅　鉄筋コンクリート造"),
        ("床面積", BUILD_AREA),
        ("原因及びその年月日", f"新築　{TITLE_DATE}"),
    ]
    # 甲区事項（所有権）
    koka = [["1", "所有権保存", TITLE_DATE, TITLE_DATE, f"所有者：{GUARANTOR}"]]
    # 乙区事項（抵当権）
    oku = [[
        "1",
        PURPOSE,
        f"{CONTRACT_DATE}　金銭消費貸借",
        FILING_DATE,
        f"債権者：{LENDER}／債務者：{BORROWER}／設定者（義務者）：{GUARANTOR}／債権額：{AMOUNT}",
    ]]
    cw = [1.0, 2.6, 3.4, 2.2, 6.8]
    build_pdf(
        "04_tatemono_touki_touhon.pdf",
        "登記事項証明書（建物登記簿謄本）",
        [
            ("【表題部】（建物の表示）", kv_table(hyodai)),
            ("【権利部（甲区）事項】（所有権に関する事項）", section_table(_meisai_header(), koka, cw)),
            ("【権利部（乙区）事項】（所有権以外の権利に関する事項）", section_table(_meisai_header(), oku, cw)),
        ],
    )


def gen_honchi() -> None:
    """本地（土地）登記簿謄本（表題部＋権利部 甲区／乙区）。"""
    hyodai = [
        ("不動産番号", FUDOUSAN_LAND),
        ("所在・地番", f"{LAND_ADDR}　地番：{LAND_CHIBAN}"),
        ("地目", CHIMOKU),
        ("地積", LAND_AREA),
        ("原因及びその年月日", f"所有権移転　{TITLE_DATE}"),
    ]
    koka = [["1", "所有権保存", TITLE_DATE, TITLE_DATE, f"所有者：{GUARANTOR}"]]
    oku = [[
        "1",
        PURPOSE,
        f"{CONTRACT_DATE}　金銭消費貸借",
        FILING_DATE,
        f"債権者：{LENDER}／債務者：{BORROWER}／設定者（義務者）：{GUARANTOR}／債権額：{AMOUNT}",
    ]]
    cw = [1.0, 2.6, 3.4, 2.2, 6.8]
    build_pdf(
        "05_honchi_touki_touhon.pdf",
        "登記事項証明書（土地登記簿謄本）",
        [
            ("【表題部】（土地の表示）", kv_table(hyodai)),
            ("【権利部（甲区）事項】（所有権に関する事項）", section_table(_meisai_header(), koka, cw)),
            ("【権利部（乙区）事項】（所有権以外の権利に関する事項）", section_table(_meisai_header(), oku, cw)),
        ],
    )


def gen_casedata() -> None:
    """17 ルールの「書類 vs 案件情報」比較が整合する caseData JSON。"""
    case_data = {
        "案件情報": {
            "顧客氏名": BORROWER.replace(" ", ""),
            "借入情報": {
                "融資実行予定日": "2019年03月29日",
                "総借入希望額": AMOUNT_PLAIN,
                "加減算後‗適用金利": "0.475%",
            },
            "連帯保証人": [GUARANTOR.replace(" ", "")],
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
    (OUT_DIR / "case_data.json").write_text(
        json.dumps(case_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("  wrote case_data.json")


def gen_readme() -> None:
    rows = [
        ("債務者（借主）", BORROWER),
        ("連帯保証人／抵当権設定者／物件所有者", GUARANTOR),
        ("債権者（金融機関）", LENDER),
        ("土地", f"{LAND_ADDR}／地目：{CHIMOKU}／地積：{LAND_AREA}"),
        ("建物", f"{BUILD_ADDR} サンプルハイツ201号床／床面積：{BUILD_AREA}"),
        ("借入金額（極度額）", AMOUNT),
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
        topMargin=2.0 * C,
        leftMargin=2.0 * C,
        rightMargin=2.0 * C,
        bottomMargin=2.0 * C,
        title="README",
    )
    doc.build(
        [
            Paragraph("登記（抵当権設定）テスト用サンプル書類セット", _TITLE),
            Paragraph("住宅ローン＋土地・建物 抵当権設定の一貫した架空案件。実在の登記事項証明書／登記識別情報通知／契約証書の様式を参考に作成。", _SUB),
            Paragraph("案件データ", _HEAD),
            kv_table(rows),
            Paragraph("ファイルと文書タイプの対応（アップロード時にマッピング）", _HEAD),
            kv_table(mapping),
            Paragraph("※ 全データは架空。17 条の比較ルールがすべて pass になるよう整合済み。正規化（氏名の空白除去、金額カンマ、和暦↔西暦）を介して一致する。", _SMALL),
        ]
    )
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
