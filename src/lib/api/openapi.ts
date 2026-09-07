import { z } from 'zod';

import { SESSION_COOKIE_NAME } from '@/lib/session-token';

import type { ApiScope } from '@/domain/api-scopes';

/**
 * Спецификация REST (docs/06-API.md).
 *
 * Схемы описаны на zod и превращаются в JSON Schema его же средствами:
 * `z.toJSONSchema` появился в zod 4, и отдельная библиотека для этого
 * больше не нужна. Один источник правды на проверку входа и на описание
 * снаружи — иначе документация начинает расходиться с кодом молча.
 */
const houseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  address: z.string().nullable(),
});

const bedSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  number: z.number().int(),
  tier: z.enum(['upper', 'lower']),
  area_id: z.uuid(),
  area_name: z.string().nullable(),
  default_price: z.number().int(),
  occupied: z.boolean(),
});

const assignmentSchema = z.object({
  id: z.uuid(),
  state: z.enum(['assigned', 'confirmed', 'missed', 'needs_reassignment', 'cancelled']),
  user_id: z.uuid().nullable(),
  user_name: z.string().nullable(),
});

const occurrenceSchema = z.object({
  id: z.uuid(),
  date: z.string(),
  status: z.enum(['scheduled', 'done', 'missed', 'cancelled']),
  type: z.enum(['regular', 'general', 'extra']),
  area_id: z.uuid(),
  area_name: z.string().nullable(),
  assignments: z.array(assignmentSchema),
});

const invoiceSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  house_id: z.uuid(),
  type: z.string(),
  status: z.string(),
  period_month: z.string().nullable(),
  due_date: z.string().nullable(),
  total: z.number().int(),
  paid: z.number().int(),
  remaining: z.number().int(),
  overdue: z.boolean(),
});

const confirmationSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  confirmed_at: z.string().nullable(),
  done_at: z.string().nullable(),
});

const errorSchema = z.object({
  error: z.object({
    code: z.enum([
      'unauthorized',
      'forbidden',
      'not_found',
      'validation_error',
      'conflict',
      'rate_limited',
      'internal',
    ]),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  request_id: z.string(),
});

interface Operation {
  method: 'get' | 'post';
  summary: string;
  /** Скоуп токена; у служебных маршрутов его нет. */
  scope?: ApiScope;
  parameters?: { name: string; in: 'path' | 'query'; required: boolean; description: string }[];
  response: z.ZodType;
}

/**
 * Маршруты, описанные снаружи.
 *
 * Задания планировщика сюда не входят намеренно: они не часть API для
 * ботов, защищены отдельным секретом и вызываются расписанием. Документ,
 * который их перечисляет, приглашал бы дёрнуть их руками.
 */
export const API_OPERATIONS: Readonly<Record<string, Operation[]>> = {
  '/houses': [
    {
      method: 'get',
      summary: 'Дома сети',
      scope: 'houses:read',
      response: z.object({ data: z.array(houseSchema) }),
    },
  ],
  '/houses/{id}/beds': [
    {
      method: 'get',
      summary: 'Места дома и их занятость на дату',
      scope: 'beds:read',
      parameters: [
        { name: 'id', in: 'path', required: true, description: 'Дом' },
        {
          name: 'date',
          in: 'query',
          required: false,
          description: 'Дата в формате YYYY-MM-DD; по умолчанию сегодня по Алматы',
        },
      ],
      response: z.object({ data: z.array(bedSchema), date: z.string() }),
    },
  ],
  '/rotations': [
    {
      method: 'get',
      summary: 'Ротации дня',
      scope: 'rotations:read',
      parameters: [
        {
          name: 'house_id',
          in: 'query',
          required: false,
          description: 'Дом; обязателен для суперадмина — у сети домов больше одного',
        },
        { name: 'date', in: 'query', required: false, description: 'Дата, по умолчанию сегодня' },
      ],
      response: z.object({
        data: z.array(occurrenceSchema),
        house_id: z.uuid().nullable(),
        date: z.string(),
      }),
    },
  ],
  '/rotations/{id}/confirm': [
    {
      method: 'post',
      summary: 'Подтверждение своей уборки',
      scope: 'rotations:write',
      parameters: [{ name: 'id', in: 'path', required: true, description: 'Назначение' }],
      response: confirmationSchema,
    },
  ],
  '/invoices': [
    {
      method: 'get',
      summary: 'Счета',
      scope: 'invoices:read',
      parameters: [
        { name: 'house_id', in: 'query', required: false, description: 'Дом' },
        { name: 'month', in: 'query', required: false, description: 'Первое число месяца' },
      ],
      response: z.object({ data: z.array(invoiceSchema) }),
    },
  ],
  '/files/upload-session': [
    {
      method: 'post',
      summary: 'Начало двухшаговой загрузки файла',
      response: z.object({ file_id: z.uuid(), upload_url: z.string() }),
    },
  ],
  '/files/{id}/complete': [
    {
      method: 'post',
      summary: 'Подтверждение загрузки файла',
      parameters: [{ name: 'id', in: 'path', required: true, description: 'Файл' }],
      response: z.object({ id: z.uuid(), status: z.string() }),
    },
  ],
  '/files/{id}/content': [
    {
      method: 'get',
      summary: 'Содержимое файла',
      parameters: [{ name: 'id', in: 'path', required: true, description: 'Файл' }],
      response: z.object({}),
    },
  ],
  '/files/{id}/blob': [
    {
      method: 'post',
      summary: 'Приём байтов локальным хранилищем',
      parameters: [{ name: 'id', in: 'path', required: true, description: 'Файл' }],
      response: z.object({ id: z.uuid() }),
    },
  ],
  '/inventory/export': [
    {
      method: 'get',
      summary: 'Выгрузка инвентаря дома в CSV или XLSX',
      parameters: [
        { name: 'house', in: 'query', required: true, description: 'Дом' },
        {
          name: 'format',
          in: 'query',
          required: false,
          description: 'csv (по умолчанию) или xlsx',
        },
      ],
      response: z.object({}),
    },
  ],
};

function jsonSchema(schema: z.ZodType): unknown {
  const converted = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  const { $schema, ...rest } = converted;
  void $schema;

  return rest;
}

export interface OpenApiOptions {
  /** Адрес сервера: в документе он один и берётся из окружения. */
  serverUrl: string;
}

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, operations] of Object.entries(API_OPERATIONS)) {
    paths[path] = {};

    for (const operation of operations) {
      paths[path][operation.method] = {
        summary: operation.summary,
        ...(operation.scope === undefined
          ? {}
          : { description: `Скоуп токена: \`${operation.scope}\`` }),
        ...(operation.parameters === undefined
          ? {}
          : {
              parameters: operation.parameters.map((parameter) => ({
                name: parameter.name,
                in: parameter.in,
                required: parameter.required,
                description: parameter.description,
                schema: { type: 'string' },
              })),
            }),
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        responses: {
          '200': {
            description: 'Успех',
            content: { 'application/json': { schema: jsonSchema(operation.response) } },
          },
          default: {
            description: 'Ошибка',
            content: { 'application/json': { schema: jsonSchema(errorSchema) } },
          },
        },
      };
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Nice Almaty API',
      version: '1.0.0',
      description:
        'REST для ботов и интеграций. Все суммы — целые тенге, даты — YYYY-MM-DD, ' +
        'моменты — ISO 8601 с зоной. Задания планировщика в документ не входят: ' +
        'они защищены отдельным секретом и вызываются расписанием.',
    },
    servers: [{ url: options.serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Токен API, выдаёт суперадмин' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME },
      },
    },
    paths,
  };
}
