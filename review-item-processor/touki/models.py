"""登記審査結果のドメインモデル（immutable）。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# 審査判定の3状態。Phase 4 の cascade（fail > undeterminable > pass）でも使用。
ReviewJudgment = Literal["pass", "fail", "undeterminable"]

_VALID_JUDGMENTS: tuple[str, ...] = ("pass", "fail", "undeterminable")


def is_valid_judgment(value: str) -> bool:
    """判定値が 3 状態のいずれか。"""
    return value in _VALID_JUDGMENTS


@dataclass(frozen=True)
class Comparison:
    """比較元/比較先のデータ。harness 出力の 比較元データ名/比較先データ名+値 に対応。"""

    role: str  # "source"（比較元）|"target"（比較先）。自由ラベルも許容。
    name: str  # データ名（例: 「抵当権設定契約証書：表面」の「債務者氏名」）
    value: str  # 実際の値（正規化後であること）


@dataclass(frozen=True)
class ToukiReviewResult:
    """1つの比較ルールに対する審査結果。"""

    result: ReviewJudgment
    confidence: float
    explanation: str  # 判断方法
    advice: str  # アドバイス（問題時の対応方法）
    comparisons: tuple[Comparison, ...]
