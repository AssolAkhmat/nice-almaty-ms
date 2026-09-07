'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Money } from '@/components/ui/money';

import {
  closeAuditAction,
  consumeAction,
  receiveAction,
  saveAuditLineAction,
  startAuditAction,
  transferAction,
  type InventoryActionState,
} from './actions';

const INITIAL: InventoryActionState = {};

export interface InventoryRow {
  itemId: string;
  name: string;
  qty: string;
  unit: string;
  unitCost: number;
  status: 'in_use' | 'written_off';
  note: string | null;
}

export interface AuditLineRow {
  itemId: string;
  name: string;
  unit: string;
  expectedQty: string;
  actualQty: string | null;
  difference: string | null;
  comment: string | null;
}

export interface InventoryViewProps {
  houseId: string;
  houses: { id: string; name: string }[];
  items: InventoryRow[];
  audit: { auditId: string; date: string; lines: AuditLineRow[] } | null;
}

function Message({ state }: { state: InventoryActionState }) {
  const t = useTranslations();

  return (
    <>
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && (
        <p className="text-success text-[13px]">
          {state.adjusted === undefined ? t(state.done) : t(state.done, { count: state.adjusted })}
        </p>
      )}
    </>
  );
}

function useRefreshOnDone(state: InventoryActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

function ReceiveForm({ houseId }: { houseId: string }) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(receiveAction, INITIAL);

  useRefreshOnDone(state);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="houseId" type="hidden" value={houseId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('name')}>
          <Input data-testid="item-name" name="name" required />
        </Field>
        <Field label={t('qty')}>
          <Input data-testid="item-qty" inputMode="decimal" name="qty" required />
        </Field>
        <Field label={t('unit')}>
          <Input data-testid="item-unit" name="unit" required />
        </Field>
        <Field label={t('unitCost')}>
          <Input data-testid="item-cost" inputMode="numeric" name="unitCost" />
        </Field>
      </div>

      <Field label={t('note')}>
        <Input name="note" />
      </Field>

      <div className="flex items-center gap-3">
        <Button data-testid="item-add" disabled={pending} type="submit">
          {t('add')}
        </Button>
        <Message state={state} />
      </div>
    </form>
  );
}

