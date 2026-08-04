import { useApiClient } from "../../../hooks/useApiClient";
import type {
  ReviewResultDetailModel,
  GetReviewResultItemsResponse,
} from "../types";

export type FilterType = "all" | "pass" | "fail" | "undeterminable" | "processing";

/**
 * 審査結果項目のキャッシュキーを生成する関数
 */
export const getReviewResultItemsKey = (
  jobId: string | null,
  parentId?: string,
  filter: FilterType = "all"
): string | null => {
  if (!jobId) return null;
  const base = `/review-jobs/${jobId}/results/items`;
  const params = new URLSearchParams();
  if (parentId) params.append("parentId", parentId);
  if (filter !== "all") params.append("filter", filter);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
};

/**
 * 審査結果項目（階層／子要素含む）一覧を取得するフック
 */
export function useReviewResultItems(
  jobId: string | null,
  parentId?: string,
  filter: FilterType = "all"
) {
  const url = getReviewResultItemsKey(jobId, parentId, filter);
  const { data, isLoading, error, refetch } =
    useApiClient().useQuery<GetReviewResultItemsResponse>(url);

  return {
    items: (data ?? []) as ReviewResultDetailModel[],
    isLoading,
    error,
    refetch,
  };
}
