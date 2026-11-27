import {
  AcceptInviteInputSchema,
  AcceptInviteResponseSchema,
  CreateInviteInputSchema,
  CreateInviteResponseSchema,
  HealthzResponseSchema,
  ListMembersResponseSchema,
  UpdateMemberRoleInputSchema,
  UpdateMemberRoleResponseSchema,
  type AcceptInviteInput,
  type AcceptInviteResponse,
  type CreateInviteInput,
  type CreateInviteResponse,
  type HealthzResponse,
  type ListMembersResponse,
  type UpdateMemberRoleInput,
  type UpdateMemberRoleResponse,
} from '@baby-tracker/shared';
import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    options?: { code?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options?.code;
    this.details = options?.details;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  const text = await response.text();
  let json: unknown = undefined;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!response.ok) {
    const errObj =
      json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    const message =
      (errObj && typeof errObj.message === 'string' && errObj.message) ||
      (errObj && typeof errObj.error === 'string' && errObj.error) ||
      `Request failed with status ${response.status}`;
    const code =
      errObj && typeof errObj.code === 'string' ? errObj.code : undefined;
    throw new ApiError(message, response.status, {
      code,
      details: json,
    });
  }

  if (schema) {
    return schema.parse(json);
  }
  return json as T;
}

export async function createBabyInvite(
  babyId: string,
  input: Partial<CreateInviteInput> = {},
): Promise<CreateInviteResponse> {
  const body = CreateInviteInputSchema.parse(input);
  return apiFetch(
    `/api/babies/${encodeURIComponent(babyId)}/invites`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    CreateInviteResponseSchema,
  );
}

export async function acceptInvite(
  input: AcceptInviteInput,
): Promise<AcceptInviteResponse> {
  const body = AcceptInviteInputSchema.parse(input);
  return apiFetch(
    '/api/invites/accept',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    AcceptInviteResponseSchema,
  );
}

export async function listBabyMembers(
  babyId: string,
): Promise<ListMembersResponse> {
  return apiFetch(
    `/api/babies/${encodeURIComponent(babyId)}/members`,
    { method: 'GET' },
    ListMembersResponseSchema,
  );
}

export async function removeBabyMember(
  babyId: string,
  userId: string,
): Promise<{ ok: true }> {
  return apiFetch(
    `/api/babies/${encodeURIComponent(babyId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
    z.object({ ok: z.literal(true) }),
  );
}

export async function updateBabyMemberRole(
  babyId: string,
  userId: string,
  input: UpdateMemberRoleInput,
): Promise<UpdateMemberRoleResponse> {
  const body = UpdateMemberRoleInputSchema.parse(input);
  return apiFetch(
    `/api/babies/${encodeURIComponent(babyId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
    UpdateMemberRoleResponseSchema,
  );
}

export async function checkHealth(): Promise<HealthzResponse> {
  return apiFetch('/healthz', { method: 'GET' }, HealthzResponseSchema);
}
