import type { FastifyInstance } from "fastify";
import type { BatchQueue } from "../../jobs/types.js";

export async function healthRoutes(
  app: FastifyInstance,
  options: { queue?: BatchQueue } = {},
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: { type: "object", properties: { status: { type: "string" } } },
        },
      },
    },
    async () => ({ status: "ok" }),
  );
  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: { type: "object", properties: { status: { type: "string" } } },
          503: { type: "object", properties: { status: { type: "string" } } },
        },
      },
    },
    async (_request, reply) => {
      if (options.queue && !options.queue.isReady())
        return reply.code(503).send({ status: "not ready" });
      return { status: "ready" };
    },
  );
}
