"""登記審査結果の解析（純粋関数）。

agent の応答メッセージから JSON を抽出し、3 状態の ToukiReviewResult へ変換する。
JSON 抽出は agent.py の <<JSON_START>>...<<JSON_END>> マーカー規約に合致（フォールバック付き）。
"""

from __future__ import annotations

import json
import re
from typing import Any

from .models import (
    _VALID_JUDGMENTS,
    Comparison,
    ReviewJudgment,
    ToukiReviewResult,
    is_valid_judgment,
)


class ToukiParseError(ValueError):
    """登記審査結果の解析に失敗した。"""


def _message_to_text(message: Any) -> str:
    """AgentResult.message 様の構造をテキストへ統一する。"""
    if isinstance(message, dict) and "content" in message:
        blocks = [
            block["text"]
            for block in message["content"]
            if isinstance(block, dict) and "text" in block
        ]
        return "".join(blocks).strip()
    return str(message).strip()


def extract_json_text(message: Any) -> str | None:
    """メッセージから JSON 文字列を取り出す（マーカー優先、次に最初の {...}）。"""
    combined = _message_to_text(message)

    marker_match = re.search(
        r"<<JSON_START>>(.*?)<<JSON_END>>", combined, re.DOTALL
    )
    if marker_match:
        return marker_match.group(1).strip()

    fallback_match = re.search(r"\{.*\}", combined, re.DOTALL)
    if fallback_match:
        return fallback_match.group(0)

    return None


def parse_touki_review_result(message: Any) -> ToukiReviewResult:
    """agent 応答を ToukiReviewResult に変換する。不正なら ToukiParseError。"""
    json_text = extract_json_text(message)
    if not json_text:
        raise ToukiParseError("メッセージ内に JSON が見つかりません")

    try:
        data = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ToukiParseError(f"JSON の解析に失敗: {exc}") from exc

    if not isinstance(data, dict):
        raise ToukiParseError("JSON がオブジェクトではありません")

    raw_result = str(data.get("result", "")).strip().lower()
    if not is_valid_judgment(raw_result):
        raise ToukiParseError(
            f"不正な result: {raw_result!r}（期待値 {_VALID_JUDGMENTS}）"
        )

    # confidence: 不正値は 0.5、範囲外は 0.0〜1.0 にクリップ
    try:
        confidence = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    explanation = str(data.get("explanation", ""))
    advice = str(data.get("advice", ""))

    comparisons: list[Comparison] = []
    raw_comparisons = data.get("comparisons", []) or []
    if isinstance(raw_comparisons, list):
        for item in raw_comparisons:
            if isinstance(item, dict):
                comparisons.append(
                    Comparison(
                        role=str(item.get("role", "")),
                        name=str(item.get("name", "")),
                        value=str(item.get("value", "")),
                    )
                )

    return ToukiReviewResult(
        result=raw_result,  # type: ignore[arg-type]
        confidence=confidence,
        explanation=explanation,
        advice=advice,
        comparisons=tuple(comparisons),
    )
