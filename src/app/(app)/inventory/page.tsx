import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AppLink } from '@/components/ui/app-link';
import { EmptyState } from '@/components/ui/empty-state';
import { listHouses } from '@/db/repositories/houses';
import { listAudits } from '@/db/repositories/inventory';
import { can } from '@/lib/authz';
import { getCurrentSession } from '@/lib/session';
import { listInventory } from '@/services/inventory';
import { readAuditSheet } from '@/services/inventory-audit';

import { InventoryView, type AuditLineRow, type InventoryRow } from './inventory-view';

import type { UserActor } from '@/services/users';

export const dynamic = 'force-dynamic';

/**
 * Инвентарь дома (docs/04-MODULES/10-accounting-inventory.md, «Инвентарь»).
 *
 * Админ ведёт свой дом, суперадмин выбирает — как на остальных экранах.
 * Незакрытая ведомость показывается сразу: инвентаризацию не начинают
 * дважды, а брошенная посреди дела должна быть видна.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ house?: string }>;
}) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect('/login');
  }

  const { context } = session;

  if (!can(context, 'inventory.read', { houseId: context.houseId })) {
    redirect('/');
  }

  const t = await getTranslations('inventory');
  const actor: UserActor = { context };

  const houses = context.role === 'superadmin' ? await listHouses(context) : [];
  const requested = (await searchParams).house;
  const houseId =
    context.role === 'superadmin' ? (requested ?? houses[0]?.id ?? null) : context.houseId;

  const header = (
    <div className="flex flex-col gap-1">
      <h1>{t('title')}</h1>
      <p className="text-text-muted text-[13px]">{t('subtitle')}</p>
    </div>
  );

  if (houseId === null) {
    return (
      <section className="flex flex-col gap-6">
        {header}
        <EmptyState title={t('empty')} />
      </section>
    );
  }

  const [items, audits] = await Promise.all([
    listInventory(actor, { houseId }),
    listAudits(context, houseId),
  ]);

  const open = audits.find((audit) => audit.status === 'draft');
  const sheet = open === undefined ? null : await readAuditSheet(actor, open.id);

  const rows: InventoryRow[] = items.map((item) => ({
    itemId: item.id,
    name: item.name,
    qty: item.qty,
    unit: item.unit,
    unitCost: item.unitCost,
    status: item.status,
    note: item.note,
  }));

  const auditLines: AuditLineRow[] =
    sheet === null
      ? []
      : sheet.lines.map((line) => ({
          itemId: line.itemId,
          name: line.name,
          unit: line.unit,
          expectedQty: line.expectedQty,
          actualQty: line.actualQty,
          difference: line.difference,
          comment: line.comment,
        }));

  return (
    <section className="flex flex-col gap-6">
      {header}

      {houses.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-[13px]">
          {houses.map((house) => (
            <AppLink
              className={
                house.id === houseId ? 'text-text font-medium' : 'text-text-muted hover:text-text'
              }
              data-testid={`house-${house.id}`}
              href={{ pathname: '/inventory', query: { house: house.id } }}
              key={house.id}
            >
              {house.name}
            </AppLink>
          ))}
        </nav>
      )}

      <InventoryView
        audit={
          sheet === null
            ? null
            : { auditId: sheet.audit.id, date: sheet.audit.date, lines: auditLines }
        }
        houseId={houseId}
        houses={houses.map((house) => ({ id: house.id, name: house.name }))}
        items={rows}
      />
    </section>
  );
}
