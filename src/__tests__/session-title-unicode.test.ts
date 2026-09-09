/**
 * A generated session title must survive every language Atlarix ships.
 *
 * Found 2026-09-08, immediately after the response-language setting landed. The
 * sanitiser used `[^\w\s-]`, and JavaScript's `\w` without the `u` flag is exactly
 * `[A-Za-z0-9_]` — so every other script was replaced with spaces. Four of the
 * thirteen locales collapsed to whatever Latin identifier happened to be in the
 * title; Turkish and German were mangled MID-WORD, which is worse because the
 * result looks like a title rather than like a failure.
 *
 * It was harmless until the app started asking the model to reply in Russian.
 * That is the shape worth remembering: a latent ASCII assumption is invisible
 * until something upstream stops speaking ASCII.
 */
import { describe, expect, it } from "vitest";
import { extractAtlarixChatSummary } from "@/lib/workspace-session-title";
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales";

const wrap = (t: string) =>
  extractAtlarixChatSummary(
    `<atlarix-chat-summary>${t}</atlarix-chat-summary>`,
  );

describe("session titles survive non-ASCII scripts", () => {
  it("keeps Cyrillic", () => {
    expect(wrap("Добавить gitignore и удалить секреты")).toBe(
      "Добавить gitignore и удалить секреты",
    );
  });

  it("keeps Simplified Chinese", () => {
    expect(wrap("添加 gitignore 并删除密钥")).toBe("添加 gitignore 并删除密钥");
  });

  it("keeps Japanese", () => {
    expect(wrap("gitignore を追加して秘密を削除")).toBe(
      "gitignore を追加して秘密を削除",
    );
  });

  it("keeps Korean", () => {
    expect(wrap("gitignore 추가 및 비밀 제거")).toBe(
      "gitignore 추가 및 비밀 제거",
    );
  });

  it("keeps Devanagari", () => {
    expect(wrap("gitignore जोड़ें और रहस्य हटाएं")).toBe(
      "gitignore जोड़ें और रहस्य हटाएं",
    );
  });

  it("keeps Turkish dotless i and cedillas — the MID-WORD case", () => {
    // Was "gitignore ekle ve s rlar kald": ı and ı stripped from inside words,
    // so the damage read as a title instead of as a failure.
    expect(wrap("gitignore ekle ve sırları kaldır")).toBe(
      "gitignore ekle ve sırları kaldır",
    );
  });

  it("keeps German umlauts", () => {
    expect(wrap("Füge gitignore hinzu")).toBe("Füge gitignore hinzu");
  });

  it("keeps Polish diacritics", () => {
    expect(wrap("Dodaj gitignore i usuń sekrety")).toBe(
      "Dodaj gitignore i usuń sekrety",
    );
  });

  it("still strips punctuation and emoji, which is what the class was for", () => {
    expect(wrap("Fix the bug! 🎉 (urgent) — really")).toBe(
      "Fix the bug urgent really",
    );
  });

  it("keeps hyphens and underscores", () => {
    expect(wrap("wire-up the auth_flow")).toBe("wire-up the auth_flow");
  });

  it("English behaviour is unchanged", () => {
    expect(wrap("Add gitignore and remove secrets")).toBe(
      "Add gitignore and remove secrets",
    );
  });

  it("no shipped locale can be reduced to nothing", () => {
    // Table-driven over the real locale list, so adding a locale without a
    // script-compatible sanitiser fails here rather than in a user's sidebar.
    const samples: Record<string, string> = {
      "en-us": "Add gitignore and remove secrets",
      "zh-hans": "添加 gitignore 并删除密钥",
      fr: "Ajouter gitignore et supprimer les secrets",
      de: "Füge gitignore hinzu",
      hi: "gitignore जोड़ें और रहस्य हटाएं",
      it: "Aggiungi gitignore e rimuovi i segreti",
      ja: "gitignore を追加して秘密を削除",
      ko: "gitignore 추가 및 비밀 제거",
      pl: "Dodaj gitignore i usuń sekrety",
      "pt-br": "Adicionar gitignore e remover segredos",
      ru: "Добавить gitignore и удалить секреты",
      es: "Añadir gitignore y eliminar secretos",
      tr: "gitignore ekle ve sırları kaldır",
    };
    for (const locale of SUPPORTED_LOCALES) {
      const sample = samples[locale];
      expect(sample, `no sample for ${locale}`).toBeDefined();
      const out = wrap(sample!);
      expect(out, `${locale} produced no title`).not.toBeNull();
      // And not merely non-null — it must not have been reduced to the one
      // Latin token that happened to be in it.
      expect(out!.length, `${locale} was gutted to "${out}"`).toBeGreaterThan(
        "gitignore".length,
      );
    }
  });
});
