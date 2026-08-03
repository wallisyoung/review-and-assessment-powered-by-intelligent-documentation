"""A3a 正規化ヘルパーの单元テスト。

AWS / LLM / DB 不要。登記サンプルデータ（touki-check-data.json）と
harness プロンプトの正規化ルールに基づくケースを網羅する。
"""

from datetime import date

import pytest

from tools.normalization import (
    date_not_after,
    dates_equal,
    nfkc,
    normalize_name,
    parse_japanese_date,
    parse_japanese_year,
    parse_rate,
    parse_yen_amount,
)


class TestNormalizeName:
    def test_fullwidth_space_removed(self) -> None:
        assert normalize_name("山田　一郎") == "山田一郎"

    def test_halfwidth_space_removed(self) -> None:
        assert normalize_name("山田 一郎") == "山田一郎"

    def test_multiple_spaces(self) -> None:
        assert normalize_name("山田　 二") == "山田二"

    def test_no_change(self) -> None:
        assert normalize_name("山田一郎") == "山田一郎"

    def test_empty(self) -> None:
        assert normalize_name("") == ""


class TestParseYenAmount:
    def test_with_commas_and_unit(self) -> None:
        assert parse_yen_amount("30,000,000円") == 30000000

    def test_with_kin_and_unit(self) -> None:
        assert parse_yen_amount("金30,000,000円") == 30000000

    def test_without_commas(self) -> None:
        assert parse_yen_amount("30000000円") == 30000000

    def test_bare_digits(self) -> None:
        assert parse_yen_amount("30000000") == 30000000

    def test_embedded_in_sentence(self) -> None:
        assert parse_yen_amount("債権額 金30,000,000円 利息") == 30000000

    def test_no_digits_returns_none(self) -> None:
        assert parse_yen_amount("円のみ") is None


class TestParseRate:
    def test_halfwidth_percent(self) -> None:
        assert parse_rate("0.475%") == pytest.approx(0.475)

    def test_fullwidth_percent(self) -> None:
        assert parse_rate("0.475％") == pytest.approx(0.475)

    def test_with_year_prefix(self) -> None:
        assert parse_rate("年 0.475％") == pytest.approx(0.475)

    def test_integer_rate(self) -> None:
        assert parse_rate("年1.5%") == pytest.approx(1.5)

    def test_penalty_rate(self) -> None:
        assert parse_rate("年14.6％") == pytest.approx(14.6)

    def test_no_number_returns_none(self) -> None:
        assert parse_rate("％のみ") is None


class TestParseJapaneseDate:
    def test_wareki_halfwidth(self) -> None:
        assert parse_japanese_date("平成31年3月29日") == date(2019, 3, 29)

    def test_wareki_fullwidth_digits(self) -> None:
        assert parse_japanese_date("平成２０年１１月１日") == date(2008, 11, 1)

    def test_seireki_with_year_month_day(self) -> None:
        assert parse_japanese_date("2019年03月29日") == date(2019, 3, 29)

    def test_seireki_with_seireki_prefix(self) -> None:
        assert parse_japanese_date("（西暦）2019年03月29日") == date(2019, 3, 29)

    def test_embedded_in_text(self) -> None:
        assert parse_japanese_date(
            "原因 平成31年3月29日金銭消費貸借同日設定"
        ) == date(2019, 3, 29)

    def test_iso_like(self) -> None:
        assert parse_japanese_date("2008-11-01") == date(2008, 11, 1)

    def test_slash_format(self) -> None:
        assert parse_japanese_date("2019/03/29") == date(2019, 3, 29)

    def test_reiwa_first_year(self) -> None:
        assert parse_japanese_date("令和元年5月1日") == date(2019, 5, 1)

    def test_invalid_date_returns_none(self) -> None:
        assert parse_japanese_date("平成31年2月30日") is None

    def test_no_date_returns_none(self) -> None:
        assert parse_japanese_date("日付なし") is None


class TestParseJapaneseYear:
    def test_reiwa_gannen(self) -> None:
        assert parse_japanese_year("令和元年") == 2019

    def test_wareki_year(self) -> None:
        assert parse_japanese_year("平成20年") == 2008

    def test_seireki_year(self) -> None:
        assert parse_japanese_year("2019年") == 2019

    def test_no_year_returns_none(self) -> None:
        assert parse_japanese_year("年度なし") is None


class TestDateComparison:
    def test_wareki_seireki_equal(self) -> None:
        assert dates_equal("平成31年3月29日", "2019年03月29日") is True

    def test_fullwidth_equal(self) -> None:
        assert dates_equal("平成２０年５月２０日", "2008-05-20") is True

    def test_not_equal(self) -> None:
        assert dates_equal("平成31年3月29日", "2019年03月30日") is False

    def test_unparseable_returns_none(self) -> None:
        assert dates_equal("日付不明", "2019年03月29日") is None

    def test_not_after_true(self) -> None:
        # 規則16: 表題部原因日付(2008-11-01) <= 融資実行予定日(2019-03-29)
        assert date_not_after("平成２０年１１月１日", "2019年03月29日") is True

    def test_not_after_false(self) -> None:
        assert date_not_after("2025年01月01日", "2019年03月29日") is False

    def test_not_after_unparseable(self) -> None:
        assert date_not_after("不明", "2019年03月29日") is None


def test_nfkc_basic() -> None:
    assert nfkc("　abc　") == "abc"
    assert nfkc("１２３") == "123"
