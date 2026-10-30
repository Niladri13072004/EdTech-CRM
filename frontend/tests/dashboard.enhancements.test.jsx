import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCurrentAdmin } from '../src/api/auth.api.js';
import { ApiError } from '../src/api/client.js';
import {
  exportInquiriesCsv,
  getAssignableAdmins,
  getInquiryStats,
  listInquiries,
  updateInquiryStatus,
} from '../src/api/inquiries.api.js';
import { saveTextFile } from '../src/lib/download.js';
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

const STATS = {
  total: 26,
  byStatus: { New: 13, 'In Progress': 7, Resolved: 6 },
  byCategory: { Scholarship: 8, Concert: 6, Admission: 6, 'General Query': 6 },
};

const row = {
  id: '6f1c3c1e-3f5b-4c8e-9a51-2b0b7f0e9d11',
  name: 'Asha Verma',
  email: 'asha@example.com',
  phone: '+91 98765 43210',
  userType: 'Parent',
  category: 'Admission',
  status: 'New',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

const page = (inquiries = [row], meta = {}) => ({
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

const lastParams = () => vi.mocked(listInquiries).mock.lastCall[0];

beforeEach(() => {
  vi.mocked(fetchCurrentAdmin).mockResolvedValue(ADMIN);
  vi.mocked(listInquiries).mockResolvedValue(page());
  vi.mocked(getInquiryStats).mockResolvedValue(STATS);
  vi.mocked(getAssignableAdmins).mockResolvedValue([]);
});

const cards = () => within(screen.getByRole('list', { name: 'Inquiry totals' }));
const card = (label) => cards().getByRole('button', { name: new RegExp(`^${label}`) });

describe('summary cards', () => {
  it('show totals from the stats API, with each status share', async () => {
    renderApp('/admin/dashboard');
    await waitFor(() => expect(card('Total inquiries')).toHaveTextContent('26'));

    expect(card('Total inquiries')).toHaveTextContent('All statuses');
    expect(card('New')).toHaveTextContent('13');
    expect(card('New')).toHaveTextContent('50% of all');
    expect(card('In progress')).toHaveTextContent('7');
    expect(card('In progress')).toHaveTextContent('27% of all');
    expect(card('Resolved')).toHaveTextContent('6');
    expect(getInquiryStats).toHaveBeenCalledTimes(1);
  });

  it('show placeholders while loading', async () => {
    vi.mocked(getInquiryStats).mockReturnValueOnce(deferred().promise);
    renderApp('/admin/dashboard');
    await screen.findByRole('table');
    expect(card('Total inquiries')).toHaveTextContent('—');
    expect(screen.getByRole('list', { name: 'Inquiry totals' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('explain a failure and retry', async () => {
    vi.mocked(getInquiryStats)
      .mockRejectedValueOnce(new ApiError('down', { status: 503, code: 'DATABASE_UNAVAILABLE' }))
      .mockResolvedValueOnce(STATS);
    const { user } = renderApp('/admin/dashboard');

    expect(await screen.findByText('Totals could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(card('Total inquiries')).toHaveTextContent('26'));
  });

  it('filter the table by status and show which one is active', async () => {
    const { user, router } = renderApp('/admin/dashboard');
    await waitFor(() => expect(card('New')).toHaveTextContent('13'));
    expect(card('Total inquiries')).toHaveAttribute('aria-pressed', 'true');

    await user.click(card('In progress'));
    await waitFor(() => expect(lastParams()).toMatchObject({ status: 'In Progress', page: 1 }));
    expect(router.state.location.search).toBe('?status=In+Progress');
    expect(card('In progress')).toHaveAttribute('aria-pressed', 'true');
    expect(card('Total inquiries')).toHaveAttribute('aria-pressed', 'false');

    await user.click(card('Total inquiries'));
    await waitFor(() => expect(lastParams()).toMatchObject({ status: '' }));
  });

  it('refresh after a status change', async () => {
    vi.mocked(updateInquiryStatus).mockResolvedValue({ ...row, status: 'Resolved' });
    const { user } = renderApp('/admin/dashboard');
    await screen.findByRole('table');
    await waitFor(() => expect(getInquiryStats).toHaveBeenCalledTimes(1));

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Status for Asha Verma' }),
      'Resolved',
    );
    await screen.findByText(/changed from New to Resolved/);
    await waitFor(() => expect(getInquiryStats).toHaveBeenCalledTimes(2));
  });
});

describe('category chart', () => {
  it('shows each category with its count and share', async () => {
    renderApp('/admin/dashboard');
    const chart = within(await screen.findByRole('figure', { name: 'Inquiries by category' }));
    await waitFor(() => expect(chart.getAllByRole('button')).toHaveLength(4));

    const rows = chart
      .getAllByRole('button')
      .map((button) => button.textContent.replace(/\..*$/, ''));
    expect(rows).toEqual([
      'Scholarship8 · 31%',
      'Concert6 · 23%',
      'Admission6 · 23%',
      'General Query6 · 23%',
    ]);
  });

  it('scales bars to the largest category', async () => {
    renderApp('/admin/dashboard');
    const chart = await screen.findByRole('figure', { name: 'Inquiries by category' });
    await waitFor(() => expect(chart.querySelectorAll('.breakdown__bar')).toHaveLength(4));
    const widths = [...chart.querySelectorAll('.breakdown__bar')].map((bar) => bar.style.width);
    expect(widths[0]).toBe('max(4px, 100%)');
    expect(widths[1]).toBe('max(4px, 75%)');
  });

  it('filters the table by a category and toggles it off again', async () => {
    const { user } = renderApp('/admin/dashboard');
    const chart = within(await screen.findByRole('figure', { name: 'Inquiries by category' }));
    const concert = await chart.findByRole('button', { name: /^Concert/ });

    await user.click(concert);
    await waitFor(() => expect(lastParams()).toMatchObject({ category: 'Concert' }));
    expect(concert).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Concert');

    await user.click(concert);
    await waitFor(() => expect(lastParams()).toMatchObject({ category: '' }));
  });
});

describe('active filter chips', () => {
  it('list each active filter and remove them one by one', async () => {
    const { user } = renderApp('/admin/dashboard?search=ravi&category=Concert&status=New');
    const list = within(await screen.findByRole('list', { name: 'Filtered by' }));
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Search: “ravi”',
      'Category: Concert',
      'Status: New',
    ]);

    await user.click(list.getByRole('button', { name: 'Remove filter Search: “ravi”' }));
    await waitFor(() =>
      expect(lastParams()).toMatchObject({ search: '', category: 'Concert', status: 'New' }),
    );
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Remove filter Category: Concert' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ category: '', status: 'New' }));
  });

  it('clear everything at once', async () => {
    const { user, router } = renderApp('/admin/dashboard?userType=School&status=Resolved');
    await user.click(await screen.findByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.queryByRole('list', { name: 'Filtered by' })).not.toBeInTheDocument();
  });

  it('are absent without filters', async () => {
    renderApp('/admin/dashboard');
    await screen.findByRole('table');
    expect(screen.queryByRole('list', { name: 'Filtered by' })).not.toBeInTheDocument();
  });
});

describe('CSV export', () => {
  let createObjectURL;
  let clicked;

  beforeEach(() => {
    clicked = [];
    createObjectURL = vi.fn(() => 'blob:mock');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicked.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it('exports the current filtered results through the API and saves the file', async () => {
    vi.mocked(exportInquiriesCsv).mockResolvedValue({
      csv: '"Name"\r\n"Asha Verma"\r\n',
      filename: 'inquiries-2026-10-30.csv',
      rowCount: 1,
    });
    const { user } = renderApp(
      '/admin/dashboard?category=Admission&userType=Parent&search=asha&status=New&sortDir=asc&page=2',
    );
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(exportInquiriesCsv).toHaveBeenCalledWith({
      search: 'asha',
      category: 'Admission',
      userType: 'Parent',
      status: 'New',
      sortBy: 'createdAt',
      sortDir: 'asc',
    });
    expect(
      await screen.findByText('Exported 1 inquiry to inquiries-2026-10-30.csv.'),
    ).toBeInTheDocument();
    expect(clicked).toEqual([{ href: 'blob:mock', download: 'inquiries-2026-10-30.csv' }]);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
  });

  it('shows progress and prevents double exports', async () => {
    const request = deferred();
    vi.mocked(exportInquiriesCsv).mockReturnValue(request.promise);
    const { user } = renderApp('/admin/dashboard');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    const busy = screen.getByRole('button', { name: 'Exporting…' });
    expect(busy).toBeDisabled();
    request.resolve({ csv: '', filename: 'x.csv', rowCount: 0 });
    await screen.findByRole('button', { name: 'Export CSV' });
    expect(exportInquiriesCsv).toHaveBeenCalledTimes(1);
  });

  it('explains a failed export', async () => {
    vi.mocked(exportInquiriesCsv).mockRejectedValue(
      new ApiError(
        'This export would contain 9000 inquiries; the limit is 5000. Narrow the filters and try again.',
        {
          status: 422,
          code: 'EXPORT_TOO_LARGE',
        },
      ),
    );
    const { user } = renderApp('/admin/dashboard');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The export failed. This export would contain 9000',
    );
    expect(clicked).toEqual([]);
  });

  it('is disabled when there is nothing to export', async () => {
    vi.mocked(listInquiries).mockResolvedValue(page([]));
    renderApp('/admin/dashboard?search=zzz');
    await screen.findByText('No inquiries match your filters');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });
});

describe('saveTextFile', () => {
  it('does not add a second BOM', async () => {
    const created = [];
    URL.createObjectURL = vi.fn((blob) => {
      created.push(blob);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    saveTextFile(`${String.fromCodePoint(0xfeff)}a`, 'a.csv');
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect([...bytes]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });
});
