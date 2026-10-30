import { Inbox, LoaderCircle, RefreshCw, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  exportInquiriesCsv,
  getInquiryStats,
  listInquiries,
  updateInquiryStatus,
} from '../api/inquiries.api.js';
import { ActiveFilters } from '../components/dashboard/ActiveFilters.jsx';
import { CategoryBreakdown } from '../components/dashboard/CategoryBreakdown.jsx';
import { DashboardToolbar } from '../components/dashboard/DashboardToolbar.jsx';
import { ExportButton } from '../components/dashboard/ExportButton.jsx';
import { InquiryDetailsDrawer } from '../components/dashboard/InquiryDetailsDrawer.jsx';
import { InquiryTable } from '../components/dashboard/InquiryTable.jsx';
import { Pagination } from '../components/dashboard/Pagination.jsx';
import { SummaryCards } from '../components/dashboard/SummaryCards.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { Button } from '../components/ui/Button.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { PAGE_SIZE, useInquiryQuery } from '../hooks/useInquiryQuery.js';
import { describeApiError } from '../lib/apiErrors.js';
import { saveTextFile } from '../lib/download.js';

export const SEARCH_DEBOUNCE_MS = 300;

const plural = (count, word) =>
  `${count} ${count === 1 ? word : `${word === 'inquiry' ? 'inquiries' : `${word}s`}`}`;

/**
 * "Showing 1–20 of 57 inquiries", or with filters
 * "Showing 1–8 of 8 matching inquiries (26 in total)".
 */
function ResultSummary({ meta, loading, filtered, overallTotal }) {
  if (!meta) return null;
  const { total, page, pageSize } = meta;
  const first = total === 0 ? 0 : Math.min((page - 1) * pageSize + 1, total);
  const last = Math.min(page * pageSize, total);
  const noun = filtered
    ? `matching ${total === 1 ? 'inquiry' : 'inquiries'}`
    : total === 1
      ? 'inquiry'
      : 'inquiries';
  const ofAll =
    filtered && typeof overallTotal === 'number'
      ? ` (${plural(overallTotal, 'inquiry')} in total)`
      : '';
  return (
    <p className="result-summary" aria-live="polite">
      {loading && <LoaderCircle className="result-summary__spinner spin" aria-hidden="true" />}
      <span>
        {total === 0
          ? `No ${filtered ? 'matching inquiries' : 'inquiries'}${ofAll}`
          : first > total
            ? `${total} ${noun}${ofAll}`
            : `Showing ${first}–${last} of ${total} ${noun}${ofAll}`}
      </span>
    </p>
  );
}

