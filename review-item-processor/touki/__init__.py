"""登記書類整合性審査（抵当権設定）の LLM 依存しない純粋層。

prompt 構築と結果解析は AWS / Strands / LLM / DB に依存しない純粋関数であり、
agent.py への組込み（Bedrock 呼出）は Bedrock 環境で後続に行う。
"""
