import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { formatDateParts, formatDateTime, telHref } from '../../lib/format.js';
import { StatusSelect } from './StatusSelect.jsx';

function Missing() {
  return (
    <>
      <span aria-hidden="true" className="muted">
        —
      </span>
      <span className="visually-hidden">Not provided</span>
    </>
  );
}

const COLUMN_LABELS = { name: 'Name', createdAt: 'Date' };

/** Column header that sorts on click; exposes the current order via aria-sort. */
function SortableHeader({ column, sortBy, sortDir, onSort }) {
  const active = sortBy === column;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  const nextDir =
    active && sortDir === 'desc'
      ? 'asc'
      : active
        ? 'desc'
        : column === 'createdAt'
          ? 'desc'
          : 'asc';
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className={`sort-button${active ? ' sort-button--active' : ''}`}
        onClick={() => onSort(column, nextDir)}
      >
        {COLUMN_LABELS[column]}
        <Icon className="sort-button__icon" aria-hidden="true" />
        <span className="visually-hidden">
          {`, sort ${nextDir === 'asc' ? 'ascending' : 'descending'}`}
        </span>
      </button>
    </th>
  );
}

function describeSort(sortBy, sortDir) {
  if (sortBy === 'name') return sortDir === 'asc' ? 'by name, A to Z' : 'by name, Z to A';
  return sortDir === 'asc' ? 'by date, oldest first' : 'by date, newest first';
}

/**
 * The seven required columns: Name, Phone, Email, User Type, Category, Date,
 * Status. Scrolls horizontally on narrow screens (keyboard-focusable region).
 */
export function InquiryTable({
  inquiries,
  sortBy,
  sortDir,
  onSort,
  pendingStatus,
  onStatusChange,
  onSelect,
  activeId,
  busy,
}) {
  return (
    <div
      className={`table-scroll${busy ? ' table-scroll--busy' : ''}`}
      role="region"
      aria-labelledby="inquiry-table-caption"
      tabIndex={0}
    >
      <table className="data-table" aria-busy={busy || undefined}>
        <caption id="inquiry-table-caption" className="visually-hidden">
          {`Inquiries, sorted ${describeSort(sortBy, sortDir)}`}
        </caption>
        <thead>
          <tr>
            <SortableHeader column="name" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
            <th scope="col">Phone</th>
            <th scope="col">Email</th>
            <th scope="col">User Type</th>
            <th scope="col">Category</th>
            <SortableHeader column="createdAt" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {inquiries.map((inquiry) => {
            const dateParts = formatDateParts(inquiry.createdAt);
            const phoneLink = inquiry.phone ? telHref(inquiry.phone) : null;
            return (
              <tr
                key={inquiry.id}
                className={`data-table__row${activeId === inquiry.id ? ' data-table__row--active' : ''}`}
                onClick={() => onSelect?.(inquiry)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect?.(inquiry);
                  }
                }}
                tabIndex={0}
                aria-label={`Open details for ${inquiry.name || 'this inquiry'}`}
              >
                <th scope="row" className="data-table__name">
                  {inquiry.name || <Missing />}
                </th>
                <td className="data-table__nowrap">
                  {inquiry.phone ? (
                    phoneLink ? (
                      <a href={phoneLink}>{inquiry.phone}</a>
                    ) : (
                      inquiry.phone
                    )
                  ) : (
                    <Missing />
                  )}
                </td>
                <td className="data-table__email">
                  {inquiry.email ? (
                    <a href={`mailto:${inquiry.email}`}>{inquiry.email}</a>
                  ) : (
                    <Missing />
                  )}
                </td>
                <td>{inquiry.userType || <Missing />}</td>
                <td className="data-table__nowrap">{inquiry.category || <Missing />}</td>
                <td className="data-table__nowrap">
                  {dateParts ? (
                    <time
                      dateTime={inquiry.createdAt}
                      title={formatDateTime(inquiry.createdAt)}
                      className="date-cell"
                    >
                      <span>{dateParts.date}</span>
                      <span className="date-cell__time">{dateParts.time}</span>
                    </time>
                  ) : (
                    <Missing />
                  )}
                </td>
                <td
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <StatusSelect
                    inquiry={inquiry}
                    value={pendingStatus[inquiry.id] ?? inquiry.status ?? 'New'}
                    saving={inquiry.id in pendingStatus}
                    onChange={onStatusChange}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
