import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { HiUserAdd, HiPencil } from "react-icons/hi";
import PageHeader from "../../../components/PageHeader";
import Table, { TableColumn, TableAction } from "../../../components/Table";
import Button from "../../../components/Button";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { useManagedUsers, useUserMutations } from "../hooks/useUserQueries";
import CreateUserModal from "../components/CreateUserModal";
import CredentialResultModal from "../components/CredentialResultModal";
import RoleChangeModal from "../components/RoleChangeModal";
import type { CreatedUserResult, ManagedUser, RapidRole } from "../types";

// Cognitoのユーザーステータスを表示ラベルキーへ変換する
// （初回パスワード変更待ち = FORCE_*, リセット要求済み = RESET_*）
const statusKeyFor = (status: string): string => {
  if (status === "CONFIRMED") return "confirmed";
  if (status.startsWith("FORCE_")) return "firstLoginPending";
  if (status.startsWith("RESET_")) return "resetRequired";
  return "unknown";
};

const STATUS_CLASSES: Record<string, string> = {
  confirmed: "text-aws-lab",
  firstLoginPending: "text-yellow",
  resetRequired: "text-yellow",
  unknown: "text-aws-font-color-gray",
};

/**
 * ユーザー管理ページ（管理者専用）。
 * アカウントの発行（一時パスワードを一度だけ表示）とロール変更を行う
 */
export default function UserManagementPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const { addToast } = useToast();
  const { users, isLoading, error, reload } = useManagedUsers();
  const { createUser, updateUserRole } = useUserMutations();

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [credentialResult, setCredentialResult] =
    useState<CreatedUserResult | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = useState<ManagedUser | null>(
    null
  );

  const currentEmail = currentUser?.email || currentUser?.username || "";

  const handleCreate = async (params: { email: string; role: RapidRole }) => {
    const result = await createUser(params);
    addToast(t("userManagement.createSucceeded"), "success");
    void reload();
    return result;
  };

  const handleCreated = (result: CreatedUserResult) => {
    setIsCreateModalOpen(false);
    setCredentialResult(result);
  };

  const handleRoleUpdate = async (username: string, role: RapidRole) => {
    await updateUserRole(username, role);
    addToast(t("userManagement.updateRoleSucceeded"), "success");
    void reload();
  };

  const roleBadge = (role: string) => {
    const key = (["", "admin", "opsEngineer"] as const).includes(
      role as never
    )
      ? role || "user"
      : "user";
    const classes: Record<string, string> = {
      user: "text-aws-font-color-gray",
      admin: "text-aws-font-color-blue",
      opsEngineer: "text-purple-600",
    };
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap rounded-full bg-aws-paper-light px-2 py-1 text-xs ${classes[key]}`}>
        {t(`userManagement.roles.${key}`)}
      </span>
    );
  };

  const statusBadge = (user: ManagedUser) => {
    const key = statusKeyFor(user.userStatus);
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap rounded-full bg-aws-paper-light px-2 py-1 text-xs ${STATUS_CLASSES[key]}`}>
        {t(`userManagement.statusLabels.${key}`)}
      </span>
    );
  };

  const columns: TableColumn<ManagedUser>[] = [
    {
      key: "email",
      header: t("userManagement.email"),
      render: (user) => (
        <div className="text-sm text-aws-squid-ink-light dark:text-aws-font-color-white-dark">
          {user.email || user.username}
        </div>
      ),
    },
    {
      key: "role",
      header: t("userManagement.role"),
      render: roleBadge,
    },
    {
      key: "userStatus",
      header: t("userManagement.status"),
      render: statusBadge,
    },
    {
      key: "createdAt",
      header: t("userManagement.createdAt"),
      render: (user) => (
        <div className="text-sm text-aws-font-color-gray">
          {user.createdAt ? new Date(user.createdAt).toLocaleString() : "-"}
        </div>
      ),
    },
  ];

  const actions: TableAction<ManagedUser>[] = [
    {
      icon: <HiPencil className="h-4 w-4" />,
      label: t("userManagement.changeRole"),
      onClick: (user) => setRoleChangeTarget(user),
      // 自分自身のロールは変更不可（バックエンドでも拒否される）
      show: (user) => (user.email || user.username) !== currentEmail,
    },
  ];

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <PageHeader
          title={t("userManagement.title")}
          description={t("userManagement.description")}
        />
        <Button
          variant="primary"
          onClick={() => setIsCreateModalOpen(true)}
          icon={<HiUserAdd className="h-5 w-5" />}>
          {t("userManagement.createUser")}
        </Button>
      </div>

      <Table
        items={users}
        columns={columns}
        actions={actions}
        isLoading={isLoading}
        error={error?.message ?? null}
        emptyMessage={t("userManagement.noUsers")}
        keyExtractor={(user) => user.username}
      />

      <CreateUserModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreate={handleCreate}
        onCreated={handleCreated}
      />

      <CredentialResultModal
        result={credentialResult}
        onClose={() => setCredentialResult(null)}
      />

      <RoleChangeModal
        user={roleChangeTarget}
        onClose={() => setRoleChangeTarget(null)}
        onUpdate={handleRoleUpdate}
      />
    </div>
  );
}
