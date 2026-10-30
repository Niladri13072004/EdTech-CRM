import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCurrentAdmin } from '../src/api/auth.api.js';
import {
  addInquiryNote,
  getAssignableAdmins,
  getInquiry,
  getInquiryStats,
  listInquiries,
  updateInquiry,
} from '../src/api/inquiries.api.js';
import { ADMIN, renderApp } from './helpers/renderApp.jsx';

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

const ID = '6f1c3c1e-3f5b-4c8e-9a51-2b0b7f0e9d11';
const OTHER_ID = '2c6f3c1e-3f5b-4c8e-9a51-2b0b7f0e9d22';

const row = (overrides = {}) => ({
  id: ID,
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

const pageOf = (inquiries) => ({
  inquiries,
  meta: {
    page: 1,
    pageSize: 20,
    total: inquiries.length,
    totalPages: inquiries.length ? 1 : 0,
    hasPreviousPage: false,
    hasNextPage: false,
  },
});

const detail = (overrides = {}) => ({
  ...row(),
  message: 'When does admission open for grade 6?',
  assignedAdminId: null,
  assignedAdmin: null,
  followUpDate: null,
  followUpOutcome: null,
  notes: [],
  activities: [],
  ...overrides,
});

const STATS = {
  total: 1,
  byStatus: { New: 1, 'In Progress': 0, Resolved: 0 },
  byCategory: { Scholarship: 0, Concert: 0, Admission: 1, 'General Query': 0 },
};

beforeEach(() => {
  vi.mocked(fetchCurrentAdmin).mockResolvedValue(ADMIN);
  vi.mocked(listInquiries).mockResolvedValue(pageOf([row()]));
  vi.mocked(getInquiryStats).mockResolvedValue(STATS);
  vi.mocked(getInquiry).mockResolvedValue(detail());
  vi.mocked(getAssignableAdmins).mockResolvedValue([{ id: ADMIN.id, email: ADMIN.email }]);
  vi.mocked(addInquiryNote).mockResolvedValue({
    id: '9e8d7c6b-5a4f-3e2d-1c0b-9a8f7e6d5c4b',
    body: 'Called the parent.',
    admin: { id: ADMIN.id, email: ADMIN.email },
    createdAt: '2026-10-01T13:00:00.000Z',
  });
  vi.mocked(updateInquiry).mockImplementation(async (_id, changes) => detail(changes));
});

async function openDetails(user) {
  await user.click(await screen.findByRole('row', { name: /Open details for Asha Verma/i }));
  return screen.findByRole('dialog', { name: /Asha Verma/i });
}

describe('inquiry details drawer', () => {
  it('opens on row click and shows the inquiry message and metadata', async () => {
    const { user } = renderApp('/admin/dashboard');
    const dialog = await openDetails(user);

    expect(getInquiry).toHaveBeenCalledWith(ID, expect.anything());
    expect(within(dialog).getByText('When does admission open for grade 6?')).toBeInTheDocument();
    expect(within(dialog).getByText('+91 98765 43210')).toBeInTheDocument();
    expect(within(dialog).getByText('asha@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Parent')).toBeInTheDocument();
    expect(within(dialog).getByText('Admission')).toBeInTheDocument();
  });

  it('closes on Escape and returns to the dashboard', async () => {
    const { user } = renderApp('/admin/dashboard');
    await openDetails(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds an internal note and displays it with the admin and timestamp', async () => {
    const { user } = renderApp('/admin/dashboard');
    await openDetails(user);
    vi.mocked(getInquiry).mockResolvedValue(
      detail({
        notes: [
          {
            id: 'note-1',
            body: 'Called the parent.',
            admin: { id: ADMIN.id, email: ADMIN.email },
            createdAt: '2026-10-01T13:00:00.000Z',
          },
        ],
      }),
    );

    await user.type(screen.getByLabelText('Add an internal note'), 'Called the parent.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() =>
      expect(addInquiryNote).toHaveBeenCalledWith(ID, 'Called the parent.'),
    );
    expect(await screen.findByText('Called the parent.')).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(ADMIN.email)).length).toBeGreaterThan(0);
  });

  it('saves status, assignment, follow-up date and outcome', async () => {
    const { user } = renderApp('/admin/dashboard');
    await openDetails(user);

    await user.selectOptions(screen.getByLabelText('Status'), 'In Progress');
    await user.selectOptions(screen.getByLabelText('Assign to'), ADMIN.id);
    await user.type(screen.getByLabelText('Follow-up date'), '2026-11-02');
    await user.type(screen.getByLabelText('Follow-up outcome'), 'Parent requested a callback.');
    await user.click(screen.getByRole('button', { name: 'Save follow-up' }));

    await waitFor(() =>
      expect(updateInquiry).toHaveBeenCalledWith(ID, {
        status: 'In Progress',
        assignedAdminId: ADMIN.id,
        followUpDate: '2026-11-02',
        followUpOutcome: 'Parent requested a callback.',
      }),
    );
  });

  it('renders the activity timeline chronologically', async () => {
    vi.mocked(getInquiry).mockResolvedValue(
      detail({
        activities: [
          {
            id: 'received',
            type: 'received',
            summary: 'Inquiry received.',
            createdAt: '2026-10-01T12:00:00.000Z',
          },
          {
            id: 'status',
            type: 'status',
            summary: 'Status changed from New to In Progress.',
            adminEmail: ADMIN.email,
            createdAt: '2026-10-01T13:00:00.000Z',
          },
        ],
      }),
    );
    const { user } = renderApp('/admin/dashboard');
    const dialog = await openDetails(user);

    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Inquiry received.');
    expect(items[1]).toHaveTextContent('Status changed from New to In Progress.');
    expect(items[1]).toHaveTextContent(ADMIN.email);
  });
});