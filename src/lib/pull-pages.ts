// Paged pulls for sync (QA H2, 26 Nov 2026).
//
// Supabase's Data API returns at most "Max rows" rows per request (1000 on Bebig's project, checked 27 Nov), whatever
// `limit` asks for. The old pull asked for 5000 from (cursor - 5 min) every time, so if more than 1000 rows changed
// within 5 minutes the same first page came back on every sync and the rest never reached that phone.
//
// Now each table is read in pages of PAGE rows ordered by (server_updated_at, id). The first page still starts
// OVERLAP_MS before the saved cursor: server_updated_at is the time a change's transaction started, so a change that
// commits late can carry a time just before rows this phone has already seen. Later pages continue strictly after the
// last row of the page before, by time and then id, so rows with the same time are never skipped or repeated, and a
// page is only "the last one" when it comes back short.
//
// A table that still has more after MAX_PAGES pages is reported as not complete: the caller keeps the rows it got,
// doesn't mark the phone as up to date, and syncs again straight away.

export const PAGE = 1000; // must not be more than the project's Max rows (Dashboard → Project Settings → Data API)
export const MAX_PAGES = 50;
export const OVERLAP_MS = 5 * 60000;

type Row = { server_updated_at: string; [k: string]: any };

/** PostgREST filter for one page, after `order=server_updated_at.asc,<id>.asc&limit=PAGE`. */
export function pageFilter(idCol: string, cursor: string | undefined, after: Row | null): string {
  if (after) {
    // values are quoted because timestamps contain ':' and '.', which PostgREST reserves inside or=(...)
    const ts = `"${after.server_updated_at}"`; const id = `"${after[idCol]}"`;
    return `&or=${encodeURIComponent(`(server_updated_at.gt.${ts},and(server_updated_at.eq.${ts},${idCol}.gt.${id}))`)}`;
  }
  if (!cursor) return '';
  return `&server_updated_at=gt.${encodeURIComponent(new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString())}`;
}

export function pageQuery(table: string, idCol: string, cursor: string | undefined, after: Row | null): string {
  return `${table}?select=*${pageFilter(idCol, cursor, after)}&order=server_updated_at.asc,${idCol}.asc&limit=${PAGE}`;
}

/** Reads every changed row of one table, page by page. `get` runs one REST GET for a query string. */
export async function fetchAllPages(get: (query: string) => Promise<Row[]>, table: string, idCol: string, cursor: string | undefined): Promise<{ rows: Row[]; complete: boolean }> {
  const rows: Row[] = [];
  let after: Row | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got: Row[] = (await get(pageQuery(table, idCol, cursor, after))) || [];
    rows.push(...got);
    if (got.length < PAGE) return { rows, complete: true };
    after = got[got.length - 1];
  }
  return { rows, complete: false };
}
