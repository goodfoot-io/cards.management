/**
 * Protected file contract carrying admitted runtime credentials into launched processes.
 * @summary Runtime credential file schema
 * @module
 */

import { z } from 'zod';
import { executionIdentitySchema, producerRoleSchema, runtimeScopeSchema } from './runtime-identity.js';

const issuedRoleCredentialSchema = z
  .object({
    credentialId: z.string().min(1),
    requestId: z.string().min(1),
    executionId: z.string().min(1),
    role: producerRoleSchema,
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
  readonly requestId: string;
  readonly credentials: readonly z.infer<typeof issuedRoleCredentialSchema>[];
}

/** Strict runtime credential-file validator, including all cross-field identity bindings. */
export const runtimeCredentialFileSchema: z.ZodType<RuntimeCredentialFile> = z
  .object({
    version: z.literal(1),
    execution: executionIdentitySchema,
    scope: runtimeScopeSchema,
    requestId: z.string().min(1),
    credentials: z.array(issuedRoleCredentialSchema).min(1)
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
  });
