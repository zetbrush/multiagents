/**
 * Dashboard translations: every literal tr() key in app.js has a Chinese
 * entry, and server-generated text (activity titles, toasts) is matched by
 * the pattern rules.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "dashboard");

async function loadI18n(lang: string) {
  const src = await Bun.file(join(DIR, "i18n.js")).text();
  const localStorage = { getItem: () => lang, setItem: () => {} };
  const navigator = { language: "en-US" };
  return new Function("localStorage", "navigator", `${src}\nreturn { tr, ZH, getLang, setLang, locale };`)(localStorage, navigator) as {
    tr: (en: string, vars?: Record<string, unknown>) => string;
    ZH: Record<string, string>;
    getLang: () => string;
    setLang: (l: string) => void;
    locale: () => string;
  };
}

/** String literals passed straight to tr(), plus the label strings app.js translates indirectly. */
async function appKeys(): Promise<string[]> {
  const js = await Bun.file(join(DIR, "app.js")).text();
  const keys = new Set<string>();
  for (const m of js.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
  for (const m of js.matchAll(/\b(?:label|submitLabel|confirmLabel|title): "((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
  for (const m of js.matchAll(/\brun\([^,]+, "((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
  return [...keys];
}

describe("dashboard i18n", () => {
  test("every UI string app.js translates has a Chinese entry", async () => {
    const { ZH } = await loadI18n("zh");
    const missing = (await appKeys()).filter((k) => !(k in ZH));
    expect(missing).toEqual([]);
  });

  test("plan-limit notes and window labels from the server are translated", async () => {
    const { tr } = await loadI18n("zh");
    const src = await Bun.file(join(DIR, "..", "orchestrator", "plan-usage.ts")).text();
    const texts = [
      ...[...src.matchAll(/note: (?:[^"\n]*\? )?"([^"]+)"/g)].map((m) => m[1]!),
      ...[...src.matchAll(/\["\w+", "([A-Z0-9][^"]+)"\]/g)].map((m) => m[1]!),
      "Weekly · Fable", "Daily · gemini-2.5-pro", "8-hour window", "42 / 100 left",
    ];
    expect(texts.length).toBeGreaterThan(15);
    const untranslated = texts.filter((t) => tr(t) === t);
    expect(untranslated).toEqual([]);
  });

  test("placeholders survive translation and English passes through", async () => {
    const zh = await loadI18n("zh");
    expect(zh.tr("Release {name}?", { name: "Claude" })).toBe("释放 Claude？");
    expect(zh.tr("some unknown text")).toBe("some unknown text");
    expect(zh.locale()).toBe("zh-CN");
    const en = await loadI18n("en");
    expect(en.tr("Release {name}?", { name: "Claude" })).toBe("Release Claude?");
    expect(en.locale()).toBe("en-US");
  });

  test("server-generated activity titles and messages are matched", async () => {
    const { tr } = await loadI18n("zh");
    expect(tr("Waiting for approval · Edit src/app.ts")).toBe("等待批准 · 编辑 src/app.ts");
    expect(tr("Result · Read README.md")).toBe("结果 · 读取 README.md");
    expect(tr("Turn finished · $0.0123 so far")).toBe("本轮结束 · 累计 $0.0123");
    expect(tr("Session started · default model")).toBe("会话已启动 · 默认模型");
    expect(tr("token limit reached (1,200 / 1,000)")).toBe("token 达到上限（1,200 / 1,000）");
    expect(tr("Broadcast to 3 agent(s)")).toBe("已广播给 3 个 agent");
    expect(tr("Paused 2 agents")).toBe("已暂停 2 个 agent");
  });

  test("the language choice is remembered", async () => {
    const i18n = await loadI18n("en");
    i18n.setLang("zh");
    expect(i18n.getLang()).toBe("zh");
    i18n.setLang("xx");
    expect(i18n.getLang()).toBe("zh");
  });
});
