"""登記審査の agent runner（LLM 呼び出しを注入可能な seam）。

LLM 呼び出しを `model_fn` として外部から注入する:
- 本番（Bedrock 環境）: `model_fn` は Strands `Agent(model=BedrockModel, tools=[正規化tool])`
  を構築して呼び出し、`agent(prompt).message` を返す。
- ローカル（モック）: `model_fn` は固定の JSON を返す。

これにより AWS / Strands に依存せず、prompt 構築 → model 呼び出し → 結果解析 の結線を検証できる。
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

from .models import ToukiReviewResult
from .parsing import parse_touki_review_result
from .prompt import ToukiDocument, build_touki_review_prompt

# model_fn: 構築された prompt と投入ドキュメントを受け取り、agent の生メッセージ
# （parse_touki_review_result が受理する文字列／dict）を返す。
ModelFn = Callable[[str, Sequence[ToukiDocument]], Any]


def run_touki_review(
    rule_name: str,
    rule_text: str,
    documents: Sequence[ToukiDocument],
    case_data: Any,
    model_fn: ModelFn,
    language_name: str = "日本語",
) -> ToukiReviewResult:
    """1つの比較ルールを審査し、ToukiReviewResult を返す。

    Args:
        rule_name: 審査項目名（比較ルールの短縮名）。
        rule_text: 比較ルールの本文（比較元/比較先/正規化要点）。
        documents: 投入するスキャン書類（文書タイプ付き）。
        case_data: 案件情報（システム抽出データ）。
        model_fn: LLM 呼び出し。prompt と documents を受け取り生メッセージを返す。
        language_name: 出力言語。

    Returns:
        審査結果（ToukiReviewResult）。
    """
    prompt = build_touki_review_prompt(
        rule_name, rule_text, documents, case_data, language_name
    )
    raw_message = model_fn(prompt, documents)
    return parse_touki_review_result(raw_message)
