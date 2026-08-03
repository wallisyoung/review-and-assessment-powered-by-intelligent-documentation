import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock factories (hoisted to avoid vi.mock initialization issues) ---

const {
  mockReviewJobRepo,
  mockCheckRepo,
  mockUserPrefRepo,
  mockToolConfigRepo,
} = vi.hoisted(() => ({
  mockReviewJobRepo: {
    findReviewJobById: vi.fn(),
  },
  mockCheckRepo: {
    findCheckListItemById: vi.fn(),
  },
  mockUserPrefRepo: {
    getUserPreference: vi.fn(),
  },
  mockToolConfigRepo: {
    findById: vi.fn(),
  },
}));

vi.mock("../../api/features/review/domain/repository", () => ({
  makePrismaReviewJobRepository: vi.fn().mockResolvedValue(mockReviewJobRepo),
}));

vi.mock("../../api/features/checklist/domain/repository", () => ({
  makePrismaCheckRepository: vi.fn().mockResolvedValue(mockCheckRepo),
}));

vi.mock("../../api/features/user-preference/domain/repository", () => ({
  makePrismaUserPreferenceRepository: vi
    .fn()
    .mockResolvedValue(mockUserPrefRepo),
}));

vi.mock("../../api/features/tool-configuration/domain/repository", () => ({
  makePrismaToolConfigurationRepository: vi
    .fn()
    .mockResolvedValue(mockToolConfigRepo),
}));

import { preReviewItemProcessor } from "../review-preprocessing/pre-review-item";

// --- Helpers ---

const makeJobDetail = (
  overrides?: Partial<{ documents: any[]; caseData: unknown }>
) => ({
  id: "job-1",
  name: "Test Job",
  status: "processing",
  caseData: { 案件情報: { 顧客氏名: "山田一郎" } },
  documents: [
    {
      id: "doc-1",
      filename: "test.pdf",
      s3Path: "s3://bucket/test.pdf",
      fileType: "pdf",
      documentType: "抵当権設定契約証書",
    },
  ],
  ...overrides,
});

// 4 文書タイプの複合レビュー対象（登記デモ用）
const makeToukiJobDetail = () => ({
  id: "job-1",
  name: "Touki Job",
  status: "processing",
  caseData: { 案件情報: { 顧客氏名: "山田一郎" } },
  documents: [
    {
      id: "doc-teitou",
      filename: "teitou.pdf",
      s3Path: "s3://bucket/teitou.pdf",
      fileType: "pdf",
      documentType: "抵当権設定契約証書",
    },
    {
      id: "doc-kanryo",
      filename: "kanryo.pdf",
      s3Path: "s3://bucket/kanryo.pdf",
      fileType: "pdf",
      documentType: "登記完了証",
    },
    {
      id: "doc-sikibetsu",
      filename: "sikibetsu.pdf",
      s3Path: "s3://bucket/sikibetsu.pdf",
      fileType: "pdf",
      documentType: "登記情報識別通知",
    },
    {
      id: "doc-touki",
      filename: "touki.pdf",
      s3Path: "s3://bucket/touki.pdf",
      fileType: "pdf",
      documentType: "登記簿謄本",
    },
  ],
});

const makeCheckListItem = (overrides?: Record<string, unknown>) => ({
  id: "check-1",
  name: "Check Item",
  description: "Check description",
  toolConfigurationId: null,
  modelId: undefined,
  feedbackSummary: null,
  ...overrides,
});

