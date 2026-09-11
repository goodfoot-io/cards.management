/**
 * Protected file contract carrying admitted runtime credentials into launched processes.
 * @summary Runtime credential file schema
 * @module
 */

import { z } from 'zod';
import type { IssuedRoleCredential, OriginalCallerRequestId } from './runtime-admission.js';
import { executionIdentitySchema, ownershipStampSchema, runtimeScopeSchema } from './runtime-identity.js';

/** The complete and only set of credentials exposed to an admitted child process. */
export const CHILD_RUNTIME_CREDENTIAL_ROLES = [
  'runtime-wrapper',
  'agent-handler',
  'agent-hook',
  'watcher',
  'cli'
] as const;
export type ChildRuntimeCredentialRole = (typeof CHILD_RUNTIME_CREDENTIAL_ROLES)[number];

const issuedRoleCredentialSchema = z
  .object({
    credentialId: z.string().min(1),
    requestId: z.string().min(1),
    executionId: z.string().min(1),
    role: z.enum(CHILD_RUNTIME_CREDENTIAL_ROLES),
    producerId: z.string().min(1),
    secret: z.string().min(1),
    issuedAt: z.number().int().nonnegative()
  })
  .strict();

/** Versioned credential handoff written before an admitted process is launched. */
export interface RuntimeCredentialFile {
  readonly version: 1;
  readonly execution: z.infer<typeof executionIdentitySchema>;
  readonly scope: z.infer<typeof runtimeScopeSchema>;
  readonly ownership: z.infer<typeof ownershipStampSchema>;
  readonly requestId: OriginalCallerRequestId;
  readonly credentials: readonly (IssuedRoleCredential & { readonly role: ChildRuntimeCredentialRole })[];
}

/** Strict runtime credential-file validator, including all cross-field identity bindings. */
export const runtimeCredentialFileSchema: z.ZodType<RuntimeCredentialFile> = z
  .object({
    version: z.literal(1),
    execution: executionIdentitySchema,
    scope: runtimeScopeSchema,
    ownership: ownershipStampSchema,
    requestId: z.string().min(1),
    credentials: z.array(issuedRoleCredentialSchema).length(CHILD_RUNTIME_CREDENTIAL_ROLES.length)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.execution.launchRequestId !== value.requestId) {
      context.addIssue({ code: 'custom', message: 'execution launch request does not match requestId' });
    }
    const roles = new Set<string>();
    for (const credential of value.credentials) {
      if (credential.requestId !== value.requestId || credential.executionId !== value.execution.executionId) {
        context.addIssue({ code: 'custom', message: 'credential identity does not match file identity' });
      }
      if (roles.has(credential.role)) {
        context.addIssue({ code: 'custom', message: `duplicate credential role: ${credential.role}` });
      }
      roles.add(credential.role);
    }
    for (const requiredRole of CHILD_RUNTIME_CREDENTIAL_ROLES) {
      if (!roles.has(requiredRole)) {
        context.addIssue({ code: 'custom', message: `missing required credential role: ${requiredRole}` });
      }
    }
  });
