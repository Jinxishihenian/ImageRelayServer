import type { Server } from "node:http";

import { createApp } from "./app/create-app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase, initializeDatabase } from "./database/mysql.js";
import { initializeFileStorage } from "./files/file-storage.js";

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function registerShutdownHandlers(server: Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`${signal} received, shutting down gracefully...`);

    try {
      await closeServer(server);
      await closeDatabase();
      process.exit(0);
    } catch (error) {
      console.error("Failed to shut down cleanly:", error);
      process.exit(1);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  await initializeDatabase(env);
  await initializeFileStorage(env);

  const app = createApp(env);
  const server = app.listen(env.port, env.host, () => {
    console.log(`Server is running on http://${env.host}:${env.port}`);
  });

  registerShutdownHandlers(server);
}

bootstrap().catch(async (error) => {
  console.error("Failed to start server:", error);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
