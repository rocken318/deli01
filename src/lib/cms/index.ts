/**
 * CMS サーバー関数エントリ（server-only）。
 * src/domain/cms/ は純粋関数・型。DB 操作はここ。
 */

export { getFieldDefinitions } from "./get-field-definitions";
export { getEntityRecord } from "./get-entity-record";
export {
  addFieldDefinition,
  updateFieldDefinition,
  toggleFieldVisibility,
  reorderFieldDefinitions,
  saveEntityRecord,
  publishEntityRecord,
} from "./actions";
export type { ActionResult } from "./actions";
