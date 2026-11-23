// Errors with an HTTP status. Database errors that are the user's fault
// (bad input, constraint violations) are mapped to 4xx in toHttp().
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

const PG_CODES = {
  '22P02': 400, // invalid text representation (bad uuid, number)
  '22007': 400, // invalid date
  '22008': 400, // date out of range
  '23502': 400, // not null
  '23503': 409, // foreign key
  '23505': 409, // unique
  '23514': 400, // check
};

function toHttp(err) {
  if (err instanceof HttpError) return err.status;
  if (PG_CODES[err.code]) return PG_CODES[err.code];
  if (err.code === 121) return 400;   // MongoDB document failed validation
  if (err.code === 11000) return 409; // MongoDB duplicate key
  return 500;
}

module.exports = { HttpError, badRequest, notFound, conflict, toHttp };
