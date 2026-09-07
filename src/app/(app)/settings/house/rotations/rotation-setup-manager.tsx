'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';

import {
  archiveChecklistAction,
  saveChecklistAction,
  saveGroupAction,
  setEligibilityAction,
  type RotationSetupActionState,
} from './actions';

const INITIAL: RotationSetupActionState = {};

const CHECKLIST_TYPES = ['regular', 'general'] as const;

type ChecklistType = (typeof CHECKLIST_TYPES)[number];

export interface ChecklistRow {
  checklistId: string;
  type: ChecklistType;
  title: string;
  items: string[];
  peopleNeeded: number;
}

export interface AreaBlock {
  areaId: string;
  name: string;
  type: 'living' | 'common';
  checklists: ChecklistRow[];
  eligibility: { regular: string[]; general: string[] };
}

export interface GroupRow {
  groupId: string;
  name: string;
  base: string;
  areaId: string | null;
  includeUserIds: string[];
  excludeUserIds: string[];
}

export interface MemberRow {
  userId: string;
  name: string;
}

export interface RotationSetupProps {
  houseId: string;
  areas: readonly AreaBlock[];
  groups: readonly GroupRow[];
  members: readonly MemberRow[];
}

/**
 * Обновление экрана после удачного действия.
 *
 * Обновляется текущий маршрут — вместе с параметром `?house=<id>`, по которому
 * раздел и открывают. Серверный `revalidatePath` такую запись кеша не трогает,
 * а сброс всего кеша перерисовывает дерево целиком и подвешивает следующее
 * нажатие. Здесь обновляется ровно то, что человек видит.
 */
function useRefreshOnDone(state: RotationSetupActionState): void {
  const router = useRouter();

  useEffect(() => {
    if (state.done !== undefined) {
      router.refresh();
    }
  }, [router, state]);
}

function Message({ state }: { state: RotationSetupActionState }) {
  const t = useTranslations();

  return (
    <>
      {state.error !== undefined && (
        <p className="text-danger text-[13px]" role="alert">
          {t(state.error)}
        </p>
      )}
      {state.done !== undefined && <p className="text-success text-[13px]">{t(state.done)}</p>}
    </>
  );
}

/** Чек-лист одного вида: название, пункты по строке и число людей на зону. */
function ChecklistForm({ area, type }: { area: AreaBlock; type: ChecklistType }) {
  const t = useTranslations('rotationSetup');
  const [saveState, save, isSaving] = useActionState(saveChecklistAction, INITIAL);
  const [archiveState, archive, isArchiving] = useActionState(archiveChecklistAction, INITIAL);

  useRefreshOnDone(saveState);
  useRefreshOnDone(archiveState);

  const checklist = area.checklists.find((item) => item.type === type);
  const id = `${area.areaId}-${type}`;

  return (
    <div className="border-border flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{t(`types.${type}`)}</span>
        {checklist === undefined ? (
          <Badge tone="neutral">{t('notSet')}</Badge>
        ) : (
          <Badge tone="info">{t('peopleShort', { count: checklist.peopleNeeded })}</Badge>
        )}
      </div>

      <form action={save} className="flex flex-col gap-2" data-testid={`checklist-form-${id}`}>
        <input name="areaId" type="hidden" value={area.areaId} />
        <input name="type" type="hidden" value={type} />

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1">
            <Field htmlFor={`title-${id}`} label={t('checklistTitle')}>
              <Input
                data-testid={`checklist-title-${id}`}
                defaultValue={checklist?.title ?? ''}
                id={`title-${id}`}
                name="title"
                required
              />
            </Field>
          </div>

          <div className="w-28">
            <Field htmlFor={`people-${id}`} label={t('peopleNeeded')}>
              <Input
                data-testid={`checklist-people-${id}`}
                defaultValue={checklist?.peopleNeeded ?? 1}
                id={`people-${id}`}
                min={1}
                name="peopleNeeded"
                required
                step={1}
                type="number"
              />
            </Field>
          </div>
        </div>

        <Field hint={t('itemsHint')} htmlFor={`items-${id}`} label={t('items')}>
          <Textarea
            data-testid={`checklist-items-${id}`}
            defaultValue={(checklist?.items ?? []).join('\n')}
            id={`items-${id}`}
            name="items"
            rows={3}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button
            data-testid={`checklist-save-${id}`}
            disabled={isSaving}
            size="sm"
            type="submit"
            variant="secondary"
          >
            {t('save')}
          </Button>
        </div>
      </form>

      <Message state={saveState} />

      {checklist !== undefined && (
        <form action={archive}>
          <input name="checklistId" type="hidden" value={checklist.checklistId} />
          <Button
            data-testid={`checklist-archive-${id}`}
            disabled={isArchiving}
            size="sm"
            type="submit"
            variant="ghost"
          >
            {t('archiveChecklist')}
          </Button>
        </form>
      )}

      <Message state={archiveState} />
    </div>
  );
}

