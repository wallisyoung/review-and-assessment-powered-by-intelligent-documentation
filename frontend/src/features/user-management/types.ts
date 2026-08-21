/**
 * ユーザー管理機能の型定義
 * バックエンド (features/users) のレスポンス構造に対応する
 */

export const RAPID_ROLES = ["", "admin", "opsEngineer"] as const;
export type RapidRole = (typeof RAPID_ROLES)[number];

export interface ManagedUser {
  username: string;
  email?: string;
  role: string;
  enabled: boolean;
  userStatus: string;
  createdAt?: string;
}

export interface CreatedUserResult {
  user: ManagedUser;
  temporaryPassword: string;
}

export interface UsersPageData {
  users: ManagedUser[];
  nextToken?: string;
}
