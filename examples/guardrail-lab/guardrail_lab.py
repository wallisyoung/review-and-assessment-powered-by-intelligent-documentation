"""
Amazon Bedrock Guardrails 动手实验（boto3）

验证 docs/research/aws-bedrock-guardrails-mechanism.md 的三个结论：
  [1] text 中的 PII（EMAIL/PHONE 等）会被 ANONYMIZE（占位符替换）—— 阳性对照
  [2] 日本语氏名/住址不在内置实体清单，大概率不命中 —— 日文实体缺位
  [3] PDF 以 document 块直传时，敏感信息过滤器不评估其内容 —— 主路径不被覆盖

前置：
  - IAM: bedrock:CreateGuardrail / ApplyGuardrail / DeleteGuardrail
         （--converse 步骤另需模型调用权限，如 bedrock:Converse）
  - 费用: guardrail 评估约 $0.10/1000字符单位；ApplyGuardrail 不调模型、无模型费用
  - 实验 [3] 需要一个内含明文 PII（如 email）的单页 PDF，用 --pdf 指定

用法：
  python guardrail_lab.py --region us-east-1
  python guardrail_lab.py --region us-east-1 --converse \
      --model-id "global.anthropic.claude-sonnet-4-6" --pdf path/to/sample.pdf
"""

import argparse
import json
import sys
import time

import boto3
from botocore.exceptions import ClientError

SAMPLE_TEXTS = {
    # [1] 阳性对照：英文 + 邮箱/电话（内置实体）
    "en_pii": (
        "My name is John Smith. Please reply to john.smith@example.com "
        "or call +1 206-555-0100."
    ),
    # [2] 日文实体缺位：日语氏名/住址
    "ja_pii": "担当者は山田太郎です。住所は東京都千代田区一番町1-2-3です。",
}


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def create_guardrail(bedrock, name: str) -> str:
    resp = bedrock.create_guardrail(
        name=name,
        description="lab: PII anonymize experiment (auto-cleanup)",
        sensitiveInformationPolicyConfig={
            "piiEntitiesConfig": [
                # action 现行枚举仅 BLOCK / ANONYMIZE / NONE（MASK 已被 ANONYMIZE 取代）
                {"type": "EMAIL", "action": "ANONYMIZE"},
                {"type": "PHONE", "action": "ANONYMIZE"},
                {"type": "NAME", "action": "ANONYMIZE"},
                {"type": "ADDRESS", "action": "ANONYMIZE"},
            ],
        },
        blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
        blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
    )
    gid = resp["guardrailId"]
    print(f"[create] guardrailId={gid} (DRAFT)")
    return gid


def run_apply_guardrail(brt, gid: str, label: str, text: str) -> None:
    print(f"\n=== ApplyGuardrail [{label}] ===")
    print(f"input : {text}")
    resp = brt.apply_guardrail(
        guardrailIdentifier=gid,
        guardrailVersion="DRAFT",
        source="INPUT",
        content=[{"text": {"text": text}}],
    )
    print(f"action: {resp['action']}")
    for out in resp.get("output", []):
        if "text" in out:
            print(f"output: {out['text']}")
    assessments = resp.get("assessments", [])
    if assessments:
        print("assessments:")
        print(dump(assessments))


def run_converse(brt, gid: str, model_id: str, label: str, content) -> None:
    print(f"\n=== Converse + guardrail [{label}] ===")
    try:
        resp = brt.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": content}],
            guardrailConfig={
                "guardrailIdentifier": gid,
                "guardrailVersion": "DRAFT",
                "trace": "enabled",
            },
        )
        print(f"stopReason: {resp.get('stopReason')}")
        msg = resp.get("output", {}).get("message", {})
        for block in msg.get("content", []):
            if "text" in block:
                print(f"assistant: {block['text'][:500]}")
        trace = resp.get("trace")
        if trace:
            print("trace.guardrail.sensitiveInformationPolicy:")
            print(dump(trace.get("guardrail", {}).get(
                "sensitiveInformationPolicy", "(no matches)")))
    except ClientError as e:
        # 输入被 BLOCK 时（取决于路径）可能以异常形式返回
        print(f"ClientError: {e.response['Error']['Code']}: "
              f"{e.response['Error'].get('Message', '')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--converse", action="store_true",
                    help="带模型路径：验证模型实际收到的是脱敏后文本")
    ap.add_argument("--model-id", default="global.anthropic.claude-sonnet-4-6")
    ap.add_argument("--pdf",
                    help="含明文 PII 的单页 PDF 路径：验证 document 块不被评估 [3]")
    args = ap.parse_args()

    bedrock = boto3.client("bedrock", region_name=args.region)
    brt = boto3.client("bedrock-runtime", region_name=args.region)
    name = f"lab-guardrail-{int(time.time())}"

    gid = create_guardrail(bedrock, name)
    try:
        # [1] 阳性对照 & [2] 日文实体缺位（不调模型，零模型费用）
        run_apply_guardrail(brt, gid, "en_pii", SAMPLE_TEXTS["en_pii"])
        run_apply_guardrail(brt, gid, "ja_pii", SAMPLE_TEXTS["ja_pii"])

        if args.converse:
            # 模型收到的 prompt 已被脱敏（ANONYMIZE 占位符，trace 可见命中项）
            run_converse(brt, gid, args.model_id, "en_pii",
                         [{"text": SAMPLE_TEXTS["en_pii"]}])
            if args.pdf:
                with open(args.pdf, "rb") as f:
                    pdf_bytes = f.read()
                # [3] 决定性对照：同样的 PII 放进 document 块 —— trace 应无命中
                run_converse(brt, gid, args.model_id, "pdf_document", [
                    {"text": "Extract any email address in this document."},
                    {"document": {
                        "name": "LabDocument",
                        "format": "pdf",
                        "source": {"bytes": pdf_bytes},
                        "citations": {"enabled": False},
                    }},
                ])
    finally:
        bedrock.delete_guardrail(guardrailIdentifier=gid)
        print(f"\n[cleanup] deleted guardrail {gid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
