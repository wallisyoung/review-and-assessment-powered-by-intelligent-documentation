/**
 * ユーザー管理のルートハンドラー（管理者専用）
 * 認証はグローバルのpreHandlerで検証済み。ここではロールチェックを行う
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { ForbiddenError, ValidationError } from "../../../core/errors";
import {
  createUser,
  isValidRapidRole,
  listUsers,
  updateUserRole,
  type RapidRole,
} from "../usecase/cognito-user";

interface CreateUserBody {
  email?: string;
  role?: string;
}

interface UpdateRoleBody {
  role?: string;
}

/**
 * リクエストユーザーが管理者であることを検証する
 */
function assertAdmin(request: FastifyRequest): void {
  if (!request.user?.isAdmin) {
    throw new ForbiddenError("User management is restricted to administrators");
  }
}

/**
 * リクエストボディのロール値を検証して返す（未指定は一般ユーザー ""）
 */
function parseRole(role: string | undefined): RapidRole {
  const normalized = role ?? "";
  if (!isValidRapidRole(normalized)) {
    throw new ValidationError(
      `Invalid role. Allowed values: "" (general user), "admin", "opsEngineer"`
    );
  }
  return normalized;
}

export const createUserHandler = async (
  request: FastifyRequest<{ Body: CreateUserBody }>,
  reply: FastifyReply
): Promise<void> => {
  assertAdmin(request);

  const body = request.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) {
    throw new ValidationError("email is required");
  }
  const role = parseRole(body.role);

  const result = await createUser({ email, role });

  reply.code(201).send({
    success: true,
    data: result,
  });
};

export const listUsersHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  assertAdmin(request);

  const query = request.query as { nextToken?: string };
  const result = await listUsers({ nextToken: query?.nextToken });

  reply.code(200).send({
    success: true,
    data: result,
  });
};

export const updateUserRoleHandler = async (
  request: FastifyRequest<{
    Params: { username: string };
    Body: UpdateRoleBody;
  }>,
  reply: FastifyReply
): Promise<void> => {
  assertAdmin(request);

  const username = decodeURIComponent(request.params.username ?? "");
  if (!username) {
    throw new ValidationError("username is required");
  }
  const role = parseRole(request.body?.role);

  // 自分自身のロール変更は禁止（誤操作による権限喪失を防ぐ）
  if (
    username === request.user?.email ||
    username === request.user?.userId
  ) {
    throw new ForbiddenError("Changing your own role is not allowed");
  }

  const result = await updateUserRole({ username, role });

  reply.code(200).send({
    success: true,
    data: result,
  });
};
