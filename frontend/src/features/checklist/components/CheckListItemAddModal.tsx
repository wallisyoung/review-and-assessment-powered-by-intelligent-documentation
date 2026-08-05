import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateCheckListItem } from "../hooks/useCheckListItemMutations";
import { useChecklistSetDetail } from "../hooks/useCheckListSetQueries";
import { useToast } from "../../../contexts/ToastContext";
import Button from "../../../components/Button";
import { HiX } from "react-icons/hi";

type CheckListItemAddModalProps = {
  isOpen: boolean;
  onClose: () => void;
  checkListSetId: string;
  parentId?: string;
  onSuccess: () => void;
};

export default function CheckListItemAddModal({
  isOpen,
  onClose,
  checkListSetId,
  parentId,
  onSuccess,
}: CheckListItemAddModalProps) {
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    parentId: parentId || "",
  });
  const [selectedDocTypes, setSelectedDocTypes] = useState<string[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState({
    name: "",
  });

  const { t } = useTranslation();
  const { addToast } = useToast();

  const {
    createCheckListItem,
    status: submitStatus,
    error: submitError,
  } = useCreateCheckListItem(checkListSetId);

  const { checklistSet } = useChecklistSetDetail(checkListSetId);
  const declaredDocumentTypes: string[] =
    (checklistSet as any)?.declaredDocumentTypes ?? [];

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    if (name === "name" && errors.name) {
      setErrors((prev) => ({ ...prev, name: "" }));
    }
  };

  const handleDocTypeToggle = (docType: string) => {
    setSelectedDocTypes((prev) =>
      prev.includes(docType)
        ? prev.filter((t) => t !== docType)
        : [...prev, docType]
    );
  };

  const validate = () => {
    const newErrors = {
      name: "",
    };

    if (!formData.name.trim()) {
      newErrors.name = t("checklist.nameRequired");
    }

    setErrors(newErrors);
    return !Object.values(newErrors).some((error) => error);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;

    setIsSubmitting(true);

    try {
      const dataToSubmit = {
        ...formData,
        parentId: parentId !== undefined ? parentId : formData.parentId,
        requiredDocumentTypes: selectedDocTypes,
      };

      await createCheckListItem(dataToSubmit);
      onSuccess();
      onClose();
    } catch (error) {
      console.error("保存に失敗しました", error);

      if (
        error instanceof Error &&
        error.message.includes("LINKED_REVIEW_JOBS")
      ) {
        addToast(t("checklist.notEditable"), "error");
      } else {
        addToast(
          t("checklist.itemAddError", "Failed to save checklist item"),
          "error"
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold text-aws-squid-ink-light">
            {t("checklist.addItem")}
          </h2>
          <Button
            variant="text"
            size="sm"
            icon={<HiX className="h-6 w-6" />}
            onClick={onClose}>
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label
              htmlFor="name"
              className="mb-2 block font-medium text-aws-squid-ink-light">
              {t("checklist.name")} <span className="text-red">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className={`w-full rounded-md border px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light ${
                errors.name ? "border-red" : "border-light-gray"
              }`}
              placeholder={t(
                "checklist.itemNamePlaceholder",
                "Checklist item name"
              )}
            />
            {errors.name && (
              <p className="mt-1 text-sm text-red">{errors.name}</p>
            )}
          </div>

          <div className="mb-4">
            <label
              htmlFor="description"
              className="mb-2 block font-medium text-aws-squid-ink-light">
              {t("checklist.description")}
            </label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows={3}
              className="w-full rounded-md border border-light-gray px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light"
              placeholder={t(
                "checklist.itemDescriptionPlaceholder",
                "Checklist item description"
              )}
            />
          </div>

          {declaredDocumentTypes.length > 0 && (
            <div className="mb-4">
              <label className="mb-2 block font-medium text-aws-squid-ink-light">
                {t("checklist.requiredDocumentTypes", "必要な文書タイプ")}
              </label>
              <p className="mb-2 text-xs text-aws-font-color-gray">
                {t(
                  "checklist.requiredDocumentTypesHint",
                  "未選択の場合は全書類を投入します"
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {declaredDocumentTypes.map((docType) => (
                  <label
                    key={docType}
                    className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      selectedDocTypes.includes(docType)
                        ? "border-aws-sea-blue-light bg-aws-sea-blue-light bg-opacity-10 text-aws-sea-blue-light"
                        : "border-light-gray text-aws-font-color-gray hover:border-aws-sea-blue-light"
                    }`}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={selectedDocTypes.includes(docType)}
                      onChange={() => handleDocTypeToggle(docType)}
                    />
                    {docType}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 flex justify-end space-x-3">
            <Button outline onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? t("common.processing")
                : t("checklist.add", "Add")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
