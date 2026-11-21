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
  var SESSION_KEY = "horizonte.session";

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
  // What a same-device return needs to pick the flow up again: which product, the loan's amount and
  // term, and the id of the PID presentation. Ids and figures the person chose; never a claim.
  function saveSession(value) {
    try {
      if (value === null) window.localStorage.removeItem(SESSION_KEY);
      else window.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    } catch (e) { /* as above */ }
  }
  function loadSession() {
    try { return JSON.parse(window.localStorage.getItem(SESSION_KEY) || "null"); }
    catch (e) { return null; }
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
    // A flow may word a step its own way ("Login"); a step it does not reword keeps the default.
    var script = "";
    function label(n) {
      var suffix = view === "business" ? "Business" : "Technical";
      return T["tech" + n + script + suffix] !== undefined ? t("tech" + n + script + suffix) : t("tech" + n + suffix);
    }
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
      use: function (name) { if (script !== name) { script = name; events = []; render(); } },
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
    // A loan that can ask for an income certificate has one more step: a second presentation.
    var LAST = opts.product === "loan" && CFG.income ? 4 : 3;
    var timers = Timers(), clock = Clock(1), head = flowHeader(t("modeEudi"), LAST, false);
    var body = el("div", "flow-body");
    var primary = null, typed = 0, data = null, done = false;
    var loan = opts.product === "loan"
      ? { amount: LOAN.defaultAmount, months: LOAN.defaultMonths, income: 0, granted: 0, verified: false, pidId: null }
      : null;
    // The PID presentation's id, which is also the back office's case, when there is one.
    var pidId = null;
    function report(outcome) {
      if (!pidId || recorded) return;
      fetch("api/expedientes/" + encodeURIComponent(pidId), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(outcome)
      }).catch(function () { /* no back office, or the case has gone: nothing to tell the person */ });
    }
    function remember() { if (loan) saveSession({ product: "loan", amount: loan.amount, months: loan.months, pidId: loan.pidId }); }
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
        primary = function () { clock.start(); store(Date.now()); remember(); consent(); };
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

    function phoneFrame(kind) {
      var phone = el("div", "phone");
      var inner = el("div", "phone-screen");
      add(inner, el("div", "phone-title", t("phoneAsks")));
      var ul = el("ul", "phone-list");
      (kind === "ingresos"
        ? ["incomeAskIncome", "incomeAskContract", "incomeAskSince", "consentName", "consentBirth"]
        : ["consentName", "consentBirth", "consentNationality", "consentDocument", "consentAddress"]).forEach(function (k) {
        add(ul, add(el("li"), el("span", "phone-check", "✓"), el("span", "", t(k))));
      });
      add(inner, ul, el("p", "phone-body", t("phoneBody")), el("div", "phone-pin", "● ● ● ● ● ●"));
      add(phone, inner);
      return add(el("figure", "phone-wrap"), phone, el("figcaption", "", t("phoneNote")));
    }

    function connect(mode, resumeId, kind) {
      kind = kind || "pid";
      var income = kind === "ingresos";
      // The panel follows one presentation at a time: the second replaces the first.
      if (income && !resumeId) tech.reset();
      screen(income ? 3 : 2, function (s) {
        var left = el("div", "connect-main"), status = statusSteps(), box = el("div", "connect-box");
        var note = el("p", "note"), error = el("div", "error"); error.hidden = true;
        add(left, el("h1", "", t(income ? "incomeConnectTitle" : "connectTitle")), box, note, status.node, error);
        add(s, add(el("div", "connect"), left, opts.compact ? null : phoneFrame(kind)));
        status.set("AWAITING_WALLET");

        function fail(key) {
          timers.stop();
          timers.every(function () { head.setTime(fmt(clock.ms())); }, 250);
          clear(box); note.textContent = "";
          error.hidden = false; error.textContent = t(key);
          primary = function () { connect(mode, null, kind); };
          add(box, button(t("connectRetry"), "btn-secondary", primary));
        }
        function settle(view) {
          status.set(view.status);
          if (view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING" || view.status === "VERIFIED") {
            tech.mark(2, null, { notObserved: true });
            tech.mark(3, { status: view.status });
          }
          if (view.status === "VERIFIED" && income) {
            tech.mark(4, { issuerTrust: "ETSI TS 119 602 list, EAA_PROVIDER, TEST", statusCheckMode: "STRICT", outcome: "VERIFIED" });
            tech.mark(5, { status: "VERIFIED", trustEnvironment: "TEST", claims: mask(view.income) });
            timers.later(function () { incomeVerified(view.income); }, 700);
            return true;
          }
          if (view.status === "VERIFIED") {
            tech.mark(4, { issuerTrust: "ETSI TS 119 602 list, PID_PROVIDER, TEST", statusCheckMode: "STRICT", outcome: "VERIFIED" });
            var claims = {};
            (view.fields || []).forEach(function (f) { claims[f.path] = mask(f.value); });
            tech.mark(5, { status: "VERIFIED", trustEnvironment: "TEST", claims: claims });
            if (!view.adult) return fail("errorMinor");
            if (view.alreadyCustomer && !loan) { timers.later(alreadyCustomer, 700); return true; }
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
            fetch("api/presentaciones/" + encodeURIComponent(id) + (income ? "?tipo=ingresos" : ""), {
              headers: token ? { "x-onboarding-token": token } : {}
            }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
              .then(function (view) { busy = settle(view) === true; })
              .catch(function () { busy = false; });
          }, 1500);
        }
        function playRecorded() {
          tech.mark(1, income ? CFG.recorded.incomeRequest : CFG.recorded.request);
          add(box, el("div", "qr qr-recorded", "QR"));
          note.textContent = t("recordedRibbon");
          CFG.recorded.statuses.forEach(function (x) {
            timers.later(function () {
              settle(x.status !== "VERIFIED"
                ? { status: x.status }
                : income
                  ? { status: "VERIFIED", income: CFG.recorded.income }
                  : { status: "VERIFIED", fields: CFG.recorded.fields, adult: true });
            }, x.afterMs);
          });
        }

        if (resumeId) { poll(resumeId, null); return; }
        if (recorded) { playRecorded(); return; }

        add(box, el("p", "note", t("connectStarting")));
        fetch("api/presentaciones", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(income
            ? { modo: mode, tipo: kind, pid: pidId || undefined }
            : { modo: mode, tipo: kind, producto: loan ? "prestamo" : "cuenta" })
        }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then(function (p) {
            clear(box);
            tech.mark(1, p.request);
            if (!income) pidId = p.id;
            if (loan && !income) { loan.pidId = p.id; remember(); }
            if (mode === "qr") {
              var svg = new DOMParser().parseFromString(p.qrSvg, "image/svg+xml").documentElement;
              add(box, add(el("div", "qr"), document.importNode(svg, true)), el("p", "qr-caption", t("connectQr")));
              var until = new Date(p.expiresAt).getTime();
              timers.every(function () {
                note.textContent = t("connectQrNote", { s: Math.max(0, Math.round((until - Date.now()) / 1000)) });
              }, 500);
              add(box, button(t("connectUsePhone"), "btn-link", function () { connect("movil", null, kind); }));
            } else {
              var a = el("a", "btn btn-primary", t("connectOpen"));
              a.href = p.walletUri;
              primary = function () { window.location.href = p.walletUri; };
              add(box, el("p", "", t("connectOpenBody")), a,
                button(t("connectUseQr"), "btn-link", function () { connect("qr", null, kind); }));
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
        if (loan && CFG.income) {
          // Nothing more to type: the income comes from a certificate, in the next step.
        } else if (loan) {
          select("loanEmployment", "loanEmploymentOptions");
          income = input("loanIncome", "number", t("loanIncomeSample"));
          income.min = "0"; income.step = "50";
        } else {
          select("kycActivity", "kycActivityOptions");
          select("kycFunds", "kycFundsOptions");
        }
        primary = function () {
          [email, phone, income].forEach(function (i) { if (i && !i.value) i.value = i.dataset.sample; });
          typed = income ? 3 : 2;
          if (loan && CFG.income) incomeIntro();
          else if (loan) { loan.income = Math.max(0, Number(income.value) || 0); decision(); }
          else sign();
        };
        add(s, el("h2", "", t("kycTitle")), kyc, add(el("div", "actions"), button(t("continue"), "btn-primary", primary)));
      });
    }

    function alreadyCustomer() {
      screen(2, function (s) {
        s.classList.add("outcome");
        add(s, el("div", "outcome-icon", "✓"), el("h1", "", t("alreadyCustomerTitle")), el("p", "", t("alreadyCustomerBody")));
        primary = function () { go("login"); };
        add(s, add(el("div", "actions center"), button(t("loginCta"), "btn-primary", primary),
          button(t("compareAgain"), "btn-secondary", reset)));
      });
      done = true;
    }

    function field(name) {
      var f = (data.fields || []).filter(function (x) { return x.path === name; })[0];
      return f ? f.value : "";
    }
    function same(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

    function incomeIntro() {
      screen(3, function (s) {
        add(s, el("h1", "", t("incomeIntroTitle")), el("p", "lead", t("incomeIntroBody")));
        var ul = el("ul", "asked");
        [["incomeAskIncome", "💶"], ["incomeAskContract", "📄"], ["incomeAskSince", "📆"]].forEach(function (x) {
          add(ul, add(el("li"), el("span", "asked-icon", x[1]),
            add(el("span", "asked-text"), el("strong", "", t(x[0])), el("small", "", t(x[0] + "Why")))));
        });
        primary = function () { connect(MOBILE() ? "movil" : "qr", null, "ingresos"); };
        add(s, ul, add(el("div", "actions"), button(t("incomeCta"), "btn-primary", primary)));
      });
    }

    // The certificate must be the same person's as the PID. The page compares what the two results
    // say; a production lender would do it in its back end.
    function incomeVerified(income) {
      var h = income.holder || {};
      if (!same(h.givenName, field("given_name")) || !same(h.familyName, field("family_name")) || !same(h.birthdate, field("birthdate"))) {
        screen(3, function (s) {
          add(s, el("h1", "", t("incomeIntroTitle")));
          var error = el("div", "error", t("errorHolderMismatch"));
          primary = incomeIntro;
          add(s, error, add(el("div", "actions"), button(t("connectRetry"), "btn-secondary", primary)));
        });
        return;
      }
      loan.income = income.netMonthlyIncome; loan.verified = true;
      screen(3, function (s) {
        add(s, el("h1", "", t("incomeVerifiedTitle")), el("p", "lead", t("incomeVerifiedLead")));
        var form = el("div", "form");
        var contract = t("incomeContract_" + income.contractType);
        [[t("incomeNet"), euros(income.netMonthlyIncome)],
         [t("incomeContract"), contract.indexOf("incomeContract_") === 0 ? income.contractType : contract],
         [t("incomeSince"), income.employedSince]].forEach(function (r, i) {
          var row = el("div", "field field-verified"), value = el("div", "field-value");
          add(row, el("label", "", r[0]), value,
            add(el("span", "seal"), el("span", "seal-icon", "🛡"), el("span", "", t("verifiedSeal"))));
          add(form, row);
          timers.later(function () { row.classList.add("in"); value.textContent = r[1]; }, 250 + i * 300);
        });
        primary = decision;
        add(s, form, add(el("div", "actions"), button(t("continue"), "btn-primary", primary)));
      });
    }

    function decisionNote() { return t(loan.verified ? "loanDecisionNoteVerified" : "loanDecisionNote"); }

    // The "decision" is a rule on one figure: typed by the person, or read from a certificate whose
    // values are fictitious. Nothing is assessed, and the screen says which.
    function decision() {
      screen(LAST - 1, function (s) {
        s.classList.add("review");
        add(s, el("h1", "", t("loanDecisionTitle")), el("div", "hourglass", "⚙"), el("p", "note", decisionNote()));
        primary = offer;
        timers.later(offer, 1800);
      });
    }

    function offer() {
      loan.granted = LOAN.affordable(loan.amount, loan.income, loan.months, LOAN.annualRatePercent, LOAN.maxPaymentShare, LOAN.stepAmount);
      screen(LAST - 1, function (s) {
        if (loan.granted < LOAN.minAmount) {
          add(s, el("h1", "", t("loanRefusedTitle")), el("p", "lead", t("loanRefusedBody")), el("p", "note", decisionNote()));
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
        add(s, card, el("p", "note", decisionNote()), add(el("div", "actions"), button(t("loanAccept"), "btn-primary", primary)));
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
      screen(LAST, function (s) {
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
      saveSession(null);
      report({ product: "prestamo", signed: true, amount: loan.amount, months: loan.months, granted: loan.granted, monthlyPayment: payment(loan.granted) });
      screen(LAST, function (s) {
        s.classList.add("success");
        add(s, el("div", "success-mark", "✓"), el("h1", "", t("loanSuccessTitle", { name: name() })),
          el("p", "lead", t("loanSuccessLead", { amount: euros(loan.granted) })));
        var metrics = el("div", "metrics");
        [[fmt(ms), t("compareTime")], [String(LAST), t("compareSteps")], ["0", t("compareDocs")], [euros(payment(loan.granted), 2), t("loanMonthly")]]
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
        add(card, el("span", "bank-card-brand", t("brandShort")), el("span", "bank-card-number", "•••• •••• •••• 0000"), el("span", "", t("successCard")));
        add(s, add(el("div", "success-grid"),
          add(el("div", "summary"), add(el("div", "kv"), el("span", "", t("successIban")), el("strong", "", t("successIbanValue")))),
          card));
        var metrics = el("div", "metrics");
        [[fmt(ms), t("compareTime")], ["3", t("compareSteps")], ["0", t("compareDocs")], [t("compareNo"), t("compareReview")]]
          .forEach(function (m) { add(metrics, add(el("div", "metric"), el("strong", "", m[0]), el("span", "", m[1]))); });
        primary = function () { go("compare"); };
        var acts = add(el("div", "actions"), button(t("successCompare"), "btn-primary", primary));
        // The customer this account opening made can log in now, with the same wallet.
        if (CFG.login && !opts.compact && !recorded) {
          add(acts, button(t("loginCta"), "btn-secondary", function () { go("login"); }));
          add(s, metrics, el("p", "note", t("joinedLogin")), acts);
        } else add(s, metrics, acts);
      });
      done = true;
      results.eudi = { ms: ms, steps: 3, typed: typed, docs: 0, retries: 0, review: false, recorded: recorded };
      report({ product: "cuenta", signed: true });
      if (opts.onDone) opts.onDone();
    }

    if (opts.resume) {
      clock.start(stored() || Date.now());
      var session = loadSession() || {};
      if (loan) {
        loan.amount = Number(session.amount) || loan.amount;
        loan.months = Number(session.months) || loan.months;
        loan.pidId = session.pidId || null;
      }
      pidId = loan && opts.resume.kind === "ingresos" ? loan.pidId : opts.resume.id;
      if (loan && opts.resume.kind === "ingresos" && loan.pidId) {
        // Back from the second presentation: the first one's result is read again by its id.
        fetch("api/presentaciones/" + encodeURIComponent(loan.pidId))
          .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then(function (view) {
            if (view.status !== "VERIFIED") throw new Error(view.status);
            data = view; connect("movil", opts.resume.id, "ingresos");
          })
          .catch(function () { product(); });
      } else connect("movil", opts.resume.id);
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

  function greeting() {
    var h = new Date().getHours();
    return t(h >= 6 && h < 14 ? "greetMorning" : h >= 14 && h < 21 ? "greetAfternoon" : "greetEvening");
  }

  /** The app's first screen: log in with the wallet, or become a customer. No credential field. */
  function home() {
    var s = el("section", "mobile home screen");
    add(s, el("div", "shapes"), el("h1", "greeting", greeting()), el("p", "lead", t("homeLead")), el("div", "spacer"));
    var stack = el("div", "stack");
    if (CFG.login) add(stack, button(t("loginCta"), "btn-primary", function () { go("login"); }));
    add(stack, button(t("joinCta"), CFG.login ? "btn-secondary" : "btn-primary", function () { go("eudi"); }));
    var note = el("p", "other-note", t(CFG.login ? "homeOtherNote" : "homeLoginOff"));
    note.hidden = CFG.login;
    var other = button(t("homeOther"), "btn-link", function () { note.hidden = !note.hidden; });
    add(s, stack, CFG.login ? add(el("div", "other"), other) : null, note);
    add(app, s);

    // The rest of the demonstration, for the presenter: below the app, never in its way.
    var more = el("section", "home-more");
    var grid = el("div", "home-more-grid");
    function card(title, body, cta, target) {
      add(grid, add(el("div", "home-card"), el("strong", "", title), el("p", "", body),
        button(cta, "btn-secondary", function () { go(target); })));
    }
    card(t("coverCurrentTitle"), t("coverCurrentBody"), t("coverCurrentCta"), "current");
    card(t("coverCompare"), t("coverLead"), t("coverCompare"), "side");
    card(t("coverLoanTitle"), t("coverLoanBody"), t("coverLoanCta"), "loan");
    add(more, el("h2", "", t("homeMoreTitle")), grid);
    add(app, more);
    advanceTarget = { advance: function () { go(CFG.login ? "login" : "eudi"); } };
  }

  /**
   * One presentation from the wallet, drawn into "box": a QR, or the button that opens the wallet on
   * this device, then "connecting" while the page polls. "settle" receives every view and returns true
   * once it has dealt with an end; "failed" is called when no request could be made at all.
   */
  function present(o) {
    var box = o.box, timers = o.timers;
    function connecting() {
      add(box, add(el("div", "connecting"), add(el("div", "dots"), el("span"), el("span"), el("span")), el("span", "", t("loginConnecting"))));
    }
    function poll(id, token) {
      var busy = false;
      timers.every(function () {
        if (busy) return;
        busy = true;
        fetch("api/presentaciones/" + encodeURIComponent(id) + "?tipo=" + o.kind, { headers: token ? { "x-onboarding-token": token } : {} })
          .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then(function (view) { busy = o.settle(view) === true; })
          .catch(function () { busy = false; });
      }, 1500);
    }
    clear(box);
    if (o.resumeId) { connecting(); poll(o.resumeId, null); return; }
    if (recorded) {
      tech.mark(1, o.recordedRequest);
      add(box, el("div", "qr qr-recorded", "QR"), el("p", "note", t("recordedRibbon")));
      connecting();
      CFG.recorded.statuses.forEach(function (x) {
        timers.later(function () { o.settle(x.status !== "VERIFIED" ? { status: x.status } : o.recordedView); }, x.afterMs);
      });
      return;
    }
    add(box, el("p", "note", t("connectStarting")));
    var body = { modo: o.mode, tipo: o.kind };
    for (var k in (o.body || {})) body[k] = o.body[k];
    fetch("api/presentaciones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (res) {
        clear(box);
        tech.mark(1, res.request);
        if (o.onStarted) o.onStarted(res.id);
        if (o.mode === "qr") {
          var svg = new DOMParser().parseFromString(res.qrSvg, "image/svg+xml").documentElement;
          add(box, add(el("div", "qr"), document.importNode(svg, true)), el("p", "qr-caption", t("loginQr")),
            button(t("loginUsePhone"), "btn-link", function () { o.restart("movil"); }));
        } else {
          var a = el("a", "btn btn-primary", t("loginOpen"));
          a.href = res.walletUri;
          if (o.setPrimary) o.setPrimary(function () { window.location.href = res.walletUri; });
          add(box, a, el("p", "note", t("loginOpenBody")),
            button(t("loginUseQr"), "btn-link", function () { o.restart("qr"); }));
        }
        connecting();
        poll(res.id, res.token);
      })
      .catch(function () { o.failed(); });
  }

  /** The app screens' frame: a phone-width section with its corner shapes, rebuilt per screen. */
  function AppScreens(host, timers) {
    var s = el("section", "mobile");
    add(host, s);
    return {
      node: s,
      page: function (build, opts) {
        timers.stop(); clear(s);
        s.className = "mobile screen" + (opts && opts.outcome ? " outcome" : "");
        add(s, el("div", "shapes"));
        build(s);
        window.scrollTo(0, 0);
      }
    };
  }

  function outcomeScreen(screens, icon, title, body, actions, setPrimary) {
    screens.page(function (p) {
      add(p, el("div", "outcome-icon", icon), el("h1", "", title), body ? el("p", "", body) : null, el("div", "spacer"));
      var stack = el("div", "stack");
      actions.forEach(function (a, i) { add(stack, button(a[0], i === 0 ? "btn-primary" : "btn-secondary", a[1])); });
      setPrimary(actions[0][1]);
      add(p, stack);
    }, { outcome: true });
  }

  function marksFor(view, domain, result) {
    tech.mark(2, null, { notObserved: true });
    tech.mark(3, { status: "PRESENTATION_RECEIVED" });
    if (view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING") return;
    tech.mark(4, { issuerTrust: "ETSI TS 119 602 list, " + domain + ", TEST", statusCheckMode: "STRICT", outcome: "VERIFIED" });
    tech.mark(5, result);
  }
  var WAITING = { AWAITING_WALLET: 1, PRESENTATION_RECEIVED: 1, VERIFYING: 1, CREATED: 1, REQUEST_READY: 1 };

  /**
   * Log in with the wallet: one presentation asking for the document number, and the bank's answer —
   * the customer it kept, or not one. The page never sees the number: the server hashes and drops it.
   */
  function loginFlow(host, resume) {
    var timers = Timers(), primary = null;
    function setPrimary(fn) { primary = fn; }
    tech.use("Login");
    var screens = AppScreens(host, timers);
    function exit() { go("home"); }

    function signedIn(customer) {
      screens.page(function (p) {
        add(p, el("h1", "greeting", greeting() + ", " + customer.givenName));
        add(p, add(el("div", "acct"), el("small", "", t("signedAccount")), el("span", "acct-iban", customer.iban),
          el("small", "", t("signedBalance")), el("span", "acct-balance", euros(0, 2))));
        add(p, add(el("div", "tile"), add(el("span"), el("strong", "", t("signedCard")), el("small", "", "•••• 0000")),
          el("span", "chip chip-ok", t("signedCardActive"))));
        add(p, add(el("div", "who"), el("strong", "", "✓ " + t("signedWho")), el("span", "", t("signedAsked"))),
          el("p", "note", t("signedFictitious")), el("div", "spacer"));
        primary = exit;
        add(p, add(el("div", "stack"), button(t("logout"), "btn-secondary", exit)));
      });
    }

    function settle(view) {
      var end = view.status === "VERIFIED" || view.status === "NOT_A_CUSTOMER" || view.status === "NO_DOCUMENT";
      if (end || view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING") {
        marksFor(view, "PID_PROVIDER", { customer: view.status === "VERIFIED" ? "found" : view.status === "NOT_A_CUSTOMER" ? "not found" : "no document number", kept: "HMAC-SHA256 only" });
      }
      if (view.status === "VERIFIED" && view.customer) { timers.later(function () { signedIn(view.customer); }, 600); return true; }
      if (view.status === "NOT_A_CUSTOMER") {
        timers.later(function () {
          outcomeScreen(screens, "⚠", t("notCustomerTitle"), t("notCustomerBody"), [[t("joinCta"), function () { go("eudi"); }], [t("logout"), exit]], setPrimary);
        }, 600);
        return true;
      }
      if (view.status === "NO_DOCUMENT") {
        timers.later(function () { outcomeScreen(screens, "⚠", t("noDocumentTitle"), t("noDocumentBody"), [[t("logout"), exit]], setPrimary); }, 600);
        return true;
      }
      if (WAITING[view.status]) return false;
      failed(view.status);
      return true;
    }
    function failed(status) {
      var oops = !status;
      outcomeScreen(screens, "⚠", t(oops ? "loginOopsTitle" : "loginFailTitle"), t(oops ? "errorUnavailable" : FAILURES[status] || "errorProtocol"),
        [[t("connectRetry"), function () { connect(MOBILE() ? "movil" : "qr"); }], [t("logout"), exit]], setPrimary);
    }

    function connect(mode, resumeId) {
      if (!resumeId) tech.reset();
      screens.page(function (p) {
        add(p, el("h1", "", t("loginTitle")), el("p", "lead", t("loginAsks")));
        add(p, add(el("ul", "asked-one"), add(el("li"), el("span", "asked-icon", "🪪"),
          add(el("span"), el("strong", "", t("loginAskDocument")), el("small", "", t("loginAskDocumentWhy"))))));
        var box = el("div", "wallet-box");
        add(p, box);
        present({
          box: box, timers: timers, kind: "acceso", mode: mode, resumeId: resumeId,
          recordedRequest: CFG.recorded.loginRequest, recordedView: { status: "VERIFIED", customer: CFG.recorded.customer },
          settle: settle, failed: failed, setPrimary: setPrimary, restart: function (m) { connect(m); }
        });
      });
    }

    if (resume) connect("movil", resume.id);
    else connect(MOBILE() ? "movil" : "qr");
    return {
      advance: function () { if (primary) primary(); },
      destroy: function () { timers.stop(); },
      isDone: function () { return false; }
    };
  }

  /**
   * Opening an account in the six phases a retail bank's app uses, with the wallet doing what the
   * document photos, the selfie and the video did. Typed details are the ones a PID does not carry;
   * the economic activity, the consents and the signature are simulated, and say so.
   */
  function accountFlow(host, opts) {
    var timers = Timers(), clock = Clock(1), primary = null, data = null, pidId = null, typed = 0;
    function setPrimary(fn) { primary = fn; }
    var screens = AppScreens(host, timers);
    var PHASES = ["phaseData", "phaseIdentity", "phaseActivity", "phaseSetup", "phaseSign"];

    function frame(build, phase) {
      screens.page(function (p) {
        if (phase) {
          var head = add(el("div", "phase"), el("span", "", t("phaseOf", { n: phase, total: PHASES.length })));
          var time = el("span", "phase-time", fmt(clock.ms()));
          add(head, time);
          var bar = add(el("div", "phase-bar"), el("div", "phase-fill"));
          bar.firstChild.style.width = Math.round((phase / PHASES.length) * 100) + "%";
          add(p, head, bar);
          timers.every(function () { time.textContent = fmt(clock.ms()); }, 500);
        }
        build(p);
      });
    }
    function actions(p, label, fn, secondary) {
      primary = fn;
      add(p, el("div", "spacer"), add(el("div", "stack"), button(label, "btn-primary", fn), secondary || null));
    }
    function field(name) {
      var f = (data && data.fields || []).filter(function (x) { return x.path === name; })[0];
      return f ? f.value : "";
    }
    function report(outcome) {
      if (!pidId || recorded) return;
      fetch("api/expedientes/" + encodeURIComponent(pidId), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(outcome)
      }).catch(function () { /* nothing to tell the person */ });
    }
    function exit() { reset(); }

    // A0 — before you start
    function before() {
      frame(function (p) {
        add(p, el("h1", "", t("a0Title")));
        var products = el("ul", "asked-one");
        [["a0Account", "a0AccountWhy"], ["a0Card", "a0CardWhy"], ["a0App", "a0AppWhy"]].forEach(function (x) {
          add(products, add(el("li"), el("span", "asked-icon", "☑"), add(el("span"), el("strong", "", t(x[0])), el("small", "", t(x[1])))));
        });
        add(p, products, el("h2", "", t("a0NeedTitle")));
        var need = el("ul", "asked-one");
        [["a0NeedAdult", "👤"], ["a0NeedWallet", "▣"], ["a0NeedPhone", "📱"]].forEach(function (x) {
          add(need, add(el("li"), el("span", "asked-icon", x[1]), add(el("span"), el("strong", "", t(x[0])), el("small", "", t(x[0] + "Why")))));
        });
        add(p, need);
        actions(p, t("continue"), function () { clock.start(); store(Date.now()); identify(); },
          button(t("a0Classic"), "btn-link", function () { go("current"); }));
      });
    }

    // A1 — personal details: the PID first
    function identify(mode, resumeId) {
      if (!resumeId) tech.reset();
      frame(function (p) {
        add(p, el("h1", "", t("a1Title")), el("p", "lead", t("a1Lead")));
        var asked = el("ul", "asked-one");
        [["consentName", "👤"], ["consentBirth", "📅"], ["consentNationality", "🌍"], ["consentDocument", "🪪"], ["consentAddress", "🏠"]].forEach(function (x) {
          add(asked, add(el("li"), el("span", "asked-icon", x[1]), add(el("span"), el("strong", "", t(x[0])), el("small", "", t(x[0] + "Why")))));
        });
        var box = el("div", "wallet-box");
        add(p, asked, box);
        present({
          box: box, timers: timers, kind: "pid", mode: mode || (MOBILE() ? "movil" : "qr"), resumeId: resumeId, body: { producto: "cuenta" },
          recordedRequest: CFG.recorded.request, recordedView: { status: "VERIFIED", fields: CFG.recorded.fields, adult: true },
          onStarted: function (id) { pidId = id; },
          settle: settle, failed: function () { failed(); }, setPrimary: setPrimary,
          restart: function (m) { identify(m); }
        });
      }, 1);
    }
    function settle(view) {
      if (view.status === "PRESENTATION_RECEIVED" || view.status === "VERIFYING" || view.status === "VERIFIED") {
        var claims = {};
        (view.fields || []).forEach(function (f) { claims[f.path] = mask(f.value); });
        marksFor(view, "PID_PROVIDER", { status: "VERIFIED", trustEnvironment: "TEST", claims: claims });
      }
      if (view.status === "VERIFIED") {
        if (!view.adult) { timers.later(function () { outcomeScreen(screens, "⚠", t("minorTitle"), t("errorMinor"), [[t("logout"), exit]], setPrimary); }, 600); return true; }
        if (view.alreadyCustomer) {
          timers.later(function () {
            outcomeScreen(screens, "✓", t("alreadyCustomerTitle"), t("alreadyCustomerBody"), [[t("loginCta"), function () { go("login"); }], [t("logout"), exit]], setPrimary);
          }, 600);
          return true;
        }
        data = view; timers.later(details, 600); return true;
      }
      if (WAITING[view.status]) return false;
      failed(view.status);
      return true;
    }
    function failed(status) {
      outcomeScreen(screens, "⚠", t(status ? "loginFailTitle" : "loginOopsTitle"), t(status ? FAILURES[status] || "errorProtocol" : "errorUnavailable"),
        [[t("connectRetry"), function () { identify(); }], [t("logout"), exit]], setPrimary);
    }

    // A1 — the verified data, and what the PID does not carry
    function details() {
      frame(function (p) {
        add(p, el("h1", "", t("a1Title")), add(el("p", "verified-line"), el("strong", "", "✓ " + t("a1Verified"))));
        var list = el("div", "locked");
        var labels = {};
        CFG.fields.forEach(function (f) { labels[f.path] = t(f.label); });
        data.fields.forEach(function (f, i) {
          var row = add(el("div", "locked-row"), el("span", "", labels[f.path] || f.path), el("strong", "", ""), el("span", "lock", "🔒"));
          add(list, row);
          timers.later(function () { row.classList.add("in"); row.children[1].textContent = f.value; }, 150 + i * 150);
        });
        add(p, list, el("h2", "", t("a1ContactTitle")));
        function input(key, type, sample) {
          var i = el("input"); i.type = type; i.dataset.sample = sample; i.autocomplete = "off";
          add(p, add(el("div", "field"), el("label", "", t(key)), i));
          return i;
        }
        var email = input("kycEmail", "email", t("kycEmailSample"));
        var phone = input("kycPhone", "tel", t("kycPhoneSample"));
        actions(p, t("continue"), function () {
          [email, phone].forEach(function (i) { if (!i.value) i.value = i.dataset.sample; });
          typed = 2;
          verifyPhone();
        });
      }, 1);
    }
    function verifyPhone() {
      frame(function (p) {
        add(p, el("h1", "", t("a1OtpTitle")), el("p", "lead", t("a1OtpLead")));
        var digits = el("div", "otp-digits");
        var cells = [0, 1, 2, 3, 4, 5].map(function () { var c = el("span", "otp-cell"); add(digits, c); return c; });
        add(p, digits, el("p", "note", t("a1OtpNote")));
        cells.forEach(function (c, i) { timers.later(function () { c.textContent = String((i * 7 + 3) % 10); }, 300 + i * 200); });
        actions(p, t("continue"), function () { checklist(2, identity); });
        timers.later(function () { checklist(2, identity); }, 2200);
      }, 1);
    }

    // Between phases: what is done and what is left
    function checklist(doneCount, next) {
      frame(function (p) {
        add(p, el("h1", "", t(doneCount >= PHASES.length ? "checkAllTitle" : "checkTitle_" + doneCount)));
        var ol = el("ol", "checklist");
        PHASES.forEach(function (k, i) {
          var li = el("li", i < doneCount ? "done" : "");
          add(li, el("span", "check-dot", i < doneCount ? "✓" : String(i + 1)),
            add(el("span"), el("strong", "", t(k)), el("small", "", t(i < doneCount ? (k === "phaseIdentity" ? "checkByWallet" : "checkDone") : k + "Time"))));
          add(ol, li);
        });
        add(p, ol);
        actions(p, t("continue"), next);
      });
    }

    // A2 — identity verification: what the wallet replaced
    function identity() {
      frame(function (p) {
        add(p, el("div", "outcome-icon good", "✓"), el("h1", "", t("a2Title")), el("p", "lead", t("a2Lead")));
        var ul = el("ul", "proof");
        ["a2Check1", "a2Check2", "a2Check3"].forEach(function (k) { add(ul, el("li", "", t(k))); });
        add(p, el("p", "", t("a2Checked")), ul, el("p", "note", t("a2Replaced")));
        actions(p, t("continue"), activity);
      }, 2);
    }

    // A3 — economic activity, simulated
    function activity() {
      frame(function (p) {
        add(p, el("h1", "", t("a3Title")), add(el("p", "note"), el("span", "chip chip-warn", t("simulated")), document.createTextNode(" " + t("a3Note"))));
        function radios(key, options) {
          var fs = add(el("fieldset", "radios"), el("legend", "", t(key)));
          t(options).split("|").forEach(function (o, i) {
            var r = el("input"); r.type = "radio"; r.name = key; r.checked = i === 0;
            add(fs, add(el("label", "radio"), r, el("span", "", o)));
          });
          add(p, fs);
        }
        radios("a3Activity", "a3ActivityOptions");
        var sel = el("select");
        t("a3IncomeOptions").split("|").forEach(function (o) { add(sel, el("option", "", o)); });
        add(p, add(el("div", "field"), el("label", "", t("a3Income")), sel));
        radios("a3Pep", "a3YesNoNo");
        radios("a3Us", "a3YesNoNo");
        actions(p, t("continue"), function () { checklist(3, setup); });
      }, 3);
    }

    // A4 — set up the account
    function setup() {
      frame(function (p) {
        add(p, el("h1", "", t("a4Title")));
        add(p, el("h2", "", t("a4AccessTitle")), add(el("div", "who"), el("strong", "", "▣ " + t("a4Access")), el("span", "", t("a4AccessBody"))));
        add(p, el("h2", "", t("a4ConsentTitle")), el("p", "note", t("a4ConsentBody")));
        var choice = el("p", "verified-line");
        var go4 = function (label) { choice.textContent = "✓ " + label; timers.later(function () { checklist(4, sign); }, 500); };
        add(p, add(el("div", "stack"), button(t("a4AcceptAll"), "btn-secondary", function () { go4(t("a4Accepted")); }),
          button(t("a4RejectAll"), "btn-secondary", function () { go4(t("a4Rejected")); })), choice);
        add(p, el("h2", "", t("a4BranchTitle")), add(el("div", "tile"), add(el("span"), el("strong", "", t("a4Branch")), el("small", "", t("a4BranchWhy")))));
        actions(p, t("a4Confirm"), function () { go4(t("a4Accepted")); });
      }, 4);
    }

    // A5 — sign, simulated
    function sign() {
      frame(function (p) {
        add(p, el("h1", "", t("a5Title")), el("p", "lead", t("a5Lead", { name: field("given_name") })));
        var docs = el("ul", "docs");
        ["a5Doc1", "a5Doc2", "a5Doc3"].forEach(function (k) { add(docs, add(el("li"), el("span", "", "📄 " + t(k)), el("span", "", "›"))); });
        var c = el("input"); c.type = "checkbox";
        add(p, docs, add(el("label", "check"), c, el("span", "", t("a5Accept"))), el("p", "note", t("a5Simulated")));
        actions(p, t("a5Sign"), function () { c.checked = true; confirm(); });
      }, 5);
    }
    function confirm() {
      frame(function (p) {
        add(p, el("h1", "", t("a5OtpTitle")), el("p", "lead", t("a5OtpLead")));
        var digits = el("div", "otp-digits");
        var cells = [0, 1, 2, 3, 4, 5].map(function () { var c = el("span", "otp-cell"); add(digits, c); return c; });
        add(p, digits, el("p", "note", t("a1OtpNote")));
        cells.forEach(function (c, i) { timers.later(function () { c.textContent = String((i * 3 + 1) % 10); }, 300 + i * 200); });
        timers.later(welcome, 2200);
        primary = welcome;
      }, 5);
    }

    function welcome() {
      clock.stop(); store(null);
      var ms = clock.ms();
      results.eudi = { ms: ms, steps: PHASES.length, typed: typed, docs: 0, retries: 0, review: false, recorded: recorded };
      report({ product: "cuenta", signed: true });
      frame(function (p) {
        add(p, el("div", "outcome-icon good", "✓"), el("h1", "", t("a5WelcomeTitle")), el("p", "lead", t("successLead")));
        add(p, add(el("div", "acct"), el("small", "", t("signedAccount")), el("span", "acct-iban", t("successIbanValue"))));
        var metrics = el("div", "metrics");
        [[fmt(ms), t("compareTime")], [String(typed), t("compareTyped")], ["0", t("compareDocs")], [t("compareNo"), t("a5Video")]]
          .forEach(function (m) { add(metrics, add(el("div", "metric"), el("strong", "", m[0]), el("span", "", m[1]))); });
        add(p, metrics);
        var login = CFG.login && !recorded;
        if (login) add(p, el("p", "note", t("joinedLogin")));
        primary = login ? function () { go("login"); } : function () { go("compare"); };
        add(p, el("div", "spacer"), add(el("div", "stack"),
          login ? button(t("loginCta"), "btn-primary", primary) : null,
          button(t("successCompare"), login ? "btn-secondary" : "btn-primary", function () { go("compare"); })));
      });
    }

    if (opts.resume) {
      clock.start(stored() || Date.now());
      pidId = opts.resume.id;
      identify("movil", opts.resume.id);
    } else before();
    return {
      advance: function () { if (primary) primary(); },
      destroy: function () { timers.stop(); },
      isDone: function () { return false; }
    };
  }

  function solo(kind, resume) {
    var pane = el("div", "pane pane-solo");
    add(app, pane);
    if (kind === "eudi") {
      // The account opening is the app's own screens, not a pane.
      app.removeChild(pane);
      var account = accountFlow(app, { resume: resume });
      flows.push(account); advanceTarget = account;
      return;
    }
    var flow = kind === "loan"
      ? eudiFlow(pane, { product: "loan", resume: resume })
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
    closeMenu();
    if (view !== "login") tech.use("");
    if (view === "login") { var f = loginFlow(app, resume); flows.push(f); advanceTarget = f; }
    else if (view === "eudi") solo("eudi", resume);
    else if (view === "current") solo("current");
    else if (view === "loan") solo("loan", resume);
    else if (view === "side") side();
    else if (view === "compare") compare();
    else home();
    window.scrollTo(0, 0);
  }

  function reset() {
    results = { eudi: null, current: null };
    store(null); saveSession(null);
    tech.reset();
    if (CFG.resume) { window.location.href = "./"; return; }
    go("home");
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
    if (key === "escape") closeMenu();
    else if (key === "r") reset();
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

  // --- the app's menu ----------------------------------------------------------------------------

  var drawer = document.getElementById("drawer"), scrim = document.getElementById("scrim");
  var menuOpen = document.getElementById("menu-open");
  function closeMenu() { drawer.hidden = true; scrim.hidden = true; menuOpen.setAttribute("aria-expanded", "false"); }
  menuOpen.addEventListener("click", function () {
    drawer.hidden = false; scrim.hidden = false; menuOpen.setAttribute("aria-expanded", "true");
    document.getElementById("menu-close").focus();
  });
  document.getElementById("menu-close").addEventListener("click", closeMenu);
  scrim.addEventListener("click", closeMenu);
  Array.prototype.forEach.call(drawer.querySelectorAll("[data-go]"), function (b) {
    b.addEventListener("click", function () {
      var target = b.getAttribute("data-go");
      if (target === "home") reset(); else go(target);
    });
  });

  setRecorded(false);
  if (CFG.resume) {
    var returning = loadSession();
    if (CFG.resumeKind === "acceso") go("login", { id: CFG.resume });
    else go(returning && returning.product === "loan" ? "loan" : "eudi", { id: CFG.resume, kind: CFG.resumeKind || "pid" });
  } else go("home");
})();
`}`;
