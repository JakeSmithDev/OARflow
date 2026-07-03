/* =====================================================================
   Pasternack Pest Management — site interactions
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- Sticky header shadow on scroll ---------- */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- Mobile nav ---------- */
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.querySelector(".mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-item").forEach(function (item) {
    var q = item.querySelector(".faq-q");
    if (!q) return;
    q.addEventListener("click", function () {
      var isOpen = item.classList.contains("open");
      // close siblings within the same .faq group
      var group = item.closest(".faq");
      if (group) {
        group.querySelectorAll(".faq-item.open").forEach(function (other) {
          if (other !== item) {
            other.classList.remove("open");
            var oq = other.querySelector(".faq-q");
            if (oq) oq.setAttribute("aria-expanded", "false");
          }
        });
      }
      item.classList.toggle("open", !isOpen);
      q.setAttribute("aria-expanded", !isOpen ? "true" : "false");
    });
  });

  /* ---------- Reveal on scroll ---------- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.01, rootMargin: "0px 0px 120px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Analytics events ---------- */
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest('a[href^="tel:"]') : null;
    if (!link || typeof window.plausible !== "function") return;
    window.plausible("Phone Call", {
      props: {
        href: link.getAttribute("href") || "",
        path: window.location.pathname || "/",
      },
    });
  });

  /* ---------- Contact / quote form ---------- */
  var form = document.querySelector("#quote-form");
  if (form) {
    var formCard = form.closest(".form-card");
    var success = formCard ? formCard.querySelector(".form-success") : null;
    var errorBox = formCard ? formCard.querySelector(".form-error") : null;
    var submitBtn = form.querySelector('[type="submit"]');

    var setError = function (input, on) {
      var field = input ? input.closest(".field") : null;
      if (field) field.classList.toggle("invalid", on);
      if (input) input.setAttribute("aria-invalid", on ? "true" : "false");
    };

    var showPanel = function (panel) {
      if (success) success.classList.toggle("show", panel === success);
      if (errorBox) errorBox.classList.toggle("show", panel === errorBox);
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var valid = true;
      var firstBad = null;

      form.querySelectorAll("[data-required]").forEach(function (input) {
        var val = (input.value || "").trim();
        var ok = val.length > 0;
        if (ok && input.type === "email") {
          ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
        }
        if (ok && input.type === "tel") {
          ok = (val.replace(/\D/g, "").length >= 10);
        }
        setError(input, !ok);
        if (!ok) { valid = false; if (!firstBad) firstBad = input; }
      });

      if (!valid) {
        if (firstBad) firstBad.focus();
        return;
      }

      var data = new FormData(form);
      var name = [data.get("first_name"), data.get("last_name")]
        .map(function (v) { return (v || "").trim(); })
        .filter(Boolean)
        .join(" ");
      var city = (data.get("city") || "").trim();
      var zip = (data.get("zip") || "").trim();
      var plan = (data.get("plan") || "").trim();
      var message = (data.get("message") || "").trim();
      var notes = [plan ? "Service interest: " + plan : "", message].filter(Boolean).join("\n\n");

      if (submitBtn) submitBtn.disabled = true;
      showPanel(null);

      fetch("/api/public/pasternack/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          phone: (data.get("phone") || "").trim(),
          email: (data.get("email") || "").trim(),
          address: [city, zip].filter(Boolean).join(", "),
          pest: (data.get("pest") || "").trim(),
          notes: notes,
        }),
      }).then(function (res) {
        if (!res.ok) throw new Error("Lead submit failed");
        showPanel(success);
        form.querySelectorAll("input, textarea, select").forEach(function (i) {
          if (i.type !== "submit") i.value = "";
        });
      }).catch(function () {
        showPanel(errorBox);
      }).finally(function () {
        if (submitBtn) submitBtn.disabled = false;
      });
    });

    // clear error styling as the user types
    form.querySelectorAll("input, textarea, select").forEach(function (input) {
      input.addEventListener("input", function () {
        var field = input.closest(".field");
        if (field) field.classList.remove("invalid");
        input.setAttribute("aria-invalid", "false");
        if (success) success.classList.remove("show");
        if (errorBox) errorBox.classList.remove("show");
      });
    });
  }

  /* ---------- Footer year ---------- */
  var yr = document.querySelector("[data-year]");
  if (yr) yr.textContent = new Date().getFullYear();
})();
