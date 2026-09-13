import { z } from "zod";
import { parseJsonInput } from "./validate.ts";

const fieldSpecSchema = z.union(
  [
    z.string().transform((selector) => ({ selector, attr: undefined, all: false })),
    z
      .strictObject({
        selector: z.string().optional(),
        attr: z.string().optional(),
        all: z.boolean().optional(),
      })
      .transform(({ selector, attr, all }) => ({ selector, attr, all: all === true })),
  ],
  { error: "must be a selector string or an object with selector, attr, all" },
);

const extractSchemaSchema = z.strictObject({
  rows: z.string().min(1, "must be a CSS selector string").optional(),
  fields: z
    .record(z.string(), fieldSpecSchema)
    .refine((fields) => Object.keys(fields).length > 0, "needs at least one field"),
  limit: z.int().positive().optional(),
});

export type ExtractSchema = z.infer<typeof extractSchemaSchema>;
export type FieldSpec = ExtractSchema["fields"][string];

const schemaHint = `{"rows": "li.item", "fields": {"title": "h2", "link": {"selector": "a", "attr": "href"}, "tags": {"selector": ".tag", "all": true}}}`;

// Validated in the daemon before it touches the page, so a typo names the field instead of returning nulls.
export function parseExtractSchema(raw: string): ExtractSchema {
  return parseJsonInput(extractSchemaSchema, raw, "extract schema", schemaHint);
}

// Runs inside the page, so it can only use what it is passed. A missing element gives null; href and src
// resolve against the document so rows carry absolute URLs.
export function extractRowsInPage(root: Element, schema: ExtractSchema): Array<Record<string, unknown>> {
  const rowElements = schema.rows === undefined ? [root] : [...root.querySelectorAll(schema.rows)];
  const limited = schema.limit === undefined ? rowElements : rowElements.slice(0, schema.limit);

  const valueOf = (element: Element, spec: FieldSpec): string | null => {
    if (spec.attr === undefined) {
      const text = element instanceof HTMLElement ? element.innerText : element.textContent;
      return (text ?? "").replace(/\s+/g, " ").trim();
    }
    const attribute = element.getAttribute(spec.attr);
    if (attribute === null) return null;
    if (spec.attr === "href" || spec.attr === "src") {
      try {
        return new URL(attribute, element.ownerDocument.baseURI).href;
      } catch {
        return attribute;
      }
    }
    return attribute;
  };

  return limited.map((row) => {
    const record: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (spec.all) {
        const matches = spec.selector === undefined ? [row] : [...row.querySelectorAll(spec.selector)];
        record[name] = matches.map((element) => valueOf(element, spec)).filter((value) => value !== null);
      } else {
        const element = spec.selector === undefined ? row : row.querySelector(spec.selector);
        record[name] = element === null ? null : valueOf(element, spec);
      }
    }
    return record;
  });
}
