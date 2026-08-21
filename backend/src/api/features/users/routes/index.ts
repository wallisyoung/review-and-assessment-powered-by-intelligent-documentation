import { FastifyInstance } from "fastify";
import {
  createUserHandler,
  listUsersHandler,
  updateUserRoleHandler,
} from "./handlers";

export function registerUserRoutes(fastify: FastifyInstance): void {
  fastify.get("/users", {
    handler: listUsersHandler,
  });

  fastify.post("/users", {
    handler: createUserHandler,
  });

  fastify.patch("/users/:username/role", {
    handler: updateUserRoleHandler,
  });
}
