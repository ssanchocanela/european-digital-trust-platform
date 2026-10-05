import { affordableAmount, LOAN_TERMS, monthlyPayment } from "./loan.js";

/**
 * The page's script, served as a file so `script-src 'self'` holds with no inline script.
 *
 * It builds every screen with `createElement` and `textContent`: nothing a wallet presented, and
 * nothing the platform answered, is ever parsed as markup. The one exception is the QR code, which
 * this process drew itself and the script parses as SVG, not HTML.
 *
 * Plain ES5-style JavaScript in a string, as the operator console's is: no build step, no bundle.
 * The loan's arithmetic is the exception: it is the source of the tested functions in `loan.ts`.
 */
const LOAN_JS = `var LOAN = ${JSON.stringify(LOAN_TERMS)};
LOAN.monthly = ${monthlyPayment.toString()};
LOAN.affordable = ${affordableAmount.toString()};
`;

export const CLIENT_JS = `"use strict";
${LOAN_JS}${String.raw`(function () {
  var T = JSON.parse(document.getElementById("i18n").textContent);
  var CFG = JSON.parse(document.getElementById("cfg").textContent);
  var app = document.getElementById("app");
  var ribbon = document.getElementById("ribbon");
  var results = { eudi: null, current: null };
  var recorded = !CFG.live;
  var flows = [];
  var advanceTarget = null;
  var T0_KEY = "horizonte.t0";

  // --- small helpers -----------------------------------------------------------------------------

  function t(key, vars) {
    var s = T[key] === undefined ? key : T[key];
    if (vars) for (var k in vars) s = s.replace("{" + k + "}", vars[k]);
    return s;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(label, cls, onClick) {
    var b = el("button", "btn " + (cls || ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function two(n) { return n < 10 ? "0" + n : String(n); }
  function fmt(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + " h " + two(m) + " min";
    return two(m) + ":" + two(s % 60);
  }
  function store(value) {
    try {
      if (value === null) window.localStorage.removeItem(T0_KEY);
      else window.localStorage.setItem(T0_KEY, String(value));
    } catch (e) { /* a private window: the timer restarts on return, nothing else */ }
  }
  function stored() {
    try { var v = Number(window.localStorage.getItem(T0_KEY)); return v > 0 ? v : null; }
    catch (e) { return null; }
  }
  function euros(n, decimals) {
    return n.toLocaleString("es-ES", { useGrouping: "always", minimumFractionDigits: decimals || 0, maximumFractionDigits: decimals || 0 }) + " €";
  }
  function mask(v) {
    if (typeof v === "string") return v.length > 1 ? v.charAt(0) + "•••" : "•";
    if (Array.isArray(v)) return v.map(mask);
    if (v && typeof v === "object") { var o = {}; for (var k in v) o[k] = mask(v[k]); return o; }
    return "•";
  }

  /** Timeouts and intervals a flow owns, so leaving a screen stops everything it started. */
  function Timers() {
    var ids = [];
    return {
      later: function (fn, ms) { var id = setTimeout(fn, ms); ids.push(["t", id]); return id; },
      every: function (fn, ms) { var id = setInterval(fn, ms); ids.push(["i", id]); return id; },
      stop: function () {
        ids.forEach(function (x) { if (x[0] === "t") clearTimeout(x[1]); else clearInterval(x[1]); });
        ids = [];
      }
    };
  }

  /** A stopwatch. "scale" is how much faster than the wall clock it runs: the simulated flow's is 6. */
  function Clock(scale) {
    var base = 0, t0 = null;
    return {
      start: function (at) { if (t0 === null) t0 = at || Date.now(); },
      stop: function () { if (t0 !== null) { base += (Date.now() - t0) * scale; t0 = null; } },
      jump: function (ms) { base += ms; },
      // A presenter who skips ahead does not make the simulated onboarding quicker than it is.
      atLeast: function (ms) { var now = this.ms(); if (now < ms) base += ms - now; },
      ms: function () { return base + (t0 === null ? 0 : (Date.now() - t0) * scale); }
    };
  }

  function flowHeader(mode, total, simulated) {
    var node = el("div", "flow-head");
    var title = el("span", "flow-mode", mode);
    if (simulated) add(title, el("span", "chip chip-muted", t("simulated")));
    var step = el("span", "flow-step");
    var time = el("span", "flow-time", "00:00");
    var chips = el("span", "flow-chips");
    var bar = el("div", "progress"), fill = el("div", "progress-fill");
    add(bar, fill);
    add(node, title, chips, step, add(el("span", "flow-clock"), el("span", "flow-clock-label", t("timer")), time), bar);
    return {
      node: node, chips: chips,
      setStep: function (n) {
        step.textContent = n > 0 ? t("stepOf", { n: n, total: total }) : "";
        fill.style.width = Math.round((n / total) * 100) + "%";
      },
      setTime: function (text) { time.textContent = text; }
    };
  }

  // --- the technical panel -----------------------------------------------------------------------

  var tech = (function () {
    var panel = document.getElementById("tech");
    var list = document.getElementById("tech-events");
    var view = "business";
    var events = [];
    function label(n) { return t("tech" + n + (view === "business" ? "Business" : "Technical")); }
    function render() {
      clear(list);
      if (events.length === 0) { add(list, el("li", "tech-empty", t("techEmpty"))); return; }
      events.forEach(function (e) {
        var li = el("li", "tech-event");
        var head = add(el("div", "tech-event-head"), el("span", "tech-n", String(e.n)), el("span", "tech-label", label(e.n)));
        add(li, head);
        var meta = el("div", "tech-meta", e.at);
        if (e.recorded) add(meta, el("span", "chip chip-warn", t("techRecorded")));
        if (e.notObserved) add(meta, el("span", "chip chip-muted", t("techNotObserved")));
        add(li, meta);
        if (e.payload) {
          var d = el("details");
          add(d, el("summary", "", "payload"), el("pre", "", JSON.stringify(e.payload, null, 2)));
          add(li, d);
        }
        add(list, li);
      });
    }
    document.getElementById("tech-view").addEventListener("click", function (ev) {
      view = view === "business" ? "technical" : "business";
      ev.currentTarget.textContent = view === "business" ? t("techTechnical") : t("techBusiness");
      render();
    });
    function toggle() {
      panel.hidden = !panel.hidden;
      document.body.classList.toggle("tech-open", !panel.hidden);
    }
    document.getElementById("tech-toggle").addEventListener("click", toggle);
    document.getElementById("tech-close").addEventListener("click", toggle);
    render();
    return {
      toggle: toggle,
      reset: function () { events = []; render(); },
      mark: function (n, payload, flags) {
        if (events.some(function (e) { return e.n === n; })) return;
        flags = flags || {};
        events.push({
          n: n, payload: payload, at: new Date().toLocaleTimeString(),
          recorded: recorded, notObserved: Boolean(flags.notObserved)
        });
        events.sort(function (a, b) { return a.n - b.n; });
        render();
      }
    };
  })();

  // --- the wallet flow ---------------------------------------------------------------------------

  var FAILURES = {
    EXPIRED: "errorExpired", DECLINED_BY_USER: "errorDeclined", REJECTED: "errorRejected",
    TRUST_ERROR: "errorTrust", POLICY_NOT_SATISFIED: "errorIncomplete"
  };

  function eudiFlow(host, opts) {
    var timers = Timers(), clock = Clock(1), head = flowHeader(t("modeEudi"), 3, false);
    var body = el("div", "flow-body");
    var primary = null, typed = 0, data = null, done = false;
    var loan = opts.product === "loan" ? { amount: LOAN.defaultAmount, months: LOAN.defaultMonths, income: 0, granted: 0 } : null;
    add(host, head.node, body);
    timers.every(function () { head.setTime(fmt(clock.ms())); }, 250);

    function screen(step, build) {
      timers.stop();
      timers.every(function () { head.setTime(fmt(clock.ms())); }, 250);
      primary = null;
      clear(body);
      head.setStep(step);
      var s = el("section", "screen");
      add(body, s);
      build(s);
    }

    function payment(amount) { return LOAN.monthly(amount, loan.months, LOAN.annualRatePercent); }

    function loanProduct() {
      screen(0, function (s) {
        var hero = el("div", "hero");
        add(hero, el("h1", "", t("loanTitle")), el("p", "lead", t("loanLead")));
        var amount = el("input"); amount.type = "range";
        amount.min = LOAN.minAmount; amount.max = LOAN.maxAmount; amount.step = LOAN.stepAmount; amount.value = loan.amount;
        var months = el("select");
        LOAN.months.forEach(function (m) {
          var o = el("option", "", t("loanMonths", { n: m })); o.value = m; o.selected = m === loan.months; add(months, o);
        });
        var amountLabel = el("strong", "loan-amount"), quota = el("strong", "loan-quota");
        function refresh() {
          loan.amount = Number(amount.value); loan.months = Number(months.value);
          amountLabel.textContent = euros(loan.amount);
          quota.textContent = euros(payment(loan.amount), 2);
        }
        amount.addEventListener("input", refresh); months.addEventListener("change", refresh);
        refresh();
        var sim = el("div", "loan-sim");
        add(sim,
          add(el("div", "field"), el("label", "", t("loanAmount")), amountLabel, amount),
          add(el("div", "field"), el("label", "", t("loanTerm")), months),
          add(el("div", "loan-result"), el("span", "", t("loanMonthly")), quota,
            el("small", "", t("loanRate", { rate: String(LOAN.annualRatePercent).replace(".", ",") }))));
        primary = function () { clock.start(); store(Date.now()); consent(); };
        var cta = button(t("loanCta"), "btn-primary btn-wide", primary);
        add(cta, el("span", "badge-new", t("badgeNew")));
        add(hero, sim, add(el("div", "actions"), cta), el("p", "note", t("loanFictitious")));
        add(s, hero);
      });
    }

    function product() {
      if (loan) return loanProduct();
      screen(0, function (s) {
        var hero = el("div", "hero");
        add(hero, el("h1", "", t("productTitle")), el("p", "lead", t("productLead")));
        var ul = el("ul", "benefits");
        ["productBenefit1", "productBenefit2", "productBenefit3"].forEach(function (k) { add(ul, el("li", "", t(k))); });
        primary = function () { clock.start(); store(Date.now()); consent(); };
        var cta = button(t("productCtaWallet"), "btn-primary btn-wide", primary);
        add(cta, el("span", "badge-new", t("badgeNew")));
        add(hero, ul, add(el("div", "actions"), cta,
          opts.onClassic ? button(t("productCtaClassic"), "btn-secondary", opts.onClassic) : null));
        add(s, hero);
      });
    }

    function consent() {
      screen(1, function (s) {
        add(s, el("h1", "", t("consentTitle")), el("p", "lead", t(loan ? "loanConsentBody" : "consentBody")));
        var ul = el("ul", "asked");
        [["consentName", "👤"], ["consentBirth", "📅"], ["consentNationality", "🌍"], ["consentDocument", "🪪"], ["consentAddress", "🏠"]]
          .forEach(function (x) {
            add(ul, add(el("li"), el("span", "asked-icon", x[1]),
              add(el("span", "asked-text"), el("strong", "", t(x[0])), el("small", "", t(x[0] + "Why")))));
          });
        primary = function () { connect(MOBILE() ? "movil" : "qr"); };
        add(s, ul, add(el("div", "actions"), button(t("consentCta"), "btn-primary", primary)));
      });
    }

    function statusSteps() {
      var ol = el("ol", "status");
      var items = ["statusWaiting", "statusReceived", "statusVerified"].map(function (k) {
        var li = el("li", "", t(k)); add(ol, li); return li;
      });
      return {
        node: ol,
        set: function (status) {
          var at = status === "VERIFIED" ? 2 : status === "PRESENTATION_RECEIVED" || status === "VERIFYING" ? 1 : 0;
          items.forEach(function (li, i) { li.className = i < at ? "done" : i === at ? "now" : ""; });
          if (at === 2 && items[2]) items[2].className = "done";
        }
      };
    }

    function phoneFrame() {
      var phone = el("div", "phone");
      var inner = el("div", "phone-screen");
      add(inner, el("div", "phone-title", t("phoneAsks")));
      var ul = el("ul", "phone-list");
      ["consentName", "consentBirth", "consentNationality", "consentDocument", "consentAddress"].forEach(function (k) {
        add(ul, add(el("li"), el("span", "phone-check", "✓"), el("span", "", t(k))));
      });
      add(inner, ul, el("p", "phone-body", t("phoneBody")), el("div", "phone-pin", "● ● ● ● ● ●"));
      add(phone, inner);
      return add(el("figure", "phone-wrap"), phone, el("figcaption", "", t("phoneNote")));
    }

    function connect(mode, resumeId) {
      screen(2, function (s) {
        var left = el("div", "connect-main"), status = statusSteps(), box = el("div", "connect-box");
        var note = el("p", "note"), error = el("div", "error"); error.hidden = true;
        add(left, el("h1", "", t("connectTitle")), box, note, status.node, error);
        add(s, add(el("div", "connect"), left, opts.compact ? null : phoneFrame()));
        status.set("AWAITING_WALLET");

        function fail(key) {
          timers.stop();
          timers.every(function () { head.setTime(fmt(clock.ms())); }, 250);
          clear(box); note.textContent = "";
          error.hidden = false; error.textContent = t(key);
          primary = function () { connect(mode); };
          add(box, button(t("connectRetry"), "btn-secondary", primary));
        }
        function settle(view) {
          status.set(view.status);
          if (view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING" || view.status === "VERIFIED") {
            tech.mark(2, null, { notObserved: true });
            tech.mark(3, { status: view.status });
          }
          if (view.status === "VERIFIED") {
            tech.mark(4, { issuerTrust: "ETSI TS 119 602 list, PID_PROVIDER, TEST", statusCheckMode: "STRICT", outcome: "VERIFIED" });
            var claims = {};
            (view.fields || []).forEach(function (f) { claims[f.path] = mask(f.value); });
            tech.mark(5, { status: "VERIFIED", trustEnvironment: "TEST", claims: claims });
            if (!view.adult) return fail("errorMinor");
            data = view; timers.later(received, 700); return true;
          }
          if (view.status === "AWAITING_WALLET" || view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING" ||
              view.status === "CREATED" || view.status === "REQUEST_READY") return false;
          fail(FAILURES[view.status] || "errorProtocol");
          return true;
        }
        function poll(id, token) {
          var busy = false;
          timers.every(function () {
            if (busy) return;
            busy = true;
            fetch("api/presentaciones/" + encodeURIComponent(id), {
              headers: token ? { "x-onboarding-token": token } : {}
            }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
              .then(function (view) { busy = settle(view) === true; })
              .catch(function () { busy = false; });
          }, 1500);
        }
        function playRecorded() {
          tech.mark(1, CFG.recorded.request);
          add(box, el("div", "qr qr-recorded", "QR"));
          note.textContent = t("recordedRibbon");
          CFG.recorded.statuses.forEach(function (x) {
            timers.later(function () {
              settle(x.status === "VERIFIED"
                ? { status: "VERIFIED", fields: CFG.recorded.fields, adult: true }
                : { status: x.status });
            }, x.afterMs);
          });
        }

        if (resumeId) { poll(resumeId, null); return; }
        if (recorded) { playRecorded(); return; }

        add(box, el("p", "note", t("connectStarting")));
        fetch("api/presentaciones", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ modo: mode })
        }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then(function (p) {
            clear(box);
            tech.mark(1, p.request);
            if (mode === "qr") {
              var svg = new DOMParser().parseFromString(p.qrSvg, "image/svg+xml").documentElement;
              add(box, add(el("div", "qr"), document.importNode(svg, true)), el("p", "qr-caption", t("connectQr")));
              var until = new Date(p.expiresAt).getTime();
              timers.every(function () {
                note.textContent = t("connectQrNote", { s: Math.max(0, Math.round((until - Date.now()) / 1000)) });
              }, 500);
              add(box, button(t("connectUsePhone"), "btn-link", function () { connect("movil"); }));
            } else {
              var a = el("a", "btn btn-primary", t("connectOpen"));
              a.href = p.walletUri;
              primary = function () { window.location.href = p.walletUri; };
              add(box, el("p", "", t("connectOpenBody")), a,
                button(t("connectUseQr"), "btn-link", function () { connect("qr"); }));
            }
            poll(p.id, p.token);
          })
          .catch(function () { fail("errorUnavailable"); });
      });
    }

    function received() {
      screen(2, function (s) {
        add(s, el("h1", "", t("dataTitle")), el("p", "lead", t("dataLead")));
        var form = el("div", "form");
        var labels = {};
        CFG.fields.forEach(function (f) { labels[f.path] = t(f.label); });
        data.fields.forEach(function (f, i) {
          var row = el("div", "field field-verified");
          var value = el("div", "field-value");
          add(row, el("label", "", labels[f.path] || f.path), value,
            add(el("span", "seal"), el("span", "seal-icon", "🛡"), el("span", "", t("verifiedSeal"))));
          add(form, row);
          timers.later(function () { row.classList.add("in"); value.textContent = f.value; }, 250 + i * 300);
        });
        add(s, form, el("p", "adult", "✓ " + t("adultCheck")));

        var kyc = el("div", "form kyc");
        function input(key, type, sample) {
          var i = el("input"); i.type = type; i.dataset.sample = sample; i.autocomplete = "off";
          add(kyc, add(el("div", "field"), el("label", "", t(key)), i));
          return i;
        }
        function select(key, options) {
          var sel = el("select");
          t(options).split("|").forEach(function (o) { add(sel, el("option", "", o)); });
          add(kyc, add(el("div", "field"), el("label", "", t(key)), sel));
        }
        var email = input("kycEmail", "email", t("kycEmailSample"));
        var phone = input("kycPhone", "tel", t("kycPhoneSample"));
        var income = null;
        if (loan) {
          select("loanEmployment", "loanEmploymentOptions");
          income = input("loanIncome", "number", t("loanIncomeSample"));
          income.min = "0"; income.step = "50";
        } else {
          select("kycActivity", "kycActivityOptions");
          select("kycFunds", "kycFundsOptions");
        }
        primary = function () {
          [email, phone, income].forEach(function (i) { if (i && !i.value) i.value = i.dataset.sample; });
          typed = loan ? 3 : 2;
          if (loan) { loan.income = Math.max(0, Number(income.value) || 0); decision(); }
          else sign();
        };
        add(s, el("h2", "", t("kycTitle")), kyc, add(el("div", "actions"), button(t("continue"), "btn-primary", primary)));
      });
    }

    // The "decision" is a rule on a figure the person typed. Nothing is assessed, and the screen says so.
    function decision() {
      screen(2, function (s) {
        s.classList.add("review");
        add(s, el("h1", "", t("loanDecisionTitle")), el("div", "hourglass", "⚙"), el("p", "note", t("loanDecisionNote")));
        primary = offer;
        timers.later(offer, 1800);
      });
    }

    function offer() {
      loan.granted = LOAN.affordable(loan.amount, loan.income, loan.months, LOAN.annualRatePercent, LOAN.maxPaymentShare, LOAN.stepAmount);
      screen(2, function (s) {
        if (loan.granted < LOAN.minAmount) {
          add(s, el("h1", "", t("loanRefusedTitle")), el("p", "lead", t("loanRefusedBody")), el("p", "note", t("loanDecisionNote")));
          primary = reset;
          add(s, add(el("div", "actions"), button(t("compareAgain"), "btn-secondary", reset)));
          return;
        }
        var q = payment(loan.granted);
        add(s, el("h1", "", t(loan.granted < loan.amount ? "loanOfferLowerTitle" : "loanOfferTitle", { name: name() })));
        if (loan.granted < loan.amount) add(s, el("p", "lead", t("loanOfferLowerBody", { asked: euros(loan.amount) })));
        var card = el("div", "summary");
        [[t("loanAmount"), euros(loan.granted)], [t("loanTerm"), t("loanMonths", { n: loan.months })],
         [t("loanMonthly"), euros(q, 2)], [t("loanRateLabel"), String(LOAN.annualRatePercent).replace(".", ",") + " %"],
         [t("loanTotal"), euros(q * loan.months, 2)]].forEach(function (r) {
          add(card, add(el("div", "kv"), el("span", "", r[0]), el("strong", "", r[1])));
        });
        primary = sign;
        add(s, card, el("p", "note", t("loanDecisionNote")), add(el("div", "actions"), button(t("loanAccept"), "btn-primary", primary)));
      });
    }

    function name() {
      var f = (data.fields || []).filter(function (x) { return x.path === "given_name"; })[0];
      return f ? f.value : "";
    }
    function fullName() {
      var f = (data.fields || []).filter(function (x) { return x.path === "family_name"; })[0];
      return (name() + " " + (f ? f.value : "")).trim();
    }

    function otp(parent, after) {
      var overlay = el("div", "otp");
      var digits = el("div", "otp-digits");
      var cells = [0, 1, 2, 3, 4, 5].map(function () { var c = el("span", "otp-cell"); add(digits, c); return c; });
      add(overlay, el("h2", "", t("otpTitle")), digits, el("p", "note", t("otpNote")));
      add(parent, overlay);
      cells.forEach(function (c, i) { timers.later(function () { c.textContent = String((i * 7 + 3) % 10); }, 200 + i * 180); });
      timers.later(after, 1700);
    }

    function sign() {
      screen(3, function (s) {
        add(s, el("h1", "", t("signTitle")));
        var card = el("div", "summary");
        (loan
          ? [[t("loanTitle"), euros(loan.granted)], [t("signHolder"), fullName()],
             [t("loanMonthly"), euros(payment(loan.granted), 2) + " × " + loan.months]]
          : [[t("signProduct"), ""], [t("signHolder"), fullName()], [t("signFees"), t("signFeesValue")]]).forEach(function (r) {
          add(card, add(el("div", "kv"), el("span", "", r[0]), el("strong", "", r[1])));
        });
        var checks = [loan ? "loanCheck1" : "signCheck1", "signCheck2"].map(function (k) {
          var c = el("input"); c.type = "checkbox";
          add(card, add(el("label", "check"), c, el("span", "", t(k))));
          return c;
        });
        var started = false;
        primary = function () {
          if (started) return;
          started = true;
          checks.forEach(function (c) { c.checked = true; });
          otp(s, success);
        };
        add(s, card, add(el("div", "actions"), button(t(loan ? "loanSignCta" : "signCta"), "btn-primary", primary)));
      });
    }

    function loanSuccess(ms) {
      screen(3, function (s) {
        s.classList.add("success");
        add(s, el("div", "success-mark", "✓"), el("h1", "", t("loanSuccessTitle", { name: name() })),
          el("p", "lead", t("loanSuccessLead", { amount: euros(loan.granted) })));
        var metrics = el("div", "metrics");
        [[fmt(ms), t("compareTime")], ["3", t("compareSteps")], ["0", t("compareDocs")], [euros(payment(loan.granted), 2), t("loanMonthly")]]
          .forEach(function (m) { add(metrics, add(el("div", "metric"), el("strong", "", m[0]), el("span", "", m[1]))); });
        primary = reset;
        add(s, metrics, el("p", "note", t("loanFictitious")), add(el("div", "actions"), button(t("compareAgain"), "btn-secondary", reset)));
      });
      done = true;
    }

    function success() {
      clock.stop(); store(null);
      var ms = clock.ms();
      if (loan) return loanSuccess(ms);
      screen(3, function (s) {
        s.classList.add("success");
        add(s, el("div", "success-mark", "✓"), el("h1", "", t("successTitle", { name: name() })), el("p", "lead", t("successLead")));
        var card = el("div", "bank-card");
        add(card, el("span", "bank-card-brand", "Horizonte"), el("span", "bank-card-number", "•••• •••• •••• 0000"), el("span", "", t("successCard")));
        add(s, add(el("div", "success-grid"),
          add(el("div", "summary"), add(el("div", "kv"), el("span", "", t("successIban")), el("strong", "", t("successIbanValue")))),
          card));
        var metrics = el("div", "metrics");
        [[fmt(ms), t("compareTime")], ["3", t("compareSteps")], ["0", t("compareDocs")], [t("compareNo"), t("compareReview")]]
          .forEach(function (m) { add(metrics, add(el("div", "metric"), el("strong", "", m[0]), el("span", "", m[1]))); });
        primary = function () { go("compare"); };
        add(s, metrics, add(el("div", "actions"), button(t("successCompare"), "btn-primary", primary)));
      });
      done = true;
      results.eudi = { ms: ms, steps: 3, typed: typed, docs: 0, retries: 0, review: false, recorded: recorded };
      if (opts.onDone) opts.onDone();
    }

    if (opts.resume) {
      clock.start(stored() || Date.now());
      connect("movil", opts.resume);
    } else product();

    return {
      advance: function () { if (primary) primary(); },
      destroy: function () { timers.stop(); },
      isDone: function () { return done; }
    };
  }

  // --- the simulated current flow ----------------------------------------------------------------

  function currentFlow(host, opts) {
    var timers = Timers(), clock = Clock(6), head = flowHeader(t("modeCurrent"), 5, true);
    var body = el("div", "flow-body");
    var m = { typed: 0, docs: 0, retries: 0, review: false };
    var stage = "", finish = null, at = -1, done = false, MINUTES = 60 * 1000;
    var chipTyped = el("span", "chip"), chipRetries = el("span", "chip chip-friction"), chipDocs = el("span", "chip");
    add(head.chips, chipTyped, chipDocs, chipRetries);
    add(host, head.node, body);

    function chips() {
      chipTyped.textContent = t("currentTyped") + ": " + m.typed;
      chipDocs.textContent = t("currentDocs") + ": " + m.docs;
      chipRetries.textContent = t("currentRetries") + ": " + m.retries;
      chipRetries.hidden = m.retries === 0;
    }
    function screen(step, title, build) {
      timers.stop();
      timers.every(function () { head.setTime(m.review && at === 3 ? fmt(clock.ms()) + " · " + t("currentPending") : fmt(clock.ms())); }, 250);
      clear(body);
      head.setStep(step);
      stage = title; at = step - 1;
      var s = el("section", "screen");
      add(s, el("h1", "", title));
      add(body, s);
      chips();
      build(s);
    }
    function next(fn) {
      if (opts.auto) timers.later(fn, 900);
    }
    function actions(s, label, fn, cls) {
      add(s, add(el("div", "actions"), button(label, cls || "btn-primary", fn)));
    }

    function form() {
      clock.start();
      var fields = t("currentFields").split("|").map(function (x) { return x.split("="); });
      screen(1, t("currentFormTitle"), function (s) {
        var grid = el("div", "form");
        var values = fields.map(function (f) {
          var v = el("div", "field-value typing");
          add(grid, add(el("div", "field"), el("label", "", f[0]), v));
          return v;
        });
        add(s, grid);
        finish = function () {
          values.forEach(function (v, i) { v.textContent = fields[i][1]; v.classList.remove("typing"); });
          m.typed = fields.length; clock.atLeast(MINUTES * 4); chips(); documents();
        };
        actions(s, t("continue"), finish, "btn-secondary");
        var i = 0, c = 0;
        timers.every(function () {
          if (i >= fields.length) return;
          c += 1;
          values[i].textContent = fields[i][1].slice(0, c);
          if (c >= fields[i][1].length) {
            values[i].classList.remove("typing");
            i += 1; c = 0; m.typed = i; chips();
            if (i === fields.length) next(finish);
          }
        }, 45);
      });
    }

    function capture(s, label, script, after) {
      var frame = el("div", "capture");
      var msg = el("div", "capture-msg");
      add(s, add(el("div", "capture-wrap"), el("div", "capture-label", label), frame, msg));
      var delay = 0;
      script.forEach(function (x) {
        timers.later(function () {
          frame.className = "capture " + x.cls;
          msg.className = "capture-msg " + (x.cls === "fail" ? "friction" : x.cls === "ok" ? "good" : "");
          msg.textContent = t(x.text);
          if (x.apply) { x.apply(); chips(); }
        }, delay);
        delay += x.ms;
      });
      timers.later(after, delay);
    }

    function documents() {
      screen(2, t("currentDocTitle"), function (s) {
        finish = function () { m.docs = 2; m.retries = 1; clock.atLeast(MINUTES * 7); chips(); selfie(); };
        capture(s, t("currentDocFront"), [
          { cls: "busy", text: "currentCapturing", ms: 1500 },
          { cls: "fail", text: "currentDocBlur", ms: 1600, apply: function () { m.retries = 1; } },
          { cls: "busy", text: "currentCapturing", ms: 1500 },
          { cls: "ok", text: "currentDocOk", ms: 700, apply: function () { m.docs = 1; } }
        ], function () {
          capture(s, t("currentDocBack"), [
            { cls: "busy", text: "currentCapturing", ms: 1500 },
            { cls: "ok", text: "currentDocOk", ms: 700, apply: function () { m.docs = 2; } }
          ], function () { next(finish); });
        });
        actions(s, t("continue"), function () { finish(); }, "btn-secondary");
      });
    }

    function selfie() {
      screen(3, t("currentSelfieTitle"), function (s) {
        finish = function () { m.docs = 3; m.retries = 2; clock.atLeast(MINUTES * 9); chips(); review(); };
        capture(s, "", [
          { cls: "busy round", text: "currentSelfieHint", ms: 2200 },
          { cls: "fail round", text: "currentSelfieFail", ms: 1600, apply: function () { m.retries = 2; } },
          { cls: "busy round", text: "currentSelfieHint", ms: 2200 },
          { cls: "ok round", text: "currentSelfieOk", ms: 700, apply: function () { m.docs = 3; } }
        ], function () { next(finish); });
        actions(s, t("continue"), function () { finish(); }, "btn-secondary");
      });
    }

    function review() {
      // The stopwatch jumps: a day goes by, and the account is still pending.
      clock.stop(); clock.jump(24 * 3600 * 1000); m.review = true;
      screen(4, t("currentReviewTitle"), function (s) {
        s.classList.add("review");
        add(s, el("div", "hourglass", "⏳"), el("p", "lead friction", t("currentReviewBody")));
        finish = function () { clock.start(); sign(); };
        actions(s, t("currentReviewForce"), function () { finish(); }, "btn-secondary");
      });
      if (opts.onStuck) opts.onStuck();
    }

    function sign() {
      screen(5, t("currentOtpTitle"), function (s) {
        var digits = el("div", "otp-digits");
        [0, 1, 2, 3, 4, 5].forEach(function (i) {
          var c = el("span", "otp-cell"); add(digits, c);
          timers.later(function () { c.textContent = String((i * 3 + 1) % 10); }, 300 + i * 250);
        });
        add(s, digits);
        finish = function () { end(); };
        timers.later(function () { finish(); }, 2400);
      });
    }

    function end() {
      clock.stop();
      var ms = clock.ms();
      screen(5, t("currentDoneTitle"), function (s) {
        add(s, el("p", "lead", t("currentDoneBody")));
        finish = null;
        if (!opts.compact) actions(s, t("successCompare"), function () { go("compare"); });
      });
      done = true;
      results.current = { ms: ms, steps: 5, typed: m.typed, docs: m.docs, retries: m.retries, review: true };
      if (opts.onDone) opts.onDone();
    }

    form();
    return {
      advance: function () { if (finish) finish(); },
      destroy: function () { timers.stop(); },
      stage: function () { return stage; },
      isDone: function () { return done; },
      snapshot: function () {
        return { ms: clock.ms(), steps: 5, typed: m.typed, docs: m.docs, retries: m.retries, review: m.review, partial: true };
      }
    };
  }

  // --- the three acts ----------------------------------------------------------------------------

  function MOBILE() { return window.matchMedia("(max-width: 720px)").matches; }

  function leave() {
    flows.forEach(function (f) { f.destroy(); });
    flows = []; advanceTarget = null;
    clear(app);
    app.className = "";
  }

  function cover() {
    var s = el("section", "cover");
    add(s, el("h1", "", t("coverTitle")), el("p", "lead", t("coverLead")));
    var cards = el("div", "cover-cards");
    function card(cls, title, text, cta, target, badge) {
      var c = el("div", "cover-card " + cls);
      add(c, badge ? el("span", "badge-new", t("badgeNew")) : null, el("h2", "", title), el("p", "", text),
        button(cta, cls === "eudi" ? "btn-primary" : "btn-secondary", function () { go(target); }));
      add(cards, c);
    }
    card("current", t("coverCurrentTitle"), t("coverCurrentBody"), t("coverCurrentCta"), "current");
    card("eudi", t("coverEudiTitle"), t("coverEudiBody"), t("coverEudiCta"), "eudi", true);
    var more = el("div", "cover-more");
    add(more, add(el("div"), el("h2", "", t("coverLoanTitle")), el("p", "", t("coverLoanBody"))),
      button(t("coverLoanCta"), "btn-secondary", function () { go("loan"); }));
    add(s, cards, add(el("div", "actions center"), button(t("coverCompare"), "btn-outline", function () { go("side"); })), more);
    add(app, s);
    advanceTarget = { advance: function () { go("eudi"); } };
  }

  function solo(kind, resume) {
    var pane = el("div", "pane pane-solo");
    add(app, pane);
    var flow = kind === "eudi"
      ? eudiFlow(pane, { resume: resume, onClassic: function () { go("current"); } })
      : kind === "loan"
        ? eudiFlow(pane, { product: "loan" })
        : currentFlow(pane, { auto: false });
    flows.push(flow); advanceTarget = flow;
  }

  function side() {
    app.className = "side";
    var left = el("div", "pane"), right = el("div", "pane"), banner = el("div", "side-banner");
    banner.hidden = true;
    add(app, banner, add(el("div", "side-grid"), left, right));
    var current = currentFlow(left, { auto: true, compact: true });
    var eudi = eudiFlow(right, {
      compact: true,
      onDone: function () {
        if (!current.isDone()) results.current = current.snapshot();
        banner.hidden = false;
        clear(banner);
        add(banner, el("span", "", t("sideDone", { where: current.stage() })),
          button(t("successCompare"), "btn-primary", function () { go("compare"); }));
      }
    });
    flows.push(current, eudi); advanceTarget = eudi;
  }

  function compare() {
    var s = el("section", "compare");
    add(s, el("h1", "", t("compareTitle")));
    var table = el("table", "compare-table");
    var c = results.current, e = results.eudi;
    function cell(r, value) { return el("td", "", r ? value(r) : t("compareNotRun")); }
    add(table, add(el("tr"), el("th", "", ""), el("th", "col-current", t("coverCurrentTitle")), el("th", "col-eudi", t("coverEudiTitle"))));
    [
      ["compareTime", function (r) { return fmt(r.ms) + (r.partial ? " · " + t("currentPending") : ""); }],
      ["compareSteps", function (r) { return String(r.steps); }],
      ["compareTyped", function (r) { return String(r.typed); }],
      ["compareDocs", function (r) { return String(r.docs); }],
      ["compareRetries", function (r) { return String(r.retries); }],
      ["compareReview", function (r) { return r.review ? t("compareYes") : t("compareNo"); }]
    ].forEach(function (row) {
      add(table, add(el("tr"), el("th", "", t(row[0])), cell(c, row[1]), cell(e, row[1])));
    });
    add(s, table, el("p", "note", t("compareNote")));
    if (e && e.recorded) add(s, el("p", "note friction", t("compareNoteRecorded")));
    add(s, add(el("div", "actions center"), button(t("compareAgain"), "btn-secondary", reset)));
    add(app, s);
    advanceTarget = null;
  }

  function go(view, resume) {
    leave();
    if (view === "eudi") solo("eudi", resume);
    else if (view === "current") solo("current");
    else if (view === "loan") solo("loan");
    else if (view === "side") side();
    else if (view === "compare") compare();
    else cover();
    window.scrollTo(0, 0);
  }

  function reset() {
    results = { eudi: null, current: null };
    store(null);
    tech.reset();
    if (CFG.resume) { window.location.href = "./"; return; }
    go("cover");
  }

  function setRecorded(on) {
    recorded = on || !CFG.live;
    ribbon.hidden = !recorded;
  }

  // --- presenter mode ----------------------------------------------------------------------------

  document.addEventListener("keydown", function (ev) {
    var tag = ev.target && ev.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var key = ev.key.toLowerCase();
    if (key === "r") reset();
    else if (key === "t") tech.toggle();
    // The fallback's switch: unlisted on the page, and what it turns on is announced on every screen.
    else if (key === "g") setRecorded(!recorded);
    else if (key === "arrowright" || key === " " || key === "pagedown") {
      if (tag === "BUTTON" || tag === "A") return;
      ev.preventDefault();
      if (advanceTarget) advanceTarget.advance();
    }
  });
  document.getElementById("restart").addEventListener("click", reset);

  setRecorded(false);
  if (CFG.resume) go("eudi", CFG.resume); else go("cover");
})();
`}`;
