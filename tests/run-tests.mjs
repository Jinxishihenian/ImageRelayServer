import assert from "node:assert/strict";

import request from "supertest";

import { createApp } from "../dist/app/create-app.js";
import { getAllowedFileAliases } from "../dist/common/role-status.js";
import { loadEnv } from "../dist/config/env.js";

const baseEnv = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  corsOrigins: [],
  dbHost: "127.0.0.1",
  dbPort: 3306,
  dbUser: "root",
  dbPassword: "test-password",
  dbName: "wss_image_relay",
  authTokenSecret: "test-secret",
  fileStorageDir: "D:/ImageRelay/data/test-files",
  fileBaseUrl: "",
  maxUploadSizeBytes: 2 * 1024 * 1024,
};

const app = createApp(baseEnv, {
  getDatabaseHealthStatus: async () => ({
    status: "up",
  }),
});

async function run() {
  assert.deepEqual(getAllowedFileAliases("trainer"), ["source", "cleaned", "annotated"]);

  const healthResponse = await request(app).get("/health");
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.status, "ok");
  assert.equal(typeof healthResponse.body.timestamp, "string");
  assert.equal(healthResponse.body.database.status, "up");

  const pingResponse = await request(app).get("/api/v1/ping");
  assert.equal(pingResponse.status, 200);
  assert.deepEqual(pingResponse.body, { message: "pong" });

  const notFoundResponse = await request(app).get("/missing-route");
  assert.equal(notFoundResponse.status, 404);
  assert.equal(notFoundResponse.body.error.code, "ROUTE_NOT_FOUND");
  assert.equal(typeof notFoundResponse.body.error.message, "string");

  const degradedApp = createApp(baseEnv, {
    getDatabaseHealthStatus: async () => ({
      status: "down",
      message: "simulated database outage",
    }),
  });
  const degradedHealthResponse = await request(degradedApp).get("/health");
  assert.equal(degradedHealthResponse.status, 503);
  assert.equal(degradedHealthResponse.body.status, "degraded");
  assert.equal(degradedHealthResponse.body.database.status, "down");
  assert.equal(degradedHealthResponse.body.database.message, "simulated database outage");

  const originalEnv = { ...process.env };

  try {
    process.env.NODE_ENV = "test";
    delete process.env.HOST;
    process.env.PORT = "3001";
    process.env.CORS_ORIGINS = "http://a.example.com, http://b.example.com";
    process.env.DB_HOST = "192.168.1.132";
    process.env.DB_PORT = "3306";
    process.env.DB_USER = "root";
    process.env.DB_PASSWORD = "123456";
    process.env.DB_NAME = "wss_image_relay";
    process.env.AUTH_TOKEN_SECRET = "local-test-secret";
    process.env.FILE_STORAGE_DIR = "D:/ImageRelay/data/local-files";
    process.env.FILE_BASE_URL = "http://localhost:3000";
    process.env.MAX_UPLOAD_SIZE_MB = "10";

    const loadedEnv = loadEnv();
    assert.equal(loadedEnv.host, "0.0.0.0");
    assert.equal(loadedEnv.dbHost, "192.168.1.132");
    assert.equal(loadedEnv.dbPort, 3306);
    assert.equal(loadedEnv.dbUser, "root");
    assert.equal(loadedEnv.dbPassword, "123456");
    assert.equal(loadedEnv.dbName, "wss_image_relay");
    assert.equal(loadedEnv.authTokenSecret, "local-test-secret");
    assert.equal(loadedEnv.fileBaseUrl, "http://localhost:3000");
    assert.equal(loadedEnv.maxUploadSizeBytes, 10 * 1024 * 1024);
    assert.deepEqual(loadedEnv.corsOrigins, [
      "http://a.example.com",
      "http://b.example.com",
    ]);

    process.env.HOST = "127.0.0.1";
    assert.equal(loadEnv().host, "127.0.0.1");

    process.env.DB_PORT = "70000";
    assert.throws(() => loadEnv(), /DB_PORT/);

    delete process.env.HOST;
    process.env.DB_PORT = "3306";
    delete process.env.DB_PASSWORD;
    assert.throws(() => loadEnv(), /DB_PASSWORD/);

    process.env.DB_PASSWORD = "123456";
    process.env.MAX_UPLOAD_SIZE_MB = "70000";
    assert.throws(() => loadEnv(), /MAX_UPLOAD_SIZE_MB/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, originalEnv);
  }

  console.log("All smoke tests passed.");
}

run().catch((error) => {
  console.error("Smoke tests failed:", error);
  process.exitCode = 1;
});
