import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  createUser,
  generateTemporaryPassword,
  listUsers,
  updateUserRole,
} from "./cognito-user";
import { ApplicationError, NotFoundError } from "../../../core/errors";

vi.mock("../../../core/cognito-idp", () => ({
  getCognitoClient: () => ({
    send: sendMock,
  }),
  getUserPoolId: () => "ap-northeast-1_TESTPOOL",
}));

const sendMock = vi.fn();

describe("generateTemporaryPassword", () => {
  it("generates a password satisfying the pool policy", () => {
    for (let i = 0; i < 50; i++) {
      const password = generateTemporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%^&*]/);
    }
  });
});

describe("createUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends AdminCreateUser with SUPPRESS, verified email and role", async () => {
    sendMock.mockResolvedValue({
      User: {
        Username: "user@example.com",
        Attributes: [
          { Name: "email", Value: "user@example.com" },
          { Name: "custom:rapid_role", Value: "admin" },
        ],
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
        UserCreateDate: new Date("2026-01-02T03:04:05Z"),
      },
    });

    const result = await createUser({
      email: "USER@Example.com",
      role: "admin",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as AdminCreateUserCommand;
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect(command.input.UserPoolId).toBe("ap-northeast-1_TESTPOOL");
    expect(command.input.Username).toBe("user@example.com");
    expect(command.input.MessageAction).toBe("SUPPRESS");
    expect(command.input.UserAttributes).toEqual(
      expect.arrayContaining([
        { Name: "email", Value: "user@example.com" },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:rapid_role", Value: "admin" },
      ])
    );
    expect(command.input.TemporaryPassword).toBe(result.temporaryPassword);

    expect(result.user).toEqual({
      username: "user@example.com",
      email: "user@example.com",
      role: "admin",
      enabled: true,
      userStatus: "FORCE_CHANGE_PASSWORD",
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("omits the role attribute for general users", async () => {
    sendMock.mockResolvedValue({
      User: { Username: "u@e.com", Attributes: [{ Name: "email", Value: "u@e.com" }] },
    });

    await createUser({ email: "u@e.com", role: "" });

    const command = sendMock.mock.calls[0][0] as AdminCreateUserCommand;
    expect(
      command.input.UserAttributes?.some(
        (a) => a.Name === "custom:rapid_role"
      )
    ).toBe(false);
  });

  it("rejects invalid email", async () => {
    await expect(createUser({ email: "not-an-email", role: "" })).rejects.toBeInstanceOf(ApplicationError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("maps UsernameExistsException to a 409 error", async () => {
    sendMock.mockRejectedValue({ name: "UsernameExistsException" });

    const error = await createUser({ email: "u@e.com", role: "" }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.statusCode).toBe(409);
    expect(error.errorCode).toBe("USER_ALREADY_EXISTS");
  });
});

describe("listUsers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps Cognito users to summaries and returns the pagination token", async () => {
    sendMock.mockResolvedValue({
      Users: [
        {
          Username: "admin@example.com",
          Attributes: [
            { Name: "sub", Value: "sub-1" },
            { Name: "email", Value: "admin@example.com" },
            { Name: "custom:rapid_role", Value: "opsEngineer" },
          ],
          Enabled: true,
          UserStatus: "CONFIRMED",
        },
        {
          Username: "user@example.com",
          Attributes: [{ Name: "email", Value: "user@example.com" }],
          Enabled: false,
          UserStatus: "FORCE_CHANGE_PASSWORD",
        },
      ],
      PaginationToken: "next-token-1",
    });

    const result = await listUsers({ nextToken: "token-0" });

    const command = sendMock.mock.calls[0][0] as ListUsersCommand;
    expect(command.input.Limit).toBe(60);
    expect(command.input.PaginationToken).toBe("token-0");

    expect(result.users).toEqual([
      {
        username: "admin@example.com",
        email: "admin@example.com",
        role: "opsEngineer",
        enabled: true,
        userStatus: "CONFIRMED",
        createdAt: undefined,
      },
      {
        username: "user@example.com",
        email: "user@example.com",
        role: "",
        enabled: false,
        userStatus: "FORCE_CHANGE_PASSWORD",
        createdAt: undefined,
      },
    ]);
    expect(result.nextToken).toBe("next-token-1");
  });
});

describe("updateUserRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends AdminUpdateUserAttributes for the role", async () => {
    sendMock.mockResolvedValue({});

    const result = await updateUserRole({
      username: "user@example.com",
      role: "admin",
    });

    const command = sendMock.mock.calls[0][0] as AdminUpdateUserAttributesCommand;
    expect(command.input.Username).toBe("user@example.com");
    expect(command.input.UserAttributes).toEqual([
      { Name: "custom:rapid_role", Value: "admin" },
    ]);
    expect(result).toEqual({ username: "user@example.com", role: "admin" });
  });

  it("maps UserNotFoundException to NotFoundError", async () => {
    sendMock.mockRejectedValue({ name: "UserNotFoundException" });

    const error = await updateUserRole({
      username: "ghost@example.com",
      role: "",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
  });

  it("rejects an empty username", async () => {
    await expect(updateUserRole({ username: "", role: "admin" })).rejects.toBeInstanceOf(
      ApplicationError
    );
    expect(sendMock).not.toHaveBeenCalled();
  });
});
