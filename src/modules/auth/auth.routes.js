import { Router } from 'express';
import { requireAuth, requireUser } from '../../middleware/require-auth.js';
import { authLimiter, guestLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './auth.controller.js';
import * as schemas from './auth.schemas.js';

const authRouter = Router();

authRouter.post('/guest', guestLimiter, validate({ body: schemas.guestSchema }), controller.guest);
authRouter.post('/signup', authLimiter, validate({ body: schemas.signupSchema }), controller.signup);
authRouter.post('/login', authLimiter, validate({ body: schemas.loginSchema }), controller.login);
authRouter.post('/google', authLimiter, validate({ body: schemas.googleSchema }), controller.google);
authRouter.post('/refresh', authLimiter, validate({ body: schemas.refreshSchema }), controller.refresh);
authRouter.post('/merge-guest', requireUser, validate({ body: schemas.mergeGuestSchema }), controller.mergeGuest);
authRouter.post('/logout', requireUser, validate({ body: schemas.logoutSchema }), controller.logout);
authRouter.get('/me', requireAuth, controller.me);
authRouter.post('/forgot-password', authLimiter, validate({ body: schemas.forgotPasswordSchema }), controller.forgotPassword);
authRouter.post('/reset-password', authLimiter, validate({ body: schemas.resetPasswordSchema }), controller.resetPassword);

export default authRouter;
