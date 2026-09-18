# PDF 图文混排手册的手册+章节指针检索——实现方案调查（一手来源）

- 调查日期：2026-09-17
- 调查方式：仅采信一手来源——docs.aws.amazon.com 官方文档（"latest"版，含各页面官方 markdown 版本与 Bedrock User Guide 官方 PDF）、Bedrock API Reference、aws.amazon.com 定价页与 Textract 官方 FAQ、Anthropic 官方定价页、各 OSS 项目的 GitHub 仓库 README/LICENSE 与官方文档站。所有结论附来源 URL 并保留英文原文关键句；AWS 未公开说明之处明确标注。纯数学推演部分标注为"分析"。
- 调查背景：本项目（基于智能文档的评审/评估系统，AWS CDK / us-east-1、Aurora MySQL Serverless v2、LLM 全走 Bedrock）要追加子功能：员工用自然语言提问"我做某项工作时该看哪本手册的哪一章"，系统回答**手册名+章节指针**——答案形态是**指针而不是自由生成的解说**。语料为中型公司的最新业务手册集（日语、几十~几百本、章节级条目估计几千个，**语料规模可控**）。本次聚焦的新问题是：**手册是 PDF 图文混排**——正文里穿插截图、流程图、表格、图注，需要回答：这种 PDF 如何解析、图表如何参与检索、章节指针如何落地。

---

## TL;DR

**(a) 图文混排日语 PDF 的推荐解析路线：Bedrock 原生两条"官方解析服务"（BDA、Textract）对日语文档均不在官方支持语言列表内，且 BDA 处理强制跨区路由（与"不出 us-east-1"口径冲突）。因此推荐：PyMuPDF（born-digital 文本层/表格/PDF outline 目录树）为主 + Docling/marker（版面模型与 OCR，按需）+ Claude 视觉模型（Bedrock in-region，仅对图表密集页生成图注/结构化描述）的自有预处理管线，产出"每章节一个带元数据的分块文件"。**

- 决定性证据 1（日语）：BDA 文档处理 "Supported Input Languages: English, German, Spanish, French, Italian, Portuguese."（[BDA Prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-limits.html)）；Textract 同样 "supports English, French, German, Italian, Portuguese, and Spanish text detection"（[Textract Set Quotas](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)）。两者还都明确不支持纵排文字（日语手册常见）。**日语均不在官方口径内**。
- 决定性证据 2（驻留）：BDA "requires users to use cross Region inference support"，"your requests and output results may move outside of your primary Region"（[BDA CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-cris.html)）——与本项目"数据不出 us-east-1"的最严口径冲突。
- 决定性证据 3（区域）：即使想用 BDA 作为 Bedrock Knowledge Bases 的 parser——"The Amazon Bedrock Data Automation parser is supported in **US West (Oregon)** and is **in preview**"（[KB supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)）——**us-east-1 不可用**。
- Bedrock 原生可行路线是 **Foundation Model parser**（Claude/Nova 视觉模型做 KB 数据源解析器，官方推荐用于含 figures/charts/tables 的 PDF，us-east-1 可用），但按页付费成本高于 OSS 自解析一个量级左右（量级估算见 1.4）。

**(b) 图表参与检索的推荐姿势：以文本为媒介（text-mediated）——"图内文字 OCR + 图注/描述 + 周边正文"一起入索引，图片本身不进向量库。** 这是 AWS 官方文档明示的模式（"you can enable multimodal retrieval through text by selecting either Amazon Bedrock Data Automation ... or Foundation Model as parsers"，[KB multimodal](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal.html)），也与 Titan Multimodal Embeddings G1 官方语言口径只有英语相印证。日语图内文字的图像向量检索缺乏官方多语支持证据，不作为主路线。

**(c) KB（托管）vs 自建：在本项目现状下（Aurora MySQL、无 pgvector、条目数千级、答案是指针），首选"自建轻量索引"（分块+embedding 存现有 Aurora MySQL，Lambda 内暴力余弦检索——数学上几千×1024 维完全可行，标注为分析）；Bedrock KB 作为二阶段升级项，且若用 KB 应优先考虑 Managed KB（us-east-1 可用、免托管解析/嵌入/重排费用）而非自建 vector store。** 关键事实：KB 的 vector store 选项里 "Amazon Aurora (RDS)" 指的是 **Aurora PostgreSQL（pgvector）**——本项目现有的 Aurora MySQL 不能复用，用 KB+自建向量库意味着新增一个 Postgres 集群（或 OpenSearch Serverless）。

---

## 1. PDF 解析/版面理解方案对比

### 1.1 Amazon Bedrock Data Automation（BDA）

**对 PDF 的输出元素**（[Standard output – Documents](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-output-documents.html)）：

