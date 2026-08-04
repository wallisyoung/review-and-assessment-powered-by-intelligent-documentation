import { Handler } from "aws-lambda";
import { exec } from "child_process";
import { getDatabaseUrl } from "../utils/database";

// Define allowed Prisma migration commands
const ALLOWED_COMMANDS = ["deploy", "reset", "status", "up", "down"] as const;
type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

/**
 * Validates if the provided command is one of the allowed Prisma migration commands
 */
const validateCommand = (command: unknown): AllowedCommand => {
  if (typeof command !== "string") return "deploy";
  const sanitizedCommand = command.trim().toLowerCase();
  if (ALLOWED_COMMANDS.includes(sanitizedCommand as AllowedCommand)) {
    return sanitizedCommand as AllowedCommand;
  }
  return "deploy";
};

/** exec を Promise<number> で包む（exit code を返す） */
const execAsync = (cmd: string): Promise<number> =>
  new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      console.log(stdout);
      if (stderr) console.error(stderr);
      resolve(error ? (error.code ?? 1) : 0);
    });
  });

/**
 * Handler for running Prisma migrations + 登記 seed
 */
export const handler: Handler = async (event, _) => {
  process.env.DATABASE_URL = await getDatabaseUrl();
  const command: AllowedCommand = validateCommand(event.command);
  let options: string[] = [];

  if (command === "reset") {
    options = ["--force", "--skip-generate", "--skip-seed"];
  }

  try {
    // マイグレーション実行
    const exitCode = await execAsync(
      `npx prisma migrate ${command} ${options.join(" ")}`
    );

    if (exitCode !== 0)
      throw Error(`command ${command} failed with exit code ${exitCode}`);

    // マイグレーション成功後、登記 seed を実行（deploy のみ、non-blocking）
    if (command === "deploy") {
      console.log("[SEED] 登記 seed 実行...");
      const seedCode = await execAsync("node dist/scripts/seed-touki.js");
      if (seedCode !== 0)
        console.warn(`[SEED] exited ${seedCode} (non-blocking)`);
      else console.log("[SEED] 登記 seed 完了");
    }
  } catch (e) {
    console.log(e);
    throw e;
  }
};