export function AdminDashboardPage() {
  const { query, hasFilters, update, resetFilters } = useInquiryQuery();

  // The search box updates immediately; the URL (and API call) follow after a pause.
  const [searchText, setSearchText] = useState(query.search);
  const [lastUrlSearch, setLastUrlSearch] = useState(query.search);
  if (query.search !== lastUrlSearch) {
    // URL changed elsewhere (reset, back button): mirror it in the box.
    setLastUrlSearch(query.search);
    setSearchText(query.search);
  }
  const debouncedSearch = useDebouncedValue(searchText, SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    // Only act once typing has settled on what is in the box; otherwise a
    // stale debounced value could undo a reset or a back-button change.
    if (debouncedSearch !== searchText) return;
    const trimmed = debouncedSearch.trim();
    if (trimmed !== query.search) update({ search: trimmed }, { replace: true });
  }, [debouncedSearch, searchText, query.search, update]);

  const apiParams = useMemo(
    () => ({
      page: query.page,
      pageSize: PAGE_SIZE,
      search: query.search,
      category: query.category,
      userType: query.userType,
      status: query.status,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    }),
    [query],
  );

  const [reloadCount, setReloadCount] = useState(0);
  const requestKey = `${JSON.stringify(apiParams)}#${reloadCount}`;
  const [result, setResult] = useState({ key: null, inquiries: [], meta: null, error: null });
  const loading = result.key !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    listInquiries(apiParams, { signal: controller.signal }).then(
      ({ inquiries, meta }) => setResult({ key: requestKey, inquiries, meta, error: null }),
      (error) => {
        if (error?.name === 'CanceledError') return;
        setResult((previous) => ({ ...previous, key: requestKey, error }));
      },
    );
    return () => controller.abort();
  }, [apiParams, requestKey]);

  // Totals for the summary cards and category chart (aggregated by the API).
  const [statsVersion, setStatsVersion] = useState(0);
  const [stats, setStats] = useState({ version: null, data: null, error: null });
  const statsLoading = stats.version !== statsVersion;
  useEffect(() => {
    const controller = new AbortController();
    getInquiryStats({ signal: controller.signal }).then(
      (data) => setStats({ version: statsVersion, data, error: null }),
      (error) => {
        if (error?.name === 'CanceledError') return;
        setStats((previous) => ({ ...previous, version: statsVersion, error }));
      },
    );
    return () => controller.abort();
  }, [statsVersion]);
  const refreshStats = () => setStatsVersion((version) => version + 1);

  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    setNotice(null);
    try {
      const { sortBy, sortDir, search, category, userType, status } = query;
      const { csv, filename, rowCount } = await exportInquiriesCsv({
        search,
        category,
        userType,
        status,
        sortBy,
        sortDir,
      });
      saveTextFile(csv, filename);
      setNotice({
        variant: 'success',
        text:
          rowCount === null
            ? `Exported ${filename}.`
            : `Exported ${plural(rowCount, 'inquiry')} to ${filename}.`,
      });
    } catch (error) {
      setNotice({
        variant: 'error',
        text: `The export failed. ${describeApiError(error, 'export')}`,
      });
    } finally {
      setExporting(false);
    }
  }

  const [pendingStatus, setPendingStatus] = useState({});
  const [notice, setNotice] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const tableTopRef = useRef(null);

  function handleDetailChanged(updated) {
    setResult((previous) => ({
      ...previous,
      inquiries: previous.inquiries.map((row) =>
        row.id === updated.id ? { ...row, ...updated } : row,
      ),
    }));
    refreshStats();
  }

  async function handleStatusChange(inquiry, status) {
    if (status === inquiry.status) return;
    setNotice(null);
    setPendingStatus((current) => ({ ...current, [inquiry.id]: status }));
    try {
      const updated = await updateInquiryStatus(inquiry.id, status);
      setResult((previous) => ({
        ...previous,
        inquiries: previous.inquiries.map((row) =>
          row.id === updated.id ? { ...row, ...updated } : row,
        ),
      }));
      setNotice({
        variant: 'success',
        text: `Status for ${inquiry.name} changed from ${inquiry.status} to ${updated.status}.`,
      });
      refreshStats();
    } catch (error) {
      setNotice({
        variant: 'error',
        text: `The status for ${inquiry.name} was not changed. ${describeApiError(error, 'status')}`,
      });
    } finally {
      setPendingStatus(({ [inquiry.id]: _done, ...rest }) => rest);
    }
  }

  function goToPage(page) {
    update({ page });
    tableTopRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  function handleReset() {
    setSearchText('');
    resetFilters();
  }

  function removeFilter(key) {
    if (key === 'search') setSearchText('');
    update({ [key]: '' });
  }

  const { inquiries, meta, error } = result;
  const firstLoad = loading && !meta && !error;
  const showError = error && !loading;
  const pastLastPage = meta && meta.total > 0 && inquiries.length === 0 && query.page > 1;

  let body;
  if (firstLoad) {
    body = (
      <div className="panel-state" role="status">
        <LoaderCircle className="panel-state__icon spin" aria-hidden="true" />
        <p>Loading inquiries…</p>
      </div>
    );
  } else if (showError) {
    body = (
      <div className="panel-state">
        <Alert variant="error" title="Inquiries could not be loaded">
          {describeApiError(error, 'list')}
        </Alert>
        <Button icon={RefreshCw} onClick={() => setReloadCount((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  } else if (meta && meta.total === 0 && !hasFilters) {
    body = (
      <div className="panel-state">
        <Inbox className="panel-state__icon" aria-hidden="true" />
        <h2 className="panel-state__title">No inquiries yet</h2>
        <p className="muted">Inquiries submitted through the public form will appear here.</p>
        <Link to="/" className="btn btn--secondary btn--md">
          Open the inquiry form
        </Link>
      </div>
    );
  } else if (meta && meta.total === 0) {
    body = (
      <div className="panel-state">
        <SearchX className="panel-state__icon" aria-hidden="true" />
        <h2 className="panel-state__title">No inquiries match your filters</h2>
        <p className="muted">Try a different search, or reset the filters to see everything.</p>
        <Button variant="secondary" onClick={handleReset}>
          Reset filters
        </Button>
      </div>
    );
  } else if (pastLastPage) {
    body = (
      <div className="panel-state">
        <SearchX className="panel-state__icon" aria-hidden="true" />
        <h2 className="panel-state__title">This page is past the end of the results</h2>
        <Button variant="secondary" onClick={() => goToPage(meta.totalPages)}>
          Go to page {meta.totalPages}
        </Button>
      </div>
    );
  } else if (meta) {
    body = (
      <>
        <InquiryTable
          inquiries={inquiries}
          sortBy={query.sortBy}
          sortDir={query.sortDir}
          onSort={(sortBy, sortDir) => update({ sortBy, sortDir })}
          pendingStatus={pendingStatus}
          onStatusChange={handleStatusChange}
          onSelect={(inquiry) => setSelectedId(inquiry.id)}
          activeId={selectedId}
          busy={loading}
        />
        <Pagination
          page={meta.page}
          totalPages={meta.totalPages}
          hasPreviousPage={meta.hasPreviousPage}
          hasNextPage={meta.hasNextPage}
          onPageChange={goToPage}
          disabled={loading}
        />
      </>
    );
  }

  return (
    <div className="container page">
      <header className="page__header">
        <h1>Inquiries</h1>
        <p className="muted">
          Inquiries submitted through the public form. Search, filter and update their status.
        </p>
      </header>

      <section className="overview" aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="visually-hidden">
          Overview
        </h2>
        {stats.error && !statsLoading ? (
          <Alert variant="error" title="Totals could not be loaded" className="overview__error">
            <span>{describeApiError(stats.error, 'stats')} </span>
            <button type="button" className="link-button" onClick={refreshStats}>
              Try again
            </button>
          </Alert>
        ) : (
          <>
            <SummaryCards
              stats={stats.data}
              loading={statsLoading}
              activeStatus={query.status}
              onSelectStatus={(status) => update({ status })}
            />
            <div className="card overview__chart">
              <CategoryBreakdown
                stats={stats.data}
                activeCategory={query.category}
                onSelectCategory={(category) => update({ category })}
              />
            </div>
          </>
        )}
      </section>

      {selectedId && (
        <InquiryDetailsDrawer
          inquiryId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={handleDetailChanged}
          onNotice={setNotice}
        />
      )}

      <section className="card dashboard-card" aria-labelledby="inquiries-heading">
        <h2 id="inquiries-heading" className="visually-hidden">
          Inquiry list
        </h2>
        <DashboardToolbar
          searchText={searchText}
          onSearchTextChange={setSearchText}
          category={query.category}
          onCategoryChange={(category) => update({ category })}
          userType={query.userType}
          onUserTypeChange={(userType) => update({ userType })}
          hasFilters={hasFilters || searchText.trim() !== ''}
          onReset={handleReset}
        />

        <ActiveFilters query={query} onRemove={removeFilter} onClearAll={handleReset} />

        <div ref={tableTopRef} className="dashboard-card__status">
          <div className="results-bar">
            <ResultSummary
              meta={showError ? null : meta}
              loading={loading && !firstLoad}
              filtered={hasFilters}
              overallTotal={stats.data?.total}
            />
            <ExportButton
              onExport={handleExport}
              exporting={exporting}
              disabled={!meta || meta.total === 0 || showError}
            />
          </div>
          <div aria-live="polite">
            {notice && (
              <Alert variant={notice.variant} className="notice">
                <span>{notice.text}</span>
                <button
                  type="button"
                  className="notice__close"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss message"
                >
                  <X aria-hidden="true" />
                </button>
              </Alert>
            )}
          </div>
        </div>

        {body}
      </section>
    </div>
  );
}
