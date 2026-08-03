import { describe, it, expect, vi } from "vitest";
import { updateCheckResultCascade } from "./review-result-cascade-update";
import {
  REVIEW_RESULT,
  REVIEW_RESULT_STATUS,
  type ReviewResultDetail,
  type ReviewResultEntity,
  type ReviewResultRepository,
} from "../model/review";

/** テスト用の審査結果ノードを生成（デフォルトは COMPLETED） */
const makeDetail = (opts: {
  checkId: string;
  parentId?: string;
  result?: REVIEW_RESULT;
  status?: REVIEW_RESULT_STATUS;
  name?: string;
  confidence?: number;
}): ReviewResultDetail => ({
  id: `result-${opts.checkId}`,
  reviewJobId: "job-1",
  checkId: opts.checkId,
  status: opts.status ?? REVIEW_RESULT_STATUS.COMPLETED,
  result: opts.result,
  confidenceScore: opts.confidence ?? 0.9,
  explanation: "",
  shortExplanation: "",
  userOverride: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  checkList: {
    id: opts.checkId,
    setId: "set-1",
    name: opts.name ?? opts.checkId,
    description: "",
    parentId: opts.parentId,
  },
  hasChildren: false,
});

/** モックリポジトリ。bulkUpdateResults に渡されたノードを記録する */
const makeRepo = (all: ReviewResultDetail[]) => {
  const bulkUpdated: ReviewResultEntity[] = [];
  const repo = {
    findDetailedReviewResultById: vi.fn(),
    findReviewResultsById: vi.fn().mockResolvedValue(all),
    updateResult: vi.fn().mockResolvedValue(undefined),
    bulkUpdateResults: vi
      .fn()
      .mockImplementation(async (params: { results: ReviewResultEntity[] }) => {
        bulkUpdated.push(...params.results);
      }),
  };
  return { repo: repo as unknown as ReviewResultRepository, bulkUpdated };
};

const runCascade = (tree: ReviewResultDetail[], updatedCheckId: string) => {
  const { repo, bulkUpdated } = makeRepo(tree);
  const updated = tree.find((r) => r.checkId === updatedCheckId)!;
  return updateCheckResultCascade({
    updated,
    deps: { reviewResultRepo: repo },
  }).then(() => bulkUpdated);
};

describe("updateCheckResultCascade (3-state: fail > undeterminable > pass)", () => {
  it("parent = pass when all children pass", async () => {
    const tree = [
      makeDetail({ checkId: "p", name: "総合審査" }),
      makeDetail({ checkId: "c1", parentId: "p", result: REVIEW_RESULT.PASS }),
      makeDetail({ checkId: "c2", parentId: "p", result: REVIEW_RESULT.PASS }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS }),
    ];
    const bulkUpdated = await runCascade(tree, "c1");
    const parent = bulkUpdated.find((r) => r.checkId === "p");
    expect(parent).toBeDefined();
    expect(parent!.result).toBe(REVIEW_RESULT.PASS);
    expect(parent!.status).toBe(REVIEW_RESULT_STATUS.COMPLETED);
  });

  it("parent = fail when any child fails", async () => {
    const tree = [
      makeDetail({ checkId: "p" }),
      makeDetail({ checkId: "c1", parentId: "p", result: REVIEW_RESULT.PASS }),
      makeDetail({ checkId: "c2", parentId: "p", result: REVIEW_RESULT.FAIL }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS }),
    ];
    const bulkUpdated = await runCascade(tree, "c1");
    const parent = bulkUpdated.find((r) => r.checkId === "p");
    expect(parent!.result).toBe(REVIEW_RESULT.FAIL);
  });

  it("parent = undeterminable when a child is undeterminable (no fail)", async () => {
    const tree = [
      makeDetail({ checkId: "p" }),
      makeDetail({
        checkId: "c1",
        parentId: "p",
        result: REVIEW_RESULT.UNDETERMINABLE,
      }),
      makeDetail({ checkId: "c2", parentId: "p", result: REVIEW_RESULT.PASS }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS }),
    ];
    const bulkUpdated = await runCascade(tree, "c2");
    const parent = bulkUpdated.find((r) => r.checkId === "p");
    expect(parent!.result).toBe(REVIEW_RESULT.UNDETERMINABLE);
  });

  it("fail wins over undeterminable", async () => {
    const tree = [
      makeDetail({ checkId: "p" }),
      makeDetail({ checkId: "c1", parentId: "p", result: REVIEW_RESULT.FAIL }),
      makeDetail({
        checkId: "c2",
        parentId: "p",
        result: REVIEW_RESULT.UNDETERMINABLE,
      }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS }),
    ];
    const bulkUpdated = await runCascade(tree, "c3");
    const parent = bulkUpdated.find((r) => r.checkId === "p");
    expect(parent!.result).toBe(REVIEW_RESULT.FAIL);
  });

  it("does not aggregate when not all children are completed", async () => {
    const tree = [
      makeDetail({ checkId: "p" }),
      makeDetail({ checkId: "c1", parentId: "p", result: REVIEW_RESULT.PASS }),
      makeDetail({
        checkId: "c2",
        parentId: "p",
        result: undefined,
        status: REVIEW_RESULT_STATUS.PROCESSING,
      }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS }),
    ];
    const bulkUpdated = await runCascade(tree, "c1");
    // 親は子が揃っていないので更新されない
    expect(bulkUpdated.find((r) => r.checkId === "p")).toBeUndefined();
  });

  it("parent explanation lists failed and undeterminable children", async () => {
    const tree = [
      makeDetail({ checkId: "p" }),
      makeDetail({
        checkId: "c1",
        parentId: "p",
        result: REVIEW_RESULT.FAIL,
        name: "債権額",
      }),
      makeDetail({
        checkId: "c2",
        parentId: "p",
        result: REVIEW_RESULT.UNDETERMINABLE,
        name: "利率",
      }),
      makeDetail({ checkId: "c3", parentId: "p", result: REVIEW_RESULT.PASS, name: "氏名" }),
    ];
    const bulkUpdated = await runCascade(tree, "c3");
    const parent = bulkUpdated.find((r) => r.checkId === "p");
    expect(parent!.explanation).toContain("債権額");
    expect(parent!.explanation).toContain("利率");
    expect(parent!.explanation).not.toContain("氏名");
  });
});
