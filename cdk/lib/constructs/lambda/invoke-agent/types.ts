export interface StepFunctionsInput {
  reviewJobId: string;
  checkId: string;
  reviewResultId: string;
  preItemResult: {
    Payload: {
      checkName: string;
      checkDescription: string;
      feedbackSummary: string | null;
      languageName: string;
      documentPaths: string[];
      documentIds: string[];
      documentTypes?: string[];
      caseData?: any;
      mcpServers: McpServerConfig[];
      toolConfiguration: any;
      modelId: string | null;
    };
  };
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentPayload {
  reviewJobId: string;
  checkId: string;
  reviewResultId: string;
  documentPaths: string[];
  documentIds?: string[];
  documentTypes?: string[];
  caseData?: any;
  checkName: string;
  checkDescription: string;
  feedbackSummary: string | null;
  languageName: string;
  mcpServers: McpServerConfig[];
  toolConfiguration: any;
  modelId: string | null;
}
