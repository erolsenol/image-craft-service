import { defineConfig } from "vitepress";

export default defineConfig({
  title: "image-craft-service",
  description: "Self-hosted image processing HTTP API",
  base: "/image-craft-service/",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "API", link: "/api" },
      {
        text: "GitHub",
        link: "https://github.com/erolsenol/image-craft-service",
      },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "API reference", link: "/api" },
          { text: "Configuration", link: "/configuration" },
          { text: "Deployment", link: "/deployment" },
          { text: "Horizontal scaling", link: "/horizontal-scaling" },
          { text: "Plugins", link: "/plugins" },
          { text: "FAQ", link: "/faq" },
          { text: "Security", link: "/security" },
          { text: "Upgrade to v1", link: "/upgrade-v1" },
        ],
      },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/erolsenol/image-craft-service",
      },
    ],
    footer: { message: "MIT licensed open source software." },
  },
});
