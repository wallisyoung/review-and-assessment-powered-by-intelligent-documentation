# AWS Bedrock Guardrails 实现机制调查报告（一手来源）

- 调查日期：2026-09-16
- 调查方式：仅采信一手来源——docs.aws.amazon.com 官方文档（"latest"版）、Bedrock API Reference、aws.amazon.com 官方定价页/FAQ、aws.amazon.com/blogs 官方博客。所有结论附来源 URL 并保留英文原文关键句；AWS 未公开说明之处明确标注。
- 调查背景：本项目（基于智能文档的评审/评估系统）LLM 调用全部走 AWS Bedrock（含 Agent / Knowledge Base / 直接模型调用）。待评估提议："追加 Bedrock Guardrails 防止敏感信息泄露"。提问者的理解："Guardrails 同样会把待检查内容上传给 LLM，如果项目和 Guardrails 都用 AWS 内部的 LLM，那追加 Guardrails 就没意义"。

---

## TL;DR

**(a) Guardrails 检测是不是"把内容再传给一个 LLM"？——不是（按官方口径），但也不是零增量暴露。**

- 官方明确：guardrail 可以在**不调用任何基础模型**的情况下独立评估内容——"Guardrails can also be used directly through the `ApplyGuardrail` API **without invoking the foundation models**"（[guardrails 总览](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)）；"ApplyGuardrail API is decoupled from foundational models. You can now use Guardrails without invoking Foundation Models."（[用户指南](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)）。它不是"再调一次 Claude/Titan"。
- 但它也**不是纯规则引擎**：AWS 官方描述敏感信息（PII）过滤器为 "a **probabilistic machine learning (ML) based solution** that is context-dependent"（[sensitive information filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)），并称各过滤器 "are **powered by underlying models**. AWS periodically updates these models..."（[How Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)）。这些"underlying models"的具体架构（小分类器还是 LLM）——**AWS 未公开说明**。
- 数据流含义：开启 guardrail 后，内容会被送入 AWS 托管的 Guardrails 服务平面做检测。若威胁模型是"**不让 AWS 看到内容**"，那么加不加 Guardrails 确实没有区别（两者都在 AWS 边界内）；若威胁模型是"**控制内容到达哪里、被记录在哪里、回显给谁**"，Guardrails 有实质作用，尤其 MASK 时**生成模型收到的是脱敏后文本，PII 原文不会到达生成模型**（见第 3 节）。

**(b) 项目 LLM 已全在 Bedrock 体系内时，追加 Guardrails 的价值边界：**

