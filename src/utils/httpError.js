// Small helper for throwing HTTP errors with a status code.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function badRequest(msg) { return new HttpError(400, msg); }
function unauthorized(msg = 'Unauthorized') { return new HttpError(401, msg); }
function forbidden(msg = 'Forbidden') { return new HttpError(403, msg); }
function notFound(msg = 'Not found') { return new HttpError(404, msg); }
function conflict(msg) { return new HttpError(409, msg); }

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
