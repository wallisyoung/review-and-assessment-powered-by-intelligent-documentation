import { useCallback, useEffect, useRef, useState } from "react";
import useHttp from "../../../hooks/useHttp";
import type { ApiResponse } from "../../../types/api";
import type { CreatedUserResult, ManagedUser, RapidRole, UsersPageData } from "../types";

// ListUsersは1回最大60件。全ページを結合して表示する（上限20ページ）
const MAX_PAGES = 20;

/**
 * ユーザー一覧を取得するフック（全ページ結合）
 */
export function useManagedUsers() {
  const { getOnce } = useHttp();
  const getOnceRef = useRef(getOnce);
  getOnceRef.current = getOnce;

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const collected: ManagedUser[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = nextToken
          ? `/users?nextToken=${encodeURIComponent(nextToken)}`
          : "/users";
        const res = await getOnceRef.current<ApiResponse<UsersPageData>>(url);
        const body = res.data;
        if (!body || body.success !== true) {
          const message = body && body.success === false ? body.error : "Failed to fetch users";
          throw new Error(message);
        }
        collected.push(...body.data.users);
        nextToken = body.data.nextToken;
        if (!nextToken) break;
      }
      setUsers(collected);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Failed to fetch users"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { users, isLoading, error, reload };
}

/**
 * ユーザー発行・ロール変更の操作フック
 */
export function useUserMutations() {
  const { post, patch } = useHttp();

  const createUser = async (params: {
    email: string;
    role: RapidRole;
  }): Promise<CreatedUserResult> => {
    const res = await post<ApiResponse<CreatedUserResult>>("/users", params);
    const body = res.data;
    if (!body || body.success !== true) {
      throw new Error(
        body && body.success === false ? body.error : "Failed to create user"
      );
    }
    return body.data;
  };

  const updateUserRole = async (
    username: string,
    role: RapidRole
  ): Promise<void> => {
    const res = await patch<ApiResponse<{ username: string; role: RapidRole }>>(
      `/users/${encodeURIComponent(username)}/role`,
      { role }
    );
    const body = res.data;
    if (!body || body.success !== true) {
      throw new Error(
        body && body.success === false
          ? body.error
          : "Failed to update the user role"
      );
    }
  };

  return { createUser, updateUserRole };
}