有意义的威胁模型：
1. **输出侧防泄露（最主要价值）**：防止模型在响应中回显/生成 PII 并返回给最终用户或写入前端日志（OUTPUT 方向 BLOCK/ANONYMIZE，见第 5 节）。
2. **减少 PII 进入模型下游的持久化面**：MASK 后模型收到的 prompt 已脱敏，从而模型调用日志（output 侧）、Agent 记忆、会话转录、传给下游工具的参数中的 PII 面收敛（注意：模型调用日志的 `input` 字段仍记录原始请求，见第 3 节的例外）。
3. **未来接入非 Bedrock 模型时**：ApplyGuardrail 官方支持任意第三方/自托管 LLM（"The ApplyGuardrail API allows you to invoke a guardrail **regardless of the model used**"，[AWS 官方博客 2024-10](https://aws.amazon.com/blogs/machine-learning/implement-model-independent-safety-measures-with-amazon-bedrock-guardrails/)）。
4. **Prompt attack / 内容合规**：与 PII 无关的另一类防护（jailbreak/注入检测等）。

没有意义（或作用有限）的威胁模型：
1. "**不让 AWS 处理敏感内容**"——Guardrails 检测本身就在 AWS 内进行，此项无增益。
2. **本项目的主数据路径可能根本不被覆盖**：敏感信息过滤器 "**This filter evaluates text content only**"（[官方文档](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)），且 Converse 中可被 guardrail 定向评估的内容块（`guardContent` / `GuardrailConverseContentBlock`）是**只含 `text` 与 `image` 两个成员的 UNION**——**没有 `document` 成员**（[GuardrailConverseContentBlock API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConverseContentBlock.html)）。**即：以 `document` 块直传模型的扫描 PDF 二进制不在敏感信息过滤器的评估范围内**（详见追加节 A）。若不对文档内容做 PII 防护，仅对伴随的 text prompt 和模型输出做防护，覆盖面非常有限。

---

## 1. Guardrails 的工作位置：随模型调用 vs 独立 ApplyGuardrail API

### 1.1 随模型调用（Converse / InvokeModel + guardrail 配置）

官方流程（[How Amazon Bedrock Guardrails works](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)，原文）：

> "When using a guardrail in the `InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, or `ConverseStream` operations, it works as follows during the inference call. ... The input is evaluated against the configured policies specified in the guardrail. Furthermore, for improved latency, the input is evaluated in parallel for each configured policy. ... **If the input evaluation results in a guardrail intervention, a configured *blocked message* response is returned and the foundation model inference is discarded.** ... If the input evaluation succeeds, the model response is then subsequently evaluated against the configured policies in the guardrail. ... If the response results in a guardrail intervention or violation, it will be overridden with *pre-configured blocked messaging* or *masking* of the sensitive information based on your policy configuration. ... If the response's evaluation succeeds, the response is returned to the application without any modifications."

要点：**先检输入→（命中阻断则模型调用被丢弃）→调模型→再检输出→（命中则覆盖为 blocked 消息或脱敏）→返回**。guardrail 评估内嵌于推理调用中。

挂载方式：
- Converse/ConverseStream：请求体 `guardrailConfig` 字段（[GuardrailConfiguration API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConfiguration.html)：`guardrailIdentifier` / `guardrailVersion` / `trace: enabled | disabled | enabled_full`）。
- InvokeModel/InvokeModelWithResponseStream：HTTP 头 `X-Amzn-Bedrock-GuardrailIdentifier`、`X-Amzn-Bedrock-GuardrailVersion`、`X-Amzn-Bedrock-Trace: ENABLED`（[Test your guardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-test.html)）。
- 选择性评估：`guardContent` 块（Converse）或输入标签（InvokeModel）可指定只检哪些内容；不指定则评估 messages 全部文本。

### 1.2 独立 ApplyGuardrail API

[用户指南](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)（原文）：

> "You can use the `ApplyGuardrail` API to assess any text using your pre-configured Amazon Bedrock Guardrails, **without invoking the foundation models**."
>
> Features: "**Decoupled from foundation models** – ApplyGuardrail API is decoupled from foundational models. You can now use Guardrails without invoking Foundation Models. You can use the assessment results to design the experience on your generative AI application."
>
> "The `source` field should be set to `INPUT` when the content to evaluated is from a user (typically the input prompt to the LLM). The `source` should be set to `OUTPUT` when the model output guardrails should be enforced (typically the LLM response)."

[API Reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ApplyGuardrail.html)：`POST /guardrail/{guardrailIdentifier}/version/{guardrailVersion}/apply`，请求体 `content`（[GuardrailContentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailContentBlock.html) 数组，文本块）+ `source: INPUT|OUTPUT`；响应 `action: NONE | GUARDRAIL_INTERVENED`、`assessments`（各 policy 明细）、`outputs`（阻断时为罐头消息；仅脱敏时为**脱敏后的文本**）、`usage`、`guardrailCoverage`。

**能否用于非 Bedrock 的任意 LLM？——可以。** [AWS 官方博客（2024-10-03）](https://aws.amazon.com/blogs/machine-learning/implement-model-independent-safety-measures-with-amazon-bedrock-guardrails/)（原文）：

> "**The ApplyGuardrail API allows you to invoke a guardrail regardless of the model used.** ... supports evaluating "user inputs and model responses for **custom and third-party FMs available outside of Amazon Bedrock**." ... You can use the ApplyGuardrail API to **decouple safeguards** for your generative AI applications from FMs."

博客给出的工作流：收输入 → ApplyGuardrail(INPUT) → 通过才把内容送给**你的**模型（任意托管位置）→ 收模型输出 → ApplyGuardrail(OUTPUT) → 通过才返回给用户。

另注：还有更新的 [InvokeGuardrailChecks API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use.html)（用户指南主题 "Use the InvokeGuardrailChecks API in your application"；定价页脚注："With the InvokeGuardrailChecks API, you can use the prompt attack filter separately outside of content filters"）。AgentCore Policy 即通过 `bedrock:InvokeGuardrailChecks` 调用 Guardrails（见追加节 C）。

---

## 2. 敏感信息（PII）检测机制：正则 vs ML

### 2.1 两类检测器

[sensitive information filters 官方页](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)（原文）：

> "This filter is a **probabilistic machine learning (ML) based solution that is context-dependent** and detects sensitive information based on the context within input prompts or model responses. You can configure by selecting from a set of built-in PIIs offered by Amazon Bedrock Guardrails ... or by defining it along with **regular expressions (custom regex) that work based on pattern matching** to block or mask PII data."

即：
- **内置 PII 实体**（`piiEntitiesConfig`，约 30+ 种）：由 AWS 的**概率 ML 检测器**识别，依赖上下文。官方页面甚至直接称之为 "**The PII model**"：
  > "The PII model performs more effectively when it is provided with sufficient context. ... Since PII can be context-dependent (for example, a string of digits might represent an AWS KMS key or a user ID depending on the surrounding information), providing comprehensive context is crucial for accurate identification."
- **自定义正则**（`regexesConfig`，每个 pattern 1–500 字符，不支持 lookaround）：确定性模式匹配，**免费**（定价页："Sensitive information filters (regular expression) — Free"）。

内置实体清单（同页）：通用（ADDRESS、AGE、NAME、EMAIL、PHONE、USERNAME、PASSWORD、DRIVER_ID、LICENSE_PLATE、VEHICLE_IDENTIFICATION_NUMBER）；金融（信用卡号/CVV/有效期、PIN、IBAN、SWIFT）；IT（IP、MAC、URL、AWS_ACCESS_KEY、AWS_SECRET_KEY）；美国（银行账号、路由号码、ITIN、护照号、SSN）；加拿大（CA_HEALTH_NUMBER、CA_SOCIAL_INSURANCE_NUMBER）；英国（NHS 号、NINO、UTR）。**没有日本特有实体**（详见追加节 B）。

### 2.2 它是独立分类器还是调用某个大模型？

- 官方对检测器的定性只有上述 "probabilistic machine learning (ML) based solution" 与总述页的 "safeguards ... are **powered by underlying models**. AWS periodically updates these models to extend functionality, address new attack vectors..."（[guardrails-how](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)）。
- 语言支持页佐证"underlying models"是 AWS 自有并按语言调优的一组模型："**Optimized and supported** – The underlying models supporting the particular policy are **tuned and tested** for the specific language."（[languages](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-supported-languages.html)）
- **Guardrail 处理本身是否调用（某个）大模型：AWS 未公开说明。** 官方从未说明其架构（专用小模型/分类器 vs LLM）。可以确认的只有：它**不是**调用 Bedrock 上可供客户调用的 FM（ApplyGuardrail "without invoking the foundation models"），且 AWS 会不定期更新这些底层模型。

### 2.3 与"是否使用 LLM"相关的官方表述边界

- 总览页明确 Guardrails 评估范围排除推理内容块："...protect sensitive information that might be present in user inputs or model responses **(excluding reasoning content blocks)**"（[guardrails.html](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)）。
- 工具调用字段不被评估（同 [sensitive-filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)）："In tool use (function calling) workloads, it does not evaluate the following ... PII the model generates into tool call arguments ... PII in tool results ... PII in the tool definitions."

---

## 3. 数据流与信任边界：MASK 命中时模型收到什么？

**结论：guardrail 检查发生在 AWS Bedrock 服务平面（推理调用内或 ApplyGuardrail 独立调用），位于生成模型之前（INPUT）与之后（OUTPUT）。开启 MASK/ANONYMIZE 且命中时，生成模型收到的是脱敏后文本，PII 原文不会到达生成模型。**

证据链（均为官方原文）：

1. [guardrails-how](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)：输入评估在**模型推理之前**，命中即"the foundation model inference is discarded"（模型根本不被调用）。
2. [guardrails-sensitive-filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)：
   > "**Mask** – Sensitive information filter policies can anonymize or redact information **from model requests or responses**. ... If sensitive information is detected in the model request or response, **the guardrail masks it and replaces it with the PII type** (for example, `{NAME}` or `{EMAIL}`)."
   >
   > "**PII masking applies only to content that is sent to the inference model (input prompts) and content that is returned from the inference model (model responses).**"
3. [AWS 官方博客（2026-01-15）](https://aws.amazon.com/blogs/machine-learning/safeguard-generative-ai-applications-with-amazon-bedrock-guardrails/)（架构描述）：
   > "...the guardrail successfully intervened and **masked PII data before sending the user query to the LLM**..."
4. ApplyGuardrail 独立模式下的显式数据流（[用户指南](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)）：响应 `outputs` 返回脱敏文本（示例：输入 "Hi, my name is Zaid. Which car brand is reliable?" → 输出 "Hi, my name is **{NAME}**. Which car brand is reliable?"），由**调用方**决定把脱敏文本送给自己选择的模型。

**重要的例外（官方明示，审计时必须知道）：**

- **模型调用日志记录的是原始未脱敏请求**（[sensitive-filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)）：
  > "**Model invocation logs** – If you enabled Monitor model invocation using CloudWatch Logs and Amazon S3, the `input` field ... **always contains the original, unmodified request regardless of guardrail intervention**. To protect sensitive information in your logs, use Amazon CloudWatch log data protection."
- **trace 中的 `match` 字段包含 PII 原值**（同页）："The `match` field in GuardrailPiiEntityFilter ... contains the **original PII value, not the masked output**. This behavior is by design so that your application can use the detection result for its own logic."
- 工具调用参数/工具结果/工具定义中的 PII 既不阻断也不脱敏（见 2.3）。
- `document` 块（PDF 等）不在敏感信息过滤器评估范围内（见追加节 A）。

**信任边界小结**：guardrail 把内容送入 AWS 托管的检测模型（与生成模型同为 AWS 边界内、同 Region），检测器架构未公开；但对"内容到达生成模型的形态"而言，MASK 确实改变了到达物（脱敏文本），且阻断命中时生成模型完全不参与。

---

## 4. 数据隐私承诺：guardrail 处理内容是否用于训练？

[Amazon Bedrock FAQ](https://aws.amazon.com/bedrock/faqs/)（原文）：

> "**With Amazon Bedrock, your content is not used to improve the base models and is not shared with any model providers.** Your data in Amazon Bedrock is always encrypted in transit and at rest..."
>
> Q: "Will AWS and third-party model providers use customer inputs to or outputs from Amazon Bedrock to train Amazon Nova, Amazon Titan or any third-party models?"
> A: "**No, AWS and the third-party model providers will not use any inputs to or outputs from Amazon Bedrock to train Amazon Nova, Amazon Titan, or any third-party models.**"

另（[Converse 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)）：

> "**Amazon Bedrock doesn't store any text, images, or documents that you provide as content. The data is only used to generate the response.**"

**边界说明**：FAQ 承诺的措辞覆盖 "customer inputs to or outputs from Amazon Bedrock"（Bedrock 的一切输入输出，按字面包含送入 Guardrails 的内容），但 AWS **没有**针对 Guardrails 处理内容的专项留存/用途声明——**Guardrails 服务内部对送检内容的留存期限与用途：AWS 未公开说明**（除上述泛化承诺与"blocked 内容会以明文出现在 Model Invocation Logs（若开启）"这一官方 Note，见 [guardrails-components](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)）。

---

## 5. 输出侧：OUTPUT 方向的 PII 检测、mask 与 blocked 时的返回结构

- **配置粒度**：PII 实体与自定义 regex 均可分别设 `outputAction` / `outputEnabled`（[CreateGuardrail 请求体](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html#guardrails-sensitive-information-policy-configure)："action": "BLOCK | ANONYMIZE | NONE"，"inputAction/outputAction/inputEnabled/outputEnabled"）。OUTPUT 方向命中 ANONYMIZE 时，模型响应中的 PII 被替换为类型占位符后返回给应用；BLOCK 时整条响应被覆盖为预配置消息。
- **blocked 时调用方收到什么**：
  - **Converse/ConverseStream**（[Include a guardrail with the Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html)，原文）：
    > "If the guardrail detects blocked content, the following happens. **The `stopReason` field in the response is set to `guardrail_intervened`.** ... The blocked content text that you have configured in the guardrail is returned in the `output` field."
    官方示例响应：`"stopReason": "guardrail_intervened"`，`output.message.content[0].text` = 预配置的 blocked 消息（"Sorry, I can't answer questions about heavy metal music."），`usage` 全 0，`trace.guardrail.inputAssessment` 含各 policy 明细。**即：不是异常抛出，而是正常 200 响应 + 专用 stopReason + 替换后的消息。**
  - **InvokeModel**（[guardrails-test](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-test.html)）：响应体带 `"amazon-bedrock-guardrailAction": "INTERVENED | NONE"` 字段；开 trace 时有 `amazon-bedrock-trace.guardrail`（含 `sensitiveInformationPolicy.piiEntities[].{type,match,action}`，action 为 `BLOCKED` 或 `ANONYMIZED`）与 `modelOutput`（被阻断的模型原始输出）。
  - **ApplyGuardrail**（[用户指南](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)）：`action: GUARDRAIL_INTERVENED`；"If guardrail intervened and blocked the request content, **the outputs field will be a single text, which is the canned message** based on guardrail configuration. ... If no guardrail action was taken on the request content, the outputs array is empty."
- 流式场景：`streamProcessingMode`（sync/async）控制先完成 guardrail 评估再吐 chunk，还是异步并行（[guardrails-use-converse-api](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html) 引用 [GuardrailStreamConfiguration](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailStreamConfiguration.html)）。

---

## 6. 成本与延迟

### 6.1 定价模型（[Bedrock 定价页](https://aws.amazon.com/bedrock/pricing/)，2026-09 抓取）

> "The pricing for Amazon Bedrock Guardrails is **based on the charges incurred by the filter used** in the guardrail."

| 策略 | 价格 |
| --- | --- |
| Content filters（text） | $0.15 / 1,000 text units |
| Content filters（image） | $0.00075 / image |
| Denied topics | $0.15 / 1,000 text units |
| **Sensitive information filters（PII）** | **$0.10 / 1,000 text units** |
| Sensitive information filters（regex） | **Free** |
| Word filters | Free |
| Contextual grounding checks | $0.10 / 1,000 text units |
| Automated Reasoning checks | $0.17 / 1,000 text units / policy |

计费单位定义（定价页原文）：

> "**A text unit can contain up to 1000 characters.** If a text input is more than 1000 characters, it is processed as multiple text units, each containing 1000 characters or less. For example, if a text input contains 5600 characters, it will be charged for 6 text units."

阻断时的计费（[guardrails-how](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)）：

> "If a guardrail blocks the input prompt, you're charged for the guardrail evaluation. **There are no charges for foundation model inference calls.**"

即 PII 检测约 **$0.10 / 100 万字符**（1M 字符 = 1000 units），正则与词过滤免费。

### 6.2 延迟特征

- 官方机制描述："for improved latency, **the input is evaluated in parallel for each configured policy**"（[guardrails-how](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html)）。
- 响应内含专门的 guardrail 处理延迟指标：`invocationMetrics.guardrailProcessingLatency`（毫秒；[Converse 示例](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html)中该值为 **240**，整次调用 `metrics.latencyMs` 为 721；[ApplyGuardrail 响应](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ApplyGuardrail.html)亦含该字段）与覆盖率指标 `guardrailCoverage.textCharacters.{guarded,total}`。

### 6.3 这能否佐证"轻量分类器/规则引擎"而非"完整 LLM 调用"？

能佐证的部分：按**字符数**（1k 字符/unit）而非 token 计费、按 policy 拆分计价、regex/word filter 免费（确定性匹配不收钱）、官方示例中 guardrail 处理延迟为**数百毫秒量级**、各 policy 可并行评估——这些特征与"按 token 计费、秒级到十秒级"的生成式 LLM 推理明显不同，而与"专用检测模型 + 规则引擎"的服务形态一致。

不能下结论的部分：**检测器真实架构（是否为小型 LLM）AWS 未公开说明**。严谨表述应为："AWS 官方称其为概率 ML 检测器（'probabilistic ML based solution'），其计费与延迟特征与完整 FM 调用不一致；架构细节未公开。"

---

## 7. 其他策略一句话概括（重点在 PII，其余从简）

- **Denied topics**：用自然语言定义一组要避开的主题（name + 定义 + 样例短语），命中用户查询或模型响应即阻断（[guardrails-components](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)："You can define a set of topics that are undesirable ... The filter will help block them if detected in user queries or model responses."）。
- **Content filters**：六类预定义有害内容（Hate/Insults/Sexual/Violence/Misconduct/Prompt Attack）的置信度分级 × 可调过滤强度（NONE/LOW/MEDIUM/HIGH），支持**文本与图像**（[content filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-content-filters-overview.html)："...block model prompts and responses in natural language **for text and images** containing harmful content."；图像按 $0.00075/张计费）。
- **Prompt attack**：内容过滤器的一个类别（Standard tier），检测 jailbreak/prompt injection/prompt leakage；可经 InvokeGuardrailChecks API 单独使用（定价页脚注）。
- **Contextual grounding checks**：对**输出侧**按 `grounding_source`/`query`/`guard_content` 限定符打 GROUNDING/RELEVANCE 分并与阈值比较，用于 RAG 幻觉拦截（[guardrails-use-converse-api](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html)、[components](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)）。
- **Automated Reasoning checks**：用自然语言编写逻辑规则/策略，验证模型输出是否满足逻辑约束，检测幻觉、给出修正建议（[components](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html)）。

---

## 追加节 A（决定性）：guardrail 是否作用于 `document` 块（PDF 二进制）与 image 块？

**结论：Converse 的 `guardrailConfig` 无法对 `document` 块（PDF/DOCX/CSV/XLS/HTML/TXT/MD 等文件字节）做敏感信息（PII）MASK/ANONYMIZE——敏感信息过滤器只评估文本内容；guardrail 可定向评估的内容块只有 text 与 image 两种，image 也仅用于内容过滤类策略，PII 检测仅限文本。**

证据（全部为一手来源原文）：

1. 敏感信息过滤器明确只评估文本（[guardrails-sensitive-filters](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)）：
   > "**This filter evaluates text content only.**"
   （同页另一句补充其覆盖"自然语言与代码域"："Sensitive information detection works across both natural language and code domains, including code syntax, comments, string literals, and hybrid content."——仍是**文本**，不是文件字节。）
2. 可被 guardrail 定向评估的内容块类型是封闭集合（[conversation-inference（Converse 文档）](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)，`guardContent` 说明）：
   > "You can pass the following types of content in a `GuardBlock`: **text** ... **image** ..."
   （只列出 text 与 image。）
3. API 层面，[GuardrailConverseContentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConverseContentBlock.html) 是 UNION 类型，**只有两个成员**：
   > "**Important** This data type is a UNION ... **image** – Image within converse content block to be evaluated by the guardrail. **text** – The text to guard."
   **没有 document 成员。**
4. [DocumentBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html) 的字段定义（format: `pdf | csv | doc | docx | xls | xlsx | html | txt | md`，source bytes/s3Location）中**没有任何与 guardrail 相关的字段或说明**。
5. image 块：仅内容过滤器评估（有害图像内容），且单独计价（定价页 "Content filters (image content) $0.00075 per image processed"）；敏感信息/PII 对图像不适用（据上述 1）。
6. Converse+guardrail 页给出的"评估与否"清单也只按字段列 text/guardContent（[guardrails-use-converse-api](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html)）：评估对象表为 "Input prompts, system prompts, model responses | text, guardContent | Yes"，工具相关字段为 No——未出现 document。

**说明与边界**：AWS 文档中没有一句逐字写明"document 块不会被任何 guardrail 策略评估"（AWS 未公开说明此否定命题的逐字表述）；以上 1–4 是官方对"能评估什么"的封闭式定义，据此可确定性推出 PDF document 块不在 PII 过滤范围内。**对本项目的含义**：扫描 PDF 以 `document` 块直传模型的路径上，Guardrails 的敏感信息过滤不提供防护；若要覆盖文档内容，需要在客户端先抽取文本，再走 ApplyGuardrail(`source=INPUT`) 脱敏后作为 text 发送，或在 KB 数据摄取侧（ingestion/解析管线）自行处理——这两点是工程结论，机制依据如上。

---

## 追加节 B：PII 实体清单的日语支持度

[语言支持官方页](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-supported-languages.html) —— **Sensitive information filters 的语言表**（原文格式：语言 | 支持级别）：

> Arabic / Chinese / Dutch / English / Finnish / French / German / Hindi / Italian / **Japanese** / Korean / Norwegian / Polish / Portuguese / Spanish / Swedish / Vietnamese —— 全部 "**Optimized and supported**"

页面术语定义（原文）：

> "**Optimized and supported** – The underlying models supporting the particular policy are **tuned and tested** for the specific language."

即：**日语属于敏感信息过滤器的"已调优且受支持"语言**（检测模型对日语做过调优与测试）。

但**内置实体清单里没有任何日本特有实体**（[实体列表](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html)只有 General/Finance/IT/USA/Canada/UK 六组）：没有日文姓名专用类型之外的日本身份证号（如 My Number）、日本住居表示、日本电话号格式等专属 entity。通用的 NAME/ADDRESS/PHONE/EMAIL 等实体可用于日语上下文（语言层面受支持），日本特有格式需用**自定义 regex**补齐（regex 免费，但不支持 lookaround）。

同页的重要警告（原文）：

> "**We strongly recommend that you test the intended languages for your guardrails use case. Guardrails are ineffective with languages that aren't supported.**"

对照（同页其他策略）：word filters 仅英/法/西；contextual grounding 仅英/法/西；content filters 与 denied topics（Standard tier）支持近百种语言（日语均为 Optimized and supported）。

---

## 追加节 C：Guardrails 能否挂到 Bedrock Agents / Knowledge Base / AgentCore？

**官方支持矩阵**（[Use cases for Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use.html)）——guardrail 可挂载于四类托管面：Model inference（InvokeModel/Converse）、**Agents**、**Knowledge base**、**Flows**（prompt 节点与 KB 节点）。原文摘录：

> "Agents – **Associate a guardrail with an agent** to apply it to prompts sent to the agent and responses returned from it.（API：CreateAgent/UpdateAgent 的 guardrailConfiguration 字段）"
> "Knowledge base – Apply a guardrail when querying a knowledge base and generating responses from it.（API：**RetrieveAndGenerate** 请求体的 guardrailConfiguration 字段）"

**Agents（Classic）**：[创建 Agent 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-create.html)有 "Guardrails details" 配置节；API 侧 `CreateAgent` 的 `guardrailConfiguration` 字段（"To add a guardrail to the agent. Specify the ID or ARN of the guardrail and the version to use."）。**注意生命周期**：Agents 已进入维护模式（[agents 总览](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html)，原文）：

> "Amazon Bedrock Agents (now Amazon Bedrock Agents Classic) **is no longer open to new customers**. For capabilities similar to Bedrock Agents Classic, explore **Amazon Bedrock AgentCore**. Existing customers can continue to use the service as normal."

**Knowledge Bases**：guardrail 挂在 **RetrieveAndGenerate** 的 `generationConfiguration.guardrailConfiguration`（`guardrailId`+`guardrailVersion`）上，用于查询与生成响应（[kb-test-config Guardrails 节](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)："You can configure denied topics to disallow undesirable topics and content filters to block harmful content in model inputs and responses."）。注意：官方支持矩阵里 **Retrieve（纯检索）API 没有列出的 guardrail 配置**；且 "Using guardrails with contextual grounding for knowledge bases is currently not supported on Claude 3 Sonnet and Haiku."

**AgentCore（Agents 的现行替代，含 Strands 类框架托管）**：对 AgentCore 开发者指南（[devguide PDF](https://docs.aws.amazon.com/pdfs/bedrock-agentcore/latest/devguide/bedrock-agentcore-dg.pdf)，2026-09-16 全文检索）确认 Guardrails 有四个挂载点：
1. **AgentCore Harness（托管推理循环）**（原文）："Use Amazon Bedrock Guardrails to filter harmful content or block denied topics in model inputs and outputs. To apply a guardrail to each model request, **add a guardrailConfig object to bedrockModelConfig.additionalParams**. The harness passes this object to Amazon Bedrock with each model request. ... **When a guardrail intervenes, the response stream reports `guardrail_intervened` as the stop reason.**"（需要 harness 执行角色具备 `bedrock:ApplyGuardrail` 权限。）
2. **AgentCore Gateway + Policy 引擎**（原文）："Guardrails – **Apply Amazon Bedrock Guardrails through the policy engine to screen requests and responses.**"；策略数据面用 FAS 凭证以 `bedrock:InvokeGuardrailChecks` 调用 Guardrails；支持 ContentFilter / PromptAttack / **SensitiveInformation** 三类 safeguard，阈值 0–1 置信分（"Bedrock Guardrails provides configurable safeguards that can run on both requests and responses to keep AI applications safe. You can currently define prompt attack, content filter, and sensitive information guardrails in policy."）。并有总括句："Apply centralized governance through Amazon Bedrock Guardrails and Amazon Bedrock AgentCore Policy consistently across **all LLM calls regardless of provider**."（HTTP 协议的 runtime target 需提供 API schema 才能用 guardrails；MCP/A2A 自动带默认 schema。）
3. **Managed Knowledge Base（agentic retrieval）**：`agenticRetrieveConfiguration.policyConfiguration.guardrailConfiguration.{guardrailId, guardrailVersion}`（"To customize agentic retrieval -- for example, to cap planning iterations or **attach a guardrail** ..."）。
4. **AgentCore Memory**：官方建议（非自动挂载）："Use Amazon Bedrock Guardrails to check prompts being sent to or from AgentCore Memory."

另：devguide 版本记录含 "AgentCore Policy Now Supports Bedrock Guardrails"。**Strands Agents 在 AgentCore 文档中是"Use any agent framework"下支持的框架之一**（AgentCore Runtime 章节含 "Strands Agents" 专节）；对 Strands 自管模型调用，guardrail 按上述 Harness/Gateway 方式或直接在 Converse 调用中挂 guardrailConfig——文档未提供 Strands 专属的 guardrail 开关（AWS 未公开说明更多）。

---

## 对提问者判断的逐条评注

| 提问者的命题 | 一手证据下的判定 |
| --- | --- |
| "Guardrails 同样会把待检查内容上传给 LLM" | **部分对、部分错**。内容确实会上传给 AWS 托管的检测模型（"powered by underlying models"），但官方明确该处理**不调用基础模型**（"without invoking the foundation models"），且 MASK 时**到达生成模型的是脱敏文本**、BLOCK 命中时生成模型**根本不被调用**。"等于把内容再给一个 LLM"的等式不成立（检测器架构未公开，但计费/延迟/并行特征与 FM 推理不同）。 |
| "项目和 Guardrails 都用 AWS 内部的 LLM，追加就没意义" | **取决于威胁模型**。若目标是"不让 AWS 接触内容"——确实无意义（Guardrails 也在 AWS 内，且 FAQ 已承诺不用于训练）。若目标是"控制 PII 到达生成模型/日志/记忆/最终用户"——有意义（INPUT MASK 改变到达模型的内容；OUTPUT MASK/BLOCK 防回显）。**但对本项目最大的限制是追加节 A**：扫描 PDF 以 document 块直传时，敏感信息过滤器不评估该块，防护只覆盖伴随 text prompt 与模型输出。 |

---

## 来源清单（全部为一手来源，访问日期 2026-09-16）

**docs.aws.amazon.com 用户指南（Amazon Bedrock User Guide, latest）**
1. Guardrails 总览：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
2. How Amazon Bedrock Guardrails works（流程/计费/并行/underlying models）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html
3. Create your guardrail（各过滤器定性）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-components.html
4. Sensitive information filters（PII 实体清单、ML 检测器、MASK、日志/trace 例外）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-sensitive-filters.html
5. Use the ApplyGuardrail API in your application（独立模式与脱敏输出示例）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html
6. Use cases for Guardrails（挂载矩阵）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use.html
7. Include a guardrail with the Converse API（stopReason/trace/工具字段表）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-converse-api.html
8. Converse API 文档（guardContent 仅 text/image；不存储内容声明）：https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
9. Test your guardrail（InvokeModel 头/amazon-bedrock-guardrailAction）：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-test.html
10. 语言支持：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-supported-languages.html
11. Content filters：https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-content-filters-overview.html
12. Agents 总览（维护模式声明）：https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html
13. Create and configure agent（Guardrails details / guardrailConfiguration）：https://docs.aws.amazon.com/bedrock/latest/userguide/agents-create.html
14. KB 查询配置（Guardrails 节）：https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html

**API Reference（Amazon Bedrock API Reference, latest）**
15. ApplyGuardrail：https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ApplyGuardrail.html
16. GuardrailConfiguration：https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConfiguration.html
17. GuardrailConverseContentBlock（UNION 仅 text/image）：https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConverseContentBlock.html
18. DocumentBlock：https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html

**AgentCore**
19. AgentCore Developer Guide（PDF 全文，2026-09-16 检索 guardrail 138 处）：https://docs.aws.amazon.com/pdfs/bedrock-agentcore/latest/devguide/bedrock-agentcore-dg.pdf（在线版首页：https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html）

**aws.amazon.com 官方页面**
20. Bedrock 定价（Guardrails 节 + text unit 定义）：https://aws.amazon.com/bedrock/pricing/
21. Bedrock FAQ（数据隐私问答）：https://aws.amazon.com/bedrock/faqs/

**AWS 官方博客（aws.amazon.com/blogs）**
22. Implement model-independent safety measures with Amazon Bedrock Guardrails（2024-10-03）：https://aws.amazon.com/blogs/machine-learning/implement-model-independent-safety-measures-with-amazon-bedrock-guardrails/
23. Safeguard generative AI applications with Amazon Bedrock Guardrails（2026-01-15）：https://aws.amazon.com/blogs/machine-learning/safeguard-generative-ai-applications-with-amazon-bedrock-guardrails/

**AWS 未公开说明的事项（明确列出，避免猜测）**
- Guardrails 各过滤器底层模型的具体架构（分类器/小型 LLM/规模）。
- Guardrails 服务对送检内容的内部留存期限与用途（仅有 Bedrock 泛化的"不用于训练"承诺）。
- "document 块不被任何 guardrail 策略评估"的逐字官方表述（本文追加节 A 的结论由官方对可评估内容类型的封闭式定义推出）。
- InvokeModel 被 guardrail 阻断输入时具体 HTTP 异常类型的逐字说明（现行用户指南仅说明返回 configured blocked message 且推理被丢弃；Converse 行为已明确为 stopReason=guardrail_intervened）。

---

# 追加调查二（2026-09-16）：模型商业承诺、closedNetwork 边界与内网 LLM 供给

- 调查对象（三个追加问题）：
  1. Bedrock 上第三方模型（本项目默认 `global.anthropic.claude-sonnet-4-6`，Anthropic）与 AWS 自家模型（Nova）的商业/隐私承诺是否一致：训练用途、IP 赔偿、合规认证（ISMAP/SOC/ISO）、cross-region inference 的数据驻留语义、SLA 与模型下架。
  2. Bedrock VPC endpoint（interface endpoint / PrivateLink）改变什么、不改变什么（对照本项目 CDK closedNetwork 全私网模式：isolated subnet、无 NAT、VPC endpoints、PrivateLink）。
  3. "有信息安全保障、限公司内部网络使用"的 LLM 是否存在、由谁供给（AWS 形态 / 自托管开源权重 / 日本国产模型 / 其他云"私有"形态），并给出面向本项目的定性权衡。
- 方法同主报告：一手来源优先（docs.aws.amazon.com、aws.amazon.com、AWS Service Terms）；NEC/富士通/PFN/NTT/Microsoft/Google 官方页面标注为**厂商来源**；媒体报道标注为**报道**。

## Q1. 第三方模型（Claude）与自家模型（Nova）的商业/隐私承诺

### Q1-1 训练用途与"数据是否给到模型提供商"：两类模型承诺口径一致；现行官方页面**不存在** "opt-in 共享给第三方模型提供商" 机制

[Bedrock FAQ](https://aws.amazon.com/bedrock/faqs/)（2026-09-16 抓取，原文）：

> "With Amazon Bedrock, your content is not used to improve the base models and is not shared with any model providers."
>
> Q: "Are user inputs and model outputs made available to third-party model providers?" — A: "**No. Users' inputs and model outputs are not shared with any model providers.**"
>
> Q: "Will AWS and third-party model providers use customer inputs to or outputs from Amazon Bedrock to train Amazon Nova, Amazon Titan or any third-party models?" — A: "**No, AWS and the third-party model providers will not use any inputs to or outputs from Amazon Bedrock to train Amazon Nova, Amazon Titan, or any third-party models.**"

即**训练用途承诺对自家（Nova/Titan）与第三方模型是同一句话、无差别**；数据共享承诺同样是全称否定（"any model providers"）。

对提问中提到的 "**opt-in to share your prompts/completions with third-party model providers**" 机制的核查结论（负结果，明确记录）：该句**未出现**在 2026-09-16 抓取的现行 Bedrock FAQ 与产品页（aws.amazon.com/bedrock/），也未出现在 Wayback Machine 2023/2024 年归档的 FAQ 与产品页快照中（均检索 "opt in"/"opt-in" 无命中）。现行官方口径是**无条件的"不共享"**，配套机制是：

- **模型调用日志（model invocation logging）**：客户自选开启，落客户自己的存储——FAQ/Nova service card："Customers can also choose to store the metadata, prompts, and completions in **their own encrypted Amazon S3 bucket**."（不存在"共享给 provider"的开关。）
- **组织级 AI services opt-out policy**（AWS Organizations，Service Terms 8.2 提及 AI 服务退出策略机制）。
- **Abuse detection 留存**（见 Q1-2）：按模型固定、非 opt-in 共享——"Retained inputs and outputs are **stored and processed by AWS and are not shared with third-party model providers**."
- 第三方模型使用前的 **EULA 接受**（console 的 model access 请求流程，属合同接受而非数据共享开关）。

**若历史某时点曾存在"opt-in 共享"表述，现行 AWS 页面已不再包含它；以现行 FAQ + Service Terms 为准。**

### Q1-2 Abuse detection（决定性文档）：默认"零操作员访问 + 零数据留存"，例外按模型逐个列出

[Amazon Bedrock abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html)（用户指南，原文）：

> "Amazon Bedrock may use automated abuse detection mechanisms to detect activity that violates our, or third-party model providers', terms of service or use policies."
>
> "Amazon Bedrock uses a **zero operator access (ZOA)** data security model. This means no operators of the service can access model input or output. Also, Amazon Bedrock uses a **zero data retention (ZDR)** data security model. This means **by default, Amazon Bedrock does not store model inputs or outputs**."
>
> "However, for specific abuse detection purposes related to the following models, we may be required to store inputs and outputs:
> + For OpenAI GPT-6 Astra, GPT-5.4, GPT-5.5, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, Daybreak Red: GPT-5.6 Cyber, and Daybreak Blue: GPT-5.6 Sol, **classifier-flagged traffic will be retained for up to 30 days** for automated offline abuse detection. Eligible customers may request full ZDR through their AWS account team.
> + For Anthropic Claude Fable 5 and Claude Fable 5.1, **all traffic will be retained for up to 30 days** for automated offline abuse detection. Classifier-flagged traffic will be subject to potential human review performed by AWS. Customers that are eligible for the **Enterprise Frontier Safeguards program** will receive ZDR through December 31, 2026."
>
> "Retained inputs and outputs are stored and processed by AWS and are not shared with third-party model providers. **If cross-region inference is enabled for these models, retained inputs and outputs are stored in destination regions (i.e., the region where your inference request is processed).**"

要点：**留存例外是按"模型"而非按"自家/第三方"划分的**（现行清单同时含 OpenAI 与 Anthropic 的特定型号）；本项目默认的 `claude-sonnet-4-6` **不在**该清单中，适用默认 ZDR。对涉日本个人信息的系统，审计时应核对该清单的现行版本（它随模型上新而变动）。

### Q1-3 知识产权赔偿（IP indemnification）：自家模型有明确、无上限的输出赔偿承诺；第三方模型在 FAQ 层面**无同等明确表述**

现行 [Bedrock FAQ](https://aws.amazon.com/bedrock/faqs/)（原文）：

> "Does AWS offer an intellectual property indemnity covering copyright claims for its generative AI services? **AWS offers an uncapped intellectual property (IP) indemnity for copyright claims arising from generative output of the following generally available Amazon generative AI services: Amazon models, and other services listed in Section 50.10 of the Service Terms (the "Indemnified Generative AI Services").** This means that customers are protected from third-party claims alleging copyright infringement by the output generated by the Indemnified Generative AI Services in response to inputs or other data provided by the customer. Customers must also use the services responsibly, such as not inputting infringing data or disabling a service's filtering features."

[Nova AI Service Card](https://docs.aws.amazon.com/ai/responsible-ai/nova-2-lite/overview.html)（docs.aws.amazon.com，原文，对自家模型的显式承诺）：

> "**AWS offers uncapped intellectual property (IP) indemnity coverage for outputs of generally available Amazon Nova models (see Section 50.10 of the AWS Service Terms).** This means that customers are protected from third-party claims alleging IP infringement or misappropriation (including copyright claims) by the outputs generated by these Amazon Nova models. In addition, our standard IP indemnity for use of the Services protects customers from third-party claims alleging IP infringement (including copyright claims) by the Services (including Amazon Nova models) and the data used to train them."

对照：AWS 2023-11 的官方博客（[Announcing new tools and capabilities to enable responsible AI innovation](https://aws.amazon.com/blogs/machine-learning/announcing-new-tools-and-capabilities-to-enable-responsible-ai-innovation/)）开出的输出赔偿清单**全部是 Amazon 自家服务**（"Amazon Titan Text Express, Amazon Titan Text Lite, Amazon Titan Embeddings, Amazon Titan Multimodal Embeddings, Amazon CodeWhisperer Professional, AWS HealthScribe, Amazon Lex, and Amazon Personalize"）。

**结论**：对 Nova/Titan（自家模型），"uncapped IP indemnity for outputs" 是逐字、显式的公开承诺；对第三方模型（Claude 等），现行 FAQ 的措辞只覆盖 "Amazon models, and other services listed in Section 50.10"——**未出现对第三方模型输出赔偿的显式句子**。最终权威范围以 [AWS Service Terms Section 50.10](https://aws.amazon.com/service-terms/) 现行文本为准（该页过长，本次抓取在 Section 21 处截断，未能取得 50.10 全文清单——**明确标注为未核验项**）。对本项目的含义：把"Claude 输出的版权风险由 AWS 兜底"写进风险登记表前，需以合同/Service Terms 逐字确认。

### Q1-4 合规认证：SOC/ISO/CSA STAR/HIPAA/GDPR 有明确声明；ISMAP 服务级覆盖**未能核验**

[Bedrock FAQ](https://aws.amazon.com/bedrock/faqs/)（原文）：

> "Amazon Bedrock is in scope for common compliance standards such as **Service and Organization Control (SOC), International Organization for Standardization (ISO)**, is Health Insurance Portability and Accountability Act (**HIPAA**) eligible, and customers can use Amazon Bedrock in compliance with the **General Data Protection Regulation (GDPR)**. Amazon Bedrock is **CSA Security Trust Assurance and Risk (STAR) Level 2** certified..."

（产品页另称 FedRAMP High in scope：[aws.amazon.com/bedrock](https://aws.amazon.com/bedrock/)。）注意：SOC/ISO 等是对 **Amazon Bedrock 服务**的认证——认证对象是服务，不区分其上跑的是 Nova 还是 Claude（模型目录内容不在 SOC/ISO 的认证维度内）。

ISMAP（日本政府云采购认证）：[AWS ISMAP 页](https://aws.amazon.com/compliance/ismap/)（原文）：

> "**Yes, AWS is ISMAP certified.**" … "**The entirety of Amazon Web Services is covered.**" … "for details on the target regions and services recently evaluated, please **see the ISMAP portal site**."

即 AWS 声明"AWS 整体在 ISMAP 覆盖范围内"，但**服务级清单以 ISMAP 官方门户的クラウドサービスリスト（云服务清单）为准**；AWS 自身页面（ISMAP 页、Services in Scope 索引页）**没有列出 Bedrock 的 ISMAP 条目**（2026-09-16 核查），ISMAP 门户检索需门户账号、本次未能核验 Bedrock 条目现状。**"Claude 是否被 ISMAP 覆盖"本身不是 ISMAP 的评价维度**——ISMAP 登记以云服务为单位；若 Amazon Bedrock 已登记，其上的第三方模型随该服务条目覆盖；这是本报告的分析性推断，非官方原文。

### Q1-5 Cross-region inference：`global.` 前缀 = 全球路由（无驻留限制），`us.` 前缀 = 地理内路由——对数据驻留含义相反

[Cross-Region inference 总览](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) 的官方对比表（原文）：

| Feature | Geographic（如 `us.`） | Global（`global.`） |
| --- | --- | --- |
| Data residency | "**Within geographic boundaries (such as US, EU, and APAC)**" | "**Any supported AWS commercial Region worldwide**" |
| Request routing | "Routed within the geography" | "Routed worldwide" |
| Cost | Standard pricing | "**Approximately 10% savings**" |

[Geographic CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)（原文）：

> "Cross-Region inference requests to an inference profile tied to a geography (such as US, EU, and APAC) **stay within that geography**. Your data remains in the AWS Regions where it originally resides. By default, the data remains stored only in the source Region. However, your input prompts and output results might move outside of your source Region during cross-Region inference. To the extent we store data for abuse detection, your input prompts and output results will be stored in the destination region."
> （`us.` profile 的示例目的地：us-east-1、us-east-2、us-west-2。）

[Global CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html)（原文）：

> "Global cross-Region inference **extends cross-Region inference beyond geographic boundaries**, enabling the routing of inference requests to **supported commercial AWS Regions worldwide**."
>
> "Organizations with data residency or compliance requirements should assess whether Global cross-Region inference fits their compliance framework, **since requests may be processed in other supported AWS commercial Regions**."

通用保证（总览页）：

> "**All data transmitted during cross-Region operations remains on the AWS network and does not traverse the public internet.** Data is encrypted in transit between AWS Regions."
>
> "CloudTrail logs all cross-Region inference requests in your source Region. Look for the `additionalEventData.inferenceRegion` field to identify where requests were processed."

**对本项目的直接结论**：默认模型 `global.anthropic.claude-sonnet-4-6` 走 **global profile**——登記書類文本（含 PII）**可能在美/欧/亚太任一受支持的商用 Region 被处理**（换取约 10% 的 token 折扣）。若合规要求限定处理地域（如仅美国，或未来仅日本），应：改用 `us.anthropic.…`（地理 profile，限美东/美西）或区域直连 model ID（单 Region）；并按官方 SCP 模式显式禁用 global CRIS：

> "This SCP explicitly denies Global cross-Region inference…"（Condition：`"aws:RequestedRegion": "unspecified"` + `"bedrock:InferenceProfileArn": "arn:aws:bedrock:*:*:inference-profile/global.*"`，原文见 [Global CRIS - Disable](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html#global-cris-disable)）

另注意：目的地 Region 无法逐请求指定（AWS re:Post 知识中心："you can't choose a specific Region to process your request… If you must process your requests in a specific Region, use models on-demand directly in that Region"，[repost.aws](https://repost.aws/knowledge-center/bedrock-cross-region-inference-routing)）；审计可用 CloudTrail 的 `inferenceRegion` 字段回查每次请求的实际处理 Region。

### Q1-6 其他商业条款差异（简述）

- **SLA**：[Amazon Bedrock SLA](https://aws.amazon.com/bedrock/sla/) 按可用性计量定义 Request（"an invocation of Amazon Bedrock by directly calling any of the Amazon Bedrock APIs"），计量 "relate solely to the Amazon Bedrock APIs **for models that are available on Amazon Bedrock**"——**不区分自家/第三方模型**（页面未点名任何 provider）。补偿阶梯：<99.9%→10%、<99%→25%、<95%→100% Service Credit。**关键排除项**（原文）："…caused by **underlying software that leads to repeated model crashes or an inoperable model**"——即模型软件本身崩溃不构成 SLA 事件，第三方模型的质量/稳定性风险实际由客户承担。
- **模型下架风险**：[Model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html)（原文）：每个模型三态 Active/Legacy/EOL；"There are two Legacy periods: **6 months and 45 days**. Most models have a 6-month Legacy period."；"After the EOL date, **the model is removed from all AWS Regions and requests made to it will fail**, unless there is a private arrangement between you and the provider for continued access."；且 "Model lifecycle dates are specific to Amazon Bedrock and **may differ from dates published by model providers (such as Anthropic or Cohere)**."——第三方模型存在"provider 与 AWS 双重节奏"的下架风险，升级迁移不会自动发生（"migration will not happen automatically"）。

## Q2. VPC endpoint / PrivateLink：改变的是"路径"，不改变的是"目的地与处理方"

[Use interface VPC endpoints (AWS PrivateLink)](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)（原文）：

> "You can use AWS PrivateLink to create a **private connection between your VPC and Amazon Bedrock**. You can access Amazon Bedrock **as if it were in your VPC**, without the use of an **internet gateway, NAT device, VPN connection, or Direct Connect connection**. Instances in your VPC don't need public IP addresses to access Amazon Bedrock."
>
> "We create an **endpoint network interface** in each subnet that you enable for the interface endpoint. These are **requester-managed network interfaces that serve as the entry point for traffic destined for Amazon Bedrock**."

FAQ 侧同义表述（[Bedrock FAQ](https://aws.amazon.com/bedrock/faqs/)）：

> "You can use AWS PrivateLink with Amazon Bedrock to **establish private connectivity between your FMs and your Amazon Virtual Private Cloud (Amazon VPC) without exposing your traffic to the Internet**."

**改变**：流量路径——从"经 IGW/NAT 出公网到服务公网端点"变为"VPC 内 endpoint ENI → AWS 骨干网内的 Bedrock 服务端点"（这正是 closedNetwork 模式引用的服务名 `com.amazonaws.<region>.bedrock-runtime` 等；bedrock / bedrock-runtime / bedrock-agent / bedrock-agent-runtime / bedrock-mantle 及 FIPS 变体均支持）。

**不改变**：(1) **目的地仍是 AWS 管理的 Amazon Bedrock 服务**（官方定位词是 "private connectivity… **as if** it were in your VPC"——"as if" 明示服务并不真的在你的 VPC 内；endpoint ENI 只是"entry point for traffic **destined for** Amazon Bedrock"）；(2) **推理仍发生在 AWS 区域内托管基础设施上**（CRIS 文档定义其路由范围为 AWS Regions，且 "remains on the AWS network"）；(3) 前述隐私/留存/赔偿等商业条款不变。**即：closedNetwork 消除的是"公网暴露面"，不是"AWS 边界"。**

## Q3. "有信息安全保障、限公司内部网络使用"的 LLM：存在，但供给方不是 hyperscaler——是自托管栈与日本/海外模型厂商的 on-prem 授权

### Q3-1 AWS 侧：**没有任何"客户内网跑 Bedrock"的形态**

逐个核验（均 2026-09-16）：

- **AWS Outposts**（客户机房机架/服务器）：[aws.amazon.com/outposts](https://aws.amazon.com/outposts/) 的服务清单为 EC2/ECS/EKS/EBS/S3/RDS/ElastiCache/EMR/ALB 等——**无 Amazon Bedrock、亦无 SageMaker**（页面仅在导航菜单出现 Bedrock 链接，与 Outposts 可用性无关）。
- **Dedicated Local Zones**（AWS 为单一客户/社区在客户指定位置部署的专属基础设施）：[aws.amazon.com/dedicatedlocalzones](https://aws.amazon.com/dedicatedlocalzones/) 定位为 "Cloud infrastructure **built specifically for you** to help address regulatory and digital sovereignty needs"、"configurable infrastructure that can be **deployed in any location you choose**"（含用例 "run workloads in **their own data centers**"）——但该页**未列出任何具体服务清单，没有任何 Bedrock 可用性声明**（DLZ 的服务集按客户与 AWS 单独配置；公开材料未见 Bedrock）。
- **（公共）Local Zones**：Bedrock **确实**在部分大都市 Local Zones 可用（[Local Zones features](https://aws.amazon.com/about-aws/global-infrastructure/localzones/features/)："Additional services including … **Amazon Bedrock** … are available in **select Local Zones**, with each service varying by metro."；"In select metros, use Amazon Bedrock to build and deploy generative AI applications and run inference"）——但 Local Zones 是 **AWS 运营的都市站点**，非客户内网。
- **AWS European Sovereign Cloud（EUSC）**：独立于商业 Region、仅限欧盟、由欧盟居民运营（正过渡到欧盟公民）的主权云，**Bedrock 自 GA 起可用**（[Opening the AWS European Sovereign Cloud](https://aws.amazon.com/blogs/aws/opening-the-aws-european-sovereign-cloud/)："You can access a broad range of AWS services … including **Amazon SageMaker and Amazon Bedrock** for artificial intelligence and machine learning (AI/ML) workloads…"；"The AWS European Sovereign Cloud will be **operated exclusively by EU residents located in the EU**."）。博客另称 EUSC 可通过 "AWS Dedicated Local Zones, AWS AI Factories, or AWS Outposts … **including your own on-premises data centres**" 扩展——但这是基础设施扩展的总体说法，**未声明 Bedrock 可在这些客户侧形态运行**。EUSC 对本项目（us-east-1）无直接可用性。
- 另注：AWS GovCloud (US) 是另一隔离云，Bedrock 可用但功能有差异（如托管 KB 数据源仅 S3，见 [kb-managed-regions](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-regions.html)）——仍是 AWS 运营。

**结论：Bedrock 的最小边界是"AWS 运营的某个区域/站点"。不存在"Bedrock 装进公司机房"的产品形态。**

### Q3-2 自托管开源权重：技术上完全成熟，这是"公司内网 LLM"的主流实现

一句话级（官方项目主页）：**vLLM**（[docs.vllm.ai](https://docs.vllm.ai/)，高吞吐 LLM 推理与服务引擎）、**TGI**（[huggingface.co/docs/text-generation-inference](https://huggingface.co/docs/text-generation-inference)，Hugging Face 的 Text Generation Inference 服务栈）、**SGLang**（[github.com/sgl-project/sglang](https://github.com/sgl-project/sglang)，快速 LLM/视觉语言模型服务框架）均可部署在自有 GPU 服务器/私有 vSphere/私有 Kubernetes 上。可承载的开放权重：**Llama**（Meta）、**Qwen**（Alibaba）、**Mistral**（Mistral AI）、**Gemma**（Google）、**DeepSeek**（DeepSeek）等——注意各自许可证条款（Llama 系列为 Meta 社区许可证、有月活门槛与命名等条件；Qwen 多数 Apache-2.0；Gemma 有 Gemma Terms of Use；DeepSeek 多数 MIT）。

### Q3-3 日本国产模型：逐个厂商核验（on-prem 商用 offering）

| 模型 | 供给方 | on-prem 商用提供 | 厂商来源关键原文 |
| --- | --- | --- | --- |
| **tsuzumi / tsuzumi2** | NTT（研究所开发；NTT Com 等集团商用） | **有**（本地/私有环境部署是产品定位） | NTT R&D 官网：「**ローカル環境での利用が可能**となるため、医療機関やコンタクトセンタなど、**SaaSを含むクラウド環境で機微情報を扱うことに障壁があるユースケースへの活用にも適し**…」「**軽量で１GPU／１CPUでも動作可能**な特性」（[rd.ntt/research/LLM_tsuzumi](https://www.rd.ntt/research/LLM_tsuzumi.html)）。NTT Com 的 "Local LLM「つづみ」" 商用页存在（[ntt.com](https://www.ntt.com/business/services/artificial-intelligence/local-llm.html)，本文抓取被反爬拦截 403，未取正文）。tsuzumi2（2025-10-20 发布，30B、单张 A100 40GB 可跑、面向本地/私有云）见**报道**（IT之家/新潮等转述 NTT 发布）。 |
| **cotomi** | NEC | **有**（云 + 专用硬件/本地环境两形态） | NEC 官网：「**豊富な提供形態** 豊富な提供形態でご利用いただけるため、**機微データを扱うような業務においてもご利用いただけます**」（[jpn.nec.com/LLM/cotomi.html](https://jpn.nec.com/LLM/cotomi.html)）；同页引 MM総研大賞受赏理由：「**クラウドと専用ハードウェアの両方での運用を可能にした**点」。NEC 2023-07 新闻稿：「為滿足客戶處理機密資訊的需求，**NEC 也提供結合雲端服務和本地環境的安全環境**…『NEC 生成式 AI 設備伺服器』硬體平台」（[fujitsu 对照：NEC TW PR](https://tw.nec.com/zh_TW/press/202307/tw_20230727_01.html)；英文版 [nec.com/en/press](https://www.nec.com/en/press/202307/global_20230706_01.html)）。 |
| **Takane**（服务品牌 Kozuchi / DI PaaS） | 富士通（与 Cohere 共同开发） | **有**（"安全私有环境"是企业定位；on-prem 经 Nutanix NAI 等形态） | 富士通新闻稿：「『Takane』為一款**專為企業在安全的私人環境中使用**的日語大型語言模型…提供專為**安全私有環境**量身定製的高精度 LLM」（[fujitsu.com TW PR 2024-09-30](https://www.fujitsu.com/tw/about/resources/news/press-releases/2024/0930-01.html)）；富士通官方用语集：「富士通は…**プライベート環境でセキュアに利用可能なエンタープライズ向け大規模言語モデルである Takane を提供します**。…金融や官公庁、R&D部門など、高度なセキュリティを必要とするお客様向けに**プライベート環境での利用**できる」（[global.fujitsu 用语集](https://global.fujitsu/ja-jp/library/llm)）。2025-04 起经 Nutanix Enterprise AI 平台提供 on-prem/混合云运行（**报道**：澎湃/新浪转述富士通与 Nutanix 合作）。 |
| **PLaMo（PLaMo Prime / 金融特化等）** | Preferred Networks（PFN） | **有**（厂商页明记"オンプレミスでも提供"） | PFN 官网：「**PLaMo Prime はクラウド型API、Amazon Bedrock Marketplace、Snowflake のほかオンプレミスでも提供しています。**」「金融機関が求める**セキュアなオンプレミス環境**で各社の独自データ…を追加学習した専用モデルを利用できるようにする」（[preferred.jp/ja/business/genai](https://www.preferred.jp/ja/business/genai/)）。 |
| **SARASHINA（Sarashina2 等）** | **SB Intuitions**（ソフトバンク子会社；非 NTT——常见误记，此处更正） | **未見公开 on-prem 商用 offering**（以法人服务/云为主；部分权重在 HF 公开，自部署需核对各自许可） | 共同新闻稿公司介绍：「**SB Intuitions株式会社 ソフトバンクの子会社として、日本語に特化した大規模言語モデル「Sarashina」シリーズを核に**生成AIの研究と周辺サービスの開発に力を入れ…**国内最大規模の計算基盤と国内データセンターでの厳格なデータ管理を強み**に、…700億パラメータのモデル「Sarashina2-70B」や視覚言語モデル「Sarashina 2-Vision」等を公開」（[dentsu.co.jp 新闻稿](https://www.dentsu.co.jp/news/release/2025/0925-010946.html)）。 |

（补充：学术/开源系还有 LLM-jp（NII 主导）、CyberAgent OpenCALM、rinna 等，均开放权重可自托管；商用支持需自行评估。）

### Q3-4 其他云的"私有"形态：仍是厂商云内，不是公司内网

- **Azure OpenAI / Microsoft Foundry "Models sold by Azure"**：厂商云内专用。Microsoft 官方（[Data, privacy, and security](https://learn.microsoft.com/en-us/legal/cognitive-services/openai/data-privacy)，原文）："Your prompts (inputs) and completions (outputs)… **are NOT available to other customers. are NOT available to OpenAI or other providers… are NOT used to train any generative AI foundation models without your permission or instruction.**"；"**Microsoft hosts the Models sold by Azure in Microsoft's Azure environment** and Models sold by Azure do NOT interact with any services operated by providers of Models sold by Azure, for example, OpenAI."；有滥用监控（含人工复核），"managed customers may **apply to modify abuse monitoring**"。**Azure Government** 是微软运营的美政府隔离云——边界仍是 Microsoft。**没有 on-prem Azure OpenAI 产品。**
- **GCP Vertex AI Model Garden**：开放权重模型可部署到 Vertex 托管端点，也可按文档把开放模型部署到客户自己的 **GKE 集群**（自管节点/GPU，仍在本项目的 Google Cloud 内）。Model Garden 官方页："discover, customize, and deploy a wide variety of models from Google and Google partners… 200+ available models"（[cloud.google.com/model-garden](https://cloud.google.com/model-garden)）；GKE 自部署细节见 Vertex AI Model Garden 文档（本次两处文档 URL 均未能抓取成功，标注为未逐字核验）。**边界仍是 Google Cloud。**

### Q3-5 面向本项目的定性权衡（分析性结论）

- **接受 AWS 边界 + 收紧配置**（推荐基线）：全部流量走 VPC endpoint（已做，closedNetwork）；隐私面靠 ZOA/ZDR + 不训练承诺 + Guardrails MASK；**把默认模型从 `global.` 换成 `us.` profile 或单 Region model ID**，并加 SCP 禁用 global CRIS（见 Q1-5）——这是成本最低、与现有架构一致、且能向审计给出"数据不出指定地理"说明的方案。残余风险：内容仍在 AWS 边界内处理；第三方模型的 IP 赔偿范围与 SLA 排除项（Q1-3/Q1-6）；模型 EOL 节奏。
- **自建内网 LLM**（vLLM/SGLang + Llama/Qwen/DeepSeek 或 tsuzumi/cotomi/Takane/PLaMo on-prem）：能真正满足"不出公司网络"的控制目标（这正是 tsuzumi/PLaMo 等产品在日本的存在理由——"SaaSを含むクラウド環境で機微情報を扱うことに障壁があるユースケース"）。代价：**能力差距**（本地 30–70B 级 vs Claude Sonnet 4.x 级的文档理解/长上下文/工具调用，对不动产登记书类的 OCR 后结构化与审查推理需要充分 PoC）；**GPU 成本与容量**（推理集群 + 高可用 + 峰值容量）；**运维负担**（模型服务、监控、安全补丁、越狱防护自建——可部分用 Bedrock ApplyGuardrail 式独立 API 补齐，但那又回到 AWS 边界）；**更新节奏**（自部署模型的迭代以季度/年计，落后于 Bedrock 目录）。
- **混合路径**：敏感度最高的字段先脱敏（Guardrails MASK/自研），再进 Bedrock；或仅对"不可出网"的少数流程保留内网 LLM 选项。这是工程折中，需以数据分级政策为前提。

## 追加调查二：来源清单（访问日期 2026-09-16）

**docs.aws.amazon.com**
1. Cross-Region inference（global vs geographic 对比表）：https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
2. Global cross-Region inference（全球路由、SCP 禁用模式）：https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html
3. Geographic cross-Region inference（地理内驻留、abuse detection 存目的地 Region）：https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html
4. Amazon Bedrock abuse detection（ZOA/ZDR、按模型留存清单）：https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html
5. Use interface VPC endpoints (AWS PrivateLink)（as if in your VPC）：https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html
6. Model lifecycle（Active/Legacy/EOL、通知期）：https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html
7. Compliance validation for Amazon Bedrock：https://docs.aws.amazon.com/bedrock/latest/userguide/compliance-validation.html
8. Nova 2 Lite AI Service Card（自家模型的隐私与 IP 赔偿原文）：https://docs.aws.amazon.com/ai/responsible-ai/nova-2-lite/overview.html
9. 托管知识库支持 Region（GovCloud 功能差异示例）：https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-regions.html

**aws.amazon.com**
10. Bedrock FAQ（训练/共享/赔偿/合规问答）：https://aws.amazon.com/bedrock/faqs/
11. Bedrock SLA：https://aws.amazon.com/bedrock/sla/
12. AWS Service Terms（Section 50.3/50.10 所在；本次仅取得 1.24.1 等节）：https://aws.amazon.com/service-terms/
13. AWS ISMAP 页（"entirety"声明）：https://aws.amazon.com/compliance/ismap/
14. AWS Outposts（服务清单，无 Bedrock）：https://aws.amazon.com/outposts/
15. AWS Dedicated Local Zones：https://aws.amazon.com/dedicatedlocalzones/
16. AWS Local Zones features（select Local Zones 含 Bedrock）：https://aws.amazon.com/about-aws/global-infrastructure/localzones/features/
17. Opening the AWS European Sovereign Cloud（EUSC GA，Bedrock 可用，EU 居民运营）：https://aws.amazon.com/blogs/aws/opening-the-aws-european-sovereign-cloud/
18. Announcing new tools and capabilities to enable responsible AI innovation（2023-11，自家服务赔偿清单）：https://aws.amazon.com/blogs/machine-learning/announcing-new-tools-and-capabilities-to-enable-responsible-ai-innovation/

**AWS re:Post（AWS 官方知识中心）**
19. Restricting Bedrock cross-region inference routing（不可指定目的地 Region）：https://repost.aws/knowledge-center/bedrock-cross-region-inference-routing

**厂商来源（vendor pages）**
20. NTT R&D Website：tsuzumi（ローカル環境利用、1GPU/1CPU）：https://www.rd.ntt/research/LLM_tsuzumi.html
21. NTT Com Local LLM「つづみ」商用页（403，仅存在性确认）：https://www.ntt.com/business/services/artificial-intelligence/local-llm.html
22. NEC cotomi（豊富な提供形態、クラウドと専用ハードウェア）：https://jpn.nec.com/LLM/cotomi.html ；NEC 生成AI 新闻稿（本地环境安全环境/设备服务器）：https://tw.nec.com/zh_TW/press/202307/tw_20230727_01.html （EN: https://www.nec.com/en/press/202307/global_20230706_01.html ）
23. 富士通 Takane 新闻稿（安全私有环境）：https://www.fujitsu.com/tw/about/resources/news/press-releases/2024/0930-01.html ；富士通用语集（プライベート環境でセキュアに利用可能）：https://global.fujitsu/ja-jp/library/llm
24. Preferred Networks 生成AI基盤モデル（PLaMo，オンプレミスでも提供）：https://www.preferred.jp/ja/business/genai/
25. 電通新闻稿（SB Intuitions/SARASHINA 公司介绍）：https://www.dentsu.co.jp/news/release/2025/0925-010946.html
26. Microsoft：Data, privacy, and security for Models sold by Azure：https://learn.microsoft.com/en-us/legal/cognitive-services/openai/data-privacy
27. Google Cloud Model Garden：https://cloud.google.com/model-garden

**报道来源（非一手，仅补充）**
28. tsuzumi2 发布（2025-10-20，30B/单卡 A100 40GB）报道：https://www.ithome.com/0/891/171.htm
29. 富士通 Takane × Nutanix NAI on-prem（2025-04）报道：https://m.thepaper.cn/newsDetail_forward_30708626

## 追加调查二：未核验/未公开事项（明确列出）

- AWS Service Terms **Section 50.10 现行完整清单**（是否已纳入第三方模型输出赔偿）——页面过长截断未能取得；涉及合同结论时应以该节现行文本与法务确认为准。
- **ISMAP クラウドサービスリスト中 Amazon Bedrock 的登记现状**——AWS 页面只给"entirety"总括声明，门户检索未能完成。
- 历史 Bedrock 页面中的 "**opt-in to share your prompts/completions with third-party model providers**" 表述——现行与所查 Wayback 2023/2024 快照均无此句；无法定位其确切出处与被移除时点。
- **Dedicated Local Zones / Outposts / AI Factories 上能否运行 Bedrock**——AWS 未公开声明；仅有 EUSC 场景下基础设施扩展的总体表述。
- EUSC 中 Bedrock 的**具体模型阵容**（是否含 Anthropic 等第三方模型）——docs.aws.eu 为 JS 渲染，未能抓取。
- Vertex AI Model Garden "Deploy to GKE" 文档页——本次两处 URL 抓取失败（404/重定向），GKE 自部署的逐字表述未核验。
- NTT Com "Local LLM つづみ" 商用页正文——反爬 403，未取得原文（以 NTT R&D 官网替代佐证本地部署定位）。

---

## 勘误（2026-09-18，实测发现）

**"MASK" 作为 PII 动作名在现行 CreateGuardrail API 中不存在。** 实测（us-east-1，2026-09-18）`CreateGuardrail` 服务端校验返回：`sensitiveInformationPolicyConfig.piiEntitiesConfig.*.member.action` 合法枚举为 **`[BLOCK, ANONYMIZE, NONE]`**。旧文档/博客行文中的 "mask/masking" 在现行 API 里对应 **ANONYMIZE**（将 PII 替换为实体类型占位符）。本文主报告与追加调查一中所有涉及 "MASK 动作" 的表述，机制结论不变（命中时**生成模型收到的是占位符替换后的脱敏文本，PII 原文不会到达生成模型**），但动作名应以 ANONYMIZE 读解。实验脚本 `examples/guardrail-lab/guardrail_lab.py` 已改用 ANONYMIZE。
