import { z } from "zod";

const dimension = z.number().int().positive().max(16_384);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const gravity = z.enum([
  "north",
  "south",
  "east",
  "west",
  "center",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
]);

export const operationSchema = z
  .discriminatedUnion("op", [
    z
      .object({
        op: z.literal("resize"),
        width: dimension.optional(),
        height: dimension.optional(),
        fit: z
          .enum(["cover", "contain", "fill", "inside", "outside"])
          .optional(),
        strategy: z.enum(["attention", "entropy"]).optional(),
        fx: z.number().min(0).max(1).optional(),
        fy: z.number().min(0).max(1).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("crop"),
        left: z.number().int().nonnegative().default(0),
        top: z.number().int().nonnegative().default(0),
        width: dimension,
        height: dimension,
        strategy: z.enum(["attention", "entropy"]).optional(),
        fx: z.number().min(0).max(1).optional(),
        fy: z.number().min(0).max(1).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("rotate"),
        angle: z.number().finite().min(-360).max(360),
      })
      .strict(),
    z
      .object({
        op: z.literal("blur"),
        sigma: z.number().min(0.3).max(100).default(1),
      })
      .strict(),
    z
      .object({
        op: z.literal("sharpen"),
        sigma: z.number().min(0.01).max(10).optional(),
      })
      .strict(),
    z.object({ op: z.literal("grayscale") }).strict(),
    z
      .object({
        op: z.literal("watermark"),
        text: z.string().min(1).max(200).optional(),
        image: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(1_398_104)
          .optional(),
        gravity: gravity.optional(),
        position: gravity.optional(),
        opacity: z.number().min(0).max(1).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("format"),
        format: z.enum(["jpeg", "png", "webp", "avif", "auto"]),
        quality: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("padding"),
        top: z.number().int().nonnegative().default(0),
        right: z.number().int().nonnegative().default(0),
        bottom: z.number().int().nonnegative().default(0),
        left: z.number().int().nonnegative().default(0),
        background: color.default("#00000000"),
      })
      .strict(),
    z.object({ op: z.literal("flip") }).strict(),
    z.object({ op: z.literal("flop") }).strict(),
    z.object({ op: z.literal("tint"), color }).strict(),
    z
      .object({
        op: z.literal("adjust"),
        brightness: z.number().min(0).max(2).optional(),
        contrast: z.number().min(-1).max(1).optional(),
        saturation: z.number().min(0).max(2).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("roundedCorners"),
        radius: z.number().int().positive().max(4096),
      })
      .strict(),
    z
      .object({
        op: z.literal("plugin"),
        name: z.string().min(1).max(100),
        options: z.unknown().optional(),
      })
      .strict(),
  ])
  .superRefine((operation, context) => {
    if (
      operation.op === "resize" &&
      operation.width === undefined &&
      operation.height === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["width"],
        message: "resize requires width or height",
      });
    }
    if (
      operation.op === "watermark" &&
      (operation.text === undefined) === (operation.image === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "watermark requires exactly one of text or image",
      });
    }
    if (
      operation.op === "watermark" &&
      operation.gravity !== undefined &&
      operation.position !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["position"],
        message: "Use either position or gravity, not both",
      });
    }
    if (
      operation.op === "adjust" &&
      operation.brightness === undefined &&
      operation.contrast === undefined &&
      operation.saturation === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adjust requires a brightness, contrast, or saturation value",
      });
    }
    if (
      (operation.op === "resize" || operation.op === "crop") &&
      (operation.fx === undefined) !== (operation.fy === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [operation.fx === undefined ? "fx" : "fy"],
        message: "fx and fy must be provided together",
      });
    }
    if (
      (operation.op === "resize" || operation.op === "crop") &&
      operation.strategy &&
      operation.fx !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strategy"],
        message: "strategy and focal point cannot be combined",
      });
    }
  });

export const operationsSchema = z.array(operationSchema).max(50);
export type Operation = z.infer<typeof operationSchema>;
export type PluginOperation = Extract<Operation, { op: "plugin" }>;
export type CoreOperation = Exclude<Operation, PluginOperation>;
