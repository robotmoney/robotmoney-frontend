// A small JSON Schema checker for the contract's response schemas (issue
// #1095). It covers exactly the keywords contract/src/schemas/*.schema.json use:
// type (one name or a list), const, enum, required, properties,
// additionalProperties: false, items, minimum, maximum, exclusiveMinimum,
// pattern and format: date-time. A schema using a keyword outside that list
// throws, so a schema edit that outgrows this checker fails loudly instead of
// validating nothing.
const KNOWN = new Set([
  "$schema", "$id", "title", "description", "type", "const", "enum", "required", "properties",
  "additionalProperties", "items", "minimum", "maximum", "exclusiveMinimum", "pattern", "format",
]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validateJsonSchema(schema: Record<string, any>, value: unknown, at = "$"): string[] {
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) throw new Error(`json-schema checker: unsupported keyword ${JSON.stringify(k)} at ${at}`);
  }
  const errors: string[] = [];
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return [`${at}: expected ${allowed.join("|")}, got ${actual}`];
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${at}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !(/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)))) {
      errors.push(`${at}: ${JSON.stringify(value)} is not a date-time`);
    }
  }
  if (actual === "array" && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validateJsonSchema(schema.items, item, `${at}[${i}]`)));
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at}: missing required ${key}`);
    const props: Record<string, any> = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) errors.push(...validateJsonSchema(props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`);
    }
  }
  return errors;
}
