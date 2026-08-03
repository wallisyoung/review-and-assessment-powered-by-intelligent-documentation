"""登記審査の正規化ヘルパーを Strands ツールとして公開（ADR-0001 の A3a: ツールは正規化のみ）。

`tools/normalization.py` の純粋関数を薄く @tool 化する。LLM が抽出値の正規化に呼ぶ。
比較/判定は LLM が行う（ここでは正規化しか返さない）。
"""

from __future__ import annotations

from typing import Any

from strands.tools import tool

from tools.normalization import (
    date_not_after,
    dates_equal,
    normalize_name,
    parse_japanese_date,
    parse_japanese_year,
    parse_rate,
    parse_yen_amount,
)


def _ok_text(value: Any) -> dict:
    """正規化結果を ToolResult 形式（テキスト）で包む。"""
    return {"status": "success", "content": [{"text": str(value)}]}


@tool
def normalize_name_tool(name: str) -> dict:
    """Normalize a person/entity name by stripping full/half-width spaces.
    Example: 山田　一郎 -> 山田一郎, 山田 二 -> 山田二."""
    return _ok_text(normalize_name(name))


@tool
def parse_yen_amount_tool(text: str) -> dict:
    """Parse a Japanese yen amount to an integer, ignoring commas and units.
    Example: 30,000,000円 -> 30000000, 金30,000,000円 -> 30000000.
    Returns None if no number is found."""
    return _ok_text(parse_yen_amount(text))


@tool
def parse_rate_tool(text: str) -> dict:
    """Parse an interest rate to a float, normalizing full/half-width %.
    Example: 0.475％ -> 0.475, 年 0.475％ -> 0.475.
    Returns None if no number is found."""
    return _ok_text(parse_rate(text))


@tool
def parse_japanese_date_tool(text: str) -> dict:
    """Extract a date (ISO YYYY-MM-DD) from Japanese-era (和暦) or Western (西暦) text,
    including full-width digits. Example: 平成31年3月29日 -> 2019-03-29, 平成２０年１１月１日 -> 2008-11-01.
    Returns None if no full date is found."""
    d = parse_japanese_date(text)
    return _ok_text(d.isoformat() if d else None)


@tool
def parse_japanese_year_tool(text: str) -> dict:
    """Extract a Western year (int) from 和暦/西暦 text. Example: 令和元年 -> 2019, 平成20年 -> 2008.
    Returns None if no year is found."""
    return _ok_text(parse_japanese_year(text))


@tool
def dates_equal_tool(a: str, b: str) -> dict:
    """Check whether two date strings (和暦/西暦 may be mixed) are the same date.
    Returns True/False, or None if either is unparseable."""
    return _ok_text(dates_equal(a, b))


@tool
def date_not_after_tool(value: str, upper: str) -> dict:
    """Check whether date `value` is on or before `upper` (value <= upper).
    和暦/西暦 may be mixed. Returns True/False, or None if either is unparseable."""
    return _ok_text(date_not_after(value, upper))


def create_normalization_tools() -> list:
    """登記審査で使用する正規化ツールの一覧を返す。"""
    return [
        normalize_name_tool,
        parse_yen_amount_tool,
        parse_rate_tool,
        parse_japanese_date_tool,
        parse_japanese_year_tool,
        dates_equal_tool,
        date_not_after_tool,
    ]
