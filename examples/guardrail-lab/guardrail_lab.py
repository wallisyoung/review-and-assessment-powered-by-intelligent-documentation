"""
Amazon Bedrock Guardrails 动手实验（boto3）

验证 docs/research/aws-bedrock-guardrails-mechanism.md 的三个结论：
  [1] text 中的 PII 会被干预（BLOCK / ANONYMIZE）—— 阳性对照
  [2] 日语文本实测：一般实体 NAME/ADDRESS 可检出日语氏名/住址（run16 已证）
  [3] PDF 以 document 块直传时，敏感信息过滤器不评估其内容 —— 主路径不被覆盖

实验设计（v4）：
  BLOCK 版 / ANONYMIZE 版（含 email 正则实体）两个 guardrail。
  - BLOCK 版：source=INPUT 跑全部文本（检测能力的基准，run16 已全部命中）
  - ANONYMIZE 版：source=INPUT 与 source=OUTPUT 各跑一遍 —— 定位
    "INPUT 方向 ANONYMIZE 不评估（0 计费单元）"是方向性问题还是动作性问题；
    正则实体与内置实体对照 —— 定问题是否只在内置 PII 检测器路径。
  - --converse：带模型路径验证"模型收到脱敏后文本"（ANONYMIZE 的主用途）

判读：
  ANON/OUTPUT 命中且 output 出现 {EMAIL} 占位符，而 ANON/INPUT 不命中
    → 独立 ApplyGuardrail 的 INPUT 方向跳过 ANONYMIZE（待向 AWS 确认是否 by design）
  正则实体在 INPUT 方向命中 → 内置 PII 检测器特有问题，正则可作 workaround
  Converse 的 trace 出现 ANONYMIZED → 模型调用路径不受影响

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

"""
TODO:
id	prompt	expected_action	attribute_type	variant
PII-001	私の名前は山田太郎です。登録をお願いします。	BLOCK	NAME	漢字・スペースなし
PII-033	京都府京都市中京区寺町通御池上る上本能寺前町488番地	BLOCK	ADDRESS	住所・伝統的住所表記
PII-056	生年月日は平成１２年８月３１日です。	BLOCK	BIRTHDAY	和暦・漢字・全角数字（平成）
PII-077	連絡先は０８０ー９８７６ー５４３２になります。	BLOCK	PHONE	携帯・全角数字・全角ハイフン
PII-100	株式会社サンプルのサポート窓口はどこですか？	NONE	NONE	正常文・架空の会社名（誤検知回避）

上面是一批测试用例代表性的5条，覆盖了所有attribute_type的类型，需要测试的是input时的BLOCK动作。
测试数据存放在一个utf-8编码的csv文件中，也可以使用shift_jis的xlsx文件，由你决定。
输出结果csv或者xlsx文件，针对每一行追加如下列：match type action deleted test_resault(OK/NG)。
请在本程序中实现上述测试功能。
"""

import argparse
import json
import sys
import time

import boto3
from botocore.exceptions import ClientError

ENTITY_TYPES = ("EMAIL", "PHONE", "NAME", "ADDRESS")
EMAIL_REGEX = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"

SAMPLE_TEXTS = {
    # [1a] 最小文本：隔离变量
    "email_only": "Contact: john@example.com.",
    # [1] 阳性对照：英文 + 邮箱/电话/姓名
    "en_pii": (
        "My name is John Smith. Please reply to john.smith@example.com "
        "or call +1 206-555-0100."
    ),
    # [2] 日语文本：一般实体对日语氏名/住址的检出（run16 已证可命中）
    "ja_pii": "担当者は山田太郎です。住所は東京都千代田区一番町1-2-3です。",
}


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def create_block_guardrail(bedrock, name: str) -> str:
    resp = bedrock.create_guardrail(
        name=name,
        description="lab: PII BLOCK baseline (auto-cleanup)",
        sensitiveInformationPolicyConfig={
            "piiEntitiesConfig": [
                {"type": t, "action": "BLOCK"} for t in ENTITY_TYPES
            ],
        },
        blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
        blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
    )
    gid = resp["guardrailId"]
    print(f"[create:BLOCK] guardrailId={gid} (DRAFT)")
    return gid


def create_anonymize_guardrail(bedrock, name: str) -> str:
    resp = bedrock.create_guardrail(
        name=name,
        description="lab: PII ANONYMIZE + email regex (auto-cleanup)",
        sensitiveInformationPolicyConfig={
            "piiEntitiesConfig": [
                {"type": t, "action": "ANONYMIZE"} for t in ENTITY_TYPES
            ],
            # 正则实体对照：若 INPUT 方向正则可 ANONYMIZE 而内置实体不可，
            # 说明问题特定于内置 PII 检测器路径，且正则是可用 workaround。
            "regexesConfig": [
                {"name": "email_regex", "pattern": EMAIL_REGEX,
                 "action": "ANONYMIZE", "description": "lab email pattern"},
            ],
        },
        blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
        blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
    )
    gid = resp["guardrailId"]
    print(f"[create:ANONYMIZE] guardrailId={gid} (DRAFT)")
    # 诊断：回显服务端实际存储的 PII 配置。
    # 注意 GetGuardrail 响应键是 sensitiveInformationPolicy（内层 piiEntities/regexes），
    # 与创建请求的 sensitiveInformationPolicyConfig.piiEntitiesConfig 不同名。
    stored = bedrock.get_guardrail(guardrailIdentifier=gid)
    print("[create:ANONYMIZE] stored sensitive information policy:")
    print(dump(stored.get("sensitiveInformationPolicy",
                          stored.get("sensitiveInformationPolicyConfig"))))
    return gid


def run_apply_guardrail(brt, gid: str, label: str, text: str,
                        source: str = "INPUT") -> None:
    print(f"\n=== ApplyGuardrail [{label}] source={source} ===")
    print(f"input : {text}")
    resp = brt.apply_guardrail(
        guardrailIdentifier=gid,
        guardrailVersion="DRAFT",
        source=source,
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
        gids["BLOCK"] = create_block_guardrail(bedrock, f"lab-gr-block-{ts}")
        gids["ANONYMIZE"] = create_anonymize_guardrail(
            bedrock, f"lab-gr-anon-{ts}")

        for label, text in SAMPLE_TEXTS.items():
            # BLOCK 基准：仅 INPUT（run16 已确认全部命中）
            run_apply_guardrail(brt, gids["BLOCK"], f"BLOCK/{label}", text,
                                "INPUT")
            # ANONYMIZE：INPUT 与 OUTPUT 双方向对照
            run_apply_guardrail(brt, gids["ANONYMIZE"],
                                f"ANON/{label}", text, "INPUT")
            run_apply_guardrail(brt, gids["ANONYMIZE"],
                                f"ANON/{label}", text, "OUTPUT")

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
