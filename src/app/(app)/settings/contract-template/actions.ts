'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { AppError, ValidationError } from '@/lib/errors';
import { getCurrentSession } from '@/lib/session';
import { previewContractTemplate, saveContractTemplate } from '@/services/contract-templates';

export interface TemplateActionState {
  error?: string;
  /** Токены, которых нет в палитре: их называют по именам. */
  tokens?: string[];
  done?: string;
  preview?: string;
}

function textField(formData: FormData, name: string): string {
  const value = formData.get(name);

  return typeof value === 'string' ? value : '';
}

async function actorFromSession() {
  const session = await getCurrentSession();
  if (session === null) {
    return null;
  }

  const store = await headers();

  return {
    context: session.context,
    ip: store.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
  };
}

function toErrorState(error: unknown): TemplateActionState {
  if (error instanceof ValidationError) {
    const tokens = (error.details as { tokens?: string[] } | undefined)?.tokens;

    return {
      error: `contractTemplate.errors.${error.message}`,
      ...(tokens === undefined ? {} : { tokens }),
    };
  }

  if (error instanceof AppError) {
    return { error: `contractTemplate.errors.${error.code}` };
  }

  throw error;
}

export async function saveTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'contractTemplate.errors.unauthorized' };
  }

  try {
    await saveContractTemplate(actor, {
      name: textField(formData, 'name'),
      bodyHtml: textField(formData, 'bodyHtml'),
    });

    revalidatePath('/settings/contract-template');

    return { done: 'contractTemplate.done.saved' };
  } catch (error) {
    return toErrorState(error);
  }
}

export async function previewTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const actor = await actorFromSession();
  if (actor === null) {
    return { error: 'contractTemplate.errors.unauthorized' };
  }

  try {
    return { preview: await previewContractTemplate(actor, textField(formData, 'bodyHtml')) };
  } catch (error) {
    return toErrorState(error);
  }
}
