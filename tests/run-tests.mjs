import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import request from "supertest";

import { createApp } from "../dist/app/create-app.js";
import { createAuthToken } from "../dist/auth/token.js";
import { getAllowedFileAliases } from "../dist/common/role-status.js";
import { loadEnv } from "../dist/config/env.js";
import {
  parseCleanedManifest,
  validateUploadContent,
} from "../dist/files/archive-utils.js";
import { initializeFileStorage } from "../dist/files/file-storage.js";
import { buildTaskFileDownloadUrl } from "../dist/tasks/tasks.controller.js";
import {
  buildTaskVisibilitySql,
  canUserAccessTask,
} from "../dist/tasks/task-visibility.js";

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
  fileStorageDir: "D:/ImageRelay/server/.tmp/test-files",
  fileBaseUrl: "",
  maxUploadSizeBytes: 2 * 1024 * 1024,
};

const app = createApp(baseEnv, {
  getDatabaseHealthStatus: async () => ({
    status: "up",
  }),
});

async function run() {
  await initializeFileStorage(baseEnv);
  assert.deepEqual(getAllowedFileAliases("trainer"), ["source", "cleaned", "annotated"]);
  assert.deepEqual(buildTaskVisibilitySql({ id: 1, role: "admin" }, "t"), {
    condition: "",
    params: [],
  });
  assert.deepEqual(buildTaskVisibilitySql({ id: 2, role: "cleaner" }, "t"), {
    condition: `(
      (t.cleaner_id = ? AND t.status = 'pending_clean')
      OR (t.cleaner_id = ? AND t.cleaned_file IS NOT NULL)
    )`,
    params: [2, 2],
  });
  assert.equal(
    buildTaskFileDownloadUrl("/api/v1/public/task-files/download?taskId=1", ""),
    "/api/v1/public/task-files/download?taskId=1",
  );
  assert.equal(
    buildTaskFileDownloadUrl(
      "/api/v1/public/task-files/download?taskId=1",
      "http://192.168.1.20:3000",
    ),
    "http://192.168.1.20:3000/api/v1/public/task-files/download?taskId=1",
  );
  assert.deepEqual(
    await parseCleanedManifest(Buffer.from('["a.png","dir\\\\b.png"]', "utf8")),
    ["a.png", "dir/b.png"],
  );
  await validateUploadContent(
    Buffer.from('["keep/a.png","keep/b.png"]', "utf8"),
    "cleaned.json",
    "task_cleaned",
  );
  await assert.rejects(
    () => validateUploadContent(Buffer.from('{"a":"b"}', "utf8"), "cleaned.json", "task_cleaned"),
    /字符串数组/,
  );
  await assert.rejects(
    () => validateUploadContent(Buffer.from('["a.png","a.png"]', "utf8"), "cleaned.json", "task_cleaned"),
    /重复路径/,
  );
  await assert.rejects(
    () => validateUploadContent(Buffer.from('["../a.png"]', "utf8"), "cleaned.json", "task_cleaned"),
    /不能包含 \. 或 \.\./,
  );

  const nestedSourceZipBase64 = "UEsDBBQAAAAIAMpyqVxxR47VPwAAAEQAAAAJAAAAZGlyXGEucG5n6wzwc+flkuJiYGDg9fRwCQLSjCDMwQIkt8rwMAEpbk8Xx5CKW8l//sszMDMzMbyf9fI8UJjB09XPZZ1TQhMAUEsBAhQAFAAAAAgAynKpXHFHjtU/AAAARAAAAAkAAAAAAAAAAAAAAAAAAAAAAGRpclxhLnBuZ1BLBQYAAAAAAQABADcAAABmAAAAAAA=";
  await fs.mkdir(baseEnv.fileStorageDir, { recursive: true });
  const nestedSourceZipPath = path.join(baseEnv.fileStorageDir, "manifest-fallback-source.zip");
  await fs.writeFile(nestedSourceZipPath, Buffer.from(nestedSourceZipBase64, "base64"));
  const { resolveCleanedManifestSelection } = await import("../dist/files/archive-utils.js");
  const fallbackSelection = await resolveCleanedManifestSelection({
    manifestSource: Buffer.from('["a.png"]', "utf8"),
    sourceArchivePath: nestedSourceZipPath,
    manifestLabel: "清洗结果文件",
    sourceArchiveLabel: "初始文件",
  });
  assert.deepEqual(fallbackSelection.selectedPaths, ["dir/a.png"]);

  const cleanerUser = {
    id: 2,
    username: "cleaner01",
    role: "cleaner",
  };
  const annotatorUser = {
    id: 3,
    username: "annotator01",
    role: "annotator",
  };
  const trainerUser = {
    id: 4,
    username: "trainer01",
    role: "trainer",
  };

  assert.equal(
    canUserAccessTask(
      {
        status: "pending_clean",
        cleanerId: 2,
        annotatorId: 3,
        trainerId: 4,
        cleanedFile: null,
        annotatedFile: null,
        modelFile: null,
      },
      cleanerUser,
    ),
    true,
  );
  assert.equal(
    canUserAccessTask(
      {
        status: "pending_train",
        cleanerId: 2,
        annotatorId: 3,
        trainerId: 4,
        cleanedFile: "tasks/task-1/cleaned.zip",
        annotatedFile: "tasks/task-1/annotated.zip",
        modelFile: null,
      },
      cleanerUser,
    ),
    true,
  );
  assert.equal(
    canUserAccessTask(
      {
        status: "pending_clean",
        cleanerId: 8,
        annotatorId: 3,
        trainerId: 4,
        cleanedFile: null,
        annotatedFile: null,
        modelFile: null,
      },
      cleanerUser,
    ),
    false,
  );
  assert.equal(
    canUserAccessTask(
      {
        status: "pending_clean",
        cleanerId: 2,
        annotatorId: 3,
        trainerId: 4,
        cleanedFile: null,
        annotatedFile: null,
        modelFile: null,
      },
      annotatorUser,
    ),
    false,
  );
  assert.equal(
    canUserAccessTask(
      {
        status: "finished",
        cleanerId: 2,
        annotatorId: 3,
        trainerId: 4,
        cleanedFile: "tasks/task-2/cleaned.zip",
        annotatedFile: "tasks/task-2/annotated.zip",
        modelFile: "tasks/task-2/model.bin",
      },
      trainerUser,
    ),
    true,
  );

  const healthResponse = await request(app).get("/health");
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.status, "ok");
  assert.equal(typeof healthResponse.body.timestamp, "string");
  assert.equal(healthResponse.body.database.status, "up");

  const pingResponse = await request(app).get("/api/v1/ping");
  assert.equal(pingResponse.status, 200);
  assert.deepEqual(pingResponse.body, { message: "pong" });

  const adminToken = createAuthToken(
    {
      id: 1,
      username: "admin01",
      role: "admin",
    },
    baseEnv.authTokenSecret,
  );
  const trainerToken = createAuthToken(
    {
      id: 4,
      username: "trainer01",
      role: "trainer",
    },
    baseEnv.authTokenSecret,
  );

  const forbiddenModelListResponse = await request(app)
    .get("/api/v1/models")
    .set("Authorization", `Bearer ${trainerToken}`);
  assert.equal(forbiddenModelListResponse.status, 403);

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

  const uploadToken = adminToken;
  const uploadFilePath = path.join(baseEnv.fileStorageDir, "smoke-upload.txt");
  await fs.mkdir(baseEnv.fileStorageDir, { recursive: true });
  await fs.writeFile(uploadFilePath, "smoke upload");

  const uploadResponse = await request(app)
    .post("/api/v1/files/upload")
    .set("Authorization", `Bearer ${uploadToken}`)
    .field("originalName", "smoke-upload.txt")
    .field("purpose", "task_model")
    .attach("file", uploadFilePath, {
      filename: "smoke-upload.txt",
      contentType: "text/plain",
    });

  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadResponse.body.item.originalName, "smoke-upload.txt");
  assert.equal(uploadResponse.body.item.mimeType, "text/plain");
  assert.equal(uploadResponse.body.item.size, 12);

  const tusCreateResponse = await request(app)
    .post("/api/v1/files/tus")
    .set("Authorization", `Bearer ${uploadToken}`)
    .set("Tus-Resumable", "1.0.0")
    .set("Upload-Length", "12")
    .set(
      "Upload-Metadata",
      `originalName ${Buffer.from("smoke-upload.txt").toString("base64")},mimeType ${Buffer.from("text/plain").toString("base64")},purpose ${Buffer.from("task_model").toString("base64")}`,
    )
    .send();

  assert.equal(tusCreateResponse.status, 201);
  assert.equal(tusCreateResponse.headers["tus-resumable"], "1.0.0");
  assert.equal(tusCreateResponse.headers["upload-offset"], "0");

  const uploadLocation = tusCreateResponse.headers.location;
  assert.equal(typeof uploadLocation, "string");

  const tusHeadBeforePatchResponse = await request(app)
    .head(uploadLocation)
    .set("Authorization", `Bearer ${uploadToken}`)
    .set("Tus-Resumable", "1.0.0");

  assert.equal(tusHeadBeforePatchResponse.status, 200);
  assert.equal(tusHeadBeforePatchResponse.headers["upload-offset"], "0");
  assert.equal(tusHeadBeforePatchResponse.headers["upload-length"], "12");

  const tusPatchResponse = await request(app)
    .patch(uploadLocation)
    .set("Authorization", `Bearer ${uploadToken}`)
    .set("Tus-Resumable", "1.0.0")
    .set("Upload-Offset", "0")
    .set("Content-Type", "application/offset+octet-stream")
    .send("smoke upload");

  assert.equal(tusPatchResponse.status, 204);
  assert.equal(tusPatchResponse.headers["upload-offset"], "12");

  const tusHeadAfterPatchResponse = await request(app)
    .head(uploadLocation)
    .set("Authorization", `Bearer ${uploadToken}`)
    .set("Tus-Resumable", "1.0.0");

  assert.equal(tusHeadAfterPatchResponse.status, 200);
  assert.equal(tusHeadAfterPatchResponse.headers["upload-offset"], "12");

  const uploadId = uploadLocation.split("/").pop();
  assert.equal(typeof uploadId, "string");
  assert.ok(uploadId);

  const finalizeResponse = await request(app)
    .post(`/api/v1/files/uploads/${uploadId}/complete`)
    .set("Authorization", `Bearer ${uploadToken}`)
    .send();

  assert.equal(finalizeResponse.status, 201);
  assert.equal(finalizeResponse.body.item.originalName, "smoke-upload.txt");
  assert.equal(finalizeResponse.body.item.mimeType, "text/plain");
  assert.equal(finalizeResponse.body.item.size, 12);

  const originalEnv = { ...process.env };

  try {
    process.env.NODE_ENV = "test";
    delete process.env.HOST;
    process.env.PORT = "3001";
    process.env.CORS_ORIGINS = "http://a.example.com, http://b.example.com";
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "3306";
    process.env.DB_USER = "root";
    process.env.DB_PASSWORD = "Abc@12345";
    process.env.DB_NAME = "wss_image_relay";
    process.env.AUTH_TOKEN_SECRET = "local-test-secret";
    process.env.FILE_STORAGE_DIR = "D:/ImageRelay/data/local-files";
    process.env.FILE_BASE_URL = "http://localhost:3000";
    process.env.MAX_UPLOAD_SIZE_MB = "10";

    const loadedEnv = loadEnv();
    assert.equal(loadedEnv.host, "0.0.0.0");
    assert.equal(loadedEnv.dbHost, "127.0.0.1");
    assert.equal(loadedEnv.dbPort, 3306);
    assert.equal(loadedEnv.dbUser, "root");
    assert.equal(loadedEnv.dbPassword, "Abc@12345");
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

    process.env.DB_PASSWORD = "Abc@12345";
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
