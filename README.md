# Inventory Register

A web application that replaces the hand-written stock registers of a college.
Every piece of equipment gets a unique asset tag and a QR label. Anyone in the
college who finds something broken scans the label with a phone and reports it;
lab staff see the report at once and record the repair.

Built for a college of about 3,500 students and 70 faculty, with 20 labs
(one with 100 computers, the others with 30) plus classrooms, offices, library,
server room and workshop. It tracks all equipment, not only computers:
projectors, printers, network gear, UPS units, air conditioners, CCTV, lab
instruments, trainer kits, workshop machines, fire extinguishers and so on.

## What it does

| Who | Can do |
| --- | --- |
| **Anyone with a phone** | Scan the QR label on an item and report a problem. No account needed (can be switched off) |
| **Student** | Scan a QR label (or type the asset tag), report a problem, follow own reports |
| **Faculty** | The same, plus browse all equipment, labs and reports (read only) |
| **Lab staff** | Add and edit equipment (singly or in batches), move it between rooms, print QR labels, export CSV, handle reports |
| **Administrator** | Everything above, plus labs/rooms, categories, people, password resets, write-offs and the activity log |

- **Unique IDs**: asset tags such as `PC-00042` are issued by the system inside a
  database transaction, so two people adding equipment at the same time can never
  receive the same tag. Tags never change and are never reused.
- **QR labels**: printable A4 sheets (three across) for a whole lab or any filtered list.
  Each code opens `BASE_URL/e/<tag>`.
- **Reporting from the label**: scanning a label opens a short form for that one item:
  what is wrong, a description, the person's name and (optionally) their roll or
  employee number. The report is saved, the item is marked *issue reported*, and it
  appears on the administrator's overview and under Problem reports, marked "not signed
  in". The visitor gets a report number and can see nothing else on the site. Set
  `GUEST_REPORTS=0` to require a sign-in for reporting instead.
- **Status follows reports**: an item is *working*, *issue reported*, *under repair* or
  *written off*. The first three are derived from its reports and cannot be typed in by
  hand, so the register cannot drift from reality.
- **Nothing is deleted**: equipment is written off with a reason; its history stays.
- **Activity log**: every sign-in and every change, with who, when and from which address.

## Install it on your laptop

You need a laptop with Windows, macOS or Linux, an internet connection for the first
start, and about 200 MB of free space.

1. **Install Node.js.** Open <https://nodejs.org>, download the **LTS** version and run
   the installer, keeping every default. (Version 22 or newer; older versions cannot
   install the database driver without extra tools.)
2. **Unpack the project.** On Windows, right-click `college-inventory.zip` and choose
   **Extract All**. Do not run anything from inside the zip.
3. **Start it.**
   - Windows: open the `college-inventory` folder and double-click **`start-windows.bat`**.
     If Windows shows "Windows protected your PC", choose **More info > Run anyway**.
   - macOS: double-click `start-mac-linux.command`. The first time, macOS may refuse
     because the file was downloaded: right-click it, choose **Open**, then **Open**.
   - Linux, or any terminal: `npm run laptop` inside the folder.

The first start takes about two minutes: it installs what the program needs and loads a
complete made-up college (3,577 accounts, 1,660 items). Later starts take a few seconds
and never replace your records. When it is ready, the browser opens the site and the
window shows the address for phones and a QR code to check your phone with.

To stop it, close the window or press `Ctrl+C`. To start again, double-click the same
file. To start over with fresh demonstration data, delete the `data` folder.

Demo sign-ins (shown on the sign-in page while demo data is loaded):

| Role | College ID | Password |
| --- | --- | --- |
| Administrator | `ADMIN01` | `Register#Admin26` |
| Lab staff | `STF001` | `Register#Staff26` |
| Faculty | `FAC001` | `Register#Faculty26` |
| Student | `23CS001` | `Register#Student26` |

The same thing by hand, if you prefer a terminal:

