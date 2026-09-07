'use client';

import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useActionState, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Table } from '@/components/ui/table';
import { parseInstant } from '@/lib/time';

import {
  createInvoiceAction,
  recordInvoicePaymentAction,
  type InvoiceActionState,
} from './actions';

import type { InvoiceLineKind } from '@/domain/invoice';

export interface InvoiceLineView {
  id: string;
  kind: string;
  title: string;
  amount: number;
}

export interface PaymentView {
  id: string;
  amount: number;
  method: string;
  paidAt: string;
  note: string | null;
}

export interface InvoiceCardView {
  id: string;
  type: string;
  status: string;
  periodMonth: string | null;
  dueDate: string | null;
  total: number;
  paid: number;
  remaining: number;
  overdue: boolean;
  residentName: string | null;
  lines: InvoiceLineView[];
  payments: PaymentView[];
}

export interface InvoiceRowView {
  id: string;
  residentName: string;
  periodMonth: string | null;
  status: string;
  total: number;
  paid: number;
  remaining: number;
  overdue: boolean;
}

export interface ResidencyOption {
  id: string;
  name: string;
}

const INITIAL: InvoiceActionState = {};

/** Виды строк, которые админ заводит руками. Остальные ставит расчёт. */
const MANUAL_KINDS: readonly InvoiceLineKind[] = [
  'rent',
  'utilities',
  'damage_carryover',
  'proration',
  'extra',
];

function statusTone(status: string, overdue: boolean) {
  if (status === 'paid') {
    return 'success' as const;
  }
  if (status === 'cancelled') {
    return 'neutral' as const;
  }

  return overdue ? ('danger' as const) : ('info' as const);
}

export function InvoiceStatus({ overdue, status }: { overdue: boolean; status: string }) {
  const t = useTranslations();

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={statusTone(status, overdue)}>{t(`invoices.status.${status}`)}</Badge>
      {overdue && <Badge tone="danger">{t('invoices.overdue')}</Badge>}
    </span>
  );
}

/** Карточка счёта жильца: строки, статус, история платежей, флаг «Долг». */
export function InvoiceCard({ invoice }: { invoice: InvoiceCardView }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Card data-testid="invoice-card">
      <CardHeader>
        <CardTitle>
          {invoice.periodMonth === null
            ? t(`invoices.type.${invoice.type}`)
            : format.dateTime(parseInstant(`${invoice.periodMonth}T00:00:00+05:00`), {
                month: 'long',
                year: 'numeric',
              })}
        </CardTitle>
        <Money amount={invoice.total} />
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0 text-[13px]">
        <InvoiceStatus overdue={invoice.overdue} status={invoice.status} />

        <ul className="flex flex-col gap-1">
          {invoice.lines.map((line) => (
            <li className="flex items-center justify-between gap-4" key={line.id}>
              <span>{line.title}</span>
              <Money amount={line.amount} />
            </li>
          ))}
        </ul>

        <div className="border-border flex flex-col gap-1 border-t pt-2">
          <div className="flex justify-between gap-4">
            <span>{t('invoices.paid')}</span>
            <Money amount={invoice.paid} />
          </div>
          <div className="flex justify-between gap-4">
            <span>{t('invoices.remaining')}</span>
            <Money amount={invoice.remaining} />
          </div>
        </div>

        {invoice.payments.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">{t('invoices.paymentHistory')}</h3>
            {invoice.payments.map((payment) => (
              <div className="flex items-center justify-between gap-4" key={payment.id}>
                <span className="text-text-muted">
                  {format.dateTime(parseInstant(payment.paidAt), {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}
                  <span className="ml-2">{t(`invoices.method.${payment.method}`)}</span>
                </span>
                <Money amount={payment.amount} />
              </div>
            ))}
          </section>
        )}
      </div>
    </Card>
  );
}

