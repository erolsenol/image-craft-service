import express from "express";
import { craft } from "image-craft-client";

const app = express();
app.get("/image-url", (request, response) => {
  const width = Number(request.query.width ?? 800);
  const url = craft
    .image("https://example.com/photo.jpg")
    .resize(width)
    .format("webp")
    .url();
  response.json({ url });
});
app.listen(3001, () => console.log("Example listening on :3001"));
