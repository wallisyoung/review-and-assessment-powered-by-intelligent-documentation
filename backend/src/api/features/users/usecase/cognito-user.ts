/**
 * Cognitoユーザー管理のユースケース
 * 管理者によるアカウント発行・一覧取得・ロール変更を提供する
 */
import { randomInt } from "crypto";
import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
  type AttributeType,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { ApplicationError, NotFoundError } from "../../../core/errors";
import { getCognitoClient, getUserPoolId } from "../../../core/cognito-idp";

/**
 * 発行可能なロール（custom:rapid_role の値）
 * 空文字は一般ユーザー
 */
export const RAPID_ROLES = ["", "admin", "opsEngineer"] as const;
export type RapidRole = (typeof RAPID_ROLES)[number];

/**
 * 一覧・作成結果として返すユーザーの概要
 */
export interface CognitoUserSummary {
  username: string;
  email?: string;
  role: string;
  enabled: boolean;
  userStatus: string;
  createdAt?: string;
}

export interface CreateUserParams {
  email: string;
  role: RapidRole;
}

export interface CreatedUserResult {
  user: CognitoUserSummary;
  // 一度だけ呼び出し元（管理者）に返す一時パスワード。保存しない
  temporaryPassword: string;
}

export interface ListUsersResult {
  users: CognitoUserSummary[];
  nextToken?: string;
}

export interface UpdateUserRoleParams {
  username: string;
  role: RapidRole;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// User Poolのパスワードポリシー（cdk/lib/constructs/auth.ts）:
// 大文字・小文字・数字・記号を必須、最小8文字
const PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_LOWER = "abcdefghijkmnpqrstuvwxyz";
const PASSWORD_DIGITS = "23456789";
const PASSWORD_SYMBOLS = "!@#$%^&*";
const PASSWORD_ALL = PASSWORD_UPPER + PASSWORD_LOWER + PASSWORD_DIGITS + PASSWORD_SYMBOLS;

/**
 * パスワードポリシーを満たす一時パスワードを生成する
 */
export function generateTemporaryPassword(length = 16): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [
    pick(PASSWORD_UPPER),
    pick(PASSWORD_LOWER),
    pick(PASSWORD_DIGITS),
    pick(PASSWORD_SYMBOLS),
  ];
  for (let i = chars.length; i < length; i++) {
    chars.push(pick(PASSWORD_ALL));
  }
  // Fisher-Yatesシャッフルで先頭4文字が固定クラスにならないようにする
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * CognitoのUserTypeをアプリケーション用の概要に変換する
 */
function toUserSummary(user: UserType): CognitoUserSummary {
  const attr = (name: string): string | undefined =>
    user.Attributes?.find((a: AttributeType) => a.Name === name)?.Value;
  return {
    username: user.Username || "",
    email: attr("email"),
    role: attr("custom:rapid_role") ?? "",
    enabled: user.Enabled ?? false,
    userStatus: user.UserStatus || "",
    createdAt: user.UserCreateDate?.toISOString(),
  };
}

/**
 * Cognito SDKの例外をアプリケーションエラーに変換する
 */
function toApplicationError(
  error: unknown,
  context?: { username?: string }
): ApplicationError {
  const err = error as { name?: string; message?: string };
  switch (err?.name) {
    case "UsernameExistsException":
      return new ApplicationError(
        "A user with this email already exists",
        409,
        "USER_ALREADY_EXISTS"
      );
    case "UserNotFoundException":
      return new NotFoundError("User", context?.username ?? "unknown");
    case "InvalidPasswordException":
      return new ApplicationError(
        `Temporary password rejected: ${err.message ?? ""}`,
        400,
        "INVALID_PASSWORD"
      );
    case "LimitExceededException":
      return new ApplicationError(
        "Cognito API rate limit exceeded. Try again later",
        429,
        "COGNITO_LIMIT_EXCEEDED"
      );
    default:
      return error instanceof ApplicationError
        ? error
        : new ApplicationError(
            `Cognito operation failed: ${err?.name ?? ""} ${err?.message ?? ""}`
          );
  }
}

/**
 * ユーザーを発行する（AdminCreateUser）。
 * MessageAction=SUPPRESS で Cognito からの招待メールを送らず、
 * 一時パスワードを呼び出し元に返すのみとする（管理者が別手段で伝達する）
 */
export async function createUser(
  params: CreateUserParams
): Promise<CreatedUserResult> {
  const email = params.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ApplicationError("Invalid email address", 400, "INVALID_EMAIL");
  }

  const temporaryPassword = generateTemporaryPassword();
  const userAttributes: AttributeType[] = [
    { Name: "email", Value: email },
    { Name: "email_verified", Value: "true" },
  ];
  if (params.role !== "") {
    userAttributes.push({ Name: "custom:rapid_role", Value: params.role });
  }

  try {
    const response = await getCognitoClient().send(
      new AdminCreateUserCommand({
        UserPoolId: getUserPoolId(),
        Username: email,
        UserAttributes: userAttributes,
        TemporaryPassword: temporaryPassword,
        MessageAction: "SUPPRESS",
      })
    );

    if (!response.User) {
      throw new ApplicationError(
        "Cognito returned no user for the creation result"
      );
    }
    return { user: toUserSummary(response.User), temporaryPassword };
  } catch (error) {
    throw toApplicationError(error, { username: email });
  }
}

/**
 * ユーザー一覧を取得する（ListUsers。1回最大60件）
 */
export async function listUsers(params: {
  nextToken?: string;
}): Promise<ListUsersResult> {
  try {
    const response = await getCognitoClient().send(
      new ListUsersCommand({
        UserPoolId: getUserPoolId(),
        Limit: 60,
        PaginationToken: params.nextToken,
      })
    );
    return {
      users: (response.Users ?? []).map(toUserSummary),
      nextToken: response.PaginationToken,
    };
  } catch (error) {
    throw toApplicationError(error);
  }
}

/**
 * ユーザーのロール（custom:rapid_role）を変更する
 */
export async function updateUserRole(
  params: UpdateUserRoleParams
): Promise<{ username: string; role: RapidRole }> {
  if (!params.username) {
    throw new ApplicationError("Username is required", 400, "INVALID_REQUEST");
  }
  const userAttributes: AttributeType[] = [
    { Name: "custom:rapid_role", Value: params.role },
  ];

  try {
    await getCognitoClient().send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: getUserPoolId(),
        Username: params.username,
        UserAttributes: userAttributes,
      })
    );
    return { username: params.username, role: params.role };
  } catch (error) {
    throw toApplicationError(error, { username: params.username });
  }
}

/**
 * ロール文字列が発行可能な値か検証する
 */
export function isValidRapidRole(value: unknown): value is RapidRole {
  return (
    typeof value === "string" &&
    (RAPID_ROLES as readonly string[]).includes(value)
  );
}
