import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReviewJob } from "./review-job";

// core/s3 と core/sqs は createReviewJob 内で直接呼ばれる（deps 経由ではない）のでモック
vi.mock("../../../core/s3", () => ({
  getS3ObjectSize: vi.fn().mockResolvedValue(1000),
  getPresignedUrl: vi.fn(),
}));

vi.mock("../../../core/sqs", () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getQueueDepth: vi.fn(),
}));

// リポジトリは deps 経由で注入するのでファクトリは呼ばれない
const mockCheckRepo = {
  findCheckListSetDetailById: vi.fn(),
  findCheckListItems: vi.fn(),
};
const mockReviewJobRepo = {
  createReviewJob: vi.fn(),
};

const TOUKI_TYPES = [
  "抵当権設定契約証書",
  "登記完了証",
  "登記情報識別通知",
  "登記簿謄本",
];

const doc = (
  documentType: string | undefined,
  id = "doc-1"
): { id: string; filename: string; s3Key: string; fileType: string; documentType?: string } => ({
  id,
  filename: `${id}.pdf`,
  s3Key: `review/${id}.pdf`,
  fileType: "pdf",
  ...(documentType !== undefined ? { documentType } : {}),
});

const call = (
  documents: ReturnType<typeof doc>[],
  declaredDocumentTypes: string[] | undefined
) =>
  createReviewJob({
    requestBody: {
      name: "登記審査",
      checkListSetId: "set-1",
      caseData: { 案件情報: { 顧客氏名: "山田一郎" } },
      documents,
      userId: "user-1",
    },
    deps: {
      checkRepo: mockCheckRepo as any,
      reviewJobRepo: mockReviewJobRepo as any,
    },
  });

describe("createReviewJob — 文書タイプ検証", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DOCUMENT_BUCKET", "mock-bucket");
    vi.stubEnv("REVIEW_QUEUE_URL", "mock-queue-url");
    // デフォルト: 4 文書タイプを宣言した登記セット
    mockCheckRepo.findCheckListSetDetailById.mockResolvedValue({
      declaredDocumentTypes: TOUKI_TYPES,
    });
    // ファクトリが項目を取れるように（空だと NotFoundError）
    mockCheckRepo.findCheckListItems.mockResolvedValue([{ id: "check-1" }]);
    mockReviewJobRepo.createReviewJob.mockResolvedValue(undefined);
  });

  it("accepts valid distinct documentTypes", async () => {
    await call(
      [doc("抵当権設定契約証書", "d1"), doc("登記簿謄本", "d2")],
      TOUKI_TYPES
    );
    expect(mockReviewJobRepo.createReviewJob).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown documentType", async () => {
    await expect(
      call([doc("存在しない書類")], TOUKI_TYPES)
    ).rejects.toThrow("Unknown documentType");
    expect(mockReviewJobRepo.createReviewJob).not.toHaveBeenCalled();
  });

  it("rejects duplicate documentTypes", async () => {
    await expect(
      call([doc("抵当権設定契約証書", "d1"), doc("抵当権設定契約証書", "d2")], TOUKI_TYPES)
    ).rejects.toThrow("Duplicate documentType");
  });

  it("rejects a missing documentType when the set declares 文書タイプ", async () => {
    await expect(call([doc(undefined)], TOUKI_TYPES)).rejects.toThrow(
      "documentType is required"
    );
  });

  it("skips documentType validation for legacy sets (no declared types)", async () => {
    // declaredDocumentTypes が空 → 従来型。documentType なしでも許可
    mockCheckRepo.findCheckListSetDetailById.mockResolvedValue({
      declaredDocumentTypes: [],
    });

    await call([doc(undefined)], []);

    expect(mockReviewJobRepo.createReviewJob).toHaveBeenCalledTimes(1);
  });

  it("persists caseData through to the review job", async () => {
    await call([doc("抵当権設定契約証書")], TOUKI_TYPES);

    const created = mockReviewJobRepo.createReviewJob.mock.calls[0][0];
    expect(created.caseData).toEqual({
      案件情報: { 顧客氏名: "山田一郎" },
    });
  });
});
