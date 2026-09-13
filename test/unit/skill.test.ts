import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandNames, errorCodes } from "../../src/protocol.ts";

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));
// SKILL.md loads whole whenever the skill triggers; details belong in references/, read on demand.
const skillBodyBudgetBytes = 6_000;
const tableOfContentsAfterLines = 100;

function frontmatterOf(markdown: string): Record<string, string> {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (block === undefined) return {};
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

function linksIn(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((match) => match[1] ?? "");
}

// `npx skills add` discovers skills/<name>/SKILL.md, skips any file missing name or description, and
// copies the skill's folder, references included.
describe("published skills", () => {
  const skillNames = readdirSync(skillsDir);

  it("ships the patchrome skill", () => {
    expect(skillNames).toContain("patchrome");
  });

  for (const skillName of skillNames) {
    const skillDir = `${skillsDir}${skillName}/`;
    const markdown = readFileSync(`${skillDir}SKILL.md`, "utf8");
    const frontmatter = frontmatterOf(markdown);
    const referencesDir = `${skillDir}references/`;
    const referenceNames = existsSync(referencesDir) ? readdirSync(referencesDir) : [];
    const references = referenceNames.map((name) => ({
      name,
      markdown: readFileSync(`${referencesDir}${name}`, "utf8"),
    }));
    const everything = [markdown, ...references.map((reference) => reference.markdown)].join("\n");

    it(`${skillName} has the frontmatter the skills CLI requires`, () => {
      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.description?.length).toBeGreaterThan(40);
      expect(frontmatter.description?.length).toBeLessThanOrEqual(1024);
      expect(frontmatter["allowed-tools"]).toBe("Bash(patchrome:*)");
    });

    it(`${skillName} keeps SKILL.md within ${skillBodyBudgetBytes} bytes`, () => {
      expect(Buffer.byteLength(markdown.replace(/^---\n[\s\S]*?\n---\n/, ""))).toBeLessThanOrEqual(
        skillBodyBudgetBytes,
      );
    });

    it(`${skillName} links every reference from SKILL.md, one level deep`, () => {
      const linked = linksIn(markdown);
      for (const link of linked) expect(existsSync(`${skillDir}${link}`), link).toBe(true);
      expect(new Set(linked)).toEqual(new Set(referenceNames.map((name) => `references/${name}`)));
      for (const reference of references) {
        expect(linksIn(reference.markdown), reference.name).toEqual([]);
        expect(reference.markdown, reference.name).not.toMatch(/\b(?:see|read) [\w-]+\.md\b/i);
      }
    });

    it(`${skillName} gives long references a table of contents`, () => {
      for (const reference of references) {
        if (reference.markdown.split("\n").length <= tableOfContentsAfterLines) continue;
        expect(reference.markdown, reference.name).toMatch(/^# .+\n\n## Contents\n/);
      }
    });

    it(`${skillName} documents every error code in SKILL.md`, () => {
      for (const code of errorCodes) expect(markdown, code).toContain(`\`${code}\``);
    });

    it(`${skillName} documents every CLI command`, () => {
      // `network-list` is typed `network list`; `devtools-url` is one word on the command line too.
      const cliWords = new Set([
        ...commandNames.map((name) => (name === "devtools-url" ? name : name.split("-")[0])),
        "pipe",
      ]);
      for (const word of cliWords) expect(everything, word).toMatch(new RegExp(`\`${word}[ \`\\\\]`));
    });
  }
});
