'use strict';

/**
 * Did the browser state that this form was submitted from one of this site's
 * own pages? Browsers add Sec-Fetch-Site (and Origin) themselves; a page on
 * another website cannot set or change them. "same-site" is not enough: a
 * sister site on the same domain is still a different site.
 */
function makeSentFromThisSite(config) {
  let ownOrigin = '';
  try { ownOrigin = config.baseUrl ? new URL(config.baseUrl).origin : ''; } catch { ownOrigin = ''; }

  return function sentFromThisSite(req) {
    const site = req.get('sec-fetch-site');
    if (site !== undefined) return site === 'same-origin';
    const header = req.get('origin');           // browsers older than Sec-Fetch-Site
    if (!header) return false;
    let sent;
    try { sent = new URL(header).origin; } catch { return false; }
    if (!sent || sent === 'null') return false;
    return sent === `${req.protocol}://${req.get('host')}` || (ownOrigin !== '' && sent === ownOrigin);
  };
}

module.exports = { makeSentFromThisSite };
