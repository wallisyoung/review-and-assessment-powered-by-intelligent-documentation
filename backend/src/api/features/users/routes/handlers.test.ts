import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createUserHandler,
  listUsersHandler,
  updateUserRoleHandler,
} from "./handlers";
import { ForbiddenError, ValidationError } from "../../../core/errors";
import * as usecase from "../usecase/cognito-user";

vi.mock("../usecase/cognito-user", () => ({
  createUser: vi.fn(),
  listUsers: vi.fn(),
  updateUserRole: vi.fn(),
  isValidRapidRole: (value: unknown) =>
    value === "" || value === "admin" || value === "opsEngineer",
}));

const adminUser = { userId: "sub-admin", email: "admin@example.com", isAdmin: true };
const generalUser = { userId: "sub-user", email: "user@example.com", isAdmin: false };

const makeReply = () => ({
  code: vi.fn().mockReturnThis(),
  send: vi.fn(),
});

describe("createUserHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-admin users with ForbiddenError", async () => {
    const reply = makeReply();

    await expect(
      createUserHandler({ user: generalUser, body: {} } as any, reply as any)
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(usecase.createUser).not.toHaveBeenCalled();
  });

  it("returns 201 with the created user and temporary password", async () => {
    // ダミーの一時パスワード（実在しない値。テストの応答マッピング検証用）
    const dummyTemporaryPassword = `dummy-${Date.now()}`;
    const created = {
      user: {
        username: "new@example.com",
        email: "new@example.com",
        role: "",
        enabled: true,
        userStatus: "FORCE_CHANGE_PASSWORD",
      },
      temporaryPassword: dummyTemporaryPassword,
    };
    vi.mocked(usecase.createUser).mockResolvedValue(created);
    const reply = makeReply();

    await createUserHandler(
      { user: adminUser, body: { email: "new@example.com" } } as any,
      reply as any
    );

    expect(usecase.createUser).toHaveBeenCalledWith({
      email: "new@example.com",
      role: "",
    });
    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith({ success: true, data: created });
  });

  it("passes an explicit role through", async () => {
    vi.mocked(usecase.createUser).mockResolvedValue({} as any);
    const reply = makeReply();

    await createUserHandler(
      { user: adminUser, body: { email: "a@b.com", role: "opsEngineer" } } as any,
      reply as any
    );

    expect(usecase.createUser).toHaveBeenCalledWith({
      email: "a@b.com",
      role: "opsEngineer",
    });
  });

  it("rejects a missing email", async () => {
    const reply = makeReply();

    await expect(
      createUserHandler({ user: adminUser, body: {} } as any, reply as any)
    ).rejects.toBeInstanceOf(ValidationError);

    expect(usecase.createUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid role", async () => {
    const reply = makeReply();

    await expect(
      createUserHandler(
        { user: adminUser, body: { email: "a@b.com", role: "superadmin" } } as any,
        reply as any
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(usecase.createUser).not.toHaveBeenCalled();
  });
});

describe("listUsersHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-admin users", async () => {
    const reply = makeReply();

    await expect(
      listUsersHandler({ user: generalUser, query: {} } as any, reply as any)
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("returns the user list with the pagination token", async () => {
    const data = { users: [], nextToken: "t2" };
    vi.mocked(usecase.listUsers).mockResolvedValue(data);
    const reply = makeReply();

    await listUsersHandler(
      { user: adminUser, query: { nextToken: "t1" } } as any,
      reply as any
    );

    expect(usecase.listUsers).toHaveBeenCalledWith({ nextToken: "t1" });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, data });
  });
});

describe("updateUserRoleHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-admin users", async () => {
    const reply = makeReply();

    await expect(
      updateUserRoleHandler(
        {
          user: generalUser,
          params: { username: "user@example.com" },
          body: { role: "admin" },
        } as any,
        reply as any
      )
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(usecase.updateUserRole).not.toHaveBeenCalled();
  });

  it("rejects changing the caller's own role", async () => {
    const reply = makeReply();

    await expect(
      updateUserRoleHandler(
        {
          user: adminUser,
          params: { username: "admin@example.com" },
          body: { role: "" },
        } as any,
        reply as any
      )
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(usecase.updateUserRole).not.toHaveBeenCalled();
  });

  it("updates the role for another user", async () => {
    const data = { username: "user@example.com", role: "admin" };
    vi.mocked(usecase.updateUserRole).mockResolvedValue(data);
    const reply = makeReply();

    await updateUserRoleHandler(
      {
        user: adminUser,
        params: { username: "user@example.com" },
        body: { role: "admin" },
      } as any,
      reply as any
    );

    expect(usecase.updateUserRole).toHaveBeenCalledWith({
      username: "user@example.com",
      role: "admin",
    });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ success: true, data });
  });

  it("rejects an invalid role", async () => {
    const reply = makeReply();

    await expect(
      updateUserRoleHandler(
        {
          user: adminUser,
          params: { username: "user@example.com" },
          body: { role: "root" },
        } as any,
        reply as any
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(usecase.updateUserRole).not.toHaveBeenCalled();
  });
});
