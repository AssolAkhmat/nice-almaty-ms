'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

import { previewTemplateAction, saveTemplateAction, type TemplateActionState } from './actions';

const INITIAL: TemplateActionState = {};

export function TemplateEditor({
  name,
  bodyHtml,
  tokens,
  version,
  canManage,
}: {
  name: string;
  bodyHtml: string;
  tokens: readonly string[];
  version: number;
  canManage: boolean;
}) {
  const t = useTranslations();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(bodyHtml);

  const [saveState, saveAction, isSavePending] = useActionState(saveTemplateAction, INITIAL);
  const [previewState, previewAction, isPreviewPending] = useActionState(
    previewTemplateAction,
    INITIAL,
  );

  /** Вставка токена туда, где стоит курсор: искать место руками — лишняя работа. */
  function insertToken(token: string): void {
    const field = bodyRef.current;

    if (field === null) {
      setBody((current) => `${current}{{${token}}}`);

      return;
    }

    const start = field.selectionStart;
    const end = field.selectionEnd;
    const next = `${body.slice(0, start)}{{${token}}}${body.slice(end)}`;

    setBody(next);

    // Курсор остаётся сразу за вставленным токеном, чтобы писать дальше.
    requestAnimationFrame(() => {
      const position = start + token.length + 4;
      field.focus();
      field.setSelectionRange(position, position);
    });
  }

  const states = [saveState, previewState];

  return (
    <div className="flex flex-col gap-4">
      {states.map((state, index) => (
        <div key={index}>
          {state.done !== undefined ? (
            <p className="text-success text-[13px]" role="status">
              {t(state.done)}
            </p>
          ) : null}
          {state.error !== undefined ? (
            <p className="text-danger text-[13px]" data-testid="template-error" role="alert">
              {t(state.error)}
              {state.tokens === undefined ? null : ` ${state.tokens.join(', ')}`}
            </p>
          ) : null}
        </div>
      ))}

      <p className="text-text-muted text-[13px]" data-testid="template-version">
        {t('contractTemplate.version', { version })}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>{t('contractTemplate.palette.title')}</CardTitle>
        </CardHeader>

        <p className="text-text-muted mb-3 text-[13px]">{t('contractTemplate.palette.hint')}</p>

        <div className="flex flex-wrap gap-2">
          {tokens.map((token) => (
            <Button
              data-testid={`token-${token}`}
              disabled={!canManage}
              key={token}
              onClick={() => {
                insertToken(token);
              }}
              size="sm"
              variant="secondary"
            >
              {token}
            </Button>
          ))}
        </div>
      </Card>

      <form action={saveAction} className="flex flex-col gap-3">
        <Field htmlFor="template-name" label={t('contractTemplate.fields.name')}>
          <Input
            data-testid="template-name"
            defaultValue={name}
            disabled={!canManage}
            id="template-name"
            name="name"
            required
          />
        </Field>

        <Field
          hint={t('contractTemplate.fields.bodyHint')}
          htmlFor="template-body"
          label={t('contractTemplate.fields.body')}
        >
          <textarea
            className="border-border bg-surface text-text rounded-control min-h-72 w-full border p-3 font-mono text-[13px]"
            data-testid="template-body"
            disabled={!canManage}
            id="template-body"
            name="bodyHtml"
            onChange={(event) => {
              setBody(event.target.value);
            }}
            ref={bodyRef}
            value={body}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button data-testid="template-save" disabled={!canManage || isSavePending} type="submit">
            {isSavePending ? t('common.loading') : t('contractTemplate.actions.save')}
          </Button>

          <Button
            data-testid="template-preview"
            disabled={isPreviewPending}
            formAction={previewAction}
            type="submit"
            variant="secondary"
          >
            {isPreviewPending ? t('common.loading') : t('contractTemplate.actions.preview')}
          </Button>
        </div>
      </form>

      {previewState.preview === undefined ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{t('contractTemplate.preview.title')}</CardTitle>
          </CardHeader>

          <p className="text-text-muted mb-3 text-[13px]">{t('contractTemplate.preview.hint')}</p>

          {/*
           * Разметку писал суперадмин, значения токенов подставлены с экранированием
           * (`src/domain/contract-template.ts`) — это ровно тот HTML, который уйдёт в PDF.
           */}
          <div
            className="prose-contract border-border rounded-control border p-4"
            dangerouslySetInnerHTML={{ __html: previewState.preview }}
            data-testid="template-preview-result"
          />
        </Card>
      )}
    </div>
  );
}
