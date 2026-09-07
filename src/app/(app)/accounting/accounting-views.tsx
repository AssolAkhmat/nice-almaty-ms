'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { Table } from '@/components/ui/table';
import { ReceiptUpload } from '@/components/upload/receipt-upload';
import { parseInstant } from '@/lib/time';

import { recordExpenseAction, reverseEntryAction, type AccountingActionState } from './actions';

export interface BalanceRow {
  accountId: string;
  code: string;
  name: string;
  balance: number;
}

export interface ReconciliationView {
  fundBalance: number;
  depositsTotal: number;
  difference: number;
}

export interface JournalLineView {
  code: string;
  name: string;
  direction: string;
  amount: number;
}

export interface JournalRowView {
  id: string;
  date: string;
  description: string;
  sourceType: string;
  category: string | null;
  receiptFileId: string | null;
  reversed: boolean;
  lines: JournalLineView[];
}

export interface AccountOption {
  id: string;
  name: string;
  /** Дом счёта; у общего счёта его нет — тогда и чек уровня сети. */
  houseId: string | null;
}

export interface TaxHouseRow {
  houseId: string;
  houseName: string;
  income: number;
  turnover: number;
  tax: number;
  acquiring: number;
}

export interface TaxView {
  from: string;
  to: string;
  taxRatePercent: string;
  acquiringRatePercent: string;
  income: number;
  turnover: number;
  tax: number;
  acquiring: number;
  deduction: number;
  net: number;
  byHouse: TaxHouseRow[];
}

const INITIAL: AccountingActionState = {};

/** Оборотная ведомость по счетам за период (модуль 10). */
export function TrialBalance({ rows }: { rows: readonly BalanceRow[] }) {
  const t = useTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accounting.trialBalance')}</CardTitle>
      </CardHeader>
      <div className="p-4 pt-0">
        <Table
          caption={t('accounting.trialBalance')}
          columns={[
            { key: 'name', header: t('accounting.account'), cell: (row) => row.name },
            { key: 'code', header: t('accounting.code'), cell: (row) => row.code },
            {
              key: 'balance',
              header: t('accounting.balance'),
              numeric: true,
              cell: (row) => <Money amount={row.balance} />,
            },
          ]}
          emptyState={
            <EmptyState
              description={t('accounting.noAccountsHint')}
              title={t('accounting.noAccounts')}
            />
          }
          rowKey={(row) => row.accountId}
          rows={rows}
        />
      </div>
    </Card>
  );
}

/** Сверка депозитного фонда: расхождение подсвечивается (инвариант 4). */
export function Reconciliation({ view }: { view: ReconciliationView }) {
  const t = useTranslations();
  const matches = view.difference === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accounting.reconciliation')}</CardTitle>
        <Badge tone={matches ? 'success' : 'danger'}>
          {matches ? t('accounting.matches') : t('accounting.mismatch')}
        </Badge>
      </CardHeader>
      <div className="flex flex-col gap-1 p-4 pt-0 text-[13px]">
        <div className="flex justify-between gap-4">
          <span>{t('accounting.fundBalance')}</span>
          <Money amount={view.fundBalance} />
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('accounting.depositsTotal')}</span>
          <Money amount={view.depositsTotal} />
        </div>
        <div className="flex justify-between gap-4">
          <span className={matches ? undefined : 'text-danger'}>{t('accounting.difference')}</span>
          <Money amount={view.difference} />
        </div>
      </div>
    </Card>
  );
}

function ReverseEntry({ entryId }: { entryId: string }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(reverseEntryAction, INITIAL);

  return (
    <form action={action}>
      <input name="entryId" type="hidden" value={entryId} />
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      <Button disabled={isPending} size="sm" type="submit" variant="ghost">
        {t('accounting.reverse')}
      </Button>
    </form>
  );
}

/** Журнал проводок: дата, описание, источник, строки дебет/кредит. */
export function Journal({ rows }: { rows: readonly JournalRowView[] }) {
  const t = useTranslations();
  const format = useFormatter();

  if (rows.length === 0) {
    return (
      <EmptyState description={t('accounting.noEntriesHint')} title={t('accounting.noEntries')} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <Card data-testid="journal-entry" key={row.id}>
          <CardHeader>
            <CardTitle>{row.description}</CardTitle>
            <span className="text-text-muted text-[13px]">
              {format.dateTime(parseInstant(`${row.date}T00:00:00+05:00`), {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })}
            </span>
          </CardHeader>

          <div className="flex flex-col gap-2 p-4 pt-0 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{t(`accounting.source.${row.sourceType}`)}</Badge>
              {row.category !== null && (
                <Badge tone="info">{t(`accounting.category.${row.category}`)}</Badge>
              )}
              {row.reversed && <Badge tone="warning">{t('accounting.reversed')}</Badge>}
            </div>

            <ul className="flex flex-col gap-1">
              {row.lines.map((line, index) => (
                <li
                  className="flex items-center justify-between gap-4"
                  key={`${line.code}-${String(index)}`}
                >
                  <span>
                    {line.name}
                    <span className="text-text-muted ml-2">
                      {t(`accounting.direction.${line.direction}`)}
                    </span>
                  </span>
                  <Money amount={line.amount} />
                </li>
              ))}
            </ul>

            {row.receiptFileId !== null && (
              <a
                className="text-text-muted hover:text-text underline-offset-2 hover:underline"
                href={`/api/v1/files/${row.receiptFileId}/content`}
                rel="noreferrer"
                target="_blank"
              >
                {t('files.receipt')}
              </a>
            )}

            {row.sourceType === 'manual' && !row.reversed && <ReverseEntry entryId={row.id} />}
          </div>
        </Card>
      ))}
    </div>
  );
}

