import type { Schema } from './json-schema';

/** Value kinds a manifest attribute can be given by a pack. */
export type AttrKind = 'string' | 'boolean' | 'integer' | 'flags' | 'platformRef';
export interface AllowedAttr { id: number; kind: AttrKind; on: readonly ('application' | 'activity')[] }

/**
 * Manifest attributes a pack may set or remove (android.R.attr ids). Anything that grants permissions, changes the
 * package identity, process, components or code loading is deliberately absent.
 */
export const PACK_MANIFEST_ATTRS: Readonly<Record<string, AllowedAttr>> = {
  label: { id: 0x01010001, kind: 'string', on: ['application', 'activity'] },
  theme: { id: 0x01010000, kind: 'platformRef', on: ['application', 'activity'] },
  launchMode: { id: 0x0101001d, kind: 'integer', on: ['activity'] },
  screenOrientation: { id: 0x0101001e, kind: 'integer', on: ['activity'] },
  configChanges: { id: 0x0101001f, kind: 'flags', on: ['activity'] },
  windowSoftInputMode: { id: 0x0101022b, kind: 'flags', on: ['activity'] },
  allowBackup: { id: 0x01010280, kind: 'boolean', on: ['application'] },
  immersive: { id: 0x010102c0, kind: 'boolean', on: ['activity'] },
  hardwareAccelerated: { id: 0x010102d3, kind: 'boolean', on: ['application', 'activity'] },
  largeHeap: { id: 0x0101035a, kind: 'boolean', on: ['application'] },
  usesCleartextTraffic: { id: 0x010104ec, kind: 'boolean', on: ['application'] },
  resizeableActivity: { id: 0x010104f6, kind: 'boolean', on: ['application', 'activity'] },
  hasFragileUserData: { id: 0x0101059a, kind: 'boolean', on: ['application'] },
  allowAudioPlaybackCapture: { id: 0x01010601, kind: 'boolean', on: ['application'] },
  requestLegacyExternalStorage: { id: 0x01010603, kind: 'boolean', on: ['application'] },
};

export const PACK_SCHEMA_VERSION = 1;
/** Hard limits; a pack beyond any of them is refused before anything is parsed further. */
export const PACK_LIMITS = {
  packBytes: 64 << 20,
  entries: 512,
  entryBytes: 32 << 20,
  totalBytes: 128 << 20,
  manifestBytes: 256 << 10,
  patches: 64,
  ops: 256,
  hexBytes: 4096,
  text: 64 << 10,
} as const;

const ident = (max: number): Schema => ({ type: 'string', pattern: `^[a-z0-9](?:[a-z0-9._-]{0,${max - 2}}[a-z0-9])?$` });
const semver: Schema = { type: 'string', pattern: '^(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})$' };
const localized = (max: number): Schema => ({
  type: 'object', required: ['en'], minProperties: 1, maxProperties: 32,
  propertyNames: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$' },
  additionalProperties: { type: 'string', minLength: 1, maxLength: max },
});
/** Path of a file inside the pack (relative, no `..`, no backslashes). */
const packFile: Schema = { type: 'string', maxLength: 240, pattern: '^(?!pack\\.json$)(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)*[A-Za-z0-9_][A-Za-z0-9._-]*$' };
/** Destination inside the APK: only assets/ and res/raw/ (checked again by safeApkPath). */
const apkFile: Schema = { type: 'string', maxLength: 240, pattern: '^(?:assets|res/raw)/(?:[A-Za-z0-9_][A-Za-z0-9 ._+-]*/)*[A-Za-z0-9_][A-Za-z0-9 ._+-]*$' };
const hex: Schema = { type: 'string', minLength: 2, maxLength: PACK_LIMITS.hexBytes * 3, pattern: '^[0-9A-Fa-f]{2}(?: ?[0-9A-Fa-f]{2})*$' };
const sha256: Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const text: Schema = { type: 'string', maxLength: PACK_LIMITS.text };
const className = '[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+';
const descriptorRe = 'L[A-Za-z_$][A-Za-z0-9_$]*(?:/[A-Za-z_$][A-Za-z0-9_$]*)*;';
const typeRe = `\\[*(?:[ZBSCIJFD]|${descriptorRe})`;
const target: Schema = {
  oneOf: [
    { type: 'string', const: 'application' },
    { type: 'object', required: ['activity'], additionalProperties: false, properties: { activity: { type: 'string', pattern: `^${className}$`, maxLength: 200 } } },
  ],
};
const scalar: Schema = { oneOf: [{ type: 'string', maxLength: 1000 }, { type: 'boolean' }, { type: 'integer', minimum: -2147483648, maximum: 4294967295 }] };
const op = (name: string, required: string[], properties: Record<string, Schema>, description: string): Schema => ({
  type: 'object', description, additionalProperties: false, required: ['op', ...required],
  properties: { op: { type: 'string', const: name }, ...properties },
});

