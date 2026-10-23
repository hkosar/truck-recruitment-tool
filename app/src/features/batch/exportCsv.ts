import { ApiError, currentCsrfToken, loadSession } from '../../lib/api';

export interface CsvDownload { blob: Blob; rows: number; excluded: number }

/** Asks the server for the CSV of these carriers. The server drops do-not-contact carriers and logs the export. */
export async function fetchBatchCsv(batchId: string, dots: number[] | null): Promise<CsvDownload> {
  if (!currentCsrfToken()) await loadSession();
  const response = await fetch(`/api/batches/${batchId}/export-csv`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/csv', 'x-csrf-token': currentCsrfToken() ?? '' },
    body: JSON.stringify({ dots }),
  });
  if (response.status === 401) {
    window.location.assign('/signin');
    throw new ApiError(401, 'signed_out');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'error');
  }
  return {
    blob: await response.blob(),
    rows: Number(response.headers.get('x-export-rows') ?? 0),
    excluded: Number(response.headers.get('x-export-excluded') ?? 0),
  };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
