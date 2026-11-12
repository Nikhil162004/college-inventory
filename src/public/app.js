// Small progressive enhancements. Every page works without this file.
(function () {
  'use strict';

  // Collapsible menu on small screens.
  var toggle = document.querySelector('.menu-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Sign-in page: its form goes stale when the page sits open for long or the
  // server is restarted. While nothing has been typed, notice that and fetch a
  // fresh page, so that signing in works on the first try.
  var signin = document.querySelector('form[data-fresh-for]');
  if (signin) {
    var shownAt = Date.now();
    var freshFor = Number(signin.getAttribute('data-fresh-for')) * 1000;
    var instance = signin.getAttribute('data-instance');
    var idBox = signin.querySelector('input[type="text"]');
    var passwordBox = signin.querySelector('input[type="password"]');
    var typedId = idBox ? idBox.value : '';
    var leaving = false;
    var renew = function () {
      // Never throw away something the person has typed.
      if (leaving || (passwordBox && passwordBox.value) || (idBox && idBox.value !== typedId)) return;
      leaving = true;
      window.location.replace(signin.getAttribute('data-fresh-url'));
    };
    var check = function () {
      if (leaving || !window.fetch) return;
      // Ask the server first: if it cannot be reached, stay on this page.
      window.fetch('/instance', { credentials: 'omit', cache: 'no-store' })
        .then(function (reply) { return reply.ok ? reply.text() : null; })
        .then(function (now) {
          if (now && (now !== instance || Date.now() - shownAt >= freshFor)) renew();
        })
        .catch(function () {});
    };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
    window.addEventListener('pageshow', function (event) { if (event.persisted) check(); });
    window.addEventListener('focus', check);
    signin.addEventListener('focusin', check);
    window.setInterval(check, 30 * 1000);
  }

  // Ask before irreversible actions: <form data-confirm="...">
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });

  // Print buttons.
  document.querySelectorAll('[data-print]').forEach(function (button) {
    button.hidden = false;
    button.addEventListener('click', function () { window.print(); });
  });

  // Roster import: load a chosen .csv file into the text box (read locally in the browser).
  var file = document.querySelector('[data-csv-file]');
  var target = document.querySelector('[data-csv-target]');
  if (file && target) {
    file.addEventListener('change', function () {
      var chosen = file.files && file.files[0];
      if (!chosen) return;
      if (chosen.size > 600 * 1024) {
        window.alert('This file is too large. Import at most 1000 people at a time.');
        file.value = '';
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { target.value = String(reader.result || ''); };
      reader.readAsText(chosen);
    });
  }

  // Credentials sheet: save the table as a CSV file.
  var save = document.querySelector('[data-save-csv]');
  if (save) {
    save.hidden = false;
    save.addEventListener('click', function () {
      var table = document.getElementById(save.getAttribute('data-save-csv'));
      if (!table) return;
      var lines = [];
      table.querySelectorAll('tr').forEach(function (row) {
        var cells = [];
        row.querySelectorAll('th, td').forEach(function (cell) {
          var text = cell.textContent.trim();
          if (/^[=+\-@]/.test(text)) text = "'" + text;
          cells.push('"' + text.replace(/"/g, '""') + '"');
        });
        lines.push(cells.join(','));
      });
      var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'temporary-passwords.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    });
  }
})();
