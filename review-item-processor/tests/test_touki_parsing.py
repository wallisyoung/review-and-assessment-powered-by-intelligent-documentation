"""登記審査結果パーサーの单元テスト（AWS/LLM 不要）。

JSON 文字列はすべて json.dumps で組み立て、引用符の入れ子による構文問題を回避する。
"""

import json

import pytest

from touki.models import Comparison
from touki.parsing import (
    ToukiParseError,
    extract_json_text,
    parse_touki_review_result,
)

_START = "<<JSON_START>>"
_END = "<<JSON_END>>"


def _wrapped(obj: dict) -> str:
    """マーカーで括った JSON 文字列を組み立てる。"""
    return _START + json.dumps(obj, ensure_ascii=False) + _END


_GOOD_MARKER = """判断します。
<<JSON_START>>
{
  "result": "pass",
  "confidence": 0.95,
  "explanation": "氏名は正規化後一致。",
  "advice": "問題ありません。",
  "comparisons": [
    {"role": "source", "name": "債務者氏名", "value": "山田一郎"},
    {"role": "target", "name": "顧客氏名", "value": "山田一郎"}
  ]
}
<<JSON_END>>
以上です。"""


class TestExtractJsonText:
    def test_marker_extraction(self) -> None:
        text = extract_json_text(_GOOD_MARKER)
        assert text is not None and '"result"' in text

    def test_fallback_no_markers(self) -> None:
        text = "prefix " + json.dumps({"result": "fail"}) + " suffix"
        assert extract_json_text(text) is not None

    def test_no_json(self) -> None:
        assert extract_json_text("JSON なしの文章") is None

    def test_dict_message_with_content_blocks(self) -> None:
        message = {
            "content": [
                {"text": _START},
                {"text": json.dumps({"result": "pass"}) + _END},
            ]
        }
        assert extract_json_text(message) is not None


class TestParseToukiReviewResult:
    def test_full_pass(self) -> None:
        r = parse_touki_review_result(_GOOD_MARKER)
        assert r.result == "pass"
        assert r.confidence == pytest.approx(0.95)
        assert "氏名" in r.explanation
        assert r.advice == "問題ありません。"
        assert r.comparisons == (
            Comparison("source", "債務者氏名", "山田一郎"),
            Comparison("target", "顧客氏名", "山田一郎"),
        )

    def test_fail_state(self) -> None:
        r = parse_touki_review_result(
            _wrapped({"result": "fail", "confidence": 0.2})
        )
        assert r.result == "fail"
        assert r.confidence == pytest.approx(0.2)
        assert r.comparisons == ()

    def test_undeterminable_state(self) -> None:
        r = parse_touki_review_result(_wrapped({"result": "undeterminable"}))
        assert r.result == "undeterminable"
        assert r.confidence == pytest.approx(0.5)  # default

    def test_fallback_json_without_markers(self) -> None:
        text = "説明 " + json.dumps({"result": "pass", "confidence": 0.8}) + " おわり"
        r = parse_touki_review_result(text)
        assert r.result == "pass"
        assert r.confidence == pytest.approx(0.8)

    def test_confidence_clamped_high(self) -> None:
        r = parse_touki_review_result(
            json.dumps({"result": "pass", "confidence": 1.5})
        )
        assert r.confidence == 1.0

    def test_confidence_clamped_low(self) -> None:
        r = parse_touki_review_result(
            json.dumps({"result": "pass", "confidence": -0.2})
        )
        assert r.confidence == 0.0

    def test_confidence_invalid_defaults(self) -> None:
        r = parse_touki_review_result(
            json.dumps({"result": "pass", "confidence": "高い"}, ensure_ascii=False)
        )
        assert r.confidence == pytest.approx(0.5)

    def test_missing_fields_default(self) -> None:
        r = parse_touki_review_result(json.dumps({"result": "undeterminable"}))
        assert r.explanation == ""
        assert r.advice == ""
        assert r.comparisons == ()
        assert r.confidence == pytest.approx(0.5)

    def test_result_uppercase_normalized(self) -> None:
        r = parse_touki_review_result(json.dumps({"result": "PASS"}))
        assert r.result == "pass"

    def test_invalid_result_raises(self) -> None:
        with pytest.raises(ToukiParseError):
            parse_touki_review_result(json.dumps({"result": "maybe"}))

    def test_missing_result_raises(self) -> None:
        with pytest.raises(ToukiParseError):
            parse_touki_review_result(json.dumps({"confidence": 0.9}))

    def test_no_json_raises(self) -> None:
        with pytest.raises(ToukiParseError):
            parse_touki_review_result("JSON のない文章です")

    def test_invalid_json_raises(self) -> None:
        with pytest.raises(ToukiParseError):
            parse_touki_review_result(_START + "{bad json}" + _END)

    def test_non_object_json_raises(self) -> None:
        with pytest.raises(ToukiParseError):
            parse_touki_review_result(_START + "[1,2,3]" + _END)
