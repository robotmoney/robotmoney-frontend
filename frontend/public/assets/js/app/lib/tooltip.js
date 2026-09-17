// Behaviour for .rm-tip (components.css). Bound ONCE, by delegation, because
// these views are Alpine templates: a tooltip inside an x-for is created and
// destroyed as data changes, so per-element listeners attached at load would
// cover the first render and nothing after it.
//
// :hover does the desktop path in CSS. This file exists for the parts CSS
// cannot do:
//
//   * touch — a phone has no hover at all, so the icon must answer a tap
//   * one at a time — a second open bubble over a first is unreadable
//   * Escape, and a tap anywhere else, to dismiss
//   * keeping the bubble inside the page, which is measured rather than
//     guessed from a breakpoint: what clips depends on where the icon landed
//     after wrapping, not on the viewport width
//
// The clamp measures against the element that actually CLIPS (the page
// container), not the viewport. Those differ by the page gutter, so a bubble
// can sit fully on screen and still be sliced.

const SEL = ".rm-tip:not([data-concept-tip])";
const OPEN = "data-open";
let open = null;

function bubble(tip) { return tip.querySelector(".rm-tip__bub"); }
function trigger(tip) { return tip.querySelector(".rm-tip__btn"); }

function close() {
  if (!open) return;
  bubble(open)?.removeAttribute(OPEN);
  trigger(open)?.setAttribute("aria-expanded", "false");
  open = null;
}

/** Position the bubble so it stays inside the page box. */
export function placeTip(tip) {
  const bub = bubble(tip);
  if (!bub) return;

  // Phones render the bubble as a pinned sheet, so only its vertical offset
  // needs setting, from the icon it belongs to.
  if (matchMedia("(max-width: 699px)").matches) {
    bub.style.top = `${tip.getBoundingClientRect().bottom + 8}px`;
    return;
  }
  bub.style.top = "";
  bub.style.setProperty("--rm-tip-nudge", "0px");

  // Above by default, below when there is no room above. A bubble's height is
  // its text's, and the role tip on the swarm roster is seven lines — enough
  // that scrolling its table header towards the top of the window would put
  // the bubble off it. Measured while hidden, which is `visibility: hidden`
  // and therefore still laid out.
  if (tip.getBoundingClientRect().top < bub.getBoundingClientRect().height + 8) {
    bub.setAttribute("data-below", "1");
  } else {
    bub.removeAttribute("data-below");
  }

  // .rv__body is the regime dashboard's own 1280px gutter box, added when the
  // panel tables grew header tips: without it the nearest match is <main>, and
  // clamping to <main> lets a bubble on the rightmost panel card sit out in the
  // 1.5rem gutter — the exact "on screen but still sliced" case above.
  const host = tip.closest(".sv__body, .rv__body, .container, .cv, main, body") || document.body;
  const box = host.getBoundingClientRect();
  const r = bub.getBoundingClientRect();
  const pad = 8;
  let shift = 0;
  if (r.left < box.left + pad) shift = (box.left + pad) - r.left;
  else if (r.right > box.right - pad) shift = (box.right - pad) - r.right;
  if (shift) bub.style.setProperty("--rm-tip-nudge", `${Math.round(shift)}px`);
}

export function initTooltips() {
  initConceptTooltips();
  if (document.documentElement.dataset.rmTips === "1") return;
  document.documentElement.dataset.rmTips = "1";

  // Position on the way in, for hover and for keyboard focus alike.
  document.addEventListener("pointerover", (e) => {
    const tip = e.target instanceof Element ? e.target.closest(SEL) : null;
    if (tip) placeTip(tip);
  }, true);
  document.addEventListener("focusin", (e) => {
    const tip = e.target instanceof Element ? e.target.closest(SEL) : null;
    if (tip) placeTip(tip);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".rm-tip__btn") : null;
    if (!btn) { close(); return; }
    if (btn.closest("[data-concept-tip]")) return;
    e.stopPropagation();
    const tip = btn.closest(SEL);
    const wasOpen = bubble(tip)?.hasAttribute(OPEN);
    close();
    if (!wasOpen) {
      placeTip(tip);
      bubble(tip)?.setAttribute(OPEN, "1");
      btn.setAttribute("aria-expanded", "true");
      open = tip;
    }
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  addEventListener("resize", () => {
    close();
    document.querySelectorAll(SEL).forEach(placeTip);
  });
  // A tap-opened bubble is positioned once, from where its icon was standing
  // at the time. Scroll moves the icon out from under that measurement — far
  // enough and an upward bubble is off the top of the window — and nothing
  // re-measures, because placement runs on pointer, focus and resize only.
  // Closing is the honest answer: the reader has moved on, and the next hover
  // or tap places it again from where things now are. A hover-opened bubble
  // needs nothing here; it is CSS, and scrolling takes the icon out from under
  // the pointer, which closes it.
  addEventListener("scroll", () => close(), { passive: true });
}

// Opt-in concept definitions share .rm-tip presentation, but use explicit state
// instead of CSS hover so Escape can dismiss a still-hovered/focused trigger.
// Delegation is unnecessary here: bind newly rendered component instances once.
export function initConceptTooltips(scope = document) {
  for (const tip of scope.querySelectorAll('[data-concept-tip]')) {
    if (tip.dataset.bound) continue;
    tip.dataset.bound = 'true';
    const btn = trigger(tip), bub = bubble(tip);
    let pinned = false, timer;
    const visible = () => bub.hasAttribute(OPEN);
    function hide() {
      clearTimeout(timer);
      bub.removeAttribute(OPEN);
      pinned = false;
    }
    function position() {
      const rect = btn.getBoundingClientRect(), margin = 12;
      bub.style.width = `${Math.min(290, innerWidth-margin*2)}px`;
      const height = bub.getBoundingClientRect().height;
      bub.style.left = `${Math.max(margin,Math.min(rect.left,innerWidth-bub.getBoundingClientRect().width-margin))}px`;
      const below = rect.bottom + 8;
      bub.style.top = `${Math.max(margin,below+height <= innerHeight-margin ? below : rect.top-height-8)}px`;
    }
    function show() {
      clearTimeout(timer);
      // One definition at a time, including pinned definitions.
      document.querySelectorAll('[data-concept-tip]').forEach(other=>{
        if(other!==tip) other.dispatchEvent(new Event('dismiss-concept'));
      });
      position();
      bub.setAttribute(OPEN,'1');
    }
    function leave() {
      clearTimeout(timer);
      timer=setTimeout(()=>{
        if(!pinned && !tip.matches(':hover') && document.activeElement!==btn)hide();
      },140);
    }
    tip.addEventListener('dismiss-concept',hide);
    tip.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')show();});
    tip.addEventListener('pointerleave',leave);
    bub.addEventListener('pointerenter',()=>clearTimeout(timer));
    bub.addEventListener('pointerleave',leave);
    btn.addEventListener('focus',show);
    btn.addEventListener('blur',leave);
    btn.addEventListener('click',()=>{if(pinned)hide();else{show();pinned=true;}});
    document.addEventListener('click',event=>{if(!tip.contains(event.target))hide();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&visible()){hide();event.stopPropagation();}});
    addEventListener('resize',hide);
    addEventListener('scroll',hide,{capture:true,passive:true});
  }
}
