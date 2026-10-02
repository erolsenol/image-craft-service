import { z } from "zod";
const dimension = z.number().int().positive().max(16_384);
export const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("resize"),
    width: dimension.optional(),
    height: dimension.optional(),
    fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
  }),
  z.object({
    op: z.literal("crop"),
    left: z.number().int().nonnegative().default(0),
    top: z.number().int().nonnegative().default(0),
    width: dimension,
    height: dimension,
  }),
  z.object({
    op: z.literal("rotate"),
    angle: z.number().finite().min(-360).max(360),
  }),
  z.object({
    op: z.literal("blur"),
    sigma: z.number().min(0.3).max(100).default(1),
  }),
  z.object({
    op: z.literal("sharpen"),
    sigma: z.number().min(0.01).max(10).optional(),
  }),
  z.object({ op: z.literal("grayscale") }),
  z.object({
    op: z.literal("watermark"),
    text: z.string().min(1).max(200),
    gravity: z
      .enum([
        "north",
        "south",
        "east",
        "west",
        "center",
        "northeast",
        "northwest",
        "southeast",
        "southwest",
      ])
      .optional(),
  }),
  z.object({
    op: z.literal("format"),
    format: z.enum(["jpeg", "png", "webp", "avif"]),
    quality: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    op: z.literal("plugin"),
    name: z.string().min(1).max(100),
    options: z.unknown().optional(),
  }),
]);
export const operationsSchema = z
  .array(operationSchema)
  .max(20)
  .superRefine((operations, context) => {
    operations.forEach((operation, index) => {
      if (
        operation.op === "resize" &&
        operation.width === undefined &&
        operation.height === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "resize requires width or height",
        });
      }
    });
  });
export type Operation = z.infer<typeof operationSchema>;
export type PluginOperation = Extract<Operation, { op: "plugin" }>;
export type CoreOperation = Exclude<Operation, PluginOperation>;
