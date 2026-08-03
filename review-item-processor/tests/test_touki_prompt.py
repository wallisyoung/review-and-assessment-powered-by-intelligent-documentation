"""登記審査プロンプトビルダーの单元テスト（AWS/LLM 不要）。"""

from touki.prompt import ToukiDocument, build_touki_review_prompt, render_case_data


def test_prompt_contains_rule() -> None:
    p = build_touki_review_prompt(
        rule_name="債務者氏名の一致",
        rule_text="「抵当権設定契約証書：表面」の「債務者氏名」と「案件情報」の「顧客氏名」が一致すること。",
        documents=[ToukiDocument("抵当権設定契約証書", "teitou.pdf")],
        case_data={"案件情報": {"顧客氏名": "山田一郎"}},
    )
    assert "債務者氏名の一致" in p
    assert "顧客氏名" in p  # rule text
    assert "抵当権設定契約証書" in p
    assert "teitou.pdf" in p
    assert "山田一郎" in p  # case data rendered


def test_prompt_contains_output_schema_and_markers() -> None:
    p = build_touki_review_prompt(
        rule_name="r", rule_text="t", documents=[], case_data=None
    )
    assert "<<JSON_START>>" in p
    assert "<<JSON_END>>" in p
    assert '"result": "pass" | "fail" | "undeterminable"' in p
    assert '"comparisons"' in p
    assert '"advice"' in p


def test_prompt_contains_normalization_and_undeterminable_guidance() -> None:
    p = build_touki_review_prompt(
        rule_name="r", rule_text="t", documents=[], case_data=None
    )
    assert "和暦" in p and "西暦" in p
    assert "undeterminable" in p  # 判定基準に3状態が言及されている


def test_prompt_multiple_documents_listed() -> None:
    p = build_touki_review_prompt(
        rule_name="r",
        rule_text="t",
        documents=[
            ToukiDocument("抵当権設定契約証書", "a.pdf"),
            ToukiDocument("登記簿謄本", "b.pdf"),
        ],
        case_data=None,
    )
    assert "抵当権設定契約証書" in p
    assert "登記簿謄本" in p
    assert "a.pdf" in p and "b.pdf" in p


def test_prompt_no_documents_shows_none() -> None:
    p = build_touki_review_prompt(
        rule_name="r", rule_text="t", documents=[], case_data=None
    )
    # 空リスト時は (なし) となる
    assert "(なし)" in p


def test_render_case_data_none() -> None:
    assert render_case_data(None) == "(なし)"


def test_render_case_data_dict_japanese_preserved() -> None:
    out = render_case_data({"顧客氏名": "山田一郎"})
    assert "山田一郎" in out  # ensure_ascii=False で日本語が残る
    assert "顧客氏名" in out


def test_render_case_data_unserializable_fallback() -> None:
    class NotSerializable:
        pass

    out = render_case_data(NotSerializable())
    assert isinstance(out, str) and out != "(なし)"
