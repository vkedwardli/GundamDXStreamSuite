// A classic script so the live overlay and standalone file:// preview share it.
function createCaptionEffects(textElement, overlayElement) {
  const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
  const measure = document.createElement("canvas").getContext("2d");
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const border = document.createElement("div");
  border.className = "caption-border-pulse";
  border.setAttribute("aria-hidden", "true");
  overlayElement.appendChild(border);
  let pulse;
  let timer;
  let characters = [];
  let revealed = 0;
  let interval = 100;
  let remaining = 0;
  let deadline = 0;
  let paused = false;

  function stopPulse() {
    pulse?.cancel();
    pulse = null;
  }

  function finishTyping() {
    clearTimeout(timer);
    // Restore ordinary text nodes after the short reveal; leave no per-character
    // elements or timers running during speech and later page changes.
    if (characters.length) {
      for (const line of textElement.children) line.textContent = line.textContent;
    }
    characters = [];
  }

  function schedule(delay) {
    remaining = delay;
    if (paused) return;
    deadline = performance.now() + delay;
    timer = setTimeout(tick, delay);
  }

  function tick() {
    characters[revealed++].style.visibility = "visible";
    if (revealed === characters.length) finishTyping();
    else schedule(interval);
  }

  return {
    fitText() {
      const style = getComputedStyle(textElement);
      const lines = Array.from(textElement.children);
      if (!lines.length) return;
      textElement.style.textAlign = lines.length === 1 ? "center" : "left";
      const width = textElement.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = textElement.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const lineHeight = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
      measure.font = `${style.fontWeight} 100px ${style.fontFamily}`;
      const widest = Math.max(1, ...lines.map((line) => measure.measureText(line.textContent).width));
      // Fit once per page, against both width and height. A short single line
      // can grow to about twice the usual size without moving the header/footer.
      textElement.style.fontSize = `${Math.max(1, Math.floor(Math.min(360,
        (width - 8) * 100 / widest, (height - 4) / (lines.length * lineHeight))))}px`;
    },
    pulse(repeat = false) {
      const iterations = repeat ? Infinity : 1;
      // Repeated preparation events must not restart the current pulse cycle.
      if (pulse && pulse.playState !== "finished" && pulse.effect.getTiming().iterations === iterations) return;
      stopPulse();
      if (!reducedMotion()) {
        pulse = border.animate([{ opacity: 0 }, { opacity: 0.8, offset: 0.45 }, { opacity: 0 }],
          { duration: 1100, easing: "ease-in-out", iterations });
        if (paused) pulse.pause();
      }
    },
    stopPulse,
    typeFirstPage() {
      finishTyping();
      if (reducedMotion()) return;
      for (const line of textElement.children) {
        const spans = Array.from(segmenter.segment(line.textContent), ({ segment }) => {
          const span = document.createElement("span");
          span.textContent = segment;
          span.style.visibility = "hidden"; // Preserve both lines' full layout.
          return span;
        });
        line.replaceChildren(...spans);
        characters.push(...spans);
      }
      if (!characters.length) return;
      revealed = 0;
      // Short messages need slower steps to make the reveal noticeable. Reveal
      // one grapheme per tick, with at most twenty updates/second on long pages.
      interval = Math.max(50, Math.min(350, 2000 / characters.length));
      // Let the panel become visible first; otherwise a short message finishes
      // typing inside the fade. An already-visible panel has no arrival delay.
      const fade = overlayElement.getAnimations().find((animation) => animation.transitionProperty === "opacity");
      const fadeDelay = fade ? Math.max(0, fade.effect.getComputedTiming().endTime - (fade.currentTime || 0)) : 0;
      schedule(fadeDelay);
    },
    finishTyping,
    pause() {
      if (paused) return;
      paused = true;
      clearTimeout(timer);
      if (characters.length) remaining = Math.max(0, deadline - performance.now());
      if (pulse?.playState === "running") pulse.pause();
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (characters.length) schedule(remaining);
      if (pulse?.playState === "paused") pulse.play();
    },
    cancel() {
      finishTyping();
      stopPulse();
      paused = false;
    },
  };
}
