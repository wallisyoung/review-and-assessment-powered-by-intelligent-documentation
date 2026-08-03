"""登記審査 agent runner のテスト（モックモデル注入・AWS 不要）。

model_fn に canned JSON を返すモックを注入し、
prompt 構築 → model 呼び出し → 結果解析 の結線を検証する。
"""

import json

import pytest

from touki.agent_runner import run_touki_review
from touki.parsing import ToukiParseError
from touki.prompt import ToukiDocument

_START = "<<JSON_START>>"
_END = "<<JSON_END>>"


def _mock_model(obj: dict, captured: dict | None = None):
    """canned JSON を返すモック model_fn。captured を与えれば入力を記録する。"""

    def model_fn(prompt: str, documents):
        if captured is not None:
            captured["prompt"] = prompt
            captured["num_documents"] = len(list(documents))
        return _START + json.dumps(obj, ensure_ascii=False) + _END

    return model_fn


def test_run_touki_review_pass() -> None:
    fn = _mock_model(
        {
            "result": "pass",
            "confidence": 0.95,
            "explanation": "正規化後、氏名は一致。",
            "advice": "問題ありません。",
            "comparisons": [
                {"role": "source", "name": "債務者氏名", "value": "山田一郎"},
                {"role": "target", "name": "顧客氏名", "value": "山田一郎"},
            ],
        }
    )
    r = run_touki_review(
        "債務者氏名の一致",
        "「抵当権設定契約証書：表面」の「債務者氏名」と「案件情報」の「顧客氏名」が一致すること。",
        [ToukiDocument("抵当権設定契約証書", "teitou.pdf")],
        {"案件情報": {"顧客氏名": "山田一郎"}},
        fn,
    )
    assert r.result == "pass"
    assert r.confidence == pytest.approx(0.95)
    assert r.advice == "問題ありません。"
    assert r.comparisons[0].value == "山田一郎"
    assert r.comparisons[1].role == "target"


def test_run_touki_review_undeterminable() -> None:
    fn = _mock_model({"result": "undeterminable", "explanation": "欄が空白"})
    r = run_touki_review("利率", "ルール...", [], None, fn)
    assert r.result == "undeterminable"


def test_run_touki_review_fail() -> None:
    fn = _mock_model({"result": "fail", "confidence": 0.3})
    r = run_touki_review("債権額", "...", [ToukiDocument("抵当権設定契約証書", "a.pdf")], {}, fn)
    assert r.result == "fail"
    assert r.confidence == pytest.approx(0.3)


def test_run_touki_review_invalid_result_raises() -> None:
    fn = _mock_model({"result": "maybe"})
    with pytest.raises(ToukiParseError):
        run_touki_review("r", "...", [], None, fn)


def test_model_fn_receives_built_prompt_with_rule_docs_and_case() -> None:
    captured: dict = {}
    fn = _mock_model({"result": "pass"}, captured)
    run_touki_review(
        "債務者氏名の一致",
        "比較ルール本文",
        [
            ToukiDocument("抵当権設定契約証書", "a.pdf"),
            ToukiDocument("登記簿謄本", "b.pdf"),
        ],
        {"案件情報": {"顧客氏名": "山田一郎"}},
        fn,
    )
    assert "債務者氏名の一致" in captured["prompt"]
    assert "比較ルール本文" in captured["prompt"]
    assert "抵当権設定契約証書" in captured["prompt"]
    assert "登記簿謄本" in captured["prompt"]
    assert "山田一郎" in captured["prompt"]  # case data rendered
    assert captured["num_documents"] == 2