export function ResidentInvoices({ invoices }: { invoices: readonly InvoiceCardView[] }) {
  const t = useTranslations();

  if (invoices.length === 0) {
    return <EmptyState description={t('invoices.emptyHint')} title={t('invoices.empty')} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {invoices.map((invoice) => (
        <InvoiceCard invoice={invoice} key={invoice.id} />
      ))}
    </div>
  );
}

export interface HouseSummary {
  issued: number;
  paid: number;
  debt: number;
}

/** Сводка дома за месяц: выставлено, оплачено, долг (модуль 2). */
export function SummaryCard({ summary }: { summary: HouseSummary }) {
  const t = useTranslations();

  return (
    <Card>
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-text-muted text-[13px]">{t('invoices.summary.issued')}</span>
          <Money amount={summary.issued} className="text-[15px]" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-muted text-[13px]">{t('invoices.summary.paid')}</span>
          <Money amount={summary.paid} className="text-[15px]" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-muted text-[13px]">{t('invoices.summary.debt')}</span>
          <Money amount={summary.debt} className="text-[15px]" />
        </div>
      </div>
    </Card>
  );
}

export function HouseInvoicesTable({ rows }: { rows: readonly InvoiceRowView[] }) {
  const t = useTranslations();

  return (
    <Table
      caption={t('invoices.tableCaption')}
      columns={[
        {
          key: 'resident',
          header: t('invoices.resident'),
          cell: (row) => (
            <Link className="underline-offset-2 hover:underline" href={`/invoices/${row.id}`}>
              {row.residentName}
            </Link>
          ),
        },
        {
          key: 'status',
          header: t('invoices.statusColumn'),
          cell: (row) => <InvoiceStatus overdue={row.overdue} status={row.status} />,
        },
        {
          key: 'total',
          header: t('invoices.total'),
          numeric: true,
          cell: (row) => <Money amount={row.total} />,
        },
        {
          key: 'paid',
          header: t('invoices.paid'),
          numeric: true,
          cell: (row) => <Money amount={row.paid} />,
        },
        {
          key: 'remaining',
          header: t('invoices.remaining'),
          numeric: true,
          cell: (row) => <Money amount={row.remaining} />,
        },
      ]}
      emptyState={<EmptyState description={t('invoices.emptyHint')} title={t('invoices.empty')} />}
      rowKey={(row) => row.id}
      rows={rows}
    />
  );
}

interface DraftLine {
  kind: InvoiceLineKind;
  title: string;
  amount: number;
}

