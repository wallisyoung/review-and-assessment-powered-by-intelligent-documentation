"""登記 touki パスの冒煙テスト（デプロイ不要・Bedrock のみ）。

agent.py の登記ブランチ（_execute_review_core → _execute_touki_review → Strands Agent
→ parse_touki_review_result）を、サンプル1件のスキャンと案件データで実際に動かす。

使い方:
  cd review-item-processor
  uv sync --extra evals                 # 初回のみ
  # AWS 認証情報（Bedrock 権限）を設定:
  #   export AWS_PROFILE=<profile-with-bedrock>   (既定 region は us-west-2)
  uv run python smoke_touki.py <スキャンファイルのパス>

例:
  uv run python smoke_touki.py ./fixtures/teitou.pdf

結果の result が pass/fail/undeterminable で返ってくれば、touki パスの結線は成功。
"""

from __future__ import annotations

import json
import sys

from agent import process_review_from_local

# サンプル案件情報（touki-check-data.json の「案件情報」相当）
CASE_DATA = {
    "案件情報": {
        "顧客氏名": "山田一郎",
        "借入情報": {
            "融資実行予定日": "2019年03月29日",
            "総借入希望額": "30,000,000円",
            "加減算後‗適用金利": "0.475%",
        },
    }
}

# 比較ルール1（例）: 債務者氏名の一致
RULE_NAME = "債務者氏名の一致"
RULE_TEXT = (
    "「抵当権設定契約証書：表面」の「債務者氏名」と「案件情報」の「顧客氏名」が一致すること。"
    "正規化：氏名の全角・半角スペースは除去して比較。"
)


def main() -> None:
    if len(sys.argv) < 2:
        print("使い方: uv run python smoke_touki.py <スキャンファイルのパス>")
        sys.exit(1)

    scan_path = sys.argv[1]
    print(f"[smoke] scan = {scan_path}")
    print(f"[smoke] rule = {RULE_NAME}")
    print("[smoke] calling process_review_from_local (touki branch) ...")

    result = process_review_from_local(
        document_paths=[scan_path],
        check_name=RULE_NAME,
        check_description=RULE_TEXT,
        language_name="日本語",
        case_data=CASE_DATA,
        document_types=["抵当権設定契約証書"],
        document_ids=["smoke-doc-1"],
    )

    print("[smoke] result:")
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
