import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;

/** One rule set shared by the form (live checklist) and the server. */
export const PASSWORD_RULES = [
  { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (v: string) => v.length >= PASSWORD_MIN_LENGTH },
  { id: 'number', label: 'One number', test: (v: string) => /\d/.test(v) },
  { id: 'special', label: 'One special character', test: (v: string) => /[^A-Za-z0-9\s]/.test(v) },
] as const;

export function passwordProblem(value: string): string | null {
  const failed = PASSWORD_RULES.find((rule) => !rule.test(value));
  return failed ? failed.label : null;
}

export const passwordSchema = z
  .string()
  .max(256)
  .superRefine((value, ctx) => {
    const problem = passwordProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: `Password needs: ${problem.toLowerCase()}` });
  });

export const setupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: passwordSchema,
});
export type SetupInput = z.infer<typeof setupSchema>;

export const loginSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface AuthState {
  setupRequired: boolean;
  user: SessionUser | null;
  version: string;
}
