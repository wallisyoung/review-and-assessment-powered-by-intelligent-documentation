import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { HiUserAdd } from "react-icons/hi";
import Modal from "../../../components/Modal";
import Button from "../../../components/Button";
import FormTextField from "../../../components/FormTextField";
import { RAPID_ROLES, type CreatedUserResult, type RapidRole } from "../types";

interface CreateUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (params: { email: string; role: RapidRole }) => Promise<CreatedUserResult>;
  onCreated: (result: CreatedUserResult) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * ユーザー発行モーダル。発行に成功すると一時パスワードを親に渡す
 */
export default function CreateUserModal({
  isOpen,
  onClose,
  onCreate,
  onCreated,
}: CreateUserModalProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RapidRole>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resetForm = () => {
    setEmail("");
    setRole("");
    setEmailError(undefined);
    setSubmitError(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setEmailError(t("userManagement.invalidEmail"));
      return;
    }
    setEmailError(undefined);

    setIsSubmitting(true);
    try {
      const result = await onCreate({ email: trimmed, role });
      resetForm();
      onCreated(result);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t("userManagement.createFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("userManagement.createUser")}>
      <form onSubmit={handleSubmit}>
        <FormTextField
          id="new-user-email"
          name="email"
          label={t("userManagement.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
          error={emailError}
          disabled={isSubmitting}
        />

        <div className="mb-6">
          <label
            htmlFor="new-user-role"
            className="mb-2 block font-medium text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
            {t("userManagement.role")}
          </label>
          <select
            id="new-user-role"
            value={role}
            onChange={(e) => setRole(e.target.value as RapidRole)}
            disabled={isSubmitting}
            className="w-full rounded-md border border-light-gray px-4 py-2 focus:outline-none focus:ring-2 focus:ring-aws-sea-blue-light">
            {RAPID_ROLES.map((r) => (
              <option key={r || "user"} value={r}>
                {t(`userManagement.roles.${r || "user"}`)}
              </option>
            ))}
          </select>
        </div>

        {submitError && (
          <div className="mb-4 rounded-md border border-red bg-red bg-opacity-10 px-4 py-2 text-sm text-red">
            {submitError}
          </div>
        )}

        <div className="flex justify-end space-x-2 border-t border-light-gray pt-4">
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={isSubmitting}
            icon={<HiUserAdd className="h-5 w-5" />}>
            {isSubmitting ? t("common.processing") : t("userManagement.createUser")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
