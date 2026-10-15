/* PT Envio Kompound Indonesia — shared site behaviour */
(function () {
  "use strict";

  /* ---------- Mobile nav ---------- */
  var burger = document.querySelector(".nav-burger");
  var navLinks = document.querySelector(".nav-links");

  if (burger && navLinks) {
    burger.addEventListener("click", function () {
      var isOpen = navLinks.classList.toggle("open");
      burger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      document.body.classList.toggle("no-scroll", isOpen);
    });
  }

  /* Dropdown toggle on click (mobile) + tap-outside close */
  document.querySelectorAll(".nav-item").forEach(function (item) {
    var toggle = item.querySelector(".nav-toggle-item");
    if (!toggle) return;
    toggle.addEventListener("click", function (e) {
      e.preventDefault();
      var isOpen = item.classList.toggle("open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      document.querySelectorAll(".nav-item").forEach(function (other) {
        if (other !== item) other.classList.remove("open");
      });
    });
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".nav-item")) {
      document.querySelectorAll(".nav-item.open").forEach(function (i) { i.classList.remove("open"); });
    }
  });

  /* Close mobile nav on link click */
  document.querySelectorAll(".nav-links a").forEach(function (a) {
    a.addEventListener("click", function () {
      if (navLinks && navLinks.classList.contains("open")) {
        navLinks.classList.remove("open");
        document.body.classList.remove("no-scroll");
        if (burger) burger.setAttribute("aria-expanded", "false");
      }
    });
  });

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Sub-nav active state on scroll (products/about pages) ---------- */
  var subnavLinks = document.querySelectorAll(".page-subnav a");
  if (subnavLinks.length) {
    var sections = Array.prototype.map.call(subnavLinks, function (a) {
      return document.querySelector(a.getAttribute("href"));
    }).filter(Boolean);

    var setActive = function () {
      var pos = window.scrollY + 160;
      var current = sections[0];
      sections.forEach(function (sec) {
        if (sec.offsetTop <= pos) current = sec;
      });
      subnavLinks.forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("href") === "#" + current.id);
      });
    };
    window.addEventListener("scroll", setActive, { passive: true });
    setActive();
  }

  /* ---------- Lightbox: [data-gallery="a.jpg|b.jpg"] opens its photos ---------- */
  var lb = null, lbImgs = [], lbIdx = 0, lbTitle = "", lbOpener = null;

  function buildLightbox() {
    lb = document.createElement("div");
    lb.className = "lightbox";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.innerHTML =
      '<button type="button" class="lb-close" aria-label="Close">&times;</button>' +
      '<button type="button" class="lb-prev" aria-label="Previous photo">&#8249;</button>' +
      '<button type="button" class="lb-next" aria-label="Next photo">&#8250;</button>' +
      '<figure><img alt=""><figcaption></figcaption></figure>';
    document.body.appendChild(lb);
    lb.querySelector(".lb-close").addEventListener("click", closeLightbox);
    lb.querySelector(".lb-prev").addEventListener("click", function () { showPhoto(lbIdx - 1); });
    lb.querySelector(".lb-next").addEventListener("click", function () { showPhoto(lbIdx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) closeLightbox(); });
  }

  function showPhoto(i) {
    lbIdx = (i + lbImgs.length) % lbImgs.length;
    var img = lb.querySelector("img");
    img.src = lbImgs[lbIdx];
    img.alt = lbTitle;
    var cap = lb.querySelector("figcaption");
    cap.textContent = lbTitle;
    if (lbImgs.length > 1) {
      var n = document.createElement("span");
      n.textContent = (lbIdx + 1) + " / " + lbImgs.length;
      cap.appendChild(n);
    }
    var multi = lbImgs.length > 1;
    lb.querySelector(".lb-prev").hidden = !multi;
    lb.querySelector(".lb-next").hidden = !multi;
  }

  function openLightbox(el) {
    if (!lb) buildLightbox();
    lbImgs = el.getAttribute("data-gallery").split("|").filter(Boolean);
    if (!lbImgs.length) return;
    lbTitle = el.getAttribute("data-title") || "";
    lb.setAttribute("aria-label", lbTitle);
    lbOpener = el;
    showPhoto(0);
    lb.classList.add("open");
    document.body.classList.add("no-scroll");
    lb.querySelector(".lb-close").focus();
  }

  function closeLightbox() {
    if (!lb || !lb.classList.contains("open")) return;
    lb.classList.remove("open");
    document.body.classList.remove("no-scroll");
    if (lbOpener) lbOpener.focus();
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-gallery]");
    if (el) { e.preventDefault(); openLightbox(el); }
  });
  document.addEventListener("keydown", function (e) {
    if (!lb || !lb.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft" && lbImgs.length > 1) showPhoto(lbIdx - 1);
    else if (e.key === "ArrowRight" && lbImgs.length > 1) showPhoto(lbIdx + 1);
  });
})();
