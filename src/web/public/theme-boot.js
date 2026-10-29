// 首屏應用主題，避免閃爍（v0.11.0；v0.24.0 支援四套主題）。
// 獨立檔案而不是內聯指令碼：CSP 用 script-src 'self'，不需要 unsafe-inline。
try {
  var META = {
    dark: { cls: "", scheme: "dark", color: "#17171a" },
    light: { cls: "theme-light", scheme: "light", color: "#f7f8fa" },
    sepia: { cls: "theme-sepia", scheme: "light", color: "#fcf8ec" },
    midnight: { cls: "theme-midnight", scheme: "dark", color: "#0b1220" }
  };
  var param = new URLSearchParams(location.search).get("theme");
  var saved = param || localStorage.getItem("pi-theme") || "light";
  if (saved === "system") {
    saved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  var meta = META[saved] || META.light;
  if (meta.cls) document.documentElement.classList.add(meta.cls);
  document.querySelector('meta[name="color-scheme"]').content = meta.scheme;
  document.querySelector('meta[name="theme-color"]').content = meta.color;
} catch (e) {}
