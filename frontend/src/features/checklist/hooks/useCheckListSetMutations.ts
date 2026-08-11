import { useApiClient } from "../../../hooks/useApiClient";
import useHttp from "../../../hooks/useHttp";
import type { ApiResponse } from "../../../types/api";
import { mutate } from "swr";
import type {
  CreateChecklistSetRequest,
  CreateChecklistSetResponse,
  DuplicateChecklistSetRequest,
  DuplicateChecklistSetResponse,
  UpdateChecklistSetRequest,
  ExportedChecklistSet,
  DetectAmbiguityResponse,
} from "../types";

export function useCreateChecklistSet() {
  const { mutateAsync, status, error } = useApiClient().useMutation<
    CreateChecklistSetResponse,
    CreateChecklistSetRequest
  >("post", "/checklist-sets");

  return { createChecklistSet: mutateAsync, status, error };
}

export function useUpdateChecklistSet() {
  const { mutateAsync, status, error } = useApiClient().useMutation<
    CreateChecklistSetResponse,
    UpdateChecklistSetRequest
  >("put", "/checklist-sets");

  function updateChecklistSet(id: string, body: UpdateChecklistSetRequest) {
    return mutateAsync(body, `/checklist-sets/${id}`);
  }

  return { updateChecklistSet, status, error };
}

export function useDeleteChecklistSet() {
  const { mutateAsync, status, error } = useApiClient().useMutation<
    CreateChecklistSetResponse,
    void
  >("delete", "/checklist-sets");

  function deleteChecklistSet(id: string) {
    return mutateAsync(undefined, `/checklist-sets/${id}`);
  }

  return { deleteChecklistSet, status, error };
}

export function useDuplicateChecklistSet() {
  const { mutateAsync, status, error } = useApiClient().useMutation<
    DuplicateChecklistSetResponse,
    DuplicateChecklistSetRequest
  >("post", "/checklist-sets");

  function duplicateChecklistSet(
    id: string,
    body?: DuplicateChecklistSetRequest
  ) {
    return mutateAsync(body || {}, `/checklist-sets/${id}/duplicate`);
  }

  return { duplicateChecklistSet, status, error };
}

/**
 * チェックリストセット エクスポート（JSON ダウンロード）
 */
export function useExportChecklistSet() {
  const http = useHttp();

  const exportChecklistSet = async (id: string, name: string) => {
    const res = await http.getOnce<ApiResponse<ExportedChecklistSet>>(
      `/checklist-sets/${id}/export`
    );
    const exported = res.data.data;
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (name || "checklist-set").replace(/[\\/:*?"<>|]/g, "_");
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return { exportChecklistSet };
}

/**
 * チェックリストセット インポート
 */
export function useImportChecklistSet() {
  const { mutateAsync, status, error } = useApiClient().useMutation<
    { setId: string },
    unknown
  >("post", "/checklist-sets/import");

  function importChecklistSet(data: unknown) {
    return mutateAsync(data);
  }

  return { importChecklistSet, status, error };
}

/**
 * 曖昧検知実行フック
 */
export function useDetectAmbiguity() {
  const { mutateAsync, status, error } =
    useApiClient().useMutation<DetectAmbiguityResponse>(
      "post",
      "/checklist-sets"
    );

  const detectAmbiguity = async (setId: string) => {
    await mutateAsync({}, `/checklist-sets/${setId}/detect-ambiguity`);

    // API完了後に部分的楽観更新
    mutate(`/checklist-sets/${setId}`, (currentData: any) => ({
      ...currentData,
      processingStatus: "detecting",
    }));

    // 関連データを再取得
    mutate(
      (key) =>
        typeof key === "string" &&
        key.startsWith(`/checklist-sets/${setId}/items`)
    );
  };

  return { detectAmbiguity, status, error };
}
