import { ApiError, apiClient } from './client.js';

/**
 * POST /api/inquiries. Resolves only when the backend confirms the inquiry
 * was stored (201) or already exists (200, duplicate); anything else rejects.
 *
 * @returns {Promise<{ id: string, duplicate: boolean, message: string }>}
 */
export async function submitInquiry(values, { signal } = {}) {
  const { data } = await apiClient.post('/inquiries', values, { signal });
  const id = data?.data?.id;
  if (data?.success !== true || typeof id !== 'string' || id.length === 0) {
    throw new ApiError(
      'The server did not confirm that your inquiry was saved. Please try again.',
      { code: 'UNCONFIRMED' },
    );
  }
  return { id, duplicate: data.data.duplicate === true, message: data.message };
}

/** Drops empty values so the URL sent to the API only carries real filters. */
function compact(params) {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    ),
  );
}

/**
 * GET /api/inquiries (admin). Filtering, search, sorting and pagination all
 * happen on the server.
 *
 * @returns {Promise<{ inquiries: object[], meta: object }>}
 */
export async function listInquiries(params, { signal } = {}) {
  const { data } = await apiClient.get('/inquiries', { params: compact(params), signal });
  if (data?.success !== true || !Array.isArray(data.data) || !data.meta) {
    throw new ApiError('Unexpected response from the server.', { code: 'BAD_RESPONSE' });
  }
  return { inquiries: data.data, meta: data.meta };
}

/** PATCH /api/inquiries/:id/status (admin). Resolves with the updated inquiry. */
export async function updateInquiryStatus(id, status) {
  const { data } = await apiClient.patch(`/inquiries/${encodeURIComponent(id)}/status`, { status });
  if (data?.success !== true || data?.data?.id !== id) {
    throw new ApiError('The server did not confirm the status change.', { code: 'UNCONFIRMED' });
  }
  return data.data;
}

/** GET /api/inquiries/stats (admin): totals by status and category, computed in the database. */
export async function getInquiryStats({ signal } = {}) {
  const { data } = await apiClient.get('/inquiries/stats', { signal });
  if (data?.success !== true || typeof data?.data?.total !== 'number') {
    throw new ApiError('Unexpected response from the server.', { code: 'BAD_RESPONSE' });
  }
  return data.data;
}

/**
 * GET /api/inquiries/export (admin): the filtered inquiries as CSV text.
 * Fetched as text so an error response can still be read as JSON.
 *
 * @returns {Promise<{ csv: string, filename: string, rowCount: number | null }>}
 */
export async function exportInquiriesCsv(params) {
  const response = await apiClient.get('/inquiries/export', {
    params: compact(params),
    responseType: 'text',
  });
  const disposition = response.headers?.['content-disposition'] ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'inquiries.csv';
  const rowCount = Number.parseInt(response.headers?.['x-export-row-count'] ?? '', 10);
  return {
    csv: String(response.data ?? ''),
    filename,
    rowCount: Number.isInteger(rowCount) ? rowCount : null,
  };
}

/** GET /api/inquiries/:id (admin): inquiry, notes, assignment, follow-up and activity. */
export async function getInquiry(id, { signal } = {}) {
  const { data } = await apiClient.get(`/inquiries/${encodeURIComponent(id)}`, { signal });
  if (data?.success !== true || data?.data?.id !== id) {
    throw new ApiError('Unexpected response from the server.', { code: 'BAD_RESPONSE' });
  }
  return data.data;
}

/** POST /api/inquiries/:id/notes (admin). Returns the created note. */
export async function addInquiryNote(id, body) {
  const { data } = await apiClient.post(`/inquiries/${encodeURIComponent(id)}/notes`, { body });
  if (data?.success !== true || !data?.data?.id) {
    throw new ApiError('The server did not confirm that the note was saved.', {
      code: 'UNCONFIRMED',
    });
  }
  return data.data;
}

/** PATCH /api/inquiries/:id (admin): status, assignment, follow-up date and outcome. */
export async function updateInquiry(id, changes) {
  const { data } = await apiClient.patch(`/inquiries/${encodeURIComponent(id)}`, changes);
  if (data?.success !== true || data?.data?.id !== id) {
    throw new ApiError('The server did not confirm that the inquiry was updated.', {
      code: 'UNCONFIRMED',
    });
  }
  return data.data;
}

/** GET /api/inquiries/assignable-admins (admin). */
export async function getAssignableAdmins({ signal } = {}) {
  const { data } = await apiClient.get('/inquiries/assignable-admins', { signal });
  if (data?.success !== true || !Array.isArray(data.data)) {
    throw new ApiError('Unexpected response from the server.', { code: 'BAD_RESPONSE' });
  }
  return data.data;
}
