# 登記書類整合性審査：多模态直读 + 案件情報 照合（提案 Demo）

## Problem Statement

团队现有一个 AWS Bedrock AgentCore harness，能对住宅ローン相关的登記（抵当権設定）书类做整合性審査。但该 harness 只接受**预先 OCR 抽取后的 JSON**（`案件情報` + `書類OCRデータ`）作为输入，**无法直接接收 PDF 或图片扫描件**。为了提案，需要证明**本项目**（已具备多模态扫描件阅读能力）能从原始扫描件 + 系统案件数据出发，端到端完成同一套整合性審査，并测出相对 harness 的准确率。同时，review 对象必须从"单一文件"升级为**复合数据**（多种 文書タイプ 的扫描件 + 结构化 案件情報），且 checklist 要能表达**跨来源的一致性比对**——这两项目前都不支持。

## Solution

扩展项目的 review-workflow，使其接受复合 review 对象：N 份带 文書タイプ 标签的扫描件 + 案件情報（JSON）。checklist 由一组 比較ルール（一致性比对规则）构成，每条规则在扫描件之间、或扫描件与 案件情報 之间比对字段。扫描件由多模态 LLM 直接阅读（取代 harness 的预抽取 OCR），易错的正規化（和暦↔西暦、金額、利率）交给 code 工具。复用现有逐项 review 循环，每条规则只传入它所需的 文書タイプ 扫描件。结果沿用现有 ReviewResult 形态，扩展第三态（判定不能），由「総合審査」父项 cascade 汇总为 総合判定。用 seed 提供登記 CheckListSet（17 条规则）。准确率以"与 harness 在同批案件上的一致率 + 不一致抽检"衡量。

## User Stories

1. 作为 審査担当者，我想为每种 文書タイプ（抵当権設定契約証書 / 登記完了証 / 登記情報識別通知 / 登記簿謄本）各上传一份扫描件并标注类型，以便系统知道每份是哪类文书。
2. 作为 審査担当者，我想以 JSON 文件（或粘贴）提供 案件情報，以便系统案件数据参与比对。
3. 作为 審査担当者，我想选择登記 CheckListSet 并发起 review，以便 17 条 比較ルール 对我的扫描件 + 案件情報 求值。
4. 作为 審査担当者，我想每条规则判定为 一致 / 不一致 / 判定不能，以便把"数据缺失"与"真正不一致"区分开。
5. 作为 審査担当者，我想在每条规则看到被比对的 比較元 与 比較先 实际取值，以便核对判定。
6. 作为 審査担当者，我想每条规则得到 アドバイス，以便在出问题时知道如何处理。
7. 作为 審査担当者，我想看到「総合審査」汇总与 総合判定（承認可 / 条件付き保留 / 否認），以便得到整体结论。
8. 作为 提案デモ観客，我想看到本方案与 harness 在同批案件上的准确率对比，以便判断是否采用。
9. 作为 開発者，我想让 review 经现有多模态通路阅读扫描件（PDF=document block / image=image_reader），以便复用已验证能力。
10. 作为 開発者，我想每条规则的 LLM 调用只收到它所需的 文書タイプ 扫描件 + 案件情報，以便调用廉价且低噪声。
11. 作为 開発者，我想让正規化（和暦↔西暦、金額、利率）由 code 工具完成，以免 LLM 犯算术/解析错误。
12. 作为 開発者，我想要登記 CheckListSet 的 seed 脚本，以便可复现地重建 demo checklist。
13. 作为 開発者，我想把案件与结果持久化，以便重跑并比对准确率。
14. 作为 開発者，我想结果（result/confidence/sourceReferences）沿用现有 ReviewResult 形态，以便现有 review-result UI/API 继续可用。
15. 作为 審査担当者，我想 登記完了証 即使在规则未完成前也作为一等 文書タイプ 被接受，以便文书集合完整。
16. 作为 開発者，我想每条 審査項目 显式声明所需 文書タイプ（requiredDocumentTypes），以便扫描件子集化是确定性的。
17. 作为 審査担当者，我想 create-review 表单能让我把每个上传文件映射到集合声明的某个 文書タイプ，以便上传无歧义。
18. 作为 審査担当者，我想看到每条规则的抽取值与置信度，以便信任或推翻结果。
19. 作为 審査担当者，我想能覆盖某条规则的结果（沿用现有 userOverride），以便纠正错误。
20. 作为 提案デモ観客，我想看到与 harness 不一致案例的抽检，以便了解本方案在哪更准/更不准。

## Implementation Decisions

- **范围**：提案 Demo，建在真实 backend/frontend/cdk 架构上（非一次性 fork）。生产级打磨（鉴权/多租户/全面错误处理/80% 覆盖率）延后。
- **架构决策（见 ADRs）**：
  - **ADR-0001（抽取策略）**：`書類OCRデータ` 概念从模型中移除；扫描件由多模态 LLM 直读（PDF→document block，image→image_reader）；易错正規化（和暦↔西暦、金額逗号、利率%、日期算术）交给 code 工具。采用 **A3a**：工具**仅正規化**；抽取/比较/判定/建议由 LLM 完成。
  - **ADR-0002（调用粒度）**：复用现有 review-workflow 的**逐项**调用循环；每次调用只传入该规则的 requiredDocumentTypes 扫描件 + 案件情報；所需类型用显式元数据声明（非文本匹配）；空/缺省 → 安全起见传入全部扫描件。
