/**
 * A small, strict interpreter for the JSON Schema subset the pack schema uses (draft 2020-12 keywords): `type`, `const`,
 * `enum`, `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`, `properties`, `required`, `additionalProperties`,
 * `propertyNames`, `minProperties`/`maxProperties`, `items`, `minItems`/`maxItems`, `uniqueItems`, `oneOf` and local `$ref`
 * (`#/$defs/<name>`). A `oneOf` whose branches all pin `properties.<key>.const` is resolved by that discriminator, so an
 * unknown or misspelt operation gets one clear message instead of one per branch.
 */
export interface Schema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
  title?: string;
  description?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  const?: string | number | boolean;
  enum?: readonly (string | number | boolean)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  minProperties?: number;
  maxProperties?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: readonly Schema[];
}

export interface SchemaIssue {
  /** JSON pointer of the offending value ('' = the document). */
  path: string;
  message: string;
}

const MAX_ISSUES = 50;
const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
const isObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object';
const escapePtr = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Validates `value` against `schema` (whose `$defs` resolve `$ref`s); returns every issue found, empty when valid. */
export function validateSchema(schema: Schema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: string, message: string): void => { if (issues.length < MAX_ISSUES) issues.push({ path, message }); };
  const resolve = (s: Schema): Schema => {
    if (s.$ref === undefined) return s;
    const name = /^#\/\$defs\/(.+)$/.exec(s.$ref)?.[1];
    const target = name === undefined ? undefined : schema.$defs?.[name];
    if (!target) throw new Error(`unresolvable $ref ${s.$ref}`);
    return resolve(target);
  };
  const walk = (raw: Schema, v: unknown, path: string, out: (path: string, message: string) => void): void => {
    const s = resolve(raw);
    const kind = kindOf(v);
    if (s.type !== undefined && kind !== s.type && !(s.type === 'number' && kind === 'integer')) {
      out(path, `must be ${s.type === 'integer' || s.type === 'array' || s.type === 'object' ? 'an' : 'a'} ${s.type}, not ${kind}`);
      return;
    }
    if (s.const !== undefined && v !== s.const) out(path, `must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v as string)) out(path, `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (typeof v === 'string') {
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) out(path, `must be at least ${s.minLength} characters long`);
      if (s.maxLength !== undefined && len > s.maxLength) out(path, `must be at most ${s.maxLength} characters long`);
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) out(path, `must match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) out(path, `must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) out(path, `must be <= ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) out(path, `must have at least ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) { out(path, `must have at most ${s.maxItems} items`); return; }
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) out(path, 'must not contain duplicates');
      if (s.items) v.forEach((x, i) => walk(s.items!, x, `${path}/${i}`, out));
    }
    if (isObject(v)) {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) out(path, `must have at least ${s.minProperties} properties`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) { out(path, `must have at most ${s.maxProperties} properties`); return; }
      for (const r of s.required ?? []) if (!(r in v)) out(path, `is missing required property "${r}"`);
      for (const k of keys) {
        const p = `${path}/${escapePtr(k)}`;
        if (s.propertyNames) walk(s.propertyNames, k, p, (pp, m) => out(pp, `name ${m}`));
        const prop = s.properties?.[k];
        if (prop) walk(prop, v[k], p, out);
        else if (s.additionalProperties === false) out(p, 'is not an allowed property');
        else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, v[k], p, out);
      }
    }
    if (s.oneOf) oneOf(s.oneOf.map(resolve), v, path, out);
  };
  const oneOf = (branches: Schema[], v: unknown, path: string, out: (path: string, message: string) => void): void => {
    const disc = discriminator(branches);
    if (disc !== undefined && isObject(v)) {
      const tag = v[disc];
      const hit = branches.find((b) => b.properties![disc]!.const === tag);
      if (!hit) {
        const names = branches.map((b) => JSON.stringify(b.properties![disc]!.const)).join(', ');
        out(`${path}/${escapePtr(disc)}`, `must be one of ${names}`);
        return;
      }
      walk(hit, v, path, out);
      return;
    }
    const passing = branches.filter((b) => {
      let ok = true;
      walk(b, v, path, () => { ok = false; });
      return ok;
    });
    if (passing.length !== 1) out(path, passing.length === 0 ? 'does not match any allowed form' : 'matches more than one allowed form');
  };
  walk(schema, value, '', add);
  return issues;
}

/** The property every branch pins with `const` (all branches must be objects), if any. */
function discriminator(branches: Schema[]): string | undefined {
  const first = branches[0]?.properties;
  if (!first) return undefined;
  return Object.keys(first).find((k) => branches.every((b) => b.type === 'object' && b.properties?.[k]?.const !== undefined));
}
