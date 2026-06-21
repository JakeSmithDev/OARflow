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
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Contact / quote form ---------- */
  var form = document.querySelector("#quote-form");
  if (form) {
    var formCard = form.closest(".form-card");
    var success = formCard ? formCard.querySelector(".form-success") : null;

    var setError = function (field, on) {
      if (field) field.classList.toggle("invalid", on);
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var valid = true;
      var firstBad = null;

      form.querySelectorAll("[data-required]").forEach(function (input) {
        var field = input.closest(".field");
        var val = (input.value || "").trim();
        var ok = val.length > 0;
        if (ok && input.type === "email") {
          ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
        }
        if (ok && input.type === "tel") {
          ok = (val.replace(/\D/g, "").length >= 10);
        }
        setError(field, !ok);
        if (!ok) { valid = false; if (!firstBad) firstBad = input; }
      });

      if (!valid) {
        if (firstBad) firstBad.focus();
        return;
      }

      // No backend wired yet — show confirmation and reset.
      // To receive submissions, set the form's action to a handler
      // (e.g. Formspree/Netlify Forms) and remove preventDefault above.
      if (success) {
        success.classList.add("show");
        success.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      form.querySelectorAll("input, textarea, select").forEach(function (i) {
        if (i.type !== "submit") i.value = "";
      });
    });

    // clear error styling as the user types
    form.querySelectorAll("input, textarea, select").forEach(function (input) {
      input.addEventListener("input", function () {
        var field = input.closest(".field");
        if (field) field.classList.remove("invalid");
        if (success) success.classList.remove("show");
      });
    });
  }

  /* ---------- Footer year ---------- */
  var yr = document.querySelector("[data-year]");
  if (yr) yr.textContent = new Date().getFullYear();
})();
