import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCurrentAdmin } from '../src/api/auth.api.js';
import { ApiError } from '../src/api/client.js';
import { getInquiryStats, listInquiries, updateInquiryStatus } from '../src/api/inquiries.api.js';
import { formatDateParts, formatDateTime } from '../src/lib/format.js';
import { ADMIN, deferred, renderApp } from './helpers/renderApp.jsx';

vi.mock('../src/api/auth.api.js', () => ({
  fetchCurrentAdmin: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../src/api/inquiries.api.js', () => ({
  submitInquiry: vi.fn(),
  listInquiries: vi.fn(),
  updateInquiryStatus: vi.fn(),
  getInquiryStats: vi.fn(),
  exportInquiriesCsv: vi.fn(),
  getInquiry: vi.fn(),
  addInquiryNote: vi.fn(),
  updateInquiry: vi.fn(),
  getAssignableAdmins: vi.fn(),
}));

const row = (overrides = {}) => ({
  id: '6f1c3c1e-3f5b-4c8e-9a51-2b0b7f0e9d11',
  name: 'Asha Verma',
  email: 'asha@example.com',
  phone: '+91 98765 43210',
  userType: 'Parent',
  category: 'Admission',
  status: 'New',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...overrides,
});

const pageOf = (inquiries, meta = {}) => ({
  inquiries,
  meta: {
    page: 1,
    pageSize: 20,
    total: inquiries.length,
    totalPages: inquiries.length ? 1 : 0,
    hasPreviousPage: false,
    hasNextPage: false,
    ...meta,
  },
});

const DEFAULT_PARAMS = {
  page: 1,
  pageSize: 20,
  search: '',
  category: '',
  userType: '',
  status: '',
  sortBy: 'createdAt',
  sortDir: 'desc',
};

const lastParams = () => vi.mocked(listInquiries).mock.lastCall[0];

const STATS = {
  total: 26,
  byStatus: { New: 13, 'In Progress': 7, Resolved: 6 },
  byCategory: { Scholarship: 8, Concert: 6, Admission: 6, 'General Query': 6 },
};

beforeEach(() => {
  vi.mocked(fetchCurrentAdmin).mockResolvedValue(ADMIN);
  vi.mocked(listInquiries).mockResolvedValue(pageOf([row()]));
  vi.mocked(getInquiryStats).mockResolvedValue(STATS);
});

async function renderDashboard(url = '/admin/dashboard') {
  const utils = renderApp(url);
  await screen.findByRole('table');
  return utils;
}

