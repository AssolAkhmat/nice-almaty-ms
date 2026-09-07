'use client';

import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useActionState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { parseInstant } from '@/lib/time';

import { markReceivedAction, markSentAction, type RemoteActionState } from './actions';

export interface RemoteTaskView {
  invoiceId: string;
  residentName: string;
  periodMonth: string | null;
  dueDate: string | null;
  total: number;
  remaining: number;
  overdue: boolean;
  sent: boolean;
}

const INITIAL: RemoteActionState = {};

function TaskCard({ task }: { task: RemoteTaskView }) {
  const t = useTranslations();
  const format = useFormatter();
  const [sentState, sentAction, isSending] = useActionState(markSentAction, INITIAL);
  const [paidState, paidAction, isPaying] = useActionState(markReceivedAction, INITIAL);

  return (
    <Card data-testid="remote-task">
      <CardHeader>
        <CardTitle>
          <Link className="hover:underline" href={`/invoices/${task.invoiceId}`}>
            {task.residentName}
          </Link>
        </CardTitle>
        <Money amount={task.remaining} />
      </CardHeader>

      <div className="flex flex-col gap-3 p-4 pt-0 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={task.sent ? 'success' : 'info'}>
            {task.sent ? t('invoices.remote.sent') : t('invoices.remote.notSent')}
          </Badge>
          {task.overdue && <Badge tone="danger">{t('invoices.overdue')}</Badge>}
          {task.dueDate !== null && (
            <span className="text-text-muted">
              {t('invoices.remote.due', {
                date: format.dateTime(parseInstant(`${task.dueDate}T00:00:00+05:00`), {
                  day: '2-digit',
                  month: '2-digit',
                }),
              })}
            </span>
          )}
        </div>

        {[sentState, paidState].map((state, index) =>
          state.error === undefined ? null : (
            <p className="text-danger" key={String(index)} role="alert">
              {t(state.error)}
            </p>
          ),
        )}

        <div className="flex flex-wrap gap-2">
          {!task.sent && (
            <form action={sentAction}>
              <input name="invoiceId" type="hidden" value={task.invoiceId} />
              <Button disabled={isSending} size="sm" type="submit" variant="secondary">
                {t('invoices.remote.markSent')}
              </Button>
            </form>
          )}

          <form action={paidAction}>
            <input name="invoiceId" type="hidden" value={task.invoiceId} />
            <input name="amount" type="hidden" value={task.remaining} />
            <Button data-testid="remote-received" disabled={isPaying} size="sm" type="submit">
              {t('invoices.remote.markReceived')}
            </Button>
          </form>
        </div>
      </div>
    </Card>
  );
}

export function RemoteList({ tasks }: { tasks: readonly RemoteTaskView[] }) {
  const t = useTranslations();

  if (tasks.length === 0) {
    return (
      <EmptyState description={t('invoices.remote.emptyHint')} title={t('invoices.remote.empty')} />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {tasks.map((task) => (
        <TaskCard key={task.invoiceId} task={task} />
      ))}
    </div>
  );
}
