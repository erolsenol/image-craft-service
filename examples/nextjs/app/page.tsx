import { CraftImage } from "image-craft-client/react";

export default function Page() {
  return (
    <main>
      <h1>Responsive image</h1>
      <CraftImage
        src="https://example.com/photo.jpg"
        serviceUrl={
          process.env.NEXT_PUBLIC_IMAGE_CRAFT_URL ?? "http://localhost:3000"
        }
        widths={[320, 640, 960, 1280]}
        sizes="(max-width: 640px) 100vw, 640px"
        format="auto"
        alt="Example"
        loading="lazy"
      />
    </main>
  );
}
