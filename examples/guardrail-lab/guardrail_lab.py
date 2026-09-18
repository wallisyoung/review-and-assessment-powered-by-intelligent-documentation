"""
Amazon Bedrock Guardrails 动手实验（boto3）

验证 docs/research/aws-bedrock-guardrails-mechanism.md 的三个结论：
  [1] text 中的 PII 会被干预（BLOCK / ANONYMIZE）—— 阳性对照
  [2] 日本语氏名/住址不在内置实体清单 —— 日文实体缺位
  [3] PDF 以 document 块直传时，敏感信息过滤器不评估其内容 —— 主路径不被覆盖

实验设计（v3，双 guardrail 对照）：
  同一套实体（EMAIL/PHONE/NAME/ADDRESS）分别建 BLOCK 版与 ANONYMIZE 版，
  相同文本各跑一遍。判读矩阵：
    - BLOCK 版命中、ANONYMIZE 版不命中 → ANONYMIZE 在独立 ApplyGuardrail
      输入方向存在行为问题（再试 inputAction 显式指定 / Converse 路径）
    - 两版都不命中 PHONE/NAME → 该实体类型对此文本未检出（换典型格式再试）
    - ANONYMIZE 版命中且 output 出现 {EMAIL} 占位符 → 一切正常
  注：GetGuardrail 响应键为 sensitiveInformationPolicy（非创建请求的
  sensitiveInformationPolicyConfig），回显按此读取。

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

ENTITY_TYPES = ("EMAIL", "PHONE", "NAME", "ADDRESS")

SAMPLE_TEXTS = {
    # [1a] 最小文本：隔离变量
    "email_only": "Contact: john@example.com.",
    # [1] 阳性对照：英文 + 邮箱/电话/姓名
    "en_pii": (
        "My name is John Smith. Please reply to john.smith@example.com "
        "or call +1 206-555-0100."
    ),
    # [2] 日文实体缺位：日语氏名/住址
    "ja_pii": "担当者は山田太郎です。住所は東京都千代田区一番町1-2-3です。",
}


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def create_guardrail(bedrock, name: str, action: str) -> str:
    resp = bedrock.create_guardrail(
        name=name,
        description=f"lab: PII {action} experiment (auto-cleanup)",
        sensitiveInformationPolicyConfig={
            "piiEntitiesConfig": [
                {"type": t, "action": action} for t in ENTITY_TYPES
            ],
        },
        blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
        blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
    )
    gid = resp["guardrailId"]
    print(f"[create:{action}] guardrailId={gid} (DRAFT)")
    # 诊断：回显服务端实际存储的 PII 配置。
    # 注意 GetGuardrail 响应键是 sensitiveInformationPolicy（内层 piiEntities），
    # 与创建请求的 sensitiveInformationPolicyConfig.piiEntitiesConfig 不同名。
    stored = bedrock.get_guardrail(guardrailIdentifier=gid)
    print(f"[create:{action}] response keys: {sorted(stored.keys())}")
    sip = stored.get("sensitiveInformationPolicy",
                     stored.get("sensitiveInformationPolicyConfig"))
    print(f"[create:{action}] stored sensitive information policy:")
    print(dump(sip))
    return gid


def run_apply_guardrail(brt, gid: str, action: str, label: str, text: str) -> None:
    print(f"\n=== ApplyGuardrail [{action}/{label}] ===")
    print(f"input : {text}")
    resp = brt.apply_guardrail(
        guardrailIdentifier=gid,
        guardrailVersion="DRAFT",
        source="INPUT",
        content=[{"text": {"text": text}}],
    )
    print(f"action: {resp['action']}")
    outputs = resp.get("output", [])
    if outputs:
        for out in outputs:
            if "text" in out:
                print(f"output: {out['text']}")
    else:
        print("output: (empty — 无任何干预/脱敏输出)")
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
    ts = int(time.time())
    gids = {}
    try:
        # 双 guardrail 对照：BLOCK 版与 ANONYMIZE 版
        gids["BLOCK"] = create_guardrail(bedrock, f"lab-gr-block-{ts}", "BLOCK")
        gids["ANONYMIZE"] = create_guardrail(bedrock, f"lab-gr-anon-{ts}", "ANONYMIZE")

        for label, text in SAMPLE_TEXTS.items():
            for action in ("BLOCK", "ANONYMIZE"):
                run_apply_guardrail(brt, gids[action], action, label, text)

        if args.converse:
            gid = gids["ANONYMIZE"]
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
        for action, gid in gids.items():
            bedrock.delete_guardrail(guardrailIdentifier=gid)
            print(f"\n[cleanup] deleted {action} guardrail {gid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
