"""A3a 正規化ヘルパー（純粋関数）

登記整合性審査で LLM が誤りやすい正規化を決定論的に行うためのヘルパー群。
ADR-0001 の A3a 方針「工具は正規化のみ行い、比較/判定/助言は LLM が担う」に基づく。

これらは AWS / LLM / DB に依存しない純粋関数であり、单元テストで完全に検証できる。
後続の agent 統合では、これらを Strands の @tool として薄くラップして LLM に提供する。

主な正規化対象（harness の「表記揺れの正規化」ruled を反映）:
- 和暦 ↔ 西暦の変換（元年対応・全角数字対応）
- 金額のカンマ区切り/非区切りの同一視
- 利率の全角/半角 % の同一視
- 氏名の全角/半角スペース除去
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

# 元号表（開始年月日）。和暦→西暦変換で使用。
# (元号名, 開始西暦年, 開始月, 開始日)
_ERAS: list[tuple[str, int, int, int]] = [
    ("令和", 2019, 5, 1),
    ("平成", 1989, 1, 8),
    ("昭和", 1926, 12, 25),
    ("大正", 1912, 7, 30),
    ("明治", 1868, 9, 8),
]

_ERA_NAMES = "|".join(name for name, _, _, _ in _ERAS)
_ERA_START: dict[str, tuple[int, int, int]] = {
    name: (y, m, d) for name, y, m, d in _ERAS
}


def nfkc(value: str) -> str:
    """全角文字を半角へ正規化し、前後の空白を削る前処理。"""
    return unicodedata.normalize("NFKC", value).strip()


def normalize_name(name: str) -> str:
    """氏名の正規化：全角/半角スペース・制御文字を除去して詰める。

    例: "山田　一郎" / "山田 一郎" / "山田　二" -> "山田一郎" / "山田二"
    """
    normalized = nfkc(name)
    # 空白類（半角・全角スペース、タブ、改行など）をすべて除去
    return re.sub(r"\s+", "", normalized)


def parse_yen_amount(text: str) -> int | None:
    """金額の正規化：カンマ区切り/非区切り・「金」「円」単位を吸収して整数へ。

    例: "30,000,000円" / "金30,000,000円" / "30000000" -> 30000000
    数字（とカンマ）以外を除去し、カンマを外して整数化する。数字が無ければ None。
    """
    normalized = nfkc(text)
    digits_and_commas = re.sub(r"[^\d,]", "", normalized)
    digits = digits_and_commas.replace(",", "")
    if not digits:
        return None
    return int(digits)


def parse_rate(text: str) -> float | None:
    """利率の正規化：全角/半角 %、「年」などを吸収して小数へ。

    例: "0.475%" / "0.475％" / "年 0.475％" / "年1.5%" -> 0.475 / 0.475 / 0.475 / 1.5
    最初に出現する小数（または整数）を利率とみなす。数値が無ければ None。
    """
    normalized = nfkc(text)
    match = re.search(r"(\d+(?:\.\d+)?)", normalized)
    if not match:
        return None
    return float(match.group(1))


def _wareki_year_to_seireki(era: str, era_year: int) -> int | None:
    """元号と元号年（1=元年）から西暦年を得る。"""
    start = _ERA_START.get(era)
    if not start:
        return None
    start_year = start[0]
    # 元号年 n の西暦年 = 開始年 + (n - 1)。元年(1)は開始年と同一年。
    return start_year + (era_year - 1)


def parse_japanese_date(text: str) -> date | None:
    """日付文字列から datetime.date を抽出する（和暦・西暦両対応、全角数字対応）。

    テキ中に埋め込まれた最初の完全な日付（年月日）を対象とする。
    例: "平成31年3月29日" / "平成２０年１１月１日" /
        "（西暦）2019年03月29日" / "原因 平成31年3月29日金銭消費貸借同日設定"
    月日が無い、または無効な日付の場合は None。
    """
    normalized = nfkc(text)

    # 1) 和暦: "(元号)(数字|元)年(月)月(日)日"
    m = re.search(
        rf"({_ERA_NAMES})\s*(\d{{1,2}}|元)\s*年\s*(\d{{1,2}})\s*月\s*(\d{{1,2}})\s*日",
        normalized,
    )
    if m:
        era, year_token, month_token, day_token = m.groups()
        era_year = 1 if year_token == "元" else int(year_token)
        seireki_year = _wareki_year_to_seireki(era, era_year)
        if seireki_year is None:
            return None
        try:
            return date(seireki_year, int(month_token), int(day_token))
        except ValueError:
            return None

    # 2) 西暦: "YYYY年MM月DD日" / "YYYY/MM/DD" / "YYYY-MM-DD"
    m = re.search(
        r"(\d{4})\s*[年/\-]\s*(\d{1,2})\s*[月/\-]\s*(\d{1,2})\s*日?",
        normalized,
    )
    if m:
        year_token, month_token, day_token = m.groups()
        try:
            return date(int(year_token), int(month_token), int(day_token))
        except ValueError:
            return None

    return None


def parse_japanese_year(text: str) -> int | None:
    """テキストから西暦年（整数）を抽出する（年和暦・西暦両対応、元年対応）。

    月日を含まない「令和元年」「平成20年」のような年のみ表記にも対応。
    例: "令和元年" -> 2019, "平成20年" -> 2008, "2019年" -> 2019
    """
    normalized = nfkc(text)

    # 1) 和暦年: "(元号)(数字|元)年"
    m = re.search(rf"({_ERA_NAMES})\s*(\d{{1,2}}|元)\s*年", normalized)
    if m:
        era, year_token = m.groups()
        era_year = 1 if year_token == "元" else int(year_token)
        seireki_year = _wareki_year_to_seireki(era, era_year)
        if seireki_year is not None:
            return seireki_year

    # 2) 西暦年: "YYYY年"
    m = re.search(r"(\d{4})\s*年", normalized)
    if m:
        return int(m.group(1))

    return None


def _to_date(value: str) -> date | None:
    """文字列を日付へ。年のみの場合は（年が合えば比較できるよう）その年の1月1日とは限らないので、
    年のみの解釈は避け、完全な日付のみ受け付けるラッパー。"""
    return parse_japanese_date(value)


def dates_equal(a: str, b: str) -> bool | None:
    """2つの日付文字列が同じ日付か。いずれかが解析不能なら None（判定不能）。"""
    da, db = _to_date(a), _to_date(b)
    if da is None or db is None:
        return None
    return da == db


def date_not_after(value: str, upper: str) -> bool | None:
    """value が upper 以前（value <= upper）か。いずれか解析不能なら None。

    例: 表題部の「原因日付」が「融資実行予定日」以降でないこと（規則16）。
    """
    dv, du = _to_date(value), _to_date(upper)
    if dv is None or du is None:
        return None
    return dv <= du