- **比較ルール 表示**：每条规则 = 一个叶子 CheckList 審査項目，description 为自由文本（含 比較元/比較先/正規化要点）；一个「総合審査」父 審査項目 承载汇总。
- **数据模型变更**（仅列决策性形状）：
  - `ReviewDocument`：+ `documentType`（文書タイプ，取值为其 CheckListSet 声明的类型之一）；保留 `fileType`(pdf|image) 作为载体。约束由"单 job 单类型 / 最多 1 PDF 或 20 图"放宽为"每个声明的 文書タイプ 一份扫描件"。
  - `ReviewJob`：+ `caseData` (Json) = 案件情報。
  - `CheckList`：+ `requiredDocumentTypes` (string[]) = 该规则所需的 文書タイプ。
  - `CheckListSet`：声明其期望的 文書タイプ 列表（demo = 4 种登記类型）。
  - `ReviewResult`：`result` 扩展为三态 `pass | fail | undeterminable`。
  - **Seed**：登記 CheckListSet = 「総合審査」父项 + 17 个叶子 審査項目（每个带 requiredDocumentTypes）；17 条规则文本来自 harness system prompt。
- **结果映射（harness → ReviewResult）**：結果 ✅/❌/⚠️ → `result` pass/fail/undeterminable；比較元/比較先 名称+取值 → `sourceReferences`；判断方法 → `explanation`；アドバイス → 追加进 `explanation`；総合判定 → 父项 cascade；総合コメント → 父项 `explanation`。confidence/extractedText/reviewMeta 沿用。
- **Cascade 规则（総合審査 父项）**：任一子项 fail → fail；否则任一子项 undeterminable → undeterminable；否则 pass。
- **逐项 LLM 调用构成**：规则文本 + 文書タイプ 标注的所需扫描件 + 案件情報(caseData) + A3a 正規化工具访问；输出三态 result + sourceReferences + advice（+ 沿用 confidence/extractedText/reviewMeta）。
- **登記完了証**：一等 文書タイプ；规则待补；不做特殊处理（可上传、可投入；demo 的 17 条规则暂不引用它）。
- **Frontend**：create-review 扩展为上传 N 份扫描件、各自映射到声明的 文書タイプ，并提供 案件情報（JSON 文件上传或粘贴 → 解析进 caseData）；review-result 视图扩展为渲染三态 + 総合審査 総合判定。
- **准确率方法（验收）**：主指标 = 同批案件上与 harness 输出的逐规则一致率；再对不一致项抽检。输入（扫描件 + caseData + harness 输出）在测试阶段以本地文件提供；先用 1 个案件验证流水线，再扩展。

## Testing Decisions

- 只测外部行为，不测实现细节。
- **Seam A（主、准确率）**：扩展现有 `review-item-processor/evals/` —— 把一个案件（扫描件 + 案件情報）经逐项 agent 跑通，断言每条规则的 `{result, sourceReferences}` 与期望标签一致。该 eval 即验收测试（与 harness 的一致率）。先例：`evals/`（evaluators/experiments/metrics/wrapper）。
- **Seam B（管线、集成）**：经现有本地 MySQL repository 模式走 review-job 生命周期 —— 断言 documentType/caseData/requiredDocumentTypes 正确持久化；逐规则扫描件子集化产出正确的文档集；三态 cascade 正确汇总。先例：backend review repository 测试 + `review-workflow/__tests__/pre-review-item.test.ts`。
- 仅当逻辑被迫抽取为纯函数时，才加 Seam C（prompt 组装 / 结果解析的单测）。

## Out of Scope

- Need-1 的 markdown 模板导入式 checklist 生成（Phase 2；demo 用 seed）。
- 生产级打磨：多租户、全面鉴权、宽泛错误处理、80% 覆盖率门槛（Demo 优先）。
- 新增 checklist 生成通路（PDF→LLM 抽取、markdown 导入）—— demo 用 seed。
- 登記完了証 的比对规则（待补，不在 17 条内）。
- 替换/扩展 harness 本身。
- 批量（17 条一次性调用）review 通路（已否决，见 ADR-0002）。

## Further Notes

- 术语表：`CONTEXT.md`。ADRs：`docs/adr/0001`（抽取策略）、`docs/adr/0002`（粒度+子集化）。
- `書類OCRデータ` 概念已从模型移除（原为 harness 的预抽取 OCR；由多模态直读取代）。
- 待提供输入（测试阶段、本地文件）：原始扫描件（4 种 文書タイプ × N 案件）；案件数（先 1 个，再 ~5–10）。
- harness system prompt（`touki-check-propmt_02.md`）是 17 条规则文本与正規化/缺数据规则的来源，agent 须遵从。