/** Ручной счёт: тип, строки, срок оплаты, комментарий (модуль 2). */
export function CreateInvoiceForm({ residencies }: { residencies: readonly ResidencyOption[] }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(createInvoiceAction, INITIAL);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [draft, setDraft] = useState<DraftLine>({ kind: 'extra', title: '', amount: 0 });

  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  function add(): void {
    if (draft.title.trim() === '' || !Number.isSafeInteger(draft.amount) || draft.amount < 0) {
      return;
    }

    setLines((current) => [...current, draft]);
    setDraft({ kind: 'extra', title: '', amount: 0 });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invoices.create')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex flex-col gap-4 p-4 pt-0">
        {lines.map((line, index) => (
          <div key={`${line.kind}-${line.title}-${String(index)}`}>
            <input name="lineKind" type="hidden" value={line.kind} />
            <input name="lineTitle" type="hidden" value={line.title} />
            <input name="lineAmount" type="hidden" value={line.amount} />
          </div>
        ))}

        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(state.error)}
          </p>
        )}
        {state.done !== undefined && <p className="text-[13px]">{t(state.done)}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field htmlFor="invoice-residency" label={t('invoices.residency')}>
            <Select data-testid="invoice-residency" id="invoice-residency" name="residencyId">
              {residencies.map((residency) => (
                <option key={residency.id} value={residency.id}>
                  {residency.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="invoice-type" label={t('invoices.typeField')}>
            <Select id="invoice-type" name="type">
              <option value="monthly">{t('invoices.type.monthly')}</option>
              <option value="extra">{t('invoices.type.extra')}</option>
            </Select>
          </Field>

          <Field
            hint={t('invoices.periodHint')}
            htmlFor="invoice-period"
            label={t('invoices.period')}
          >
            <Input id="invoice-period" name="periodMonth" type="date" />
          </Field>

          <Field htmlFor="invoice-due" label={t('invoices.dueDate')}>
            <Input id="invoice-due" name="dueDate" type="date" />
          </Field>
        </div>

        <Field htmlFor="invoice-note" label={t('invoices.note')}>
          <Textarea id="invoice-note" name="note" rows={2} />
        </Field>

        <fieldset className="border-border flex flex-col gap-3 border-t pt-3">
          <legend className="text-label">{t('invoices.lines')}</legend>

          {lines.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('invoices.noLinesYet')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {lines.map((line, index) => (
                <li
                  className="flex items-center justify-between gap-4"
                  key={`${line.title}-${String(index)}`}
                >
                  <span>{line.title}</span>
                  <span className="flex items-center gap-3">
                    <Money amount={line.amount} />
                    <Button
                      onClick={() => {
                        setLines((current) => current.filter((_, at) => at !== index));
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t('common.remove')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="grid items-end gap-3 md:grid-cols-[1fr_2fr_1fr_auto]">
            <Field htmlFor="line-kind" label={t('invoices.lineKind')}>
              <Select
                id="line-kind"
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    kind: event.target.value as InvoiceLineKind,
                  }));
                }}
                value={draft.kind}
              >
                {MANUAL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`invoices.kind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field htmlFor="line-title" label={t('invoices.lineTitle')}>
              <Input
                data-testid="line-title"
                id="line-title"
                onChange={(event) => {
                  setDraft((current) => ({ ...current, title: event.target.value }));
                }}
                value={draft.title}
              />
            </Field>

            <Field htmlFor="line-amount" label={t('invoices.lineAmount')}>
              <Input
                data-testid="line-amount"
                id="line-amount"
                inputMode="numeric"
                onChange={(event) => {
                  setDraft((current) => ({ ...current, amount: Number(event.target.value) }));
                }}
                step={1}
                type="number"
                value={draft.amount === 0 ? '' : draft.amount}
              />
            </Field>

            <Button onClick={add} size="sm" type="button" variant="secondary">
              {t('invoices.addLine')}
            </Button>
          </div>
        </fieldset>

        <div className="flex items-center justify-between gap-4 text-[13px]">
          <span>{t('invoices.total')}</span>
          <Money amount={total} />
        </div>

        <Button disabled={isPending || lines.length === 0} type="submit">
          {t('invoices.submit')}
        </Button>
      </form>
    </Card>
  );
}

/** Быстрая отметка оплаты (модуль 2): сумма, способ, комментарий. */
export function PaymentForm({ invoiceId, remaining }: { invoiceId: string; remaining: number }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(recordInvoicePaymentAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input name="invoiceId" type="hidden" value={invoiceId} />

      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}

      <Field htmlFor={`payment-${invoiceId}`} label={t('invoices.paymentAmount')}>
        <Input
          data-testid="invoice-payment-amount"
          defaultValue={remaining}
          id={`payment-${invoiceId}`}
          inputMode="numeric"
          name="amount"
          step={1}
          type="number"
        />
      </Field>

      <Field htmlFor={`method-${invoiceId}`} label={t('invoices.method.label')}>
        <Select id={`method-${invoiceId}`} name="method">
          <option value="kaspi">{t('invoices.method.kaspi')}</option>
          <option value="cash">{t('invoices.method.cash')}</option>
        </Select>
      </Field>

      <Field
        hint={t('invoices.paidAtHint')}
        htmlFor={`paid-at-${invoiceId}`}
        label={t('invoices.paidAt')}
      >
        <Input id={`paid-at-${invoiceId}`} name="paidAt" type="date" />
      </Field>

      <Button disabled={isPending} type="submit">
        {t('invoices.record')}
      </Button>
    </form>
  );
}
