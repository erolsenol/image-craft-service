import {
  createElement,
  type ImgHTMLAttributes,
  type ReactElement,
} from "react";
import { createCraftClient, type ImageFormat } from "./index.js";

export interface CraftImageProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "srcSet"
> {
  readonly src: string;
  readonly serviceUrl?: string;
  readonly widths?: readonly number[];
  readonly format?: ImageFormat;
  readonly quality?: number;
}

export function CraftImage({
  src,
  serviceUrl = "http://localhost:3000",
  widths = [320, 640, 960, 1280],
  format = "auto",
  quality,
  ...imageProps
}: CraftImageProps): ReactElement {
  const client = createCraftClient({ baseUrl: serviceUrl });
  const build = (width: number) =>
    client.image(src).resize(width).format(format, quality).url();
  const srcSet = [...new Set(widths)]
    .sort((a, b) => a - b)
    .map((width) => {
      if (!Number.isInteger(width) || width <= 0)
        throw new RangeError("widths must contain positive integers");
      return `${build(width)} ${width}w`;
    })
    .join(", ");
  const fallbackWidth =
    (typeof imageProps.width === "number" ? imageProps.width : undefined) ??
    widths[0] ??
    640;
  return createElement("img", {
    ...imageProps,
    src: build(fallbackWidth),
    srcSet,
  });
}