const CATEGORIES = ['rent', 'equipment', 'chemicals', 'depreciation', 'repair', 'other'] as const;

/** Расход: дата, сумма, категория, счёт списания, описание, чек (модуль 10). */
export function ExpenseForm({ accounts }: { accounts: readonly AccountOption[] }) {
  const t = useTranslations();
  const [state, action, isPending] = useActionState(recordExpenseAction, INITIAL);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');

  // Чек принадлежит дому счёта списания: у общего счёта дома нет (§10.1).
  const receiptHouseId = accounts.find((account) => account.id === accountId)?.houseId ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accounting.expense')}</CardTitle>
      </CardHeader>

      <form action={action} className="flex flex-col gap-4 p-4 pt-0">
        {state.error !== undefined && (
          <p className="text-danger text-[13px]" role="alert">
            {t(state.error)}
          </p>
        )}
        {state.done !== undefined && <p className="text-[13px]">{t(state.done)}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field htmlFor="expense-category" label={t('accounting.categoryField')}>
            <Select data-testid="expense-category" id="expense-category" name="category">
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`accounting.category.${category}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="expense-amount" label={t('accounting.amount')}>
            <Input
              data-testid="expense-amount"
              id="expense-amount"
              inputMode="numeric"
              name="amount"
              step={1}
              type="number"
            />
          </Field>

          <Field htmlFor="expense-account" label={t('accounting.writeOffAccount')}>
            <Select
              id="expense-account"
              name="accountId"
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
              value={accountId}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor="expense-paid-from" label={t('accounting.paidFrom')}>
            <Select id="expense-paid-from" name="paidFrom">
              <option value="cash">{t('accounting.cash')}</option>
              <option value="kaspi">Kaspi</option>
            </Select>
          </Field>

          <Field htmlFor="expense-date" label={t('accounting.date')}>
            <Input id="expense-date" name="date" type="date" />
          </Field>

          <Field htmlFor="expense-description" label={t('accounting.description')}>
            <Input data-testid="expense-description" id="expense-description" name="description" />
          </Field>

          <ReceiptUpload
            houseId={receiptHouseId}
            id="expense-receipt"
            name="receiptFileId"
            purpose="expense-receipt"
          />
        </div>

        <Button disabled={isPending} type="submit">
          {t('accounting.recordExpense')}
        </Button>
      </form>
    </Card>
  );
}

/** Калькулятор налогов: расчёт справочный и проводок не создаёт (§10.2). */
export function TaxCalculator({ view }: { view: TaxView }) {
  const t = useTranslations();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accounting.tax')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-4 p-4 pt-0">
        <form className="grid items-end gap-3 md:grid-cols-4" method="get">
          <Field htmlFor="tax-from" label={t('accounting.from')}>
            <Input defaultValue={view.from} id="tax-from" name="from" type="date" />
          </Field>
          <Field htmlFor="tax-to" label={t('accounting.to')}>
            <Input defaultValue={view.to} id="tax-to" name="to" type="date" />
          </Field>
          <Field
            hint={t('accounting.percentHint')}
            htmlFor="tax-rate"
            label={t('accounting.taxRate')}
          >
            <Input
              data-testid="tax-rate"
              defaultValue={view.taxRatePercent}
              id="tax-rate"
              inputMode="decimal"
              name="taxRate"
              step="0.01"
              type="number"
            />
          </Field>
          <Field htmlFor="acquiring-rate" label={t('accounting.acquiringRate')}>
            <Input
              defaultValue={view.acquiringRatePercent}
              id="acquiring-rate"
              inputMode="decimal"
              name="acquiringRate"
              step="0.01"
              type="number"
            />
          </Field>
          <Button size="sm" type="submit" variant="secondary">
            {t('accounting.recalculate')}
          </Button>
        </form>

        <div className="flex flex-col gap-1 text-[13px]" data-testid="tax-result">
          <div className="flex justify-between gap-4">
            <span>{t('accounting.kaspiIncome')}</span>
            <Money amount={view.income} />
          </div>
          <div className="flex justify-between gap-4">
            <span>{t('accounting.kaspiTurnover')}</span>
            <Money amount={view.turnover} />
          </div>
          <div className="flex justify-between gap-4">
            <span>{t('accounting.taxAmount')}</span>
            <Money amount={view.tax} />
          </div>
          <div className="flex justify-between gap-4">
            <span>{t('accounting.acquiringAmount')}</span>
            <Money amount={view.acquiring} />
          </div>
          <div className="flex justify-between gap-4 font-medium">
            <span>{t('accounting.deduction')}</span>
            <Money amount={view.deduction} />
          </div>
          <div className="flex justify-between gap-4">
            <span>{t('accounting.net')}</span>
            <Money amount={view.net} />
          </div>
        </div>

        {view.byHouse.length > 0 && (
          <Table
            caption={t('accounting.byHouse')}
            columns={[
              { key: 'house', header: t('accounting.house'), cell: (row) => row.houseName },
              {
                key: 'income',
                header: t('accounting.kaspiIncome'),
                numeric: true,
                cell: (row) => <Money amount={row.income} />,
              },
              {
                key: 'tax',
                header: t('accounting.taxAmount'),
                numeric: true,
                cell: (row) => <Money amount={row.tax} />,
              },
              {
                key: 'acquiring',
                header: t('accounting.acquiringAmount'),
                numeric: true,
                cell: (row) => <Money amount={row.acquiring} />,
              },
            ]}
            rowKey={(row) => row.houseId}
            rows={view.byHouse}
          />
        )}

        <p className="text-text-muted text-[13px]">{t('accounting.taxDisclaimer')}</p>
      </div>
    </Card>
  );
}
