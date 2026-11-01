/* Contact form: regular POST to FormSubmit (https://formsubmit.co), which emails each message
   and then sends the visitor back here with ?sent=1 so we can show the thank-you note. */
(function () {
  "use strict";
  document.querySelectorAll('.php-email-form').forEach(function (form) {
    var loading = form.querySelector('.loading'),
        sent = form.querySelector('.sent-message'),
        btn = form.querySelector('[type="submit"]'),
        next = form.querySelector('[name="_next"]');

    // Where FormSubmit should send people after it emails the message.
    if (next) next.value = location.href.split('#')[0].split('?')[0] + '?sent=1#contact';

    // Back from FormSubmit: show the thank-you message.
    if (/[?&]sent=1/.test(location.search) && sent) {
      sent.classList.add('d-block');
      history.replaceState(null, '', location.pathname + '#contact');
    }

    form.addEventListener('submit', function (e) {
      var honey = form.querySelector('[name="_honey"]');
      if (honey && honey.value) { e.preventDefault(); return; }   // bot trap
      if (loading) loading.classList.add('d-block');
      if (btn) btn.disabled = true;
      if (sent) sent.classList.remove('d-block');
      // Let the browser submit the form normally.
    });
  });
})();