describe("preReviewItemProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserPrefRepo.getUserPreference.mockResolvedValue(null);
    // テスト用の availableModels を設定
    vi.stubEnv(
      "AVAILABLE_MODELS",
      JSON.stringify([
        {
          modelId: "anthropic.claude-sonnet-4",
          displayName: "Claude Sonnet 4",
        },
        { modelId: "model-x", displayName: "Model X" },
      ])
    );
  });

  it("includes modelId in output when checkList has modelId set", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: "anthropic.claude-sonnet-4" })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.modelId).toBe("anthropic.claude-sonnet-4");
  });

  it("sets modelId to null when checkList modelId is not set", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: undefined })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.modelId).toBeNull();
  });

  it("sets modelId to null when checkList modelId is null", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: null })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.modelId).toBeNull();
  });

  it("returns correct payload shape with all expected fields", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: "anthropic.claude-sonnet-4" })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result).toEqual({
      checkName: "Check Item",
      checkDescription: "Check description",
      feedbackSummary: null,
      languageName: "English",
      documentPaths: ["s3://bucket/test.pdf"],
      documentIds: ["doc-1"],
      documentTypes: ["抵当権設定契約証書"],
      caseData: { 案件情報: { 顧客氏名: "山田一郎" } },
      toolConfiguration: null,
      modelId: "anthropic.claude-sonnet-4",
    });
  });

  it("throws when checkList item is not found", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(null);

    await expect(
      preReviewItemProcessor({
        reviewJobId: "job-1",
        checkId: "missing-check",
        reviewResultId: "result-1",
      })
    ).rejects.toThrow("Check list item not found: missing-check");
  });

  it("throws when no documents found", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(
      makeJobDetail({ documents: [] })
    );
    mockCheckRepo.findCheckListItemById.mockResolvedValue(makeCheckListItem());

    await expect(
      preReviewItemProcessor({
        reviewJobId: "job-1",
        checkId: "check-1",
        reviewResultId: "result-1",
      })
    ).rejects.toThrow("No documents found for review job job-1");
  });

  it("includes toolConfiguration when checkList has toolConfigurationId", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ toolConfigurationId: "tool-1", modelId: "model-x" })
    );
    mockToolConfigRepo.findById.mockResolvedValue({
      id: "tool-1",
      name: "KB Config",
      knowledgeBase: { knowledgeBaseId: "kb-1" },
      codeInterpreter: false,
      mcpConfig: null,
    });

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.toolConfiguration).toEqual({
      knowledgeBase: { knowledgeBaseId: "kb-1" },
      codeInterpreter: false,
      mcpConfig: null,
    });
    expect(result.modelId).toBe("model-x");
  });

  it("uses user language preference when userId is provided", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(makeCheckListItem());
    mockUserPrefRepo.getUserPreference.mockResolvedValue({
      language: "ja",
    });

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
      userId: "user-1",
    });

    expect(result.languageName).toBe("Japanese");
    expect(result.modelId).toBeNull();
  });

  it("falls back modelId to null when modelId is not in availableModels", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: "removed-model-id" })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.modelId).toBeNull();
  });

  it("falls back modelId to null when AVAILABLE_MODELS is empty", async () => {
    vi.stubEnv("AVAILABLE_MODELS", "[]");
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ modelId: "anthropic.claude-sonnet-4" })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.modelId).toBeNull();
  });

  // --- ADR-0002: 規則ごとの requiredDocumentTypes によるスキャン部分投入 ---

  it("subsets documents to a single requiredDocumentType", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeToukiJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ requiredDocumentTypes: ["登記簿謄本"] })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.documentIds).toEqual(["doc-touki"]);
    expect(result.documentTypes).toEqual(["登記簿謄本"]);
  });

  it("subsets documents to multiple requiredDocumentTypes", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeToukiJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({
        requiredDocumentTypes: ["抵当権設定契約証書", "登記簿謄本"],
      })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.documentIds).toEqual(["doc-teitou", "doc-touki"]);
    expect(result.documentTypes).toEqual([
      "抵当権設定契約証書",
      "登記簿謄本",
    ]);
  });

  it("passes all documents when requiredDocumentTypes is empty", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeToukiJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(
      makeCheckListItem({ requiredDocumentTypes: [] })
    );

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.documentIds).toEqual([
      "doc-teitou",
      "doc-kanryo",
      "doc-sikibetsu",
      "doc-touki",
    ]);
  });

  it("passes all documents when requiredDocumentTypes is undefined", async () => {
    mockReviewJobRepo.findReviewJobById.mockResolvedValue(makeToukiJobDetail());
    mockCheckRepo.findCheckListItemById.mockResolvedValue(makeCheckListItem());

    const result = await preReviewItemProcessor({
      reviewJobId: "job-1",
      checkId: "check-1",
      reviewResultId: "result-1",
    });

    expect(result.documentIds).toEqual([
      "doc-teitou",
      "doc-kanryo",
      "doc-sikibetsu",
      "doc-touki",
    ]);
    // caseData もそのまま透過される
    expect(result.caseData).toEqual({
      案件情報: { 顧客氏名: "山田一郎" },
    });
  });
});
