import { Router } from 'express';
import { authLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { signup } from '../auth/auth.controller.js';
import { signupSchema } from '../auth/auth.schemas.js';

// POST /api/v1/users is the original registration endpoint. It now behaves exactly like
// POST /api/v1/auth/signup, which is the documented one.
const usersRouter = Router();
usersRouter.post('/', authLimiter, validate({ body: signupSchema }), signup);

export default usersRouter;
