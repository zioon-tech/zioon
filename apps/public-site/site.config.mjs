export const site = Object.freeze({
  name: "Zioon",
  origin: "https://zioon.tech",
  language: "zh-CN",
  updated: "2026-10-28",
  description: "让 AI 工作持续下去。在 Workbench、CLI 与 API 中使用会话、工具、记忆和插件，从想法接着完成工作。",
  links: Object.freeze({
    workbench: "https://runtime.zioon.tech/",
    marketplace: "https://marketplace.zioon.tech/",
    login: "https://runtime.zioon.tech/v1/account/login?returnTo=%2F",
    account: "https://auth.zioon.tech/account",
    memory: "https://memory.zioon.tech/",
    adc: "https://adc.zioon.tech/"
  }),
  image: Object.freeze({
    file: "studio.jpg",
    source: "https://copilot-cn.bytedance.net/api/ide/v1/tool_text_to_image?prompt="
      + encodeURIComponent("Website hero banner for Zioon, a calm AI workspace product: editorial architectural photograph of a quiet contemporary creative studio, warm ivory plaster wall, a long oak desk with a closed charcoal laptop and neatly arranged sheets of paper, one sculptural wooden chair, strong afternoon sunlight falling through a large window on the far right, very spacious left two thirds filled with calm warm ivory wall and gentle shadows to allow dark website typography overlay, muted warm neutral palette, realistic material details, premium magazine photography, subtle film grain, horizontal wide angle composition, photorealistic, no people, no letters, no logos, no visible screen interface, no collage, no frames.")
      + "&image_size=landscape_16_9"
  })
});
