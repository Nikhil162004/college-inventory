'use strict';
/**
 * Session store backed by the same SQLite database.
 * Keeping user_id in its own column lets us end every session of a user at once
 * (on password change, password reset or deactivation).
 */
const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs }) {
    super();
    this.ttlMs = ttlMs;
    this.q = {
      get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?'),
      set: db.prepare(`INSERT INTO sessions (sid, user_id, data, expires_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      destroyUser: db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref();
  }

  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.q.set.run(sid, sess.userId || null, JSON.stringify(sess), this.expiry(sess));
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      this.q.touch.run(this.expiry(sess), sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try {
      this.q.destroy.run(sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  /** Ends all sessions of a user, optionally keeping one (the current one). */
  destroyUserSessions(userId, exceptSid = '') {
    return this.q.destroyUser.run(userId, exceptSid).changes;
  }

  prune() {
    try { this.q.prune.run(Date.now()); } catch { /* next run will retry */ }
  }
}

module.exports = { SqliteSessionStore };
