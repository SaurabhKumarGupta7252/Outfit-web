import { z } from 'zod';

export const installationFields = {
  installationUuid: z.string().uuid(),
  // Random secret generated once by the app (at least 32 bytes, base64url or hex) and kept in secure storage.
  guestSecret: z.string().min(32).max(256),
  platform: z.enum(['android', 'ios']).optional(),
  appVersion: z.string().max(32).optional(),
  deviceModel: z.string().max(120).optional(),
  // Optional device identifiers sent for reinstall protection (hashed on the server).
  ssaid: z.string().min(1).max(128).optional(),
  deviceFingerprint: z.string().max(256).optional(),
};

// Sent with signup/login/google so the guest wallet on this installation is linked in the same call.
const guestLink = z.object({
  installationUuid: installationFields.installationUuid,
  guestSecret: installationFields.guestSecret,
}).optional();

const email = z.string().trim().toLowerCase().email().max(320);
const password = z.string().min(8).max(128);

export const guestSchema = z.object(installationFields);
export const signupSchema = z.object({ email, password, displayName: z.string().trim().min(1).max(120).optional(), guest: guestLink });
export const loginSchema = z.object({ email, password: z.string().min(1).max(128), guest: guestLink });
export const googleSchema = z.object({ idToken: z.string().min(20).max(8192), guest: guestLink });
export const mergeGuestSchema = z.object({
  installationUuid: installationFields.installationUuid,
  guestSecret: installationFields.guestSecret,
});
export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) });
export const logoutSchema = z.object({ refreshToken: z.string().min(20).max(512).optional(), allDevices: z.boolean().optional() });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(512), newPassword: password });