/** Кто допущен к зоне по этому виду уборки: отмеченные группы дома. */
function EligibilityForm({
  area,
  groups,
  type,
}: {
  area: AreaBlock;
  groups: readonly GroupRow[];
  type: ChecklistType;
}) {
  const t = useTranslations('rotationSetup');
  const [state, submit, isPending] = useActionState(setEligibilityAction, INITIAL);

  useRefreshOnDone(state);

  const chosen = new Set(area.eligibility[type]);
  const id = `${area.areaId}-${type}`;

  if (groups.length === 0) {
    return null;
  }

  return (
    <form action={submit} className="flex flex-col gap-2" data-testid={`eligibility-form-${id}`}>
      <input name="areaId" type="hidden" value={area.areaId} />
      <input name="checklistType" type="hidden" value={type} />

      <span className="text-text-muted text-[13px]">
        {t('eligibility', { kind: t(`types.${type}`) })}
      </span>

      <div className="flex flex-wrap gap-3">
        {groups.map((group) => (
          <label className="flex items-center gap-2 text-[13px]" key={group.groupId}>
            <input
              className="accent-primary size-4"
              data-testid={`eligibility-${id}-${group.groupId}`}
              defaultChecked={chosen.has(group.groupId)}
              name="groupIds"
              type="checkbox"
              value={group.groupId}
            />
            {group.name}
          </label>
        ))}
      </div>

      <div>
        <Button
          data-testid={`eligibility-save-${id}`}
          disabled={isPending}
          size="sm"
          type="submit"
          variant="ghost"
        >
          {t('saveEligibility')}
        </Button>
      </div>

      <Message state={state} />
    </form>
  );
}

/** Группа допуска: основа, комната для основы «жильцы комнаты» и два списка. */
function GroupForm({
  areas,
  group,
  houseId,
  members,
}: {
  areas: readonly AreaBlock[];
  group: GroupRow | null;
  houseId: string;
  members: readonly MemberRow[];
}) {
  const t = useTranslations('rotationSetup');
  const [state, submit, isPending] = useActionState(saveGroupAction, INITIAL);
  const [base, setBase] = useState(group?.base ?? 'all');

  useRefreshOnDone(state);

  const id = group?.groupId ?? 'new';
  const included = new Set(group?.includeUserIds ?? []);
  const excluded = new Set(group?.excludeUserIds ?? []);

  return (
    <form action={submit} className="flex flex-col gap-2" data-testid={`group-form-${id}`}>
      <input name="houseId" type="hidden" value={houseId} />
      <input name="groupId" type="hidden" value={group?.groupId ?? ''} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <Field htmlFor={`group-name-${id}`} label={t('groupName')}>
            <Input
              data-testid={`group-name-${id}`}
              defaultValue={group?.name ?? ''}
              id={`group-name-${id}`}
              name="name"
              required
            />
          </Field>
        </div>

        <div className="w-44">
          <Field htmlFor={`group-base-${id}`} label={t('groupBase')}>
            <Select
              data-testid={`group-base-${id}`}
              id={`group-base-${id}`}
              name="base"
              onChange={(event) => {
                setBase(event.target.value);
              }}
              value={base}
            >
              <option value="all">{t('bases.all')}</option>
              <option value="male">{t('bases.male')}</option>
              <option value="female">{t('bases.female')}</option>
              <option value="room">{t('bases.room')}</option>
            </Select>
          </Field>
        </div>

        {base === 'room' && (
          <div className="w-48">
            <Field htmlFor={`group-area-${id}`} label={t('groupRoom')}>
              <Select
                data-testid={`group-area-${id}`}
                defaultValue={group?.areaId ?? ''}
                id={`group-area-${id}`}
                name="ruleAreaId"
              >
                <option value="">{t('chooseRoom')}</option>
                {areas
                  .filter((area) => area.type === 'living')
                  .map((area) => (
                    <option key={area.areaId} value={area.areaId}>
                      {area.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
      </div>

      {members.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          <fieldset className="flex flex-col gap-1">
            <legend className="text-text-muted text-[13px]">{t('include')}</legend>
            {members.map((member) => (
              <label className="flex items-center gap-2 text-[13px]" key={`in-${member.userId}`}>
                <input
                  className="accent-primary size-4"
                  data-testid={`group-include-${id}-${member.userId}`}
                  defaultChecked={included.has(member.userId)}
                  name="includeUserIds"
                  type="checkbox"
                  value={member.userId}
                />
                {member.name}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-text-muted text-[13px]">{t('exclude')}</legend>
            {members.map((member) => (
              <label className="flex items-center gap-2 text-[13px]" key={`out-${member.userId}`}>
                <input
                  className="accent-primary size-4"
                  data-testid={`group-exclude-${id}-${member.userId}`}
                  defaultChecked={excluded.has(member.userId)}
                  name="excludeUserIds"
                  type="checkbox"
                  value={member.userId}
                />
                {member.name}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      <div>
        <Button
          data-testid={`group-save-${id}`}
          disabled={isPending}
          size="sm"
          type="submit"
          variant={group === null ? 'primary' : 'secondary'}
        >
          {group === null ? t('addGroup') : t('save')}
        </Button>
      </div>

      <Message state={state} />
    </form>
  );
}

export function RotationSetupManager({ areas, groups, houseId, members }: RotationSetupProps) {
  const t = useTranslations('rotationSetup');

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('groupsTitle')}</CardTitle>
        </CardHeader>

        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <GroupForm
              areas={areas}
              group={group}
              houseId={houseId}
              key={group.groupId}
              members={members}
            />
          ))}

          <div className="border-border border-t pt-4">
            <p className="text-text-muted mb-2 text-[13px]">{t('addGroupTitle')}</p>
            <GroupForm areas={areas} group={null} houseId={houseId} members={members} />
          </div>
        </div>
      </Card>

      {areas.length === 0 ? (
        <EmptyState description={t('emptyHint')} title={t('empty')} />
      ) : (
        areas.map((area) => (
          <Card key={area.areaId}>
            <CardHeader>
              <CardTitle>{area.name}</CardTitle>
            </CardHeader>

            <div className="flex flex-col gap-4">
              {CHECKLIST_TYPES.map((type) => (
                <div className="flex flex-col gap-3" key={type}>
                  <ChecklistForm area={area} type={type} />
                  <EligibilityForm area={area} groups={groups} type={type} />
                </div>
              ))}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
