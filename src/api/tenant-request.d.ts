import type { ApiPrincipal } from "../security/api-keys.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantPrincipal: ApiPrincipal | null;
  }
}
