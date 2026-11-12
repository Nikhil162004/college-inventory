'use strict';
/**
 * HOSTED DEMO PREVIEW ONLY.
 *
 * The preview shows the site inside a frame on another website. Some browsers
 * do not return cookies to a framed site, and without the session cookie
 * nobody can stay signed in. For such a browser -- one whose request arrives
 * without the session cookie -- this module carries the session in the address
 * instead: every local link, form and redirect in the response gets the
 * parameter "_ps", holding exactly the value the cookie would have had (the
 * session id, signed with the server's secret, so it cannot be made up).
 *
 * A session id in an address is weaker than a cookie: it ends up in browser
 * history and can be copied along with a link. That is acceptable for made-up
 * demonstration data and for nothing else, so:
 *
 *   - app.js loads this file only when EMBED_PREVIEW is set, and
 *   - the configuration refuses to start with EMBED_PREVIEW in production.
 *
 * Outside preview mode "_ps" is an unknown parameter like any other.
 * Everything else (form tokens, permissions, lockout) works unchanged.
 */
const crypto = require('crypto');

const PARAM = '_ps';
const SHAPE = /^s:[\w-]{16,64}\.[A-Za-z0-9+/]{43}$/;

module.exports = function cookielessPreview({ cookieName, secret }) {
  // The same signature express-session puts into its cookie.
  const signed = (sid) => 's:' + sid + '.' + crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
  const sentCookie = (req) => String(req.headers.cookie || '').split(';').some((c) => c.trim().startsWith(cookieName + '='));

  /** Adds the session to a local address; anything else is returned untouched. */
  function carry(url, value, amp) {
    if (typeof url !== 'string' || url[0] !== '/' || url[1] === '/' || url[1] === '\\' || url.startsWith('/static/')) return url;
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    return base + (base.includes('?') ? amp : '?') + PARAM + '=' + encodeURIComponent(value) + (hash < 0 ? '' : url.slice(hash));
  }

  function rewrite(html, value) {
    const inAttribute = (name) => new RegExp(`(\\s${name}=")(/[^"]*)(")`);
    return html
      .replace(/<a\b[^>]*>/g, (tag) => (/\starget="_blank"/.test(tag) ? tag
        : tag.replace(inAttribute('href'), (m, a, url, z) => a + carry(url, value, '&amp;') + z)))
      .replace(/<form\b[^>]*>/g, (tag) => {
        const out = tag.replace(inAttribute('data-fresh-url'), (m, a, url, z) => a + carry(url, value, '&amp;') + z);
        // A POST form keeps the query string of its address; a GET form replaces it with its fields.
        if (/\smethod="post"/i.test(out)) return out.replace(inAttribute('action'), (m, a, url, z) => a + carry(url, value, '&amp;') + z);
        // (a form field is encoded by the browser itself; the value has no characters that need escaping in HTML)
        return out + `<input type="hidden" name="${PARAM}" value="${value}">`;
      });
  }

  return function cookieless(req, res, next) {
    // Take the parameter out of the request so that the application never sees it.
    let value = '';
    const q = req.url.indexOf('?');
    if (q >= 0 && req.url.includes(PARAM + '=')) {
      const params = new URLSearchParams(req.url.slice(q + 1));
      value = params.get(PARAM) || '';
      params.delete(PARAM);
      const rest = params.toString();
      req.url = req.url.slice(0, q) + (rest ? '?' + rest : '');
      req.originalUrl = req.url;
      if (req.query) delete req.query[PARAM];
    }

    // A browser that returns cookies is served exactly as usual.
    if (sentCookie(req)) return next();

    if (SHAPE.test(value)) {
      const others = req.headers.cookie ? req.headers.cookie + '; ' : '';
      req.headers.cookie = others + cookieName + '=' + encodeURIComponent(value); // verified by express-session as usual
    }

    const current = () => (req.session && req.sessionID ? signed(req.sessionID) : '');

    const redirect = res.redirect;
    res.redirect = function (...args) {
      const i = args.length > 1 && typeof args[0] === 'number' ? 1 : 0;
      const now = current();
      if (now) args[i] = carry(args[i], now, '&');
      return redirect.apply(this, args);
    };

    const send = res.send;
    res.send = function (body) {
      const type = String(res.get('Content-Type') || '');
      const now = current();
      if (now && typeof body === 'string' && (type === '' || type.includes('html'))) body = rewrite(body, now);
      return send.call(this, body);
    };

    next();
  };
};
