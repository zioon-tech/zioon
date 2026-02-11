export async function activate(ctx) {
  try {
    const mod = await import("../dev.sticky-user-header/main.js");
    if (typeof mod?.activate === "function") {
      await mod.activate(ctx);
    }
  } catch (e) {
    console.error("[dev.sticky-header] compatibility activate failed:", e);
  }
}

