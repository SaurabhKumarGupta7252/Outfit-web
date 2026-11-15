import { ok } from '../../utils/respond.js';
import { getWalletForPrincipal, presentWallet } from '../wallet/wallet.service.js';
import * as authService from './auth.service.js';

export async function guest(req, res) {
  ok(res, await authService.signInGuest(req.valid.body, req.ip));
}

export async function signup(req, res) {
  ok(res, await authService.signUp(req.valid.body, req.ip), { status: 201 });
}

export async function login(req, res) {
  ok(res, await authService.logIn(req.valid.body, req.ip));
}

export async function google(req, res) {
  ok(res, await authService.signInWithGoogle(req.valid.body, req.ip));
}

export async function refresh(req, res) {
  ok(res, await authService.refreshSession(req.valid.body.refreshToken));
}

export async function mergeGuest(req, res) {
  ok(res, await authService.mergeGuest(req.auth.userId, req.valid.body, req.ip));
}

export async function logout(req, res) {
  await authService.logOut(req.auth.userId, req.valid.body);
  ok(res, { loggedOut: true });
}

export async function me(req, res) {
  const wallet = presentWallet(await getWalletForPrincipal(req.auth));
  if (req.auth.kind === 'guest') {
    return ok(res, { kind: 'guest', guest: { id: req.auth.guestSessionId, installationId: req.auth.installationId }, user: null, wallet });
  }
  const user = await authService.getUser(req.auth.userId);
  ok(res, { kind: 'user', guest: null, user: authService.presentUser(user), wallet });
}

export async function forgotPassword(req, res) {
  await authService.requestPasswordReset(req.valid.body.email);
  ok(res, { message: 'If an account exists for this email, a reset link has been sent.' });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.valid.body);
  ok(res, { passwordReset: true });
}