describe('dashboard layout', () => {
  it('shows a loading state, then the header, session, controls and table', async () => {
    const request = deferred();
    vi.mocked(listInquiries).mockReturnValueOnce(request.promise);
    renderApp('/admin/dashboard');

    expect(await screen.findByText('Loading inquiries…')).toBeInTheDocument();
    request.resolve(pageOf([row()]));

    expect(await screen.findByRole('heading', { level: 1, name: 'Inquiries' })).toBeInTheDocument();
    const banner = within(document.querySelector('.site-header'));
    expect(banner.getByText('Signed in as')).toBeInTheDocument();
    expect(banner.getByText(ADMIN.email)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'User type' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeDisabled();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(listInquiries).toHaveBeenCalledWith(DEFAULT_PARAMS, expect.anything());
  });

  it('shows exactly the seven required columns, in order', async () => {
    await renderDashboard();
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((th) => th.textContent.replace(/,.*$/, '').trim());
    expect(headers).toEqual(['Name', 'Phone', 'Email', 'User Type', 'Category', 'Date', 'Status']);
  });

  it('shows each value and formats the date readably', async () => {
    await renderDashboard();
    const cells = within(screen.getAllByRole('row')[1]);
    expect(cells.getByRole('rowheader')).toHaveTextContent('Asha Verma');
    expect(cells.getByRole('link', { name: '+91 98765 43210' })).toHaveAttribute(
      'href',
      'tel:+919876543210',
    );
    expect(cells.getByRole('link', { name: 'asha@example.com' })).toHaveAttribute(
      'href',
      'mailto:asha@example.com',
    );
    expect(cells.getByText('Parent')).toBeInTheDocument();
    expect(cells.getByText('Admission')).toBeInTheDocument();
    const { date, time } = formatDateParts('2026-10-01T12:00:00.000Z');
    const timeElement = cells.getByText(date).closest('time');
    expect(timeElement).toHaveAttribute('dateTime', '2026-10-01T12:00:00.000Z');
    expect(timeElement).toHaveTextContent(`${date}${time}`);
    expect(timeElement).toHaveAttribute('title', formatDateTime('2026-10-01T12:00:00.000Z'));
    expect(timeElement.textContent).not.toContain('T12:00');
    expect(cells.getByRole('combobox', { name: 'Status for Asha Verma' })).toHaveValue('New');
  });

  it('handles missing and malformed values gracefully', async () => {
    vi.mocked(listInquiries).mockResolvedValue(
      pageOf([row({ phone: null, email: '', createdAt: 'not-a-date', status: undefined })]),
    );
    await renderDashboard();
    const cells = within(screen.getAllByRole('row')[1]);
    expect(cells.getAllByText('Not provided')).toHaveLength(3);
    expect(cells.getByRole('combobox', { name: /Status for/ })).toHaveValue('New');
  });

  it('summarises the visible range', async () => {
    vi.mocked(listInquiries).mockResolvedValue(
      pageOf([row()], { total: 26, totalPages: 2, hasNextPage: true }),
    );
    await renderDashboard();
    expect(screen.getByText('Showing 1–20 of 26 inquiries')).toBeInTheDocument();
  });

  it('says how many match the filters out of the overall total', async () => {
    vi.mocked(listInquiries).mockResolvedValue(pageOf([row()], { total: 8 }));
    renderApp('/admin/dashboard?category=Scholarship');
    expect(
      await screen.findByText('Showing 1–8 of 8 matching inquiries (26 inquiries in total)'),
    ).toBeInTheDocument();
  });
});

describe('filters and search (sent to the API)', () => {
  it('filters by category', async () => {
    const { user, router } = await renderDashboard();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Concert');

    await waitFor(() => expect(lastParams()).toEqual({ ...DEFAULT_PARAMS, category: 'Concert' }));
    expect(router.state.location.search).toBe('?category=Concert');
  });

  it('offers every category and user type', async () => {
    await renderDashboard();
    const options = (name) =>
      within(screen.getByRole('combobox', { name }))
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(options('Category')).toEqual([
      'All categories',
      'Scholarship',
      'Concert',
      'Admission',
      'General Query',
    ]);
    expect(options('User type')).toEqual(['All user types', 'Parent', 'Student', 'School']);
  });

  it('filters by user type', async () => {
    const { user } = await renderDashboard();
    await user.selectOptions(screen.getByRole('combobox', { name: 'User type' }), 'School');
    await waitFor(() => expect(lastParams()).toEqual({ ...DEFAULT_PARAMS, userType: 'School' }));
  });

  it('searches by name or phone after the user pauses typing', async () => {
    const { user, router } = await renderDashboard();
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), '98765 432');

    await waitFor(() => expect(lastParams().search).toBe('98765 432'));
    const searches = vi.mocked(listInquiries).mock.calls.map(([params]) => params.search);
    expect(searches).toEqual(['', '98765 432']);
    expect(router.state.location.search).toBe('?search=98765+432');
  });

  it('combines search and filters, restoring them from the URL', async () => {
    await renderDashboard('/admin/dashboard?category=Concert&userType=School&search=ravi');
    expect(listInquiries).toHaveBeenCalledWith(
      { ...DEFAULT_PARAMS, category: 'Concert', userType: 'School', search: 'ravi' },
      expect.anything(),
    );
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('ravi');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Concert');
    expect(screen.getByRole('combobox', { name: 'User type' })).toHaveValue('School');
  });

  it('ignores invalid filter values in the URL', async () => {
    await renderDashboard(
      '/admin/dashboard?category=Sports&userType=Teacher&page=-3&sortBy=password',
    );
    expect(lastParams()).toEqual(DEFAULT_PARAMS);
  });

  it('clears every filter and the search with Reset filters', async () => {
    const { user, router } = await renderDashboard(
      '/admin/dashboard?category=Concert&userType=School&search=ravi&page=2',
    );
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));

    await waitFor(() => expect(lastParams()).toEqual(DEFAULT_PARAMS));
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeDisabled();
  });

  it('returns to page 1 when a filter changes', async () => {
    const { user } = await renderDashboard('/admin/dashboard?page=2&userType=Parent');
    expect(lastParams()).toMatchObject({ page: 2, userType: 'Parent' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Admission');
    await waitFor(() =>
      expect(lastParams()).toMatchObject({ page: 1, userType: 'Parent', category: 'Admission' }),
    );
  });

  it('sorts by name and date through the API', async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    await waitFor(() => expect(lastParams()).toMatchObject({ sortBy: 'name', sortDir: 'asc' }));
    expect(screen.getByRole('columnheader', { name: /^Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    await user.click(screen.getByRole('button', { name: /^Date/ }));
    await waitFor(() =>
      expect(lastParams()).toMatchObject({ sortBy: 'createdAt', sortDir: 'desc' }),
    );
  });
});

describe('pagination', () => {
  it('moves between pages and keeps the filters', async () => {
    vi.mocked(listInquiries).mockImplementation(async ({ page }) =>
      pageOf([row({ id: `id-${page}`, name: `Person on page ${page}` })], {
        page,
        total: 26,
        totalPages: 2,
        hasPreviousPage: page > 1,
        hasNextPage: page < 2,
      }),
    );
    const { user } = await renderDashboard('/admin/dashboard?category=Concert');

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Person on page 2')).toBeInTheDocument();
    expect(lastParams()).toMatchObject({ page: 2, category: 'Concert' });
    expect(
      screen.getByText('Showing 21–26 of 26 matching inquiries (26 inquiries in total)'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Person on page 1')).toBeInTheDocument();
    expect(lastParams()).toMatchObject({ page: 1, category: 'Concert' });
  });

  it('hides pagination when everything fits on one page', async () => {
    await renderDashboard();
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });

  it('offers a way back from a page past the end', async () => {
    vi.mocked(listInquiries).mockImplementation(async ({ page }) =>
      page === 9
        ? pageOf([], { page: 9, total: 26, totalPages: 2 })
        : pageOf([row()], { total: 26, totalPages: 2, page }),
    );
    const { user } = renderApp('/admin/dashboard?page=9');
    await user.click(await screen.findByRole('button', { name: 'Go to page 2' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ page: 2 }));
  });
});

describe('empty, no-results and error states', () => {
  it('explains when there are no inquiries yet', async () => {
    vi.mocked(listInquiries).mockResolvedValue(pageOf([]));
    renderApp('/admin/dashboard');
    expect(await screen.findByRole('heading', { name: 'No inquiries yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the inquiry form' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('explains when filters match nothing, with a way out', async () => {
    vi.mocked(listInquiries).mockResolvedValue(pageOf([]));
    const { user } = renderApp('/admin/dashboard?search=zzz');
    expect(
      await screen.findByRole('heading', { name: 'No inquiries match your filters' }),
    ).toBeInTheDocument();

    const resetButtons = screen.getAllByRole('button', { name: 'Reset filters' });
    await user.click(resetButtons.at(-1));
    await waitFor(() => expect(lastParams()).toEqual(DEFAULT_PARAMS));
  });

  it('shows an error with a retry when loading fails', async () => {
    vi.mocked(listInquiries)
      .mockRejectedValueOnce(new ApiError('down', { status: 503, code: 'DATABASE_UNAVAILABLE' }))
      .mockResolvedValueOnce(pageOf([row()]));
    const { user } = renderApp('/admin/dashboard');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Inquiries could not be loaded');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});

describe('status management', () => {
  it('updates the status through the API, then the row, with visible feedback', async () => {
    const request = deferred();
    vi.mocked(updateInquiryStatus).mockReturnValue(request.promise);
    const { user } = await renderDashboard();
    const select = screen.getByRole('combobox', { name: 'Status for Asha Verma' });

    await user.selectOptions(select, 'Resolved');
    expect(updateInquiryStatus).toHaveBeenCalledWith(row().id, 'Resolved');
    expect(select).toBeDisabled();
    expect(select).toHaveValue('Resolved');

    await act(async () => request.resolve(row({ status: 'Resolved' })));
    expect(select).toBeEnabled();
    expect(select).toHaveValue('Resolved');
    expect(screen.getByRole('status', { name: '' })).toBeDefined();
    expect(
      screen.getByText('Status for Asha Verma changed from New to Resolved.'),
    ).toBeInTheDocument();
  });

  it('puts the old status back and explains when the update fails', async () => {
    vi.mocked(updateInquiryStatus).mockRejectedValue(
      new ApiError('Inquiry not found', { status: 404, code: 'NOT_FOUND' }),
    );
    const { user } = await renderDashboard();
    const select = screen.getByRole('combobox', { name: 'Status for Asha Verma' });
    await user.selectOptions(select, 'In Progress');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The status for Asha Verma was not changed. Inquiry not found',
    );
    expect(select).toHaveValue('New');
    expect(select).toBeEnabled();
  });

  it('lets the user dismiss the message', async () => {
    vi.mocked(updateInquiryStatus).mockResolvedValue(row({ status: 'In Progress' }));
    const { user } = await renderDashboard();
    await user.selectOptions(screen.getByRole('combobox', { name: /Status for/ }), 'In Progress');
    await screen.findByText(/changed from New to In Progress/);
    await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText(/changed from New/)).not.toBeInTheDocument();
  });
});