```bash
npm install
npm run seed:demo      # optional: loads the made-up college
npm start              # http://localhost:3000
```

### Scanning QR codes with a phone

A QR code contains the address of the site, so a phone can only open it if the phone can
reach that address. On your laptop that means: **the phone and the laptop are on the same
Wi-Fi.**

1. Start the register as above. The window shows a line such as
   `On this computer and on phones: http://192.168.1.23:3000` and a QR code.
2. Point the phone's camera at that QR code (or type the address under it). The "report
   a problem" form for the first item opens. No sign-in is needed.
3. On the laptop, sign in as `ADMIN01`, open any item or the QR label sheet, and scan
   those codes the same way. Each report appears on the administrator's overview.

### Phone cannot connect

Work down this list; the first two cover nearly every case.

1. **Windows firewall.** The first time, Windows asks whether to allow Node.js on the
   network. Choose **Allow**, with both *Private* and *Public* ticked. If you closed that
   question, open the Start menu, type `cmd`, choose **Run as administrator**, and paste:

   ```
   netsh advfirewall firewall add rule name="Inventory Register" dir=in action=allow protocol=TCP localport=3000
   ```

   (To remove it later: `netsh advfirewall firewall delete rule name="Inventory Register"`.)
   On macOS, choose **Allow** when asked whether "node" may accept incoming connections.
2. **College or hostel Wi-Fi.** Many of these stop devices from talking to each other.
   Turn on the phone's **Wi-Fi hotspot**, connect the laptop to it, and start the register
   again. The address in the window changes; scan the new code. A second phone can join
   the same hotspot.
3. **Same network.** A phone on mobile data alone cannot reach the laptop. Nor can one on
   a guest Wi-Fi while the laptop is on the main one.
4. **The address changed.** The laptop gets a new address on each network, and QR codes
   keep the address they were made with. Reload the page on the laptop before scanning.

That last point is why labels for real use must be printed only after the site has a
permanent address: see "Using it for real".

The QR pages warn when their address cannot be opened by other devices (`localhost`, or
a hosted preview), and the label sheet reminds you to set `BASE_URL` before printing for
real, because printed labels keep the address they were made with.

### A public demonstration on the internet

