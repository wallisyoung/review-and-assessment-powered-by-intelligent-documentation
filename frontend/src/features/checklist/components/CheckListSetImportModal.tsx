import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HiUpload } from "react-icons/hi";
import Modal from "../../../components/Modal";
import Button from "../../../components/Button";
import { useImportChecklistSet } from "../hooks/useCheckListSetMutations";
import { useToast } from "../../../contexts/ToastContext";

type CheckListSetImportModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
};

/**
 * チェックリストセット インポートモーダル
 * JSON ファイルを選択 → 名前編集 → 新規セットとして取り込む。
 */
export default function CheckListSetImportModal({
  isOpen,
  onClose,
  onImported,
}: CheckListSetImportModalProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { importChecklistSet, status } = useImportChecklistSet();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [parsed, setParsed] = useState<any>(null);
  const [fileName, setFileName] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [error, setError] = useState("");

  const isSubmitting = status === "loading";

  const reset = () => {
    setParsed(null);
    setFileName("");
    setNameOverride("");
    setError("");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (
          !data ||
          typeof data !== "object" ||
          !data.set ||
          !Array.isArray(data.items)
        ) {
          throw new Error("shape");
        }
        setParsed(data);
        setNameOverride(data.set?.name ?? "");
      } catch {
        setParsed(null);
        setNameOverride("");
        setError(t("checklist.importInvalidFile"));
      }
    };
    reader.onerror = () => setError(t("checklist.importReadError"));
    reader.readAsText(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed) {
      setError(t("checklist.importNoFile"));
      return;
    }
    if (!nameOverride.trim()) {
      setError(t("checklist.editItemNameRequired"));
      return;
    }
    setError("");
    try {
      const payload = {
        ...parsed,
        set: { ...parsed.set, name: nameOverride.trim() },
      };
      await importChecklistSet(payload);
      addToast(t("checklist.importSuccess"), "success");
      onImported();
      reset();
      onClose();
    } catch (err) {
      const msg =
        (err as { message?: string })?.message ?? t("checklist.importError");
      setError(msg);
      addToast(t("checklist.importError"), "error");
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const itemCount = Array.isArray(parsed?.items) ? parsed.items.length : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("checklist.importTitle")}
      size="2xl">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-4 rounded-md border border-red bg-red/10 p-3 text-red whitespace-normal break-words">
            {error}
          </div>
        )}

        <div className="mb-6">
          <label className="mb-2 block font-medium text-aws-squid-ink-light">
            {t("checklist.importFileLabel")}
          </label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={handleFile}
            className="block w-full text-sm text-aws-font-color-gray
              file:mr-3 file:rounded-md file:border-0 file:bg-aws-sea-blue-light file:px-4 file:py-2
              file:text-white hover:file:bg-aws-sea-blue-dark"
          />
          {fileName && (
            <p className="mt-2 text-xs text-aws-font-color-gray">
              {fileName}
              {parsed
                ? ` (${itemCount} ${t("checklist.importItems")})`
                : ""}
            </p>
          )}
        </div>

        {parsed && (
          <div className="mb-6">
            <label
              htmlFor="import-name"
              className="mb-2 block font-medium text-aws-squid-ink-light">
              {t("checklist.name")} <span className="text-red">*</span>
            </label>
            <input
              type="text"
              id="import-name"
              value={nameOverride}
              onChange={(e) => setNameOverride(e.target.value)}
              className="w-full rounded-md border border-light-gray px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light"
            />
            <p className="mt-1 text-xs text-aws-font-color-gray">
              {t("checklist.importNameHint")}
            </p>
          </div>
        )}

        <div className="mt-6 flex justify-end space-x-3">
          <Button outline onClick={handleClose} type="button">
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={isSubmitting || !parsed}>
            <HiUpload className="mr-1 h-4 w-4" />
            {isSubmitting ? t("checklist.importing") : t("checklist.import")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
