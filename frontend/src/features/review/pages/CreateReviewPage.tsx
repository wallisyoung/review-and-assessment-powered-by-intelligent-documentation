import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Button from "../../../components/Button";
import PageHeader from "../../../components/PageHeader";
import FormTextField from "../../../components/FormTextField";
import ChecklistSelector from "../components/ChecklistSelector";
import { useCreateReviewJob } from "../hooks/useReviewJobMutations";
import { useDocumentUpload } from "../../../hooks/useDocumentUpload";
import {
  useChecklistSets,
  useChecklistSetDetail,
} from "../../checklist/hooks/useCheckListSetQueries";
import { CHECK_LIST_STATUS } from "../../checklist/types";
import { REVIEW_FILE_TYPE } from "../types";
import { HiExclamationCircle, HiTrash } from "react-icons/hi";

interface UploadResult {
  documentId: string;
  filename: string;
  s3Key: string;
  fileType: string;
}

export const CreateReviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [selectedChecklistId, setSelectedChecklistId] = useState<string | null>(
    null
  );
  const [jobName, setJobName] = useState("");
  const [typeUploads, setTypeUploads] = useState<
    Record<string, UploadResult | null>
  >({});
  const [caseDataText, setCaseDataText] = useState("");
  const [checklistPage, setChecklistPage] = useState(1);
  const [checklistLimit] = useState(5);
  const [errors, setErrors] = useState({ name: "", files: "", caseData: "" });

  // チェックリストセット一覧（完成状態のみ）
  const {
    items: checkListSets,
    isLoading: isLoadingCheckListSets,
    error: checkListSetsError,
    total: checklistTotal,
    totalPages: checklistTotalPages,
  } = useChecklistSets(
    checklistPage,
    checklistLimit,
    "id",
    "desc",
    CHECK_LIST_STATUS.COMPLETED
  );

  // 選択中セットの詳細（declaredDocumentTypes を取得）
  const { checklistSet: selectedDetail } =
    useChecklistSetDetail(selectedChecklistId);
  const declaredDocumentTypes: string[] =
    (selectedDetail as any)?.declaredDocumentTypes ?? [];

  const { createReviewJob, status, error: createError } = useCreateReviewJob();
  const isSubmitting = status === "loading";

  const { uploadDocument, isUploading } = useDocumentUpload({
    presignedUrlEndpoint: "/documents/review/presigned-url",
    deleteEndpointPrefix: "/documents/review/",
  });

  const uploadedCount = Object.values(typeUploads).filter(Boolean).length;
  const isReady =
    uploadedCount > 0 &&
    selectedChecklistId !== null &&
    jobName.trim() !== "";

  // スロットごとのファイルアップロード
  const handleSlotUpload = async (docType: string, file: File) => {
    try {
      const result = await uploadDocument(file);
      setTypeUploads((prev) => ({ ...prev, [docType]: result as UploadResult }));
      if (errors.files)
        setErrors((prev) => ({ ...prev, files: "" }));
    } catch (error) {
      console.error("Upload failed:", error);
    }
  };

  const handleSlotRemove = (docType: string) => {
    setTypeUploads((prev) => ({ ...prev, [docType]: null }));
  };

  // 案件情報ファイル読み込み
  const handleCaseDataFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCaseDataText(String(reader.result || ""));
    reader.readAsText(file);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === "jobName") setJobName(value);
    if (errors.name as keyof typeof errors)
      setErrors((prev) => ({ ...prev, name: "" }));
  };

  const validate = () => {
    const newErrors = { name: "", files: "", caseData: "" };
    if (!jobName.trim()) newErrors.name = t("review.nameRequired");
    if (uploadedCount === 0) newErrors.files = t("review.fileRequired");
    if (caseDataText.trim()) {
      try {
        JSON.parse(caseDataText);
      } catch {
        newErrors.caseData = "Invalid JSON format";
      }
    }
    setErrors(newErrors);
    return !Object.values(newErrors).some(Boolean);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || !selectedChecklistId) return;

    try {
      const documents = Object.entries(typeUploads)
        .filter(([, doc]) => doc !== null)
        .map(([docType, doc]) => ({
          id: doc!.documentId,
          filename: doc!.filename,
          s3Key: doc!.s3Key,
          fileType: doc!.fileType.includes("pdf")
            ? REVIEW_FILE_TYPE.PDF
            : REVIEW_FILE_TYPE.IMAGE,
          documentType: docType,
        }));

      let caseData: unknown = undefined;
      if (caseDataText.trim()) {
        caseData = JSON.parse(caseDataText);
      }

      await createReviewJob({
        name: jobName,
        checkListSetId: selectedChecklistId,
        documents,
        caseData,
      });

      navigate("/review", { replace: true });
    } catch (error) {
      console.error(t("review.createError"), error);
    }
  };

  const displayError = createError;

  return (
    <div>
      <PageHeader
        title={t("review.createTitle")}
        description={t("review.createDescription")}
        backLink={{ to: "/review", label: t("review.backToList") }}
      />

      {displayError && (
        <div
          className="mb-6 rounded-md border border-red bg-light-red px-6 py-4 text-red shadow-sm"
          role="alert">
          <div className="flex items-center">
            <HiExclamationCircle className="mr-2 h-6 w-6" />
            <strong className="font-medium">{t("common.error")}: </strong>
            <span className="ml-2">{displayError.message}</span>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-light-gray bg-white p-6 shadow-md">
        <form onSubmit={handleSubmit}>
          <FormTextField
            id="jobName"
            name="jobName"
            label={t("review.jobName")}
            value={jobName}
            onChange={handleInputChange}
            placeholder={t("review.jobNamePlaceholder")}
            required
            error={errors.name}
          />

          {/* チェックリスト選択 */}
          <div className="mb-6">
            {isLoadingCheckListSets ? (
              <div className="flex h-32 items-center justify-center">
                <div className="border-primary h-8 w-8 animate-spin rounded-full border-b-2 border-t-2"></div>
              </div>
            ) : checkListSetsError ? (
              <div className="rounded-md border border-red p-4 text-red">
                {t("checklist.loadError")}
              </div>
            ) : (
              <ChecklistSelector
                checklists={checkListSets as any}
                selectedChecklistId={selectedChecklistId}
                onSelectChecklist={(checklist: any) =>
                  setSelectedChecklistId(checklist.id)
                }
                currentPage={checklistPage}
                totalPages={checklistTotalPages}
                totalItems={checklistTotal}
                itemsPerPage={checklistLimit}
                onPageChange={setChecklistPage}
                isLoading={isLoadingCheckListSets}
              />
            )}
          </div>

          {/* 複合レビュー：文書タイプ別アップロード */}
          {selectedChecklistId && (
            <div className="mb-6">
              <label className="mb-2 block font-medium text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
                審査対象書類（文書タイプごとにアップロード）{" "}
                <span className="text-red">*</span>
              </label>
              {declaredDocumentTypes.length > 0 ? (
                <div className="space-y-3">
                  {declaredDocumentTypes.map((docType) => (
                    <div
                      key={docType}
                      className="flex items-center gap-3 rounded border border-light-gray p-3">
                      <span className="min-w-[200px] text-sm font-medium">
                        {docType}
                      </span>
                      {typeUploads[docType] ? (
                        <>
                          <span className="text-sm text-aws-font-color-gray">
                            {typeUploads[docType]!.filename}
                          </span>
                          <Button
                            onClick={() => handleSlotRemove(docType)}
                            variant="text"
                            size="sm"
                            icon={<HiTrash className="h-4 w-4" />}
                            className="text-red">
                            {t("common.delete", "削除")}
                          </Button>
                        </>
                      ) : (
                        <input
                          type="file"
                          accept=".pdf,image/*"
                          onChange={(e) =>
                            e.target.files?.[0] &&
                            handleSlotUpload(docType, e.target.files[0])
                          }
                          className="text-sm"
                          disabled={isUploading}
                        />
                      )}
                    </div>
                  ))}
                  {errors.files && (
                    <p className="text-sm text-red">{errors.files}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-aws-font-color-gray">
                  このチェックリストセットは複合レビュー（文書タイプ別）に対応していません。
                </p>
              )}
            </div>
          )}

          {/* 案件情報（JSON） */}
          {selectedChecklistId && declaredDocumentTypes.length > 0 && (
            <div className="mb-6">
              <label className="mb-1 block font-medium text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
                案件情報（JSON）
              </label>
              <p className="mb-2 text-xs text-aws-font-color-gray">
                touki-check-data.json の「案件情報」部分を貼り付けるか、ファイルを読み込んでください。
              </p>
              <div className="mb-2">
                <input
                  type="file"
                  accept=".json"
                  onChange={handleCaseDataFile}
                  className="text-sm"
                />
              </div>
              <textarea
                className="w-full rounded border border-light-gray p-2 font-mono text-sm"
                rows={6}
                value={caseDataText}
                onChange={(e) => setCaseDataText(e.target.value)}
                placeholder='{"案件情報": {"顧客氏名": "山田一郎", ...}}'
              />
              {errors.caseData && (
                <p className="text-sm text-red">{errors.caseData}</p>
              )}
            </div>
          )}

          <div className="mt-8 flex justify-end space-x-3">
            <Button outline to="/review">
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!isReady || isSubmitting || isUploading}>
              {isSubmitting || isUploading ? (
                <>
                  <div className="-ml-1 mr-2 h-4 w-4 animate-spin text-white">
                    <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent"></div>
                  </div>
                  {t("common.processing")}
                </>
              ) : (
                t("review.compare")
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateReviewPage;
