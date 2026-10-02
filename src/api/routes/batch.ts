import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import type { Storage } from "../../storage/storage.js";
import { operationsSchema } from "../schemas/operations.js";
import type { BatchQueue } from "../../jobs/types.js";

const batchRequestSchema = z.object({
  sources: z
    .array(z.string().url().max(2048))
    .min(1)
    .max(100)
    .refine(
      (sources) =>
        sources.every((source) => {
          const url = new URL(source);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        }),
      "Sources must be HTTP or HTTPS URLs without credentials",
    ),
  ops: operationsSchema,
});

export async function batchRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    storage: Storage;
    queue?: BatchQueue;
  },
): Promise<void> {
  const { config, storage, queue } = options;
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
              items: { type: "string", format: "uri" },
            },
            ops: { type: "array", items: { type: "object" } },
          },
        },
        response: {
          400: {
            type: "object",
            properties: { error: { type: "string" } },
          },
          202: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              statusUrl: { type: "string" },
            },
          },
          503: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const parsed = batchRequestSchema.safeParse(request.body);
      if (
        !parsed.success ||
        parsed.data.sources.length > config.BATCH_MAX_ITEMS
      )
        return reply.code(400).send({ error: "Invalid batch request" });
      const id = await queue.enqueue(parsed.data);
      return reply.code(202).send({
        id,
        status: "waiting",
        statusUrl: `/v1/jobs/${id}`,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/jobs/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
        },
        response: {
          200: {
            description: "Job status JSON or the completed ZIP archive",
          },
          503: {
            type: "object",
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!queue)
        return reply.code(503).send({ error: "Batch jobs are disabled" });
      if (!queue.isReady())
        return reply.code(503).send({ error: "Batch queue is unavailable" });
      const status = await queue.get(request.params.id);
      if (!status) return reply.code(404).send({ error: "Job not found" });
      if (status.state === "completed") {
        const archive = await storage.get(`batch-result:${status.id}`);
        if (!archive)
          return reply.code(410).send({ error: "Job result has expired" });
        return reply
          .type("application/zip")
          .header(
            "Content-Disposition",
            'attachment; filename="image-craft-result.zip"',
          )
          .send(archive);
      }
      if (status.state === "failed")
        return reply
          .code(200)
          .send({ ...status, error: "Batch processing failed" });
      return reply.send(status);
    },
  );
}
