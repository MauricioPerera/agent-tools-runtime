// Scroll reveal for module sections + the bus pulse that tracks the active
// section. Small, dependency-free.
(function () {
  "use strict";

  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window) || !items.length) {
      items.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    items.forEach(function (el) { io.observe(el); });
  }

  function initBusPulse() {
    var pulse = document.querySelector(".bus__pulse");
    var sections = document.querySelectorAll("[data-bus-anchor]");
    if (!pulse || !sections.length) return;
    var ticking = false;
    function update() {
      ticking = false;
      var viewportCenter = window.innerHeight * 0.42;
      var closest = null;
      var closestDist = Infinity;
      sections.forEach(function (el) {
        var rect = el.getBoundingClientRect();
        var dist = Math.abs(rect.top - viewportCenter);
        if (dist < closestDist) { closestDist = dist; closest = el; }
      });
      if (closest) {
        var rect = closest.getBoundingClientRect();
        pulse.style.top = (rect.top + rect.height / 2 - 70) + "px";
      }
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  document.addEventListener("DOMContentLoaded", function () {
    initReveal();
    initBusPulse();
  });
})();
