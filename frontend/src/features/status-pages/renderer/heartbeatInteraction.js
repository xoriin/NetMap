// Fixed, hash-authorised code only. No network, storage, parent DOM access, HTML
// parsing or evaluation: all tooltip content is written with textContent.
(() => {
  "use strict";
  const strips = Array.from(document.querySelectorAll(".sp-heartbeats"));
  // Match Monitoring's transient arrival marker. Leaving a fill-forwards
  // animation on a bar would override its hover transform indefinitely.
  setTimeout(() => document.querySelectorAll(".sp-beat--new").forEach(beat => beat.classList.remove("sp-beat--new")), 900);
  strips.forEach(strip => {
    strip.dataset.spEnhanced = "true";
    strip.querySelectorAll(".sp-beat-slot").forEach(slot => slot.removeAttribute("title"));
  });
  const tip = document.createElement("div");
  tip.id = "sp-heartbeat-tooltip";
  tip.className = "hb-tooltip-card sp-heartbeat-tooltip";
  tip.setAttribute("role", "tooltip");
  const header = document.createElement("div");
  header.className = "hb-tooltip-header";
  const date = document.createElement("span");
  date.className = "hb-tooltip-date";
  const time = document.createElement("span");
  time.className = "hb-tooltip-time";
  header.append(date, time);
  const row = document.createElement("div");
  row.className = "hb-tooltip-status-row";
  const status = document.createElement("span");
  status.className = "hb-tooltip-status-text sp-heartbeat-tooltip-status";
  const response = document.createElement("span");
  response.className = "hb-tooltip-rtt";
  row.append(status, response);
  const info = document.createElement("div");
  info.className = "hb-tooltip-ports sp-heartbeat-tooltip-info";
  tip.append(header, row, info);
  document.body.append(tip);
  let active = null;
  let described = null;
  let dismissed = null;
  let timer = 0;
  let pinned = null;

  function clearSelection(strip) {
    if (!strip) return;
    strip.classList.remove("has-active");
    strip.querySelectorAll(".sp-beat").forEach(beat => beat.classList.remove("is-active", "is-pinned"));
  }
  function hide() {
    clearTimeout(timer);
    clearSelection(active);
    pinned = null;
    active = null;
    tip.dataset.open = "false";
    if (described) described.removeAttribute("aria-describedby");
    described = null;
  }
  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => pinned ? show(pinned.strip, pinned.index) : hide(), 140);
  }
  function show(strip, index) {
    if (dismissed === strip) return;
    clearTimeout(timer);
    if (active !== strip) clearSelection(active);
    active = strip;
    const slots = Array.from(strip.querySelectorAll(".sp-beat-slot"));
    const slot = slots[index];
    if (!slot) return;
    const choice = slot.querySelector(".sp-beat-choice");
    if (described && described !== choice) described.removeAttribute("aria-describedby");
    described = choice;
    choice.setAttribute("aria-describedby", tip.id);
    strip.classList.add("has-active");
    slots.forEach((entry, at) => {
      const beat = entry.querySelector(".sp-beat");
      beat.classList.toggle("is-active", at === index);
      beat.classList.toggle("is-pinned", pinned?.strip === strip && pinned.index === at);
    });
    let lines;
    try { lines = JSON.parse(slot.dataset.spDetails); } catch { return hide(); }
    if (!Array.isArray(lines) || !lines.every(line => typeof line === "string")) return hide();
    date.textContent = lines[2];
    time.textContent = lines[3];
    status.textContent = lines[1];
    status.dataset.state = slot.dataset.spState;
    response.textContent = lines[5] || "";
    response.hidden = !lines[5];
    info.textContent = lines[0] + "\n" + lines[4];
    const anchor = slot.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.max(12, Math.min(innerWidth - box.width - 12, anchor.left + anchor.width / 2 - box.width / 2));
    const above = anchor.top - box.height - 22;
    const top = above >= 12 ? above : Math.min(innerHeight - box.height - 12, anchor.bottom + 22);
    // Start a newly opened card at its target; glide only between live targets.
    const opening = tip.dataset.open !== "true";
    if (opening) tip.style.transition = "none";
    tip.style.left = left + "px";
    tip.style.top = Math.max(12, top) + "px";
    if (opening) {
      void tip.offsetWidth;
      tip.style.removeProperty("transition");
    }
    tip.dataset.open = "true";
  }
  strips.forEach(strip => {
    const slots = Array.from(strip.querySelectorAll(".sp-beat-slot"));
    strip.addEventListener("pointermove", event => {
      if (event.pointerType !== "mouse" || dismissed === strip || !slots.length) return;
      const first = slots[0].getBoundingClientRect();
      const last = slots[slots.length - 1].getBoundingClientRect();
      const step = slots.length > 1 ? (last.left + last.width / 2 - first.left - first.width / 2) / (slots.length - 1) : 1;
      const center = Math.max(0, Math.min(slots.length - 1, (event.clientX - first.left - first.width / 2) / step));
      show(strip, Math.round(center));
    });
    strip.addEventListener("click", event => {
      if (event.target instanceof HTMLInputElement) return;
      const index = slots.findIndex(slot => slot.contains(event.target));
      if (index < 0) return;
      dismissed = null;
      pinned = pinned?.strip === strip && pinned.index === index ? null : { strip, index };
      show(strip, index);
    });
    strip.addEventListener("pointerleave", () => {
      dismissed = null;
      leave();
    });
    const inspect = event => {
      const index = slots.findIndex(slot => slot.contains(event.target));
      if (index < 0) return;
      dismissed = null;
      if (event.type === "change") pinned = { strip, index };
      show(strip, index);
    };
    strip.addEventListener("focusin", inspect);
    strip.addEventListener("change", inspect);
    strip.addEventListener("focusout", event => {
      if (!strip.contains(event.relatedTarget)) leave();
    });
  });
  tip.addEventListener("pointerenter", () => clearTimeout(timer));
  tip.addEventListener("pointerleave", leave);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && active) {
      dismissed = active;
      hide();
      event.stopPropagation();
    }
  });
  addEventListener("message", event => {
    if (event.source === parent && event.data === "netmap:status-heartbeat-dismiss" && active) {
      dismissed = active;
      hide();
    }
  });
  document.addEventListener("scroll", hide, true);
  addEventListener("resize", hide);

})();
