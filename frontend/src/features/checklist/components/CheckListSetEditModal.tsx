import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HiPlus, HiX } from "react-icons/hi";
import Modal from "../../../components/Modal";
import Button from "../../../components/Button";
import { useUpdateChecklistSet } from "../hooks/useCheckListSetMutations";
import { useChecklistSetDetail } from "../hooks/useCheckListSetQueries";
import { useToast } from "../../../contexts/ToastContext";
import { UpdateChecklistSetRequest } from "../types";

type CheckListSetEditModalProps = {
  isOpen: boolean;
  onClose: () => void;
  checkListSetId: string;
  onSuccess: () => void;
};

/**
 * チェックリストセット編集モーダル
 * - name / description / declaredDocumentTypes（文書タイプの追加・削除）を編集
 * - 使用済みセットは UI 側で開かない想定（後段 API でも二重ガード）
 */
export default function CheckListSetEditModal({
  isOpen,
  onClose,
  checkListSetId,
  onSuccess,
}: CheckListSetEditModalProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { checklistSet } = useChecklistSetDetail(checkListSetId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [newType, setNewType] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { updateChecklistSet } = useUpdateChecklistSet();

  // セット詳細読み込み時にフォームを初期化
  useEffect(() => {
    if (checklistSet) {
      setName(checklistSet.name || "");
      setDescription(checklistSet.description || "");
      setDocTypes(
        (checklistSet as { declaredDocumentTypes?: string[] })
          ?.declaredDocumentTypes ?? []
      );
      setError("");
      setNewType("");
    }
  }, [checklistSet]);

  const handleAddType = () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    if (docTypes.includes(trimmed)) {
      setError(t("checklist.editSetDocTypeDuplicate"));
      return;
    }
    setDocTypes((prev) => [...prev, trimmed]);
    setNewType("");
    setError("");
  };

  const handleRemoveType = (type: string) => {
    setDocTypes((prev) => prev.filter((it) => it !== type));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError(t("checklist.editItemNameRequired"));
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const body: UpdateChecklistSetRequest = {
        name: name.trim(),
        description,
        declaredDocumentTypes: docTypes,
      };
      await updateChecklistSet(checkListSetId, body);
      addToast(t("checklist.editSetUpdateSuccess"), "success");
      onSuccess();
      onClose();
    } catch (err) {
      console.error("チェックリストセットの更新に失敗しました", err);
      const e = err as { data?: { error?: string }; message?: string };
      const msg =
        e?.data?.error ?? e?.message ?? t("checklist.editSetUpdateError");
      setError(msg);
      addToast(t("checklist.editSetUpdateErrorToast"), "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("checklist.editSetTitle")}
      size="2xl">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-4 whitespace-normal break-words rounded-md border border-red bg-red/10 p-3 text-red">
            {error}
          </div>
        )}

        <div className="mb-6">
          <label
            htmlFor="set-name"
            className="mb-2 block font-medium text-aws-squid-ink-light">
            {t("checklist.name")} <span className="text-red">*</span>
          </label>
          <input
            type="text"
            id="set-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light ${
              !name.trim() ? "border-red" : "border-light-gray"
            }`}
            placeholder={t("checklist.itemNamePlaceholder")}
            required
          />
        </div>

        <div className="mb-6">
          <label
            htmlFor="set-description"
            className="mb-2 block font-medium text-aws-squid-ink-light">
            {t("common.description")}
          </label>
          <textarea
            id="set-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-light-gray px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light"
            placeholder={t("checklist.itemDescriptionPlaceholder")}
          />
        </div>

        <div className="mb-6">
          <label className="mb-2 block font-medium text-aws-squid-ink-light">
            {t("checklist.requiredDocumentTypes", "必要な文書タイプ")}
          </label>
          <p className="mb-2 text-xs text-aws-font-color-gray">
            {t(
              "checklist.editSetDocTypesHint",
              "このセットが受け付ける文書タイプを追加・削除できます。ルールが使用中のタイプは削除できません。"
            )}
          </p>

          {docTypes.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {docTypes.map((type) => (
                <span
                  key={type}
                  className="inline-flex items-center space-x-1 rounded-md border border-aws-sea-blue-light bg-aws-sea-blue-light bg-opacity-10 px-3 py-1.5 text-sm text-aws-sea-blue-light">
                  <span>{type}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveType(type)}
                    className="ml-1 text-aws-sea-blue-light hover:text-red"
                    aria-label={t("common.delete")}>
                    <HiX className="h-4 w-4" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddType();
                }
              }}
              className="flex-1 rounded-md border border-light-gray px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light"
              placeholder={t(
                "checklist.editSetDocTypePlaceholder",
                "新しい文書タイプ名"
              )}
            />
            <Button
              type="button"
              variant="primary"
              outline
              onClick={handleAddType}
              disabled={!newType.trim()}>
              <HiPlus className="mr-1 h-4 w-4" />
              {t("checklist.add")}
            </Button>
          </div>
        </div>

        <div className="mt-6 flex justify-end space-x-3">
          <Button outline onClick={onClose} type="button">
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? t("checklist.editItemUpdating")
              : t("checklist.editItemUpdate")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
