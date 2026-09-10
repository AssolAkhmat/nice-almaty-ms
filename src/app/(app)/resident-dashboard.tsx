'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { AppLink } from '@/components/ui/app-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';

import { confirmAction, type CalendarActionState } from './rotations/actions';

const INITIAL: CalendarActionState = {};

export interface DashboardCleaning {
  assignmentId: string;
  date: string;
  areaName: string;
  checklistTitle: string;
  canConfirm: boolean;
  confirmed: boolean;
}

export interface DashboardInvoiceView {
  invoiceId: string;
  total: number;
  remaining: number;
  dueDate: string;
  overdue: boolean;
}

export interface DashboardAttention {
  /** Название документа уже выбрано в языке читающего. */
  title: string;
  reason: 'rejected' | 'expiring' | 'expired' | 'missing';
  daysLeft: number | null;
}

export interface ResidentDashboardProps {
  cleaning: DashboardCleaning | null;
  invoice: DashboardInvoiceView | null;
  deposit: { balance: number; transactions: { id: string; type: string; amount: number }[] };
  rating: { value: number | null; visible: boolean; debts: number };
  attention: { documents: DashboardAttention[]; steps: string[] };
}

/** Подтверждение прямо с дэшборда: без фото, для фото есть календарь (§6.4). */
function ConfirmCleaning({ assignmentId }: { assignmentId: string }) {
  const t = useTranslations('home.cleaning');
  const router = useRouter();
  const [state, action, pending] = useActionState(confirmAction, INITIAL);

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input name="assignmentId" type="hidden" value={assignmentId} />
      <Button data-testid="dashboard-confirm" disabled={pending} size="sm" type="submit">
        {t('confirm')}
      </Button>
      <AppLink className="text-accent text-[13px] underline" href="/rotations?mode=day">
        {t('withPhoto')}
      </AppLink>
    </form>
  );
}

export function ResidentDashboard({
  attention,
  cleaning,
  deposit,
  invoice,
  rating,
}: ResidentDashboardProps) {
  const t = useTranslations('home');
  /* Названия движений депозита и шагов заселения уже есть в своих разделах. */
  const tMovement = useTranslations('deposit.movement');
  const tStep = useTranslations('onboarding.steps');

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card data-testid="card-cleaning">
        <CardHeader>
          <CardTitle>{t('cleaning.title')}</CardTitle>
        </CardHeader>

        {cleaning === null ? (
          <EmptyState title={t('cleaning.none')} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-[15px] font-medium">{cleaning.date}</span>
              <span className="text-text-muted text-[13px]">
                {cleaning.areaName} · {cleaning.checklistTitle}
              </span>
            </div>

            {cleaning.confirmed ? (
              <Badge tone="success">{t('cleaning.confirmed')}</Badge>
            ) : cleaning.canConfirm ? (
              <ConfirmCleaning assignmentId={cleaning.assignmentId} />
            ) : (
              <AppLink className="text-accent text-[13px] underline" href="/rotations">
                {t('cleaning.withPhoto')}
              </AppLink>
            )}
          </div>
        )}
      </Card>

      <Card data-testid="card-absence">
        <CardHeader>
          <CardTitle>{t('absence.title')}</CardTitle>
        </CardHeader>

        <div className="flex flex-col items-start gap-3">
          <p className="text-text-muted text-[13px]">{t('absence.hint')}</p>
          <AppLink
            className="bg-primary text-primary-fg rounded-control flex h-11 items-center px-4 text-[15px] font-medium"
            data-testid="dashboard-absence"
            href="/absences"
          >
            {t('absence.action')}
          </AppLink>
        </div>
      </Card>

      <Card data-testid="card-invoice">
        <CardHeader>
          <CardTitle>{t('invoice.title')}</CardTitle>
        </CardHeader>

        {invoice === null ? (
          <EmptyState title={t('invoice.none')} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-muted text-[13px]">{t('invoice.remaining')}</span>
              <Money amount={invoice.remaining} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-muted text-[13px]">{t('invoice.due')}</span>
              <span className="tabular text-[13px]">{invoice.dueDate}</span>
            </div>
            {invoice.overdue && <Badge tone="danger">{t('invoice.overdue')}</Badge>}
            <AppLink className="text-accent text-[13px] underline" href="/invoices">
              {t('invoice.open')}
            </AppLink>
          </div>
        )}
      </Card>

      <Card data-testid="card-deposit">
        <CardHeader>
          <CardTitle>{t('deposit.title')}</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-[13px]">{t('deposit.balance')}</span>
            <Money amount={deposit.balance} />
          </div>

          {deposit.transactions.length === 0 ? (
            <p className="text-text-muted text-[13px]">{t('deposit.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {deposit.transactions.map((transaction) => (
                <li className="flex items-center justify-between gap-3" key={transaction.id}>
                  <span className="text-text-muted text-[13px]">{tMovement(transaction.type)}</span>
                  <Money amount={transaction.amount} />
                </li>
              ))}
            </ul>
          )}

          <AppLink className="text-accent text-[13px] underline" href="/deposit">
            {t('deposit.open')}
          </AppLink>
        </div>
      </Card>

      <Card data-testid="card-rating">
        <CardHeader>
          <CardTitle>{t('rating.title')}</CardTitle>
        </CardHeader>

        {rating.visible && rating.value !== null ? (
          <p className="tabular text-[28px] font-semibold" data-testid="dashboard-rating">
            {rating.value}
          </p>
        ) : (
          <p className="text-text-muted text-[13px]">{t('rating.hidden')}</p>
        )}

        <p className="text-text-muted mt-2 text-[13px]" data-testid="dashboard-debts">
          {rating.debts < 0
            ? t('rating.reserve', { count: -rating.debts })
            : t('rating.debts', { count: rating.debts })}
        </p>
      </Card>

      <Card data-testid="card-attention">
        <CardHeader>
          <CardTitle>{t('attention.title')}</CardTitle>
        </CardHeader>

        {attention.documents.length === 0 && attention.steps.length === 0 ? (
          <p className="text-text-muted text-[13px]">{t('attention.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {attention.documents.map((document) => (
              <li
                className="flex flex-wrap items-center gap-2"
                key={`${document.title}-${document.reason}`}
              >
                <Badge tone={document.reason === 'expiring' ? 'warning' : 'danger'}>
                  {document.reason === 'expiring'
                    ? t('attention.reasons.expiring', { days: document.daysLeft ?? 0 })
                    : t(`attention.reasons.${document.reason}`)}
                </Badge>
                <span className="text-[13px]">{document.title}</span>
              </li>
            ))}

            {attention.steps.map((step) => (
              <li className="flex flex-wrap items-center gap-2" key={step}>
                <Badge tone="warning">{t('attention.step')}</Badge>
                <span className="text-[13px]">{tStep(step)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
