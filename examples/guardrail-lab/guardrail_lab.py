"""
Amazon Bedrock Guardrails 动手实验（boto3）

两种运行形态：

1. 交互实验模式（默认）
   验证 docs/research/aws-bedrock-guardrails-mechanism.md 的三个结论：
     [1] text 中的 PII 会被干预（BLOCK / ANONYMIZE）—— 阳性对照
     [2] 日语文本实测：一般实体 NAME/ADDRESS 可检出日语氏名/住址（run16 已证）
     [3] PDF 以 document 块直传时，敏感信息过滤器不评估其内容 —— 主路径不被覆盖
   BLOCK / ANONYMIZE（含 email 正则）双 guardrail，ANONYMIZE 版对每条文本
   按 source=INPUT 与 OUTPUT 各跑一遍 —— 定位 run16 发现的
   "INPUT 方向 ANONYMIZE 不评估（0 计费单元）"是方向性问题还是动作性问题。

2. 批量判定模式（--batch <csv>）
   对一批测试用例逐行执行 ApplyGuardrail(source=INPUT, BLOCK)，判定并输出结果。
   输入 CSV（UTF-8 with BOM）列：id,prompt,expected_action,attribute_type,variant
   （--batch/--pdf 指定的文件必须位于脚本所在目录内；输入文件名须为 ASCII
   字母/数字/_/- 组成）
   输出 CSV 写入脚本同目录下 <输入名>_result.csv（同编码），追加列：
   match,type,action,detected,test_result
   判定规则（严格）：
     - expected_action=BLOCK：须 GUARDRAIL_INTERVENED 且命中实体 type 与
       attribute_type 一致才算 OK；干预但类型不符记 NG
     - expected_action=NONE：完全无干预且无命中为 OK；任何命中记 NG（误检）
   attribute_type 必须是 Guardrails 合法实体枚举值（运行时从 SDK 服务模型读取，
   当前 31 种：ADDRESS/AGE/AWS_ACCESS_KEY/.../VEHICLE_IDENTIFICATION_NUMBER，
   无 BIRTHDAY/DATE_OF_BIRTH——生年月日类用例应将 expected_action 设为 NONE
   作阴性对照）。无映射的 attribute_type 不配置对应实体，并打印警告。
   API 异常行 test_result 记 "ERROR:<code>"，不中断整批。

前置：
  - IAM: bedrock:CreateGuardrail / ApplyGuardrail / DeleteGuardrail
         （--converse 步骤另需模型调用权限，如 bedrock:Converse）
  - 费用: guardrail 评估约 $0.10/1000字符单位；ApplyGuardrail 不调模型、无模型费用
  - 交互实验 [3] 需要一个内含明文 PII（如 email）的单页 PDF，用 --pdf 指定

用法：
  python guardrail_lab.py --region us-east-1
  python guardrail_lab.py --region us-east-1 --converse \
      --model-id "global.anthropic.claude-sonnet-4-6" --pdf path/to/sample.pdf
  python guardrail_lab.py --region us-east-1 --batch testcases.csv
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

ENTITY_TYPES = ("EMAIL", "PHONE", "NAME", "ADDRESS")
EMAIL_REGEX = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"

BATCH_INPUT_COLUMNS = ["id", "prompt", "expected_action", "attribute_type", "variant"]
BATCH_RESULT_COLUMNS = ["match", "type", "action", "detected", "test_result"]

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


def valid_entity_types(bedrock) -> set:
    """从当前 SDK 的服务模型读取 PII 实体合法枚举（自适配 SDK 版本）。"""
    op = bedrock.meta.service_model.operation_model("CreateGuardrail")
    cfg = (op.input_shape.members["sensitiveInformationPolicyConfig"]
           .members["piiEntitiesConfig"].member)
    return set(cfg.members["type"].enum)


def create_guardrail(bedrock, name: str, entities, regexes=None) -> str:
    policy = {"piiEntitiesConfig": [{"type": t, "action": "BLOCK"}
                                    for t in entities]}
    if regexes:
        policy["regexesConfig"] = regexes
    resp = bedrock.create_guardrail(
        name=name,
        description="lab: guardrail experiment (auto-cleanup)",
        sensitiveInformationPolicyConfig=policy,
        blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
        blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
    )
    gid = resp["guardrailId"]
    print(f"[create:{name.rsplit('-', 2)[0]}] guardrailId={gid} (DRAFT)")
    # 诊断：回显服务端实际存储的 PII 配置。
    # 注意 GetGuardrail 响应键是 sensitiveInformationPolicy（内层 piiEntities/regexes），
    # 与创建请求的 sensitiveInformationPolicyConfig.piiEntitiesConfig 不同名。
    stored = bedrock.get_guardrail(guardrailIdentifier=gid)
    print("[create] stored sensitive information policy:")
    print(dump(stored.get("sensitiveInformationPolicy",
                          stored.get("sensitiveInformationPolicyConfig"))))
    return gid


def extract_pii_matches(resp) -> list:
    """从 ApplyGuardrail 响应提取 PII 命中项（match/type/action/detected）。"""
    matches = []
    for assessment in resp.get("assessments", []):
        sip = assessment.get("sensitiveInformationPolicy") or {}
        for entity in sip.get("piiEntities", []):
            matches.append({
                "match": entity.get("match", ""),
                "type": entity.get("type", ""),
                "action": entity.get("action", ""),
                "detected": str(entity.get("detected", "")),
            })
    return matches


def judge(expected_action: str, attribute_type: str,
          resp_action: str, matches: list) -> str:
    """严格判定：BLOCK 须干预且类型一致；NONE 须零干预零命中。"""
    expected = (expected_action or "").strip().upper()
    attr = (attribute_type or "").strip().upper()
    matched_types = {m["type"] for m in matches}
    intervened = resp_action == "GUARDRAIL_INTERVENED"
    if expected == "BLOCK":
        ok = intervened and attr in matched_types
    else:  # NONE
        ok = (not intervened) and not matches
    return "OK" if ok else "NG"


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


def resolve_input_path(raw: str, what: str) -> str:
    """入口校验：用户给出的输入文件必须位于脚本所在目录内（防路径穿越）。"""
    allowed = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    p = os.path.realpath(raw)
    if not p.startswith(allowed + os.sep):
        raise SystemExit(f"{what} 必须位于脚本目录内（{allowed}），已拒绝: {raw}")
    if not os.path.isfile(p):
        raise SystemExit(f"{what} 文件不存在: {raw}")
    return p


def load_testcases(path: str) -> list:
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [c for c in BATCH_INPUT_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f"[batch] 输入 CSV 缺少必需列: {missing}")
        return list(reader)


def write_results_csv(out_path: str, results: list) -> None:
    """写出结果 CSV（UTF-8 with BOM）。调用方须先完成输出路径校验。"""
    buf = io.StringIO(newline="")
    writer = csv.DictWriter(
        buf, fieldnames=BATCH_INPUT_COLUMNS + BATCH_RESULT_COLUMNS,
        extrasaction="ignore")
    writer.writeheader()
    writer.writerows(results)
    Path(out_path).write_text(buf.getvalue(), encoding="utf-8-sig", newline="")


def run_batch(bedrock, brt, csv_path: str) -> int:
    valid = valid_entity_types(bedrock)
    print(f"[batch] 当前 SDK 支持的 PII 实体枚举（{len(valid)} 种）")
    rows = load_testcases(csv_path)

    # 需要配置的实体 = CSV 中合法且期望 BLOCK 的 attribute_type 去重
    needed = sorted({
        (r["attribute_type"] or "").strip().upper()
        for r in rows
        if (r["attribute_type"] or "").strip().upper() in valid
        and (r["expected_action"] or "").strip().upper() == "BLOCK"
    })
    for r in rows:
        attr = (r["attribute_type"] or "").strip().upper()
        if attr and attr not in valid:
            print(f"[batch] 警告: {r.get('id')} 的 attribute_type={attr} "
                  f"不在实体枚举内，不配置该实体（该行应作阴性对照）")

    ts = int(time.time())
    gid = create_guardrail(bedrock, f"lab-gr-batch-{ts}", needed)
    results = []
    try:
        for r in rows:
            row_out = dict(r)
            try:
                resp = brt.apply_guardrail(
                    guardrailIdentifier=gid,
                    guardrailVersion="DRAFT",
                    source="INPUT",
                    content=[{"text": {"text": r["prompt"] or ""}}],
                )
                matches = extract_pii_matches(resp)
                verdict = judge(r["expected_action"], r["attribute_type"],
                                resp["action"], matches)
                row_out["match"] = " | ".join(m["match"] for m in matches) or "-"
                row_out["type"] = " | ".join(m["type"] for m in matches) or "-"
                row_out["action"] = " | ".join(m["action"] for m in matches) or "-"
                row_out["detected"] = " | ".join(m["detected"] for m in matches) or "-"
                row_out["test_result"] = verdict
            except ClientError as e:
                for col in BATCH_RESULT_COLUMNS[:-1]:
                    row_out[col] = "-"
                row_out["test_result"] = f"ERROR:{e.response['Error']['Code']}"
            results.append(row_out)
            print(f"[batch] {row_out.get('id')}: {row_out['test_result']}")
    finally:
        bedrock.delete_guardrail(guardrailIdentifier=gid)
        print(f"[cleanup] deleted batch guardrail {gid}")

    # 输出固定写入脚本所在目录：目录为常量（来自 __file__），文件名 stem 经
    # 字符白名单校验（仅 ASCII 字母数字-_，无点、无分隔符，".." 无法成形），
    # realpath 规范化后断言仍在允许目录内
    allowed_dir = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
    stem = os.path.splitext(os.path.basename(csv_path))[0]
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", stem):
        raise SystemExit(
            f"[batch] 输入文件名须为 ASCII 字母/数字/_/- 组成（当前: {stem!r}），"
            "以便安全生成结果文件名")
    out_path = os.path.join(allowed_dir, stem + "_result.csv")
    if os.path.dirname(os.path.realpath(out_path)) != allowed_dir:
        raise SystemExit(f"[batch] 输出路径越界，已拒绝: {out_path}")
    write_results_csv(out_path, results)

    counts = {}
    for r in results:
        v = r["test_result"] if r["test_result"] in ("OK", "NG") else "ERROR"
        counts[v] = counts.get(v, 0) + 1
    print(f"[batch] 完成 {len(results)} 行: "
          + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print(f"[batch] 结果已写入: {out_path}")
    return 0 if counts.get("NG", 0) == 0 and counts.get("ERROR", 0) == 0 else 1


def run_interactive(bedrock, brt, args) -> None:
    ts = int(time.time())
    gids = {}
    try:
        # BLOCK 基准版：固定四实体，仅 action=BLOCK
        gids["BLOCK"] = create_guardrail(bedrock, f"lab-gr-block-{ts}",
                                         ENTITY_TYPES)
        # ANONYMIZE 对照版：同实体全 ANONYMIZE + email 正则对照
        # （若 INPUT 方向正则可 ANONYMIZE 而内置实体不可，说明问题特定于
        #   内置 PII 检测器路径，且正则是可用 workaround）
        resp = bedrock.create_guardrail(
            name=f"lab-gr-anon-{ts}",
            description="lab: PII ANONYMIZE + email regex (auto-cleanup)",
            sensitiveInformationPolicyConfig={
                "piiEntitiesConfig": [
                    {"type": t, "action": "ANONYMIZE"} for t in ENTITY_TYPES
                ],
                "regexesConfig": [
                    {"name": "email_regex", "pattern": EMAIL_REGEX,
                     "action": "ANONYMIZE", "description": "lab email pattern"},
                ],
            },
            blockedInputMessaging="[BLOCKED] 入力はガードレールによりブロックされました。",
            blockedOutputsMessaging="[BLOCKED] 出力はガードレールによりブロックされました。",
        )
        gids["ANONYMIZE"] = resp["guardrailId"]
        print(f"[create:ANONYMIZE] guardrailId={gids['ANONYMIZE']} (DRAFT)")

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--batch", metavar="CSV",
                    help="批量判定模式：输入测试用例 CSV，输出 *_result.csv")
    ap.add_argument("--converse", action="store_true",
                    help="（交互模式）带模型路径：验证模型实际收到的是脱敏后文本")
    ap.add_argument("--model-id", default="global.anthropic.claude-sonnet-4-6")
    ap.add_argument("--pdf",
                    help="（交互模式）含明文 PII 的单页 PDF：验证 document 块不被评估")
    args = ap.parse_args()

    bedrock = boto3.client("bedrock", region_name=args.region)
    brt = boto3.client("bedrock-runtime", region_name=args.region)

    # 入口校验：--batch / --pdf 必须位于脚本所在目录内（防路径穿越）
    if args.batch:
        args.batch = resolve_input_path(args.batch, "--batch")
    if args.pdf:
        args.pdf = resolve_input_path(args.pdf, "--pdf")

    if args.batch:
        return run_batch(bedrock, brt, args.batch)
    run_interactive(bedrock, brt, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