function ItemActions({
  item,
  houses,
}: {
  item: InventoryRow;
  houses: { id: string; name: string }[];
}) {
  const t = useTranslations('inventory');
  const [consumeState, consume, consuming] = useActionState(consumeAction, INITIAL);
  const [transferState, transfer, transferring] = useActionState(transferAction, INITIAL);

  useRefreshOnDone(consumeState);
  useRefreshOnDone(transferState);

  return (
    <div className="flex flex-col gap-2">
      <form action={consume} className="flex flex-wrap items-end gap-2">
        <input name="itemId" type="hidden" value={item.itemId} />
        <Field label={t('qty')}>
          <Input
            className="w-24"
            data-testid={`consume-qty-${item.itemId}`}
            inputMode="decimal"
            name="qty"
            required
          />
        </Field>
        <Field label={t('status')}>
          <Select defaultValue="out" name="type">
            <option value="out">{t('consume')}</option>
            <option value="write_off">{t('writeOff')}</option>
          </Select>
        </Field>
        <Button disabled={consuming} size="sm" type="submit" variant="secondary">
          {t('consume')}
        </Button>
        <Message state={consumeState} />
      </form>

      {houses.length > 1 && (
        <form action={transfer} className="flex flex-wrap items-end gap-2">
          <input name="itemId" type="hidden" value={item.itemId} />
          <Field label={t('toHouse')}>
            <Select name="toHouseId">
              {houses.map((house) => (
                <option key={house.id} value={house.id}>
                  {house.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button disabled={transferring} size="sm" type="submit" variant="secondary">
            {t('transfer')}
          </Button>
          <Message state={transferState} />
        </form>
      )}
    </div>
  );
}

function AuditLine({ auditId, line }: { auditId: string; line: AuditLineRow }) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(saveAuditLineAction, INITIAL);

  useRefreshOnDone(state);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="auditId" type="hidden" value={auditId} />
      <input name="itemId" type="hidden" value={line.itemId} />

      <span className="min-w-32 text-[13px] font-medium">{line.name}</span>
      <span className="tabular text-text-muted text-[13px]">
        {t('expected')}: {line.expectedQty}
      </span>

      <Field label={t('actual')}>
        <Input
          className="w-24"
          data-testid={`audit-actual-${line.itemId}`}
          defaultValue={line.actualQty ?? ''}
          inputMode="decimal"
          name="actualQty"
        />
      </Field>

      <Field label={t('comment')}>
        <Input className="w-40" defaultValue={line.comment ?? ''} name="comment" />
      </Field>

      {line.difference !== null && (
        <Badge tone={line.difference.startsWith('-') ? 'danger' : 'success'}>
          {t('difference')}: {line.difference}
        </Badge>
      )}

      <Button disabled={pending} size="sm" type="submit" variant="secondary">
        {t('save')}
      </Button>
      <Message state={state} />
    </form>
  );
}

function AuditPanel({ audit, houseId }: { audit: InventoryViewProps['audit']; houseId: string }) {
  const t = useTranslations('inventory');
  const [startState, start, starting] = useActionState(startAuditAction, INITIAL);
  const [closeState, close, closing] = useActionState(closeAuditAction, INITIAL);

  useRefreshOnDone(startState);
  useRefreshOnDone(closeState);

  return (
    <Card data-testid="audit-panel">
      <CardHeader>
        <CardTitle>{t('auditTitle')}</CardTitle>
      </CardHeader>

      {audit === null ? (
        <form action={start} className="flex flex-wrap items-center gap-3">
          <input name="houseId" type="hidden" value={houseId} />
          <p className="text-text-muted text-[13px]">{t('auditNone')}</p>
          <Button data-testid="audit-start" disabled={starting} size="sm" type="submit">
            {t('auditStart')}
          </Button>
          <Message state={startState} />
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <span className="tabular text-text-muted text-[13px]">{audit.date}</span>

          {audit.lines.map((line) => (
            <AuditLine auditId={audit.auditId} key={line.itemId} line={line} />
          ))}

          <form action={close} className="flex flex-wrap items-center gap-3">
            <input name="auditId" type="hidden" value={audit.auditId} />
            <Button data-testid="audit-close" disabled={closing} size="sm" type="submit">
              {t('auditClose')}
            </Button>
            <Message state={closeState} />
          </form>
        </div>
      )}
    </Card>
  );
}

export function InventoryView({ audit, houseId, houses, items }: InventoryViewProps) {
  const t = useTranslations('inventory');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('add')}</CardTitle>
        </CardHeader>
        <ReceiveForm houseId={houseId} />
      </Card>

      <Card data-testid="inventory-list">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>

        <div className="mb-3 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-text-muted">{t('export')}</span>
          <a
            className="text-accent underline"
            data-testid="export-csv"
            href={`/api/v1/inventory/export?house=${houseId}&format=csv`}
          >
            {t('exportCsv')}
          </a>
          <a
            className="text-accent underline"
            data-testid="export-xlsx"
            href={`/api/v1/inventory/export?house=${houseId}&format=xlsx`}
          >
            {t('exportXlsx')}
          </a>
        </div>

        {items.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          <ul className="flex flex-col gap-4">
            {items.map((item) => (
              <li className="flex flex-col gap-2" key={item.itemId}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[15px] font-medium">{item.name}</span>
                  <span className="tabular text-[13px]">
                    {item.qty} {item.unit}
                  </span>
                  <Money amount={item.unitCost} />
                  <Badge tone={item.status === 'in_use' ? 'neutral' : 'warning'}>
                    {t(`statuses.${item.status}`)}
                  </Badge>
                </div>

                {item.status === 'in_use' && <ItemActions houses={houses} item={item} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AuditPanel audit={audit} houseId={houseId} />
    </div>
  );
}
