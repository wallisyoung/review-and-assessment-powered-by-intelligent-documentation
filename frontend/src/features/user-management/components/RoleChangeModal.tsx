import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../../components/Modal";
import Button from "../../../components/Button";
import { RAPID_ROLES, type ManagedUser, type RapidRole } from "../types";

interface RoleChangeModalProps {
  user: ManagedUser | null;
  onClose: () => void;
  onUpdate: (username: string, role: RapidRole) => Promise<void>;
}

/**
 * ユーザーのロール変更モーダル
 */
export default function RoleChangeModal({
  user,
  onClose,
  onUpdate,
}: RoleChangeModalProps) {
  const { t } = useTranslation();
  const [role, setRole] = useState<RapidRole>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      // 不明な値が入っている場合は一般ユーザー扱いで選択させる
      setRole(
        (RAPID_ROLES as readonly string[]).includes(user.role)
          ? (user.role as RapidRole)
          : ""
      );
      setSubmitError(null);
    }
  }, [user]);

  if (!user) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onUpdate(user.username, role);
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t("userManagement.updateRoleFailed")
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={t("userManagement.changeRole")}>
      <form onSubmit={handleSubmit}>
        <p className="mb-4 break-all text-sm text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
          {user.email || user.username}
        </p>

        <div className="mb-6">
          <label
            htmlFor="role-select"
            className="mb-2 block font-medium text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
            {t("userManagement.role")}
          </label>
          <select
            id="role-select"
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
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? t("common.processing") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