To let anyone's phone scan the codes without being on your Wi-Fi, the site needs a
public https address. `render.yaml` sets up a free one on [Render](https://render.com):

1. Create a GitHub repository and upload the contents of this folder to it, so that
   `render.yaml` and `package.json` are at the top level of the repository.
2. On render.com, sign in with GitHub, choose **New > Blueprint**, pick the repository
   and apply it. The first build takes a few minutes.
3. Open the `https://…onrender.com` address Render shows, sign in with a demo account,
   and scan any QR code with a phone.

What this is and is not:

- It is the made-up college with the demo sign-ins printed on the sign-in page
  (`PUBLIC_DEMO=1`). Anyone who has the address can sign in, including as administrator.
- On the free plan the site sleeps when nobody uses it (the next visit takes about a
  minute) and **forgets everything that was added** whenever it restarts or sleeps.
- It runs with the production safeguards (https-only cookies, strict headers), but it is
  for showing the system, never for real records. For that, see "Using it for real".

## Email alerts

The register can email the person in charge every time a problem is reported, from a
phone or by someone signed in.

```bash
npm run alerts
```

It asks which address should receive the alerts and which mailbox sends them, sends one
test email, and saves the answers only if that email went out. Then start the register
again. `npm run alerts -- --test` sends another test; `npm run alerts -- --off` turns
alerts off.

With a Gmail mailbox, Google does not accept the normal password from programs. It needs
an **app password**, which only the owner of the mailbox can create: turn on 2-Step
Verification, open <https://myaccount.google.com/apppasswords>, create one, and paste
the 16 letters when asked. It can be withdrawn there at any time.

How the address is kept private:

- It is stored in one place, the file `.env` next to the program, on your computer or
  server. That file is listed in `.gitignore`, so it is not uploaded with the project.
  Do not send that file to anyone, and leave it out if you zip the folder for someone.
- No page of the site shows it, not even to the administrator. The overview only says
  whether alerts are on.
- The emails go only to that address. Nothing typed into a report form can add a
  recipient, change the subject or become a link; the messages are plain text.
- The mailbox password is never written to the log.

A report is saved first and emailed afterwards. If the mail server cannot be reached, the
report is still in the register and the reason is printed in the server's window. At
most 60 alerts are sent per hour (`ALERTS_PER_HOUR`); beyond that one email says more are
waiting. Some college networks block outgoing mail; if the test fails with "did not
answer", try from another network.

There are no SMS or WhatsApp alerts: those need a paid messaging provider (and, in India,
a registered sender). An email to a mailbox that is on your phone arrives as a
notification in the same way.

## Tests

```bash
npm test
```

137 automated tests cover sign-in and lockout, session handling, CSRF, the permission
matrix for every page and role, input validation, script and SQL injection attempts,
the complete scan → report → repair → resolve flow, reports from the label without an
account, email alerts (against a real mail server conversation), roster import,
write-offs, security headers and error handling. Run them before and after every change; a change is ready
only when all of them pass.

## Using it for real

1. **Start empty.** Do not load demo data. Delete `data/` if you tried the demo. (The app
   refuses to start in production on the demo data, because its passwords are public.)
2. Copy `.env.example` to `.env` and fill in `SESSION_SECRET`, `BASE_URL`, `COLLEGE_NAME`.
   With `NODE_ENV=production` the app refuses to start without a strong secret and an
   `https://` address.
3. `npm run setup` creates the standard categories and asks for the first administrator.
   `npm run alerts` (optional) sets up the email that is sent for every new report.
4. Put the app behind a reverse proxy that provides HTTPS (nginx or Caddy), keep
   `HOST=127.0.0.1` so it is reachable only through the proxy, and run it under a
   process manager (`systemd` or `pm2`) so it restarts after a reboot.
5. Sign in, then:
   - **Labs & rooms** → add your labs and rooms.
   - Reporting from the labels needs no accounts for students. Import the roster only if
     you want students and faculty to sign in and follow their own reports.
   - **People → Import roster** → paste the student and faculty lists (CSV, up to 1,000 per
     import). Each person receives a one-time temporary password and must choose their
     own at first sign-in.
   - **Equipment → Add equipment** → enter each batch (e.g. quantity 30 for a lab's computers).
   - **QR labels** → print, and stick one on every item.
6. **Back up** `data/inventory.db` every night (for example
   `sqlite3 data/inventory.db ".backup '/backups/inventory-$(date +%F).db'"`), and keep
   copies off the server.

Decide `BASE_URL` before printing labels: it is inside every QR code.

## Security

| Risk | What the application does |
| --- | --- |
| Stolen password database | Passwords are stored only as salted **scrypt** hashes (memory-hard, OWASP parameters N=2¹⁵, r=8, p=3). |
| Weak passwords | Minimum 10 characters; common passwords and ones containing the person's name or ID are refused. |
| Password guessing | Account locks for 15 minutes after 5 wrong attempts; failed sign-ins are rate limited per network address; the error message is identical whether or not the ID exists, and takes the same time. |
| Temporary passwords | Random, shown once, never stored readable, must be replaced at first sign-in. |
| Session theft / fixation | Server-side sessions; cookie is `HttpOnly`, `Secure`, `SameSite=Lax` with the `__Host-` prefix; new session ID at sign-in; 2-hour idle and 12-hour absolute timeout; changing or resetting a password ends all other sessions. |
| Cross-site request forgery | Every form carries a per-session token that is checked on every POST. A form whose token does not match is never acted on, with one exception: the sign-in form of a signed-out visitor is still accepted when the browser itself states (`Sec-Fetch-Site: same-origin`, or a matching `Origin`) that it was submitted from this site's own page, which other websites cannot fake. This lets someone sign in from a page that was left open or shown before a restart; the password check, lockout and rate limit apply as usual. Anything else gets a fresh sign-in form and an explanation, never an error page. |
| Cross-site scripting | All output is HTML-escaped by the templates; a strict Content-Security-Policy allows no inline scripts or styles and no third-party resources. |
| SQL injection | Every query uses bound parameters; search text is escaped for `LIKE`. |
| Privilege escalation | Permissions are checked on the server for every request; the user's role is re-read from the database each time, so demotion or deactivation applies immediately. Students receive "not found" for other people's reports. |
| Mass assignment | Each form is validated against a schema; fields not on the form are ignored. |
| Clickjacking / sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS, restrictive `Referrer-Policy` and `Permissions-Policy`. |
| Spam reports | Signed in: one open report per person per item; 10 reports per person per hour. From the label without an account: at most 3 open reports per item, 30 per hour per network address, repeated sends ignored, a trap field for automatic form-fillers, and every report logged with its network address. |
| Reports without an account | The name on such a report is whatever the person typed, and staff see it marked "not signed in". The form shows only the item's tag, name and room. It is protected against cross-site submission like every other form; when the browser keeps no cookies, the report is accepted only if the browser itself states it was sent from this site's own page. |
| Email alerts | Sent only over an encrypted connection to a mail server whose certificate is verified; recipients come only from the server's settings; plain text; subject built only from the register's own data; rate limited; the address and password appear on no page and in no log. |
| CSV formula injection | Exported cells beginning with `= + - @` are neutralised. |
| Information leaks | Error pages never show stack traces; signed-in pages are sent with `Cache-Control: no-store`. |
| Lost accountability | Append-only activity log; equipment is never deleted. |

Things the application cannot do for you: provide HTTPS (use the reverse proxy), patch
the server's operating system, keep backups, or keep the `.env` file private. Before going
live it is worth asking your institute's IT cell to review the deployment.

`EMBED_PREVIEW=1` exists only so the app can be shown inside a hosted preview frame. It
relaxes the framing rules and the cookie settings, and for a browser that returns no
cookies to a framed site it carries the session in the address of every link and form
(`src/preview/cookieless.js`). A session in an address can be copied along with a link, so
this is for made-up demonstration data only: the module is not even loaded without
`EMBED_PREVIEW`, and the app refuses to start with it when `NODE_ENV=production`.

## How it is built

- **Node.js + Express**, server-rendered **EJS** pages, hand-written CSS, about 100 lines of
  optional JavaScript. No front-end framework, no CDN, no tracking; works with JavaScript off.
- **SQLite** (WAL mode) through `better-sqlite3`: one file, no database server to run, and
  far more capacity than a college needs. The schema is in `src/schema.sql`.
- Dependencies: `express`, `express-session`, `helmet`, `express-rate-limit`, `ejs`,
  `better-sqlite3`, `zod`, `qrcode`.

```
src/
  server.js            starts the app
  app.js               middleware order, security headers, routes, error pages
  config.js            settings from the environment
  schema.sql, db.js    database
  security/            password hashing, CSRF, session store
  preview/             demo-preview-only helper (never loaded in production)
  middleware/auth.js   who may do what
  lib/                 validation, audit log, CSV, asset tags and QR codes
  routes/              one file per area: auth, guest (the label's report form), dashboard, equipment, reports, locations, categories, users, audit
  views/               pages
  public/              stylesheet and script
scripts/               first-time setup and demo data
test/                  automated tests
```

## Ideas for later

Photo attachments on reports, SMS or WhatsApp notifications to the lab in-charge,
warranty-expiry reminders, a yearly stock-verification checklist per room, and
single sign-on with the college's Google or Microsoft accounts.