- **粒度**：Page（默认）/ Element（Layout，默认）/ Word 三级。"Element level granularity (Layout) – ... These elements, such as figures, tables, or paragraphs. These are returned in logical reading order based off the structure of the document."
- **TEXT 实体**：带 `sub_type`——"TITLE/SECTION_TITLE/HEADER/FOOTER/PARAGRAPH/LIST/PAGE_NUMBER"，附 `reading_order`、`page_indices`、bounding box。**存在 SECTION_TITLE（章节标题）这一类型**，理论上可用于章节切分。
- **TABLE 实体**：`representation` 含 `"markdown": "| header | ..."`、html、text、csv，另有 `headers`、`title`（表题）、`footers`、跨页 `page_indices`，async 模式还输出表格截图（`crop_images` 指向 S3）。
- **FIGURE 实体**（图表/截图在输出里的形态）：`"type": "FIGURE"`，带 `"sub_type": "CHART"`（图表种类）、`"title": "figure title"`（图题）、`"summary": ""`、`crop_images`（图片裁切存 S3）、`rai_flag`、`page_indices`。即：**图表作为独立实体出现，带图题、类型、页码与裁切图文件；正文 markdown 里对应位置可与之对位**。
- **图注生成（Generative Fields）**："When you select Generative Fields, you are generated a summary of the document, both a 10 word and 250 word version. Then, if you select elements as a response granularity, **you generate a descriptive caption of each figure detected in the document. Figures include things like charts, graphs, and images.**"——官方明示可对每个图生成描述性 caption，且"document summaries and figure captions are returned in the detected language of the document"（[Prerequisites 注记](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-limits.html)）。
- **文本格式**：Plaintext / **Text with markdown（默认）** / Text with HTML / CSV（仅表格）。`JSON+files` 输出会额外落盘："a markdown file for the text with structural markdown, and CSV files for each table ... Figures located inside a document will be saved as well as figure crops and rectified images. These outputs are located in `standard_output/{{logical_doc_id}}/assets/`"。
- **限额**：async 每文档最多 20 页（console）/ 3000 页（splitter 启用），≤500MB；sync ≤10 页、50MB；figure captioning "20 images per page (async)"（[Prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-limits.html)）。手册单本几百页需开 splitter 或自行分卷。

**日语支持：不支持（官方口径）。** 同页 "Supported Input Languages | English, German, Spanish, French, Italian, Portuguese."，且 "BDA does not support vertical text (text written vertically, as is common in languages like Japanese and Chinese) alignment within the document."。BDA 的日语能力只出现在**音频**转写与自定义词汇表（Data Automation Library 的 Japanese character set）——与文档解析无关。**BDA 文档解析对日语的实际效果：AWS 未公开说明（不在支持列表内，无法承诺）。**

**us-east-1 可用性与驻留**：BDA 本身可从 us-east-1 调用（CRIS ARN 表列出 "US East (N. Virginia) | arn:aws:bedrock:us-east-1:{account}:data-automation-profile/us.data-automation-v1"），但 "BDA requires users to use cross Region inference support when processing files"，"Although the data remains stored only in the source Region, **when using cross-Region inference, your requests and output results may move outside of your primary Region**"，美国地理内的路由范围是 us-east-1/us-east-2/us-west-1/us-west-2（[BDA CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-cris.html)）。**与"不出 us-east-1"的硬口径冲突。**

**与 Bedrock Knowledge Bases 的集成（作为 parser）**：

- 官方推荐语境："Because the default parser only outputs text, we recommend using Amazon Bedrock Data Automation or a foundation model as a parser instead of the default parser **if your documents include figures, charts, tables, or images**."；BDA/FM parser 还能 "extract these figures, charts, tables, and images and store them as files in an S3 destination ... During knowledge base retrieval, these files can be returned in the response or in source attribution."（[Parsing options](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-advanced-parsing.html)）。
- 配置方式：数据源 `vectorIngestionConfiguration.parsingConfiguration.parsingStrategy = "BEDROCK_DATA_AUTOMATION"`（[Customize ingestion](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-data-source-customize-ingestion.html)，该节标题仍为 "Amazon Bedrock Data Automation parser (preview)"）。
- **区域限制**："The Amazon Bedrock Data Automation parser is supported in **US West (Oregon)** and is in preview and subject to change."（[Supported models and Regions for KB](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)）——**截至调查日 us-east-1 不可用**。
- 注意事项："If you choose Amazon Bedrock Data Automation or foundation models as a parser, the method that you choose will be used to parse **all** .pdf files in your data source, even if the .pdf files contain only text."（计费影响）；多模态 S3 存储位置 "can't add ... after you've created a knowledge base"。

**定价**（[Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)）：KB 集成场景 "Bedrock Knowledge Bases and Bedrock Data Automation integration uses standard output, where the per page price is **$0.010**"（示例：1,000 页 = $10）；独立调用 Custom Output "The per page price for any blueprint with 30 fields or less is **$0.040**"。**前提（日语不支持+跨区）不成立，本项目用不上，仅作对照。**

### 1.2 Amazon Textract

