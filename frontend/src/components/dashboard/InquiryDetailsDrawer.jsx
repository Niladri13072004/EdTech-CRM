import {
  Activity,
  CalendarClock,
  CircleCheck,
  ClipboardList,
  Mail,
  Phone,
  Save,
  StickyNote,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  addInquiryNote,
  getAssignableAdmins,
  getInquiry,
  updateInquiry,
} from '../../api/inquiries.api.js';
import { INQUIRY_STATUSES } from '../../constants/inquiry.js';
import { describeApiError } from '../../lib/apiErrors.js';
import { formatDateTime, telHref } from '../../lib/format.js';
import { Alert } from '../ui/Alert.jsx';
import { Button } from '../ui/Button.jsx';

const ACTIVITY_LABELS = {
  received: 'Inquiry received',
  status: 'Status changed',
  note: 'Note added',
  assignment: 'Assignment changed',
  follow_up: 'Follow-up scheduled',
  outcome: 'Follow-up outcome',
  update: 'Inquiry updated',
};

function DetailItem({ label, children }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{children || <span className="muted">Not provided</span>}</dd>
    </div>
  );
}

function Timeline({ activities }) {
  if (!activities?.length) return <p className="muted">No activity recorded yet.</p>;
  return (
    <ol className="timeline">
      {activities.map((item) => (
        <li key={item.id} className="timeline__item">
          <span className={`timeline__dot timeline__dot--${item.type}`} aria-hidden="true" />
          <div className="timeline__body">
            <p className="timeline__summary">{item.summary}</p>
            <p className="timeline__meta">
              {formatDateTime(item.createdAt)}
              {item.adminEmail ? ` · ${item.adminEmail}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Right-side inquiry detail drawer. Loads the full record (message, notes,
 * follow-up and activity) when opened, and keeps the dashboard row in sync
 * through `onChanged` after every successful write.
 */
export function InquiryDetailsDrawer({ inquiryId, onClose, onChanged, onNotice }) {
  const [state, setState] = useState({ id: inquiryId, status: 'loading', data: null, error: null });
  const [admins, setAdmins] = useState([]);
  const [note, setNote] = useState('');
  const [form, setForm] = useState({
    status: '',
    assignedAdminId: '',
    followUpDate: '',
    followUpOutcome: '',
  });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(null);
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    return () => previousFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getInquiry(inquiryId, { signal: controller.signal }).then(
      (data) => {
        setState({ id: inquiryId, status: 'ready', data, error: null });
        setForm({
          status: data.status ?? 'New',
          assignedAdminId: data.assignedAdminId ?? '',
          followUpDate: data.followUpDate ?? '',
          followUpOutcome: data.followUpOutcome ?? '',
        });
      },
      (error) => {
        if (error?.name === 'CanceledError') return;
        setState({ id: inquiryId, status: 'error', data: null, error });
      },
    );
    return () => controller.abort();
  }, [inquiryId]);

  useEffect(() => {
    const controller = new AbortController();
    getAssignableAdmins({ signal: controller.signal }).then(setAdmins, () => setAdmins([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // Escape closes. Tab is contained inside the drawer: with aria-modal set,
    // assistive tech treats the rest of the page as inert, so focus must not
    // escape to it either. Disabled and hidden controls are skipped.
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter(
        (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function applyUpdated(data) {
    setState({ id: inquiryId, status: 'ready', data, error: null });
    setForm({
      status: data.status ?? 'New',
      assignedAdminId: data.assignedAdminId ?? '',
      followUpDate: data.followUpDate ?? '',
      followUpOutcome: data.followUpOutcome ?? '',
    });
    onChanged?.(data);
  }

  async function handleNoteSubmit(event) {
    event.preventDefault();
    const body = note.trim();
    if (!body) return;
    setSaving(true);
    setActionError(null);
    try {
      await addInquiryNote(inquiryId, body);
      const refreshed = await getInquiry(inquiryId);
      setNote('');
      applyUpdated(refreshed);
      onNotice?.({ variant: 'success', text: 'Note added.' });
    } catch (error) {
      setActionError(describeApiError(error, 'detail'));
    } finally {
      setSaving(false);
    }
  }

  async function handleWorkflowSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      const updated = await updateInquiry(inquiryId, {
        status: form.status,
        assignedAdminId: form.assignedAdminId || null,
        followUpDate: form.followUpDate || null,
        followUpOutcome: form.followUpOutcome.trim() || null,
      });
      applyUpdated(updated);
      onNotice?.({ variant: 'success', text: 'Inquiry updated.' });
    } catch (error) {
      setActionError(describeApiError(error, 'detail'));
    } finally {
      setSaving(false);
    }
  }

  const current = state.id === inquiryId ? state : { status: 'loading', data: null, error: null };
  const data = current.data;
  const phoneHref = data?.phone ? telHref(data.phone) : null;
  const followUpId = `follow-up-${inquiryId}`;
  const outcomeId = `outcome-${inquiryId}`;

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inquiry-detail-title"
        ref={dialogRef}
      >
        <header className="drawer__header">
          <div>
            <p className="drawer__eyebrow">Inquiry details</p>
            <h2 id="inquiry-detail-title" ref={headingRef} tabIndex={-1}>
              {data?.name ?? 'Loading inquiry…'}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close inquiry details"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="drawer__scroll">
          {current.status === 'loading' && (
            <p className="muted" role="status">
              Loading inquiry…
            </p>
          )}
          {current.status === 'error' && (
            <Alert variant="error" title="Inquiry could not be loaded">
              {describeApiError(current.error, 'detail')}
            </Alert>
          )}
          {data && (
            <>
              <section className="drawer__section" aria-labelledby="detail-information-heading">
                <h3 id="detail-information-heading" className="drawer__section-title">
                  <ClipboardList aria-hidden="true" /> Inquiry information
                </h3>
                <dl className="detail-grid">
                  <DetailItem label="Name">{data.name}</DetailItem>
                  <DetailItem label="User type">{data.userType}</DetailItem>
                  <DetailItem label="Phone">
                    {data.phone ? (
                      phoneHref ? (
                        <a href={phoneHref}>{data.phone}</a>
                      ) : (
                        data.phone
                      )
                    ) : null}
                  </DetailItem>
                  <DetailItem label="Email">
                    {data.email ? <a href={`mailto:${data.email}`}>{data.email}</a> : null}
                  </DetailItem>
                  <DetailItem label="Category">{data.category}</DetailItem>
                  <DetailItem label="Submitted">{formatDateTime(data.createdAt)}</DetailItem>
                </dl>
                <div className="message-block">
                  <p className="detail-item__label">Original query / message</p>
                  <p className="message-block__body">{data.message}</p>
                </div>
              </section>

              <section className="drawer__section" aria-labelledby="detail-notes-heading">
                <h3 id="detail-notes-heading" className="drawer__section-title">
                  <StickyNote aria-hidden="true" /> Admin notes
                </h3>
                <form className="drawer__form" onSubmit={handleNoteSubmit}>
                  <label htmlFor="new-note" className="field__label">
                    Add an internal note
                  </label>
                  <textarea
                    id="new-note"
                    className="input textarea"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    maxLength={5000}
                    rows={3}
                    placeholder="Called the parent; discussed scholarship eligibility."
                  />
                  <div className="drawer__actions">
                    <Button
                      type="submit"
                      icon={StickyNote}
                      loading={saving}
                      disabled={saving || !note.trim()}
                    >
                      Add note
                    </Button>
                  </div>
                </form>
                {data.notes?.length ? (
                  <ul className="note-list">
                    {data.notes.map((item) => (
                      <li key={item.id} className="note-list__item">
                        <p className="note-list__body">{item.body}</p>
                        <p className="note-list__meta">
                          {item.admin?.email ?? 'Administrator'} · {formatDateTime(item.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No notes yet.</p>
                )}
              </section>

              <section className="drawer__section" aria-labelledby="detail-follow-up-heading">
                <h3 id="detail-follow-up-heading" className="drawer__section-title">
                  <CalendarClock aria-hidden="true" /> Follow-up
                </h3>
                <form className="drawer__form" onSubmit={handleWorkflowSubmit}>
                  <div className="drawer__field-grid">
                    <div className="field">
                      <label htmlFor="detail-status" className="field__label">
                        Status
                      </label>
                      <select
                        id="detail-status"
                        className="input select"
                        value={form.status}
                        onChange={(event) => setForm({ ...form, status: event.target.value })}
                      >
                        {INQUIRY_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="detail-assignee" className="field__label">
                        Assign to
                      </label>
                      <select
                        id="detail-assignee"
                        className="input select"
                        value={form.assignedAdminId}
                        onChange={(event) =>
                          setForm({ ...form, assignedAdminId: event.target.value })
                        }
                      >
                        <option value="">Unassigned</option>
                        {admins.map((admin) => (
                          <option key={admin.id} value={admin.id}>
                            {admin.email}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={followUpId} className="field__label">
                        Follow-up date
                      </label>
                      <input
                        id={followUpId}
                        type="date"
                        className="input"
                        value={form.followUpDate}
                        onChange={(event) => setForm({ ...form, followUpDate: event.target.value })}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor={outcomeId} className="field__label">
                      Follow-up outcome
                    </label>
                    <textarea
                      id={outcomeId}
                      className="input textarea"
                      value={form.followUpOutcome}
                      onChange={(event) =>
                        setForm({ ...form, followUpOutcome: event.target.value })
                      }
                      maxLength={2000}
                      rows={3}
                      placeholder="Record what happened and any next steps."
                    />
                  </div>
                  <div className="drawer__actions">
                    <Button type="submit" icon={Save} loading={saving} disabled={saving}>
                      Save follow-up
                    </Button>
                  </div>
                </form>
              </section>

              <section className="drawer__section" aria-labelledby="detail-activity-heading">
                <h3 id="detail-activity-heading" className="drawer__section-title">
                  <Activity aria-hidden="true" /> Activity timeline
                </h3>
                <Timeline activities={data.activities} />
              </section>
            </>
          )}
          {actionError && (
            <Alert variant="error" title="Change not saved">
              {actionError}
            </Alert>
          )}
        </div>
      </aside>
    </div>
  );
}
