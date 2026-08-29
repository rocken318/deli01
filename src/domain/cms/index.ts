/**
 * CMS ドメイン（spec 3-1）。DB にも Next.js にも依存しない純粋関数・型。
 * サーバー関数は src/lib/cms/ を使うこと。
 */

export { buildZodSchema } from "./build-zod-schema";
export type { DynamicSchema } from "./build-zod-schema";
export type {
  AddFieldInput,
  EntityRecord,
  FieldDefinition,
  FieldOptions,
  FieldType,
  UpdateFieldInput,
} from "./types";
export { FIELD_TYPES } from "./types";
