import { encodeAnnotationData } from '../schema/rows';

let nextId = 0;

/** A stored row as the local SQLite holds it (`data` as JSON text), for tests. */
export function storedRow(z: number, annotation: Parameters<typeof encodeAnnotationData>[0]) {
  return {
    id: `019a7a2e-1c2d-7e3f-8a4b-${String(++nextId).padStart(12, '0')}`,
    owner_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0e',
    score_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
    layer_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0d',
    page_index: 0,
    type: annotation.type,
    data: JSON.stringify(encodeAnnotationData(annotation)),
    z,
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    deleted_at: null,
  };
}