export const PACK_OPS: readonly Schema[] = [
  op('manifest.set', ['target', 'attr', 'value'], { target, attr: { type: 'string', enum: Object.keys(PACK_MANIFEST_ATTRS) }, value: scalar },
    'Sets an allow-listed android: attribute on <application> or one top-level <activity>.'),
  op('manifest.remove', ['target', 'attr'], { target, attr: { type: 'string', enum: Object.keys(PACK_MANIFEST_ATTRS) } },
    'Removes an allow-listed android: attribute.'),
  op('file.add', ['path', 'from'], { path: apkFile, from: packFile }, 'Adds a new file under assets/ or res/raw/ (refused when one already exists with other content).'),
  op('file.replace', ['path', 'from'], { path: apkFile, from: packFile, expectSha256: sha256 },
    'Replaces an existing file under assets/ or res/raw/, optionally only when its current SHA-256 matches.'),
  op('plist.set', ['path', 'key', 'value'], { path: apkFile, key: { type: 'string', minLength: 1, maxLength: 200 }, value: scalar },
    'Sets a top-level key of an XML property list to a string, boolean or integer.'),
  op('plist.arrayInsert', ['path', 'key', 'value'], { path: apkFile, key: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', maxLength: 1000 } },
    'Appends a string to the top-level array under `key` of an XML property list (once).'),
  op('text.replace', ['path', 'find', 'replace'], { path: apkFile, find: { ...text, minLength: 1 }, replace: text },
    'Replaces the single occurrence of `find` in a UTF-8 text file.'),
  op('native.patch', ['lib', 'locate', 'expect', 'replace'], {
    lib: { type: 'string', pattern: '^lib/(?:armeabi-v7a|armeabi|arm64-v8a|x86|x86_64)/[A-Za-z0-9_.+-]+\\.so$', maxLength: 200 },
    locate: {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['symbol'], properties: { symbol: { type: 'string', pattern: '^[A-Za-z0-9_$.@]{1,512}$' }, add: { type: 'integer', minimum: -65536, maximum: 65536 } } },
        { type: 'object', additionalProperties: false, required: ['objcMethod'], properties: { objcMethod: { type: 'string', pattern: '^[+-]\\[[A-Za-z_$][A-Za-z0-9_$]* [A-Za-z_$:][A-Za-z0-9_$:]*\\]$', maxLength: 512 }, add: { type: 'integer', minimum: -65536, maximum: 65536 } } },
        { type: 'object', additionalProperties: false, required: ['vaddr'], properties: { vaddr: { type: 'integer', minimum: 0, maximum: 4294967295 } } },
        { type: 'object', additionalProperties: false, required: ['fileOffset'], properties: { fileOffset: { type: 'integer', minimum: 0, maximum: 4294967295 } } },
      ],
    },
    expect: hex, replace: hex, libSha256: sha256,
  }, 'Replaces bytes in a native library at a symbol, an Objective-C method, a virtual address or a file offset; the current bytes must equal `expect`.'),
  op('dex.add', ['from'], { from: packFile }, 'Adds a prebuilt .dex from the pack as the next classesN.dex.'),
  op('dex.hook', ['class', 'method', 'call'], {
    class: { type: 'string', pattern: `^${descriptorRe}$`, maxLength: 300 },
    method: { type: 'string', pattern: '^(?:<init>|[A-Za-z_$][A-Za-z0-9_$]*)$', maxLength: 200 },
    params: { type: 'array', maxItems: 32, items: { type: 'string', pattern: `^${typeRe}$`, maxLength: 300 } },
    returns: { type: 'string', pattern: `^(?:V|${typeRe})$`, maxLength: 300 },
    at: { type: 'string', const: 'start' },
    call: { type: 'string', pattern: `^${descriptorRe}->[A-Za-z_$][A-Za-z0-9_$]*\\((?:${descriptorRe})?\\)V$`, maxLength: 600 },
  }, 'Calls a static method of a class added by dex.add at the start of an existing method: no arguments, or the instance (`this`).'),
];

const appliesTo: Schema = {
  type: 'object', additionalProperties: false, required: ['packageName'],
  properties: {
    packageName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$', maxLength: 200 },
    versionNames: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
    versionCodes: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 4294967295 } },
    sha256: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: sha256 },
  },
};

/** JSON Schema of `pack.json` (published as docs/pack.schema.json; a test keeps the two in sync). */
export const PACK_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/Blockheads-Club/blockheads-patcher/blob/dev/docs/pack.schema.json',
  title: 'Blockheads Patcher patch pack (pack.json)',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'version', 'name', 'appliesTo', 'patches'],
  properties: {
    schemaVersion: { type: 'integer', const: PACK_SCHEMA_VERSION },
    id: ident(48),
    version: semver,
    name: localized(80),
    description: localized(2000),
    author: { type: 'string', minLength: 1, maxLength: 120 },
    minPatcherVersion: semver,
    appliesTo,
    patches: {
      type: 'array', minItems: 1, maxItems: PACK_LIMITS.patches,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'description', 'ops'],
        properties: {
          id: ident(48),
          name: localized(120),
          summary: localized(400),
          description: localized(4000),
          appliesTo,
          ops: { type: 'array', minItems: 1, maxItems: PACK_LIMITS.ops, items: { $ref: '#/$defs/op' } },
        },
      },
    },
  },
  $defs: { op: { oneOf: PACK_OPS } },
};
