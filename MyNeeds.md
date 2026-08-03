# 将本通用项目进行特定Review需求的改造

## checklist-workflow相关改造

1. 在保留现有的CheckList生成管理功能的基础上，追加模板导入式的CheckList生成，输入文件是markdown类型的模板，符合系统现有数据结构，用户输入自己的checklist后，允许LLM进行原有的分析与提示功能。

## review-workflow相关改造

1. review对象不是单一的文件，而是一组复合数据。包括：若干特定文件格式的扫描件，每种文件格式对应一个扫描件（可以是PDF或图片），用户选择文件格式并上传相应的文件；一份Json格式的数据，数据内的名值对都是LLM可理解的自然语言。

2. CheckList涵盖文件与文件之间的数据一致性比较，文件与Json数据之间的数据一致性比较。

3. 结果格式与相关功能保持为与目前的设计一致。

## 相关背景

1. 目前有一个AWS bedrock AgentCore Harness，这个Harness接受一个Json的输入，输入中分两个部分，一个部分是模拟的若干特定文件格式的扫描件的OCR结果，一个部分是系统内抽出的相关数据，名值对都是LLM可理解的自然语言。

2. 在AWS bedrock AgentCore Harness内部，System Prompt中写了一个特定的CheckList，将比较上面的数据一致性并输出结果。

3. 用户要求使用本项目结合上述Harness的功能，以便于提案。Harness本身不支持pdf或者图片作为参数输入，所以考虑在本项目上进行改造，实现相同的功能。

4. 暂定使用项目的多模态LLM的思路，测试准确性。