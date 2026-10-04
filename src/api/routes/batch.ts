import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import type { BatchQueue, BatchRequest } from "../../jobs/types.js";
import { BatchAdmissionError } from "../../jobs/bullmq-batch-queue.js";
import type { Storage } from "../../storage/storage.js";
import { assertPublicWebhookUrl } from "../../security/webhook.js";
import { resolveBatchClientId } from "../../security/api-keys.js";
import { validateImage } from "../../security/limits.js";
import { operationsSchema } from "../schemas/operations.js";
import { supportsPresignedUploads } from "../../storage/presigned-upload-storage.js";
import {
  namespaceTenantKey,
  tenantAllowsOperations,
  tenantAllowsSource,
  type TenantUsage,
} from "../../security/tenants.js";

const presignedUploadRequestSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
  sizeBytes: z.number().int().positive(),
});

const fileIdPattern =
  /^file_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceSchema = z
  .string()
  .max(2048)
  .refine((source) => {
    if (fileIdPattern.test(source)) return true;
    try {
      const url = new URL(source);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Each source must be a public HTTP(S) URL or an uploaded file ID");

const batchRequestSchema = (maxItems: number) =>
  z.object({
    sources: z.array(sourceSchema).min(1).max(maxItems),
    ops: operationsSchema,
    webhookUrl: z
      .string()
      .url()
      .max(2048)
      .optional()
      .refine((value) => {
        if (!value) return true;
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "Webhook URL must use HTTP(S) and cannot contain credentials"),
  });

export async function batchRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    storage: Storage;
    queue?: BatchQueue;
    tenantUsage?: TenantUsage;
    validateWebhook?: (url: string) => Promise<unknown>;
  },
): Promise<void> {
  const { config, storage, queue, tenantUsage } = options;
  const validateWebhook = options.validateWebhook ?? assertPublicWebhookUrl;

  app.post(
    "/v1/uploads",
    {
      schema: {
        consumes: ["multipart/form-data", "application/json"],
        response: {
          201: {
            type: "object",
            required: ["fileId", "expiresIn"],
            properties: {
              fileId: { type: "string" },
              expiresIn: { type: "integer" },
              uploadUrl: { type: "string", format: "uri" },
              method: { type: "string", enum: ["PUT"] },
              headers: { type: "object", additionalProperties: true },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
          503: { type: "object", properties: { error: { type: "string" } } },
          415: { type: "object", properties: { error: { type: "string" } } },
          429: {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const tenantId = request.tenantPrincipal?.tenantId;
      const clientId =
        tenantId ??
        resolveBatchClientId(
          headerValue(request.headers["x-api-key"]),
          request.ip,
          config.API_KEYS,
        );
      if (!clientId) return reply.code(401).send({ error: "Invalid API key" });
      if (!request.isMultipart()) {
        if (!supportsPresignedUploads(storage))
          return reply.code(415).send({
            error: "Presigned uploads require S3-compatible storage",
            code: "PRESIGNED_UPLOADS_UNAVAILABLE",
          });
        const parsed = presignedUploadRequestSchema.safeParse(request.body);
        if (!parsed.success || parsed.data.sizeBytes > config.MAX_UPLOAD_BYTES)
          return reply.code(400).send({
            error:
              "contentType and a sizeBytes within MAX_UPLOAD_BYTES are required",
            code: "INVALID_UPLOAD_REQUEST",
          });
        const fileId = `file_${randomUUID()}`;
        if (
          tenantId &&
          !tenantUsage?.recordBytes(tenantId, parsed.data.sizeBytes)
        )
          return reply.code(429).send({
            error: "Tenant daily byte quota exceeded",
            code: "TENANT_BYTES_QUOTA_EXCEEDED",
          });
        const storageKey = namespaceTenantKey(
          tenantId,
          `batch-upload:${fileId}`,
        );
        await storage.set(
          namespaceTenantKey(tenantId, `batch-upload-owner:${fileId}`),
          Buffer.from(clientId),
          config.BATCH_RESULT_TTL_SECONDS,
        );
        const presigned = await storage.createPresignedUpload(
          storageKey,
          parsed.data.contentType,
          parsed.data.sizeBytes,
          config.S3_PRESIGNED_UPLOAD_TTL_SECONDS,
          config.BATCH_RESULT_TTL_SECONDS,
        );
        return reply.code(201).send({
          fileId,
          uploadUrl: presigned.url,
          method: "PUT",
          headers: presigned.headers,
          expiresIn: presigned.expiresIn,
        });
      }
      const parts = request.parts({
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 0 },
      });
      let image: Buffer | undefined;
      for await (const part of parts) {
        if (part.type === "file") image = await part.toBuffer();
      }
      if (!image) return reply.code(400).send({ error: "file is required" });
      if (tenantId && !tenantUsage?.recordBytes(tenantId, image.length))
        return reply.code(429).send({
          error: "Tenant daily byte quota exceeded",
          code: "TENANT_BYTES_QUOTA_EXCEEDED",
        });
      await validateImage(image, config.MAX_INPUT_PIXELS);
      const fileId = `file_${randomUUID()}`;
      await storage.set(
        namespaceTenantKey(tenantId, `batch-upload:${fileId}`),
        image,
        config.BATCH_RESULT_TTL_SECONDS,
      );
      await storage.set(
        namespaceTenantKey(tenantId, `batch-upload-owner:${fileId}`),
        Buffer.from(clientId),
        config.BATCH_RESULT_TTL_SECONDS,
      );
      return reply.code(201).send({
        fileId,
        expiresIn: config.BATCH_RESULT_TTL_SECONDS,
      });
    },
  );

  app.post(
    "/v1/batch",
    {
      schema: {
        body: {
          type: "object",
          required: ["sources", "ops"],
          properties: {
            sources: {
              type: "array",
              maxItems: config.BATCH_MAX_ITEMS,
              items: { type: "string", maxLength: 2048 },
            },
            ops: { type: "array", items: { type: "object" } },
            webhookUrl: { type: "string", format: "uri" },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["jobId"],
            properties: { jobId: { type: "string" } },
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              code: { type: "string" },
            },
          },
          401: { type: "object", properties: { error: { type: "string" } } },
          403: {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          429: {
            type: "object",
            properties: {
              error: { type: "string" },
              code: { type: "string" },
            },
          },
          503: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const tenantId = request.tenantPrincipal?.tenantId;
      const clientId =
        tenantId ??
        resolveBatchClientId(
          headerValue(request.headers["x-api-key"]),
          request.ip,
          config.API_KEYS,
        );
      if (!clientId) return reply.code(401).send({ error: "Invalid API key" });
      const body = request.body as { ops?: unknown };
      if (Array.isArray(body.ops) && body.ops.length > config.MAX_OPS_CHAIN)
        return reply.code(400).send({
          error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
          code: "OPS_CHAIN_TOO_LONG",
        });
      const parsed = batchRequestSchema(config.BATCH_MAX_ITEMS).safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Invalid batch request",
          code: "INVALID_BATCH_REQUEST",
        });
      if (parsed.data.ops.length > config.MAX_OPS_CHAIN)
        return reply.code(400).send({
          error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
          code: "OPS_CHAIN_TOO_LONG",
        });
      if (tenantId) {
        const policy = config.TENANTS[tenantId];
        if (
          !policy ||
          !tenantAllowsOperations(policy, parsed.data.ops) ||
          parsed.data.sources.some(
            (source) =>
              !source.startsWith("file_") &&
              !tenantAllowsSource(policy, source),
          )
        )
          return reply.code(403).send({
            error: "Batch source or operation is not allowed for this tenant",
            code: "TENANT_POLICY_DENIED",
          });
      }
      if (parsed.data.webhookUrl) {
        if (!config.WEBHOOK_SIGNING_SECRET)
          return reply.code(400).send({
            error: "WEBHOOK_SIGNING_SECRET is required for webhook callbacks",
            code: "WEBHOOK_SIGNING_SECRET_REQUIRED",
          });
        try {
          await validateWebhook(parsed.data.webhookUrl);
        } catch {
          return reply.code(400).send({
            error: "Webhook URL must resolve to a public address",
            code: "WEBHOOK_URL_NOT_ALLOWED",
          });
        }
      }
      const input: BatchRequest = {
        sources: parsed.data.sources,
        ops: parsed.data.ops,
        apiKeyId: clientId,
        ...(tenantId ? { tenantId } : {}),
        ...(parsed.data.webhookUrl
          ? { webhookUrl: parsed.data.webhookUrl }
          : {}),
      };
      try {
        const jobId = await queue.enqueue(input);
        return reply.code(202).send({ jobId });
      } catch (error) {
        if (error instanceof BatchAdmissionError)
          return reply.code(429).send({
            error:
              error.code === "BATCH_API_KEY_CONCURRENCY"
                ? "Too many active batch jobs for this API key"
                : "Batch request rate limit exceeded for this API key",
            code: error.code,
          });
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/jobs/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^[0-9a-f-]{36}$", maxLength: 36 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["jobId", "status", "progress", "errors"],
            properties: {
              jobId: { type: "string" },
              status: {
                type: "string",
                enum: ["queued", "active", "done", "failed"],
              },
              progress: { type: "integer", minimum: 0, maximum: 100 },
              completedItems: { type: "integer" },
              totalItems: { type: "integer" },
              errors: { type: "array", items: { type: "object" } },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
          503: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const clientId =
        request.tenantPrincipal?.tenantId ??
        resolveBatchClientId(
          headerValue(request.headers["x-api-key"]),
          request.ip,
          config.API_KEYS,
        );
      if (!clientId) return reply.code(401).send({ error: "Invalid API key" });
      const status = await queue.get(request.params.id, clientId);
      if (!status) return reply.code(404).send({ error: "Job not found" });
      return reply.send(status);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/jobs/:id/download",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^[0-9a-f-]{36}$", maxLength: 36 },
          },
        },
        response: {
          200: { type: "string", format: "binary", description: "ZIP stream" },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
          410: { type: "object", properties: { error: { type: "string" } } },
          503: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const clientId =
        request.tenantPrincipal?.tenantId ??
        resolveBatchClientId(
          headerValue(request.headers["x-api-key"]),
          request.ip,
          config.API_KEYS,
        );
      if (!clientId) return reply.code(401).send({ error: "Invalid API key" });
      const job = await queue.get(request.params.id, clientId);
      if (!job) return reply.code(404).send({ error: "Job not found" });
      if (job.status !== "done")
        return reply.code(409).send({ error: "Batch job is not complete" });
      const archive = await queue.download(request.params.id, clientId);
      if (!archive)
        return reply.code(410).send({ error: "Job results have expired" });
      return reply
        .type("application/zip")
        .header(
          "Content-Disposition",
          'attachment; filename="image-craft-result.zip"',
        )
        .send(archive);
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
