"""登記審査の per-rule プロンプト構築（純粋関数）。

ADR-0002 の「逐項判定＋規則ごとのスキャン部分投入」に従い、
1つの比較ルールにつき1プロンプトを構築する。
入力: ルール(名前+テキスト) + 文書タイプ付きスキャン一覧 + 案件情報。
出力: LLM への指示文字列（出力 JSON を <<JSON_START>>...<<JSON_END>> で括る指示を含む）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Sequence


@dataclass(frozen=True)
class ToukiDocument:
    """比較ルールの判定に投入するスキャン書類（文書タイプ付き）。"""

    document_type: str  # 文書タイプ（例: 抵当権設定契約証書）
    filename: str  # 添付ファイル名


def render_case_data(case_data: Any) -> str:
    """案件情報を人が読める JSON 文字列へ。None の場合は (なし)。"""
    if case_data is None:
        return "(なし)"
    try:
        return json.dumps(case_data, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(case_data)


def build_touki_review_prompt(
    rule_name: str,
    rule_text: str,
    documents: Sequence[ToukiDocument],
    case_data: Any,
    language_name: str = "日本語",
) -> str:
    """1つの比較ルールに対する審査プロンプトを構築する。"""
    docs_section = (
        "\n".join(
            f"- 文書タイプ「{d.document_type}」: 添付ファイル {d.filename}"
            for d in documents
        )
        or "(なし)"
    )
    case_section = render_case_data(case_data)

    return f"""You are an AI assistant that conducts 整合性審査 (consistency review) for Japanese 登記 (real-estate registration) documents.

You judge ONE 比較ルール (comparison rule) at a time, comparing fields across the attached scanned documents and/or the provided 案件情報 (case data).

## 審査項目（このルールを判定せよ）
- 名前: {rule_name}
- ルール: {rule_text}

## スキャン書類（文書タイプ別・添付ファイル）
{docs_section}
読み取りは本ルールに関連する文書のみを対象とすること（PDF は document block、画像は image_reader を使用）。

## 案件情報（システム抽出データ）
{case_section}

## 正規化ルール（表記揺れの吸収）
比較の前に値を以下の通り正規化すること。必要なら正規化ツールを利用:
- 氏名: 全角・半角スペースを除去（例: 山田　一郎 → 山田一郎）
- 金額: カンマ区切り/非区切りを数値として同一視（例: 30,000,000円 = 30000000）
- 利率: 全角「％」と半角「%」を同一視
- 日付: 和暦と西暦を相互変換して比較（例: 令和元年 = 2019年、平成31年 = 2019年）

## 判定基準
- 比較元と比較先が（正規化後）一致 → "pass"
- 一致しない → "fail"
- 比較対象のいずれかが欠損・空白・読取不能 → "undeterminable"（要確認）

## 出力要件
- 出力はすべて {language_name} で記述すること（JSON の値も含む）。
- Markdown のコードブロックを使わず、次の JSON を <<JSON_START>> と <<JSON_END>> で括って出力すること:

<<JSON_START>>
{{
  "result": "pass" | "fail" | "undeterminable",
  "confidence": <number 0.0〜1.0>,
  "explanation": "<判断方法を具体的に ({language_name})>",
  "advice": "<問題時の対応方法、なければその旨 ({language_name})>",
  "comparisons": [
    {{ "role": "source", "name": "<比較元データ名>", "value": "<正規化後の実際の値>" }},
    {{ "role": "target", "name": "<比較先データ名>", "value": "<正規化後の実際の値>" }}
  ]
}}
<<JSON_END>>
""".strip()