- **Layout 能力**：AnalyzeDocument 加 `LAYOUT` FeatureType，返回 "paragraphs, lists, headers, footers, page numbers, figures, tables, titles, and section headers" 的版面块与阅读顺序（[Analyzing Documents](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-analyzing.html)）；BlockType 为 `LAYOUT_TITLE` / `LAYOUT_SECTION_HEADER` / `LAYOUT_FIGURE` / `LAYOUT_TABLE` / `LAYOUT_LIST` / `LAYOUT_HEADER` / `LAYOUT_FOOTER` / `LAYOUT_PAGE_NUMBER` / `LAYOUT_KEY_VALUE` / `LAYOUT_TEXT`，多栏按栏序返回（[Layout Response Objects](https://docs.aws.amazon.com/textract/latest/dg/layoutresponse.html)）。**有 LAYOUT_SECTION_HEADER，但注意它只是版面元素，不等于手册章节树；PDF outline/bookmark Textract 不提供。**
- **Tables/Forms**：TABLES 抽取表格结构与单元格（"table cells, cell text, and selection elements in cells"，可出 JSON/CSV/TXT），FORMS 抽 key-value（[Analyzing Documents](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-analyzing.html)）。
- **日语支持：不支持（官方口径）。** "Amazon Textract supports English, French, German, Italian, Portuguese, and Spanish text detection. ... **Query detection is only available in English** document detection."；同样 "does not support vertical text ... as is common in languages like Japanese and Chinese"（[Set Quotas](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)）。手写体识别仅英语。
- **与 BDA 的分工**：BDA 是 Bedrock 侧"生成式"多模态抽取（蓝图/摘要/图注 + markdown），Textract 是 OCR/版面基础设施层的按 API 计费服务。两者文档语言列表与"纵排不支持"表述一致；**BDA 文档解析是否内部调用 Textract——AWS 未公开说明**（文档未写）。对本项目两者结论相同：**日语手册不在官方支持范围**。
- **驻留（重要）**：Textract FAQ："Any content processed by Amazon Textract is encrypted and stored at rest in the AWS region where you are using Amazon Textract. **Unless you opt out ... some portion of content processed by Amazon Textract may be stored in another AWS region** solely in connection with the continuous improvement and development of your Amazon Textract customer experience ... You may opt out ... using an AWS Organizations opt-out policy."（[Textract FAQ](https://aws.amazon.com/textract/faqs/)）——**默认可能跨区留存用于服务改进，需 Organizations AI opt-out 才关掉**；这与 Bedrock 模型调用"不留存"的保证（见既有报告 `aws-bedrock-guardrails-mechanism.md` 第 4 节）是两套口径。

### 1.3 OSS 方案（GitHub 一手 README/LICENSE/官方文档）

| 项目 | 与本需求相关的能力（一手引用） | 日语成熟度 | 章节/目录（outline）能力 | 备注 |
| --- | --- | --- | --- | --- |
| **PyMuPDF**（[README](https://github.com/pymupdf/PyMuPDF)） | "Accurate — pixel-perfect text extraction with font, color, and position metadata"；`find_tables()` 表格→"Markdown or structured data"；**"Bookmarks — Read and write the outline / table of contents tree"** | FAQ 明示："Does PyMuPDF work with Korean, Japanese, or Chinese documents? **Yes — PyMuPDF has solid CJK support**"（文本层抽取；非 OCR） | **直接读 PDF outline/bookmark 树**（手册通常有书签目录，这是章节指针最可靠的锚点） | AGPL/商业双许可（MuPDF 系，选用前需过许可评审）；"runs entirely locally ... No data is transmitted anywhere" |
| **Docling**（IBM，[README](https://github.com/docling-project/docling)） | "Advanced PDF understanding incl. page layout, reading order, table structure, code, formulas, **image classification**"；导出 "Markdown, HTML, ... and lossless JSON"；"**Chart understanding (Barchart, Piechart, LinePlot): convert them into tables or code and add detailed descriptions**"；VLM 路线（GraniteDocling 等）；"Local execution capabilities for sensitive data and air-gapped environments" | OCR 引擎可插拔：Tesseract/EasyOCR/RapidOCR/Surya 等，语言经 `OcrOptions.lang`（BCP-47，如 `iso:ja`→引擎码）（[OCR concepts](https://docling-project.github.io/docling/concepts/OCR/)）；日语质量取决于所选引擎，**项目未单独承诺日语精度** | 无 outline 提取声明；章节结构靠版面标题层级（layout 模型） | MIT License（README 徽章）；LF AI & Data 基金会项目 |
| **marker**（datalab，[README](https://github.com/VikParuchuri/marker)） | "**Converts PDF, image, PPTX, DOCX, XLSX, HTML, EPUB files in all languages**"；单表/表单/公式格式化；olmocr-bench "Balanced mode scores **76.0%** overall – 83.5% on born-digital PDFs – ahead of MinerU and docling"；fast/balanced 两档；`--use_llm` 可挂 Claude/Gemini/OpenAI 兼容端点做难页精修 | "OCR runs through the surya VLM, which is **multilingual**"；"If you don't need OCR, marker can work with any language."（born-digital 日语文本层无需 OCR） | 无 outline 声明；输出 markdown 带标题层级 | **许可注意**：代码 Apache-2.0，但 "Our model weights use a modified AI Pubs Open Rail-M license (free for research, personal use, and startups under $5M funding/revenue). **For commercial use of the model weights beyond that, visit our pricing page**" |
| **unstructured**（[README](https://github.com/Unstructured-IO/unstructured)） | `partition_pdf` 分区为元素；hi-res 模式带版面模型；表格抽取 | OCR 走 tesseract："`tesseract-ocr` (images and PDFs, install **`tesseract-lang` for additional language support**)"——日语需自装 jpn 语言包，精度自担 | 无 outline 声明 | Apache-2.0（[LICENSE.md](https://github.com/Unstructured-IO/unstructured/blob/main/LICENSE.md)） |
| **pdfplumber**（[README](https://github.com/jsvine/pdfplumber)） | "Plumb a PDF for detailed information about each text character, rectangle, and line. Plus: Table extraction and visual debugging." | 文本层（pdfminer.six）对 CJK 无特殊声明 | 无 | 明确非目标："It's also helpful to know what features pdfplumber does **not** provide: ... **Optical character recognition (OCR)**"——只适合 born-digital |

**小结**：对"日语、born-digital 为主、需要章节树"的手册集，**PyMuPDF 的文本层+表格+outline 读取是地基**（唯一在 README 明示 outline 能力与 CJK 支持的选项）；扫描页/复杂版面再叠 Docling 或 marker（日语走 OCR/VLM，多语官方口径存在，但精度需用真实手册 PoC 验证——一手来源只承诺"支持"，不承诺质量）。marker 需先过模型权重商业许可。

### 1.4 视觉 LLM 路线（Bedrock 上的 Claude/Nova 解析 PDF）

**可行性（官方支持，us-east-1 可用）**：KB 的 FM parser 官方明确支持 "Claude vision models / Nova vision models / LLama 4 vision models"（[KB supported](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)），配置 `parsingStrategy = "BEDROCK_FOUNDATION_MODEL"` + `modelArn` + `parsingPrompt`（可定制解析提示词，[Customize ingestion](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-data-source-customize-ingestion.html)）。官方将其与 BDA 并列为图文混排 PDF 的推荐 parser："we recommend using Amazon Bedrock Data Automation or **a foundation model** as a parser ... if your documents include figures, charts, tables, or images."。自管管线等价物：PyMuPDF/Docling 把页面渲染成图 → Converse API `image` 块 → 生成带标题层级的 markdown——同一机制，可控性更强（分页、提示词、失败重试都归自己管）。

**成本量级（分析，基于官方单价）**：

- 官方给出的 token 参考值："processing 1,000 pages, where 30% contain tables and 30% contain figures, typically requires 2,900 input tokens and 750 output tokens"（[Pricing](https://aws.amazon.com/bedrock/pricing/)。原文挂在一千页的句子里，但按页面图像 token 消耗常识只能按**每页**理解；原文表述有歧义，此处为解读）。
- 以 Claude Sonnet 4.6 的提供方牌价 $3/MTok 输入、$15/MTok 输出（[Anthropic pricing](https://www.anthropic.com/pricing)；Bedrock 区域牌价页的动态表未随 HTML 输出，未能静态核实，标注）估算：每页 ≈ 2,900×$3/1M + 750×$15/1M ≈ **$0.020/页**；1.6 万页（200 本×80 页，示意规模）一次性全量解析 ≈ **$320**。用 Nova 系视觉模型可显著降低（其 us-east-1 牌价未能从静态页核实，标注）。
- 对照：BDA KB parser $0.010/页（但日语不支持+us-east-1 不可用）；OSS 自解析只付算力（Lambda/Fargate），无按页费用。
- **失真风险（定性）**：视觉转写会引入幻觉（图表数值、假图注）、页眉页脚噪声、跨页表格断裂；marker README 的对策佐证："For the highest accuracy, pass the `--use_llm` flag ... merge tables across pages"。指针型答案的正确性依赖章节锚点来自 PDF outline/页码而非模型记忆——因此**视觉模型只应产出"内容与图注"，章节指针必须由解析器（outline/页码）锚定**。

### 1.5 对比总表

| 方案 | 日语 PDF 官方口径 | 图表产出 | 章节/目录锚点 | us-east-1 | 成本量级 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- |
| BDA | **不支持**（EN/DE/ES/FR/IT/PT；纵排不支持） | FIGURE 实体+caption+裁切图 | SECTION_TITLE 版面类型（无 outline） | 可调用但**强制跨区**；作 KB parser 仅 us-west-2 preview | KB 集成 $0.01/页 | 日语质量未知；跨区违反口径 |
| Textract | **不支持**（同上语言列表） | LAYOUT_FIGURE（位置，无内容解读） | LAYOUT_SECTION_HEADER（无 outline） | 可用 | 按 API 计费 | 日语质量未知；FAQ 默认跨区留存（可 opt-out） |
| KB FM parser（Claude/Nova vision） | 可行（模型多语能力强，但 AWS 不给日语文档解析精度承诺） | 文本化图注+图片存 S3 供引用 | 依赖 parsingPrompt 输出标题层级 | **可用** | ≈$0.02/页（Claude Sonnet 4.6，分析） | 幻觉/失真；全 PDF 都走 FM 计费 |
| OSS（PyMuPDF+Docling/marker） | 文本层 CJK 支持（PyMuPDF 明示）；OCR 多语可插拔 | Docling 图表理解/图注；marker 表格/公式 | **PyMuPDF 读 outline 树** | 本地运行 | 只付算力 | 工程量自担；marker 权重商业许可 |

---

## 2. 图表/截图/流程图如何参与检索

**结论：走"文本中介"路线——图内文字 OCR + 图注/生成描述 + 周边正文，三者进同一文本索引；图片文件存 S3 供答案展示，图片向量不入库（或仅作可选增强）。**

官方证据链：

1. **AWS 官方对 text embedding 模型的明示**："Text embedding models limit retrieval to text-only content. However, **you can enable multimodal retrieval through text** by selecting either Amazon Bedrock Data Automation (for audio, video, and images) or Foundation Model as parsers (for images)."（[KB multimodal – adding data sources](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-add-data-source-and-ingest.html)）。即 KB 自己的推荐就是"用 parser 把图变成文本"。
2. **图注关联文本的产出能力**：
   - BDA："you generate a **descriptive caption of each figure** detected in the document"（Generative Fields，[Documents output](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-output-documents.html)）；BDA 独立图像模态还有 Image Summary 与 Image Text Detection（图内文字+bbox，[Images output](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-ouput-image.html)）——机制存在，但受日语不支持与区域限制约束。
   - BDA **Custom Output（blueprint）**可以定义任意抽取字段（含对图的描述字段），上限 40 个文档蓝图/项目（[Custom output](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-custom-output-idp.html)）——同样受日语/区域约束。
   - FM parser：`parsingPrompt` 完全自定义，可要求"为每个图输出图注+图内要点"。
   - OSS：Docling "Chart understanding ... convert them into tables or code and **add detailed descriptions**"；marker 表格→markdown。
3. **图片作为检索结果返回**：用 BDA/FM parser 时，"these files can be returned in the response or in source attribution"；Retrieve 响应里图片块以 base64 返回，并带响应头 "`x-amz-bedrock-kb-byte-content-source` – Contains the Amazon S3 URI of the image"、"x-amz-bedrock-kb-description"（[Query a knowledge base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)）。
4. **图像模态向量检索的现状**：KB 的多模态 embedding 选项为 Titan Multimodal Embeddings G1（**"Languages – English"**，图像 ≤2048×2048/25MB，1024/384/256 维，[模型页](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-multiemb-models.html)）、Cohere Embed v3/v4（多模态）、Amazon Nova Multimodal Embeddings（`amazon.nova-2-multimodal-embeddings-v1:0`，输入含 Text/Image/Audio/Video，[模型卡](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-amazon-nova-multimodal-embeddings.html)）。图像查询限制："**Image queries are only supported with multimodal embedding models (Titan G1 or Cohere Embed v3)**"、"Maximum of one image per query"、"RetrieveAndGenerate API is not supported for knowledge bases with multimodal embedding models and S3 content buckets"（[Query a knowledge base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)）。**对"日语图内文字的图像向量检索"没有任何官方多语质量口径；且本需求的查询是自然语言问句而非以图搜图**——AWS 自己的 Nova vs BDA 决策矩阵也把 BDA（文本抽取）对位到 "Image Content ... Text extraction from images, document processing, OCR requirements"，把 Nova 图像向量对位到 "Visual similarity searches"（同页）。
5. **务实路线的证据**：综上，"图内文字 OCR（Textract 日语不可用→用 OSS OCR 或 Claude 视觉）+ 图注 + 周边正文入索引、图片本体不入向量库"是唯一同时满足（i）AWS 官方推荐模式、（ii）日语可用、（iii）答案是指针（图注与图都挂在章节分块上）三个条件的姿势。图片文件存 S3，指针答案可附 S3 URI/页码让员工自行查看原图。

---

## 3. 章节切分与引用粒度（Bedrock Knowledge Bases）

**Chunking 选项现状**（[How content chunking works](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html) + [ChunkingConfiguration API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_ChunkingConfiguration.html)）：

| 策略 | 说明（官方） | 备注 |
| --- | --- | --- |
| Default | "Splits content into text chunks of approximately **300 tokens**"，保句边界 | 不传配置时的默认 |
| FIXED_SIZE | `maxTokens` + `overlapPercentage` | |
| HIERARCHICAL | parent/child 两层，检索时子块被父块替换 | 传大 token 时注意元数据大小限制（S3 Vectors 明示） |
| SEMANTIC | 按 `maxTokens`/`bufferSize`/`breakpointPercentileThreshold` 语义切分 | "There are **additional costs** ... due to its use of a foundation model" |
| NONE | "Each document is treated a single text chunk" | **没有名为 CUSTOM 的策略值**；"If you opt for NONE, then you may want to **pre-process your files by splitting them up such that each file corresponds to a chunk**"（API Reference 原文）——S3 预分块文件 + NONE 即"custom chunking"的现行做法 |
| Lambda 后处理 | `CustomTransformationConfiguration` + `stepToApply: POST_CHUNKING`："Include **chunking logic to provide a custom chunking strategy**" 与 "Include logic to specify **chunk-level metadata**" | 建数据源后**不可再改 chunking 策略**；parsing 策略类型同样不可改 |

- 与解析器联动的重要行为："For parsed content (such as content using advanced parsers or converted from HTML), ... **The chunker respects logical document boundaries (such as pages or sections)** and does not merge content across these boundaries"。
- NONE 的代价："If you choose no chunking for your documents, **you cannot view page number in citation** or filter by the *x-amz-bedrock-kb-document-page-number* metadata field"。

**Citations / retrievedReferences 能精确到什么粒度**：

- **Retrieve API**：返回 `retrievalResults[]`（KnowledgeBaseRetrievalResult）：`content`（文本块，或图片 base64）、`metadata`（**含你在 .metadata.json 里定义的全部自定义属性**）、`location`（"Contains the URI or URL of the document"，S3 数据源即 S3 URI）、`score`（[Query a knowledge base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)）。
- **RetrieveAndGenerate / InvokeAgent**：`citations[].retrievedReferences[]`（[RetrievedReference API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent-runtime_RetrievedReference.html)：`content` / `location` / `metadata`——"metadata attributes and their values **for the file in the data source**"）。InvokeAgent 响应同样有 retrievedReferences 字段。
- **粒度上限 = chunk 级**：引用能落到"哪个 S3 文件（=哪个分块文件）+ 该块的自定义 metadata + （OpenSearch Serverless/Aurora 向量库时）服务生成的页码属性"。**"手册名/章节号"要靠自定义 metadata 落地**：S3 数据源 sidecar 文件 `fileName.extension.metadata.json`（同名同目录，≤10KB），支持 `STRING/NUMBER/BOOLEAN/STRING_LIST`，且 `includeForEmbedding: true` 时 "The metadata key-value pair is concatenated to the chunk text before embedding"，可让"手册名/章名"参与语义匹配（[S3 connector metadata fields](https://docs.aws.amazon.com/bedrock/latest/userguide/s3-data-source-connector.html#ds-s3-metadata-fields)、[Include metadata](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-metadata.html)）。
- **页码**："If you have PDF documents in your data source and use **Amazon OpenSearch Serverless or Amazon Aurora** for your vector store: ... document page numbers ... stored in a metadata field/attribute called *x-amz-bedrock-kb-document-page-number*"（[kb-test-config](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)）。**若采用"预切分文件+NONE"路线则没有页码属性**——但这无关紧要：预切分路线下页码/章节号本来就在自己的 metadata 里。
- **metadata filter 能力**：equals/notEquals/greaterThan(OrEquals)/lessThan(OrEquals)/in/notIn/stringContains/listContains + andAll/orAll 组合；`x-amz-bedrock` 前缀为服务保留（同页）。过滤器可锁定"只在某手册/某版本内检索"。
- **结论**：对本需求（答案是"手册名+章节指针"），KB 的引用粒度**够用但需要自建 metadata 通道**：把每章切成一个文件（或用 Lambda 后处理按章切块），sidecar metadata 写 {manual_name, chapter_no, chapter_title, page_start, version}，retrievedReferences 即可直接拼出指针，LLM 只负责从候选里挑并组织成一句话——**指针值不由模型生成，而由检索结果携带**。

---

## 4. 日语 embedding 与检索（us-east-1、Bedrock 上）

| 模型 | 官方多语口径（原文） | 维度 | us-east-1 | 可否作 KB embedding |
| --- | --- | --- | --- | --- |
| **Titan Text Embeddings V2**（`amazon.titan-embed-text-v2:0`） | "optimized for English, **with multilingual support** for the following languages"（列表含 **Japanese**）；模型卡 "Languages – English (**100+ languages in preview**)"；"Cross-language queries ... will return sub-optimal results" | 1024（默认）/512/256，float+binary；8,192 token | In-Region 支持 | **可以**（KB 支持列表第一位） |
| Cohere Embed Multilingual v3（`cohere.embed-multilingual-v3`） | "multilingual text embedding model supporting **100+ languages** for cross-lingual search and classification" | 1024 | In-Region 支持 | 可以 |
| Cohere Embed v4（2025-04） | "unified **multimodal** embedding model that processes **text, images, and mixed content** in a single model for search and RAG" | 1024（float+binary） | us-east-1 In-Region（还支持 Geo/Global profile） | 模型卡标注 Knowledge base 支持；**KB"supported embeddings"表当前未列 v4**——两页口径不一致，截至调查日以 KB 表为准并标注 |
| Titan Multimodal Embeddings G1（`amazon.titan-embed-image-v1`） | **"Languages – English"**（文本侧） | 1024/384/256 | 支持 | 可（图像模态；见第 2 节限制） |
| Amazon Nova Multimodal Embeddings（`amazon.nova-2-multimodal-embeddings-v1:0`，2025-10-28 发布） | 输入 Text/Image/Audio/Video；**模型卡功能矩阵把 Knowledge base 列为不支持**，且只走 `StartAsyncInvoke`（异步） | （模型卡未列维度；KB 支持表单列 "Amazon Nova Multimodal Embeddings 1024"） | 仅 us-east-1 / us-gov-west-1 In-Region | **当前不可作为 KB embedding**（KB embeddings 支持表仅 Titan G1/Titan v2/Cohere v3 两个文本系 + 多模态维度表） |
| （曾宣布的 Nova Embed 文本系模型） | — | — | — | **现行模型目录（models at a glance / region compatibility）中不存在** nova-embed 系文本模型 ID；截至调查日未能核实其可用性 |

来源：[KB supported embeddings](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)、[Titan embeddings](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)、[Titan multimodal](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-multiemb-models.html)、[Nova MM 模型卡](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-amazon-nova-multimodal-embeddings.html)、[Cohere Embed Multilingual 卡](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-embed-multilingual.html)、[Cohere Embed v4 卡](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-embed-v4.html)、[模型区域兼容表](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html)。

**Hybrid 检索（语义+关键词）**：

- 自管 KB：`overrideSearchType: HYBRID | SEMANTIC`；"Hybrid – Combines searching vector embeddings (semantic search) with searching through the raw text."；**"Hybrid search is only supported for Amazon RDS, Amazon OpenSearch Serverless, and MongoDB vector stores that contain a filterable text field."**（[Configure and customize queries](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html)）。
- Managed KB："**Retrieval always uses hybrid search** ... Semantic-only search is not available for fully managed knowledge bases."（[Query a KB](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)）。
- **底层 OpenSearch 对日语分词（kuromoji）的处理：AWS 未公开说明。** KB 文档只说"searching through the raw text"，未披露索引 analyzer 配置；OpenSearch 引擎本身提供 kuromoji 分析器（OpenSearch 官方文档），但 **Bedrock KB 内部托管索引是否启用 kuromoji、日语查询的关键词侧如何切词，AWS 未公开说明**——自建 OpenSearch 集群路线可自行配 analyzer，托管路线只能黑盒测试。此点列为未知，需 PoC 用日语查询实测 hybrid 召回。

**Rerank（us-east-1）**："**The Amazon Rerank 1.0 model is not supported in the US East (N. Virginia) AWS Region.** You can only use the Cohere Rerank 3.5 model in this Region."（[rerank-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-supported.html)）。Cohere Rerank 3.5（`cohere.rerank-v3-5:0`）牌价 **$2.00/1,000 查询**（每"search unit"≤100 chunks、每文档 ≤512 token，[Pricing](https://aws.amazon.com/bedrock/pricing/)）。Managed KB 的服务托管 reranker 免费开启（默认）。

---

## 5. KB（托管）vs 自建

### 5.1 KB 的 vector store 选项（对照本项目 Aurora MySQL）

KB 支持的向量库（[Turning data into a knowledge base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-how-data.html)）：**Amazon OpenSearch Serverless、Amazon OpenSearch Service Managed Clusters、Amazon Neptune（Analytics/GraphRAG）、Amazon Aurora (RDS)、Pinecone、Redis Enterprise Cloud、MongoDB Atlas、Amazon S3 Vectors**。

其中 "Amazon Aurora (RDS)" 的真身是 **Aurora PostgreSQL + pgvector**："Create an Amazon Aurora database (DB) cluster ... by following the steps at **Using Aurora PostgreSQL as a knowledge base**"，元数据过滤建议单列 jsonb + GIN 索引，"we recommend enabling HNSW iterative index scans (**requires pgvector 0.8.0 or later**)"（[Vector store prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html)）。**本项目现有库是 Aurora MySQL（`cdk/lib/constructs/database.ts`，AuroraMysqlEngineVersion 3.08）——不能作为 KB 向量库。** 用 KB + 自管向量库 = 新增一个 Aurora PostgreSQL 集群（或 OpenSearch Serverless 集合）；binary 向量仅 OpenSearch 系支持；hybrid 仅 RDS/OpenSearch Serverless/Mongo。

### 5.2 KB 的数据更新模型（对"最新手册集"的意义）

- **S3 数据源增量 sync**："Syncing is incremental, so Amazon Bedrock processes only the documents that were added, modified, or deleted since the last sync."；删除语义明确：**"Document deleted → The document is removed from the vector store."**；另有 metadata-only 优化（只改 .metadata.json 不重嵌入）（[Sync your data](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-data-source-sync-ingest.html)）。对"手册改版"场景：换版本=新 S3 对象+旧对象删除+sync，天然增量。
- **Direct ingestion（custom ingest API）现状：已可用**："With direct ingestion, you can directly add, update, or delete files in a knowledge base in a single action ... Direct ingestion uses the **`KnowledgeBaseDocuments` API operations**"，支持 S3 与 Custom 数据源；注意 S3 数据源混用警告（sync 会覆盖 direct ingestion 的变更）（[Ingest changes directly](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-direct-ingestion.html)）。
- 数据源删除策略：RETAIN 删除后内容仍留在向量库直到显式 resync（[multimodal 数据源删除行为](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-add-data-source-and-ingest.html)）。

### 5.3 Managed KB（本项目若走 KB 的首选形态）

[Bedrock Managed KB](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html)（us-east-1 在支持列表，[regions](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-regions.html)）：Bedrock 托管 ingestion/存储/索引/检索，"Managed Embedding model | Comes with built-in managed model ... **at no extra cost**"、"Managed Reranking | ... at no extra cost"、"Data parsing | **Built-in parser for multimodal file types**"、"Chunking | Choose among built-in (default) or **fixed-size**"。定价（[Pricing](https://aws.amazon.com/bedrock/pricing/)）：**Index Storage $5.00/GB 原始数据/月；Standard Retrieval（Retrieve API）$1.00/1,000 次调用；托管 parser/embedding/rerank $0**。检索恒为 hybrid + 默认托管 rerank。**注意其 chunking 只有 default/fixed-size（无 NONE/语义/hierarchical），且托管 parser 对日语 PDF 的质量：AWS 未公开说明。** managedSearchConfiguration 下 `startsWith`/`stringContains` 过滤器不可用（[kb-test-retrieve](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve.html)）。

### 5.4 自建路线的可行性（分析，非来源结论）

量级测算（标注为**分析**）：章节级条目 N=5,000，Titan v2 1024 维 float32 → 向量总量 5,000×1024×4B ≈ **20.5 MB**——一次性载入 Lambda 内存毫无压力；暴力余弦 = 单查询 5.12M 次乘加，NumPy 矩阵乘在百 ms 内（Node/TS typed array 亦然）。存储：现有 Aurora MySQL 建一张 `manual_chunk` 表（chunk 文本 + embedding BLOB + 手册名/章号/页码/版本列），冷启动或缓存加载全量向量。一次性嵌入成本：5,000 块×约 1,000 token ≈ 5M token；参照定价页 Cohere embed 示例牌价（10K token=$0.001，即 $0.10/MTok）≈ **$0.5/全量**（Titan v2 牌价未静态核实，量级相同）。关键词侧可用 MySQL FULLTEXT（MySQL 8.0 内置 ngram 解析器面向 CJK；**Aurora MySQL 对 ngram 的支持未在 AWS 文档逐项核实，标注**），或干脆用向量 top-K + 简易日文 n-gram 重排。**结论：在"几千条目"规模，自建是完全可行的，且不新增任何 AWS 资产；代价是自己负责更新（改版=删旧插新）与检索质量调优。**

---

## 6. 数据驻留（与"不出 us-east-1"口径的相容性）

| 服务 | 官方表述（原文摘录） | 与本项目口径相容性 |
| --- | --- | --- |
| **BDA** | "BDA **requires** users to use cross Region inference support ... Although the data remains stored only in the source Region, **when using cross-Region inference, your requests and output results may move outside of your primary Region**."（US 地理内 us-east-1/2、us-west-1/2）（[BDA CRIS](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-cris.html)） | **不相容（最严口径下）**：处理可能在美区内其他 Region 进行。存储留源区，但"请求与输出结果"会出区 |
| **Textract** | "Any content processed by Amazon Textract is encrypted and **stored at rest in the AWS region where you are using** Amazon Textract. **Unless you opt out ... some portion of content ... may be stored in another AWS region** solely in connection with the continuous improvement ..."（[Textract FAQ](https://aws.amazon.com/textract/faqs/)） | 有条件相容：处理区域性，但**默认可能为服务改进跨区留存**，须设 AWS Organizations AI opt-out policy |
| **Bedrock KB** | "If you use cross-Region inference, **your data can be shared across Regions**."（[KB supported](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)） | 相容（前提）：parsing/生成用 **in-region 模型 ID** 即留在 us-east-1；用 us. 前缀 profile 则同 BDA 逻辑出区 |
| **Cross-Region Inference（通用）** | Geographic profile："Data residency | **Within geographic boundaries** (such as US, EU, and APAC)"；"All data transmitted during cross-Region operations remains on the AWS network"（[cross-region-inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)） | us. 前缀=美国地理内、可能跨 us-east-2/us-west-*。**若口径是"字面上不出 us-east-1"，应选 in-region 模型 ID 而非 us. profile**——这与既有数据口径报告"倾向 us. 前缀"的偏好存在张力，建议在提案话术上把口径定义为"不出 AWS 美国区域（us. profile）"或改用 in-region |
| **Embedding 模型** | 模型区域兼容表：Titan v2 / Cohere Embed 在 us-east-1 为 **In-Region**（Geo/Global 列为不支持）（[models-region-compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html)） | 相容：embedding 调用天然 in-region |
| **OSS 解析（PyMuPDF/Docling 等）** | PyMuPDF："runs entirely locally ... **No data is transmitted anywhere**"；Docling："**Local execution** capabilities for sensitive data and air-gapped environments" | 完全相容：解析发生在自管 Lambda/Fargate 内，出界流量只有 → Bedrock（in-region）与 → S3 |

Bedrock 模型调用的"不留存、不训练"保证沿用既有结论（见 `docs/research/aws-bedrock-guardrails-mechanism.md` 第 4 节，本文不复述）。

---

## 与本项目的对接点

1. **现有 IAM 已备好检索侧**：`cdk/lib/constructs/agent.ts` 的 AgentCore 运行时角色已有 `bedrock:Retrieve`（`arn:aws:bedrock:{region}:{account}:knowledge-base/*`）。无论自建还是 KB，运行时侧改动的都是处理器代码而非权限主体；若走 KB，**建库/同步**还需在数据管线角色上加 `bedrock-agent:*`（CreateKnowledgeBase/StartIngestionJob 等）——现有策略不含。
2. **数据库现状决定架构分叉**：`cdk/lib/constructs/database.ts` 是 Aurora MySQL Serverless v2（3.08），**KB 用不上它**。三条路径：
   - **A（推荐起步）自建**：解析管线（Lambda Python：PyMuPDF outline+文本+表格；扫描页叠 OCR；Claude 视觉生成图注）→ 章节分块 + {manual, chapter, page, version} 元数据 → Titan v2 embedding（us-east-1 in-region）→ 存现有 MySQL → AgentCore 处理器内余弦 top-K + 日语 n-gram 重排 → LLM 从 retrievedReferences 式结构化结果里**选指针**（不生成指针内容）。零新增 AWS 资产、完全驻留相容、几千条目数学上轻松（分析）。
   - **B 升级到 Managed KB**：同一套预切分文件放 S3 做 S3 数据源（managed KB chunking 只有 default/fixed-size，预切分成小文件可绕过）；引用侧拿 `location`（S3 URI）+ metadata 指针；$5/GB/月 + $1/1k 检索，免 parser/embedding/rerank 费用，us-east-1 可用。代价：托管 parser 对日语的解析质量 AWS 未公开说明，且 metadata 过滤操作面比自管 KB 窄。
   - **C 自管 KB（OpenSearch Serverless 或新增 Aurora PostgreSQL）**：只有当需要"hybrid 的托管日语分词 + 页码引用 + 完整 metadata filter + Cohere Rerank"全套时才值得，成本=新增集群运维。**不建议为本需求直接上 C。**
3. **BDA/Textract 在本需求中的定位**：调查结论是**双双出局**（日语不在官方支持语言列表 + BDA 跨区强制 + BDA-as-KB-parser 仅 us-west-2 preview）。若未来 AWS 把 BDA 文档语言扩到日语且 KB parser 进 us-east-1，可按 $0.01/页重估——届时再查 [bda-limits](https://docs.aws.amazon.com/bedrock/latest/userguide/bda-limits.html) 与 [knowledge-base-supported](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)。
4. **与数据口径报告（2026-09-16）的衔接**：口径说"数据不出 us-east-1、倾向 us. 前缀 inference profile"。本调查补充了一个必须写进提案的细节：**us. profile 与 BDA 一样是"地理内跨区"**（AWS 原文见第 6 节）。手册解析管线建议全部用 in-region 模型 ID（Claude 视觉解析、Titan v2 embedding 均支持 in-region），把"不出 us-east-1"做成字面成立；us. profile 仅用于与手册检索无关的既有对话场景。
5. **答案形态的落地约定**：检索返回的每条结果天然携带 {manual_name, chapter_no, chapter_title, page, s3_uri}——LLM 的职责是"选择与表述"，指针字段一律来自检索结果与 MySQL 元数据（第 3 节的 metadata 通道），这样"答案是指针不是解说"由数据结构保证，而不是靠提示词约束。

### 未知/未能核实事项清单（截至 2026-09-17）

1. BDA/Textract 对日语文档的**实际**解析质量——AWS 未公开说明（官方语言列表不含日语，属"不支持"而非"质量未知"，但工程上常被问及，故留档）。
2. Bedrock KB hybrid 检索关键词侧的**日语分词（kuromoji 或其他 analyzer）配置**——AWS 未公开说明；只能 PoC 实测。
3. Bedrock 托管 KB 内置 parser 对日语 PDF 的质量与语言口径——AWS 未公开说明。
4. Titan Text Embeddings V2 与 Nova 视觉模型在 us-east-1 的**精确牌价**——Bedrock 定价页模型价格表为动态加载，静态抓取未获得；本文成本估算使用 Anthropic 牌价（Claude Sonnet 4.6 $3/$15 per MTok）与定价页官方示例（Cohere embed $0.10/MTok、BDA $0.01/页、Rerank $2/1k）。
5. 曾于 2025 年宣布的 Nova Embed 系**纯文本 embedding 模型**——现行 Bedrock 模型目录中已不存在对应模型 ID，截至调查日未能核实其状态（现存 Nova 侧仅 `amazon.nova-2-multimodal-embeddings-v1:0`，且其模型卡标注不支持作为 KB embedding）。
6. marker 模型权重商业授权的费用条款——需联系 datalab（README 明示超过门槛需付费）。
7. Aurora MySQL（MySQL 8.0 兼容）的 ngram 全文解析器在 Aurora 上的逐项支持——引擎层为 MySQL 官方能力，AWS Aurora 文档层面未逐项核实。
8. 定价页 FM parser 示例中 "2,900 input tokens and 750 output tokens" 的计量口径（每页/每千页）——原文有歧义，本文按每页理解并已标注。
