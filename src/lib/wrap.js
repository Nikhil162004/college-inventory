'use strict';
/** Lets async route handlers pass their errors to the Express error page. */
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
