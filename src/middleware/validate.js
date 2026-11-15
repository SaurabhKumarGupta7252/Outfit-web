import { badRequest } from '../utils/errors.js';

// validate({ body, query, params }) parses each part with its Zod schema and stores the
// parsed values on req.valid, so handlers never read unvalidated input.
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.join('.') || part,
          message: issue.message,
        }));
        return next(badRequest(`Invalid request ${part}.`, details));
      }
      valid[part] = result.data;
    }
    req.valid = valid;
    next();
  };
}
